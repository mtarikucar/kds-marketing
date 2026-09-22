import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';

export interface KnowledgeSnippet {
  id: string;
  title: string;
  snippet: string;
  rank: number;
}

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/** Upper bounds on a retrieval query that may be a whole inbound message. */
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_TERMS = 24;
/** A tsvector lexeme has no business being longer than this; Postgres caps at 2046 bytes. */
const MAX_TERM_CHARS = 64;

/**
 * Neutralise a retrieval query that a stranger wrote.
 *
 * `search()` is reached with whatever the customer typed — an inbound email
 * body, a webchat line, the synthetic prompt built from an IVR keypress. Two
 * consequences follow, and neither is hypothetical:
 *
 * 1. `websearch_to_tsquery` has an operator language: `"phrase"`, `-negation`,
 *    `or`. Passing sender text verbatim hands the sender that language, so the
 *    message gets a say in which of the workspace's docs are pasted into the
 *    model's prompt. Reduced to a bag of words every term is ANDed, which can
 *    only ever retrieve LESS than the sender asked for, never more.
 * 2. The text is unbounded. A 100 KB body becomes a 100 KB tsquery evaluated
 *    against every ACTIVE doc of the workspace three times over (headline, rank,
 *    match) on the inbound path — a CPU bill anyone can trigger for free.
 *
 * Returns `''` when nothing usable survives; `search()` then short-circuits
 * before touching the database.
 */
export function sanitizeSearchQuery(raw: string): string {
  if (typeof raw !== 'string' || !raw) return '';
  const words = raw
    // Bound the work before splitting: the input may be a whole message.
    .slice(0, MAX_QUERY_CHARS * MAX_QUERY_TERMS)
    // Control characters are never part of a term and poison logs.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // Phrase pinning and the quote forms that reach it.
    .replace(/["'`‘’“”]+/g, ' ')
    .split(/\s+/)
    // `-term` excludes, `+term` requires — drop the sign, keep the word.
    .map((t) => t.replace(/^[-+]+/, '').slice(0, MAX_TERM_CHARS))
    // A bare OR is the one operator that WIDENS the match.
    .filter((t) => t.length > 0 && !/^or$/i.test(t));

  const kept: string[] = [];
  let budget = MAX_QUERY_CHARS;
  for (const word of words) {
    if (kept.length >= MAX_QUERY_TERMS) break;
    const cost = kept.length ? word.length + 1 : word.length;
    if (cost > budget) break;
    kept.push(word);
    budget -= cost;
  }
  return kept.join(' ');
}

/**
 * Workspace knowledge base + FTS retrieval (Postgres tsvector). The agent
 * engine calls `search()` to ground replies; CRUD is the Agent Studio UI.
 * Every query is workspaceId-scoped; the FTS regconfig is chosen by a CASE
 * whitelist in the trigger (never interpolated), so retrieval is injection-safe.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.knowledgeDoc.findMany({
      where: { workspaceId },
      select: {
        id: true,
        title: true,
        source: true,
        language: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async get(workspaceId: string, id: string) {
    const doc = await this.prisma.knowledgeDoc.findFirst({
      where: { id, workspaceId },
    });
    if (!doc) throw new NotFoundException('Knowledge doc not found');
    return doc;
  }

  async create(
    workspaceId: string,
    dto: { title: string; content: string; language?: string; source?: string; sourceRef?: string },
  ) {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.maxKnowledgeDocs;
    const data = {
      workspaceId,
      title: dto.title,
      content: dto.content,
      language: dto.language ?? 'tr',
      source: dto.source ?? 'MANUAL',
      sourceRef: dto.sourceRef ?? null,
    };
    const select = { id: true, title: true, language: true, status: true, updatedAt: true };
    // Unlimited plan — no cap to race against.
    if (limit === -1) {
      return this.prisma.knowledgeDoc.create({ data, select });
    }
    // Serialize the count-check + create per workspace under an advisory xact-lock:
    // a bare count-then-create lets two concurrent requests at (limit-1) BOTH pass
    // the cap and exceed it. The lock makes the read-modify-write atomic (mirrors the
    // ai-credits / message-quota / research quota pattern).
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('knowledge-docs:' + workspaceId)}))::text AS locked`,
      );
      const count = await tx.knowledgeDoc.count({ where: { workspaceId } });
      if (count >= limit) {
        throw new BadRequestException(
          `Knowledge doc limit reached (${limit}) — upgrade your package`,
        );
      }
      return tx.knowledgeDoc.create({ data, select });
    });
  }

  async update(
    workspaceId: string,
    id: string,
    dto: { title?: string; content?: string; language?: string; status?: string },
  ) {
    const existing = await this.prisma.knowledgeDoc.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Knowledge doc not found');
    return this.prisma.knowledgeDoc.update({
      where: { id: existing.id },
      data: dto,
      select: { id: true, title: true, language: true, status: true, updatedAt: true },
    });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.knowledgeDoc.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Knowledge doc not found');
    return { message: 'Knowledge doc deleted' };
  }

  /**
   * Full-text search over ACTIVE docs. `websearch_to_tsquery` parses a plain
   * query string; `ts_rank` orders; `ts_headline` extracts a snippet. The doc
   * row's own searchVector (language-aware via the trigger) is matched against
   * a query parsed with the matching regconfig per row. ALWAYS workspace-scoped.
   *
   * `query` arrives from untrusted senders on every AI lane, so it is bounded
   * and stripped of the websearch operator alphabet first — see
   * `sanitizeSearchQuery`. The workspace scope and `status = 'ACTIVE'` are the
   * only things that decide WHICH docs are reachable; the sender's text only
   * ever narrows within that set.
   */
  async search(
    workspaceId: string,
    query: string,
    docIds?: string[],
    limit = 4,
  ): Promise<KnowledgeSnippet[]> {
    const q = sanitizeSearchQuery(query);
    if (!q) return [];
    // Empty selection = every ACTIVE doc, deliberately. Every agent saved
    // through the Agent Studio posts `kbDocIds: []`, the live one included, so
    // reading empty as "no knowledge" would un-ground every deployed agent at
    // once. Keeping a customer-facing agent away from an internal doc needs a
    // per-doc audience flag on `knowledge_docs` (a schema change, handed off),
    // not a re-reading of this filter.
    const idFilter =
      docIds && docIds.length
        ? Prisma.sql`AND "id" = ANY(${docIds})`
        : Prisma.sql``;
    // The query regconfig is derived per-row from a fixed CASE on the row's
    // language; the user query string is bound, never interpolated.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; snippet: string; rank: number }>
    >`
      SELECT "id", "title",
             ts_headline(
               CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                               WHEN 'en' THEN 'english'::regconfig
                               WHEN 'ru' THEN 'russian'::regconfig
                               ELSE 'simple'::regconfig END,
               "content",
               websearch_to_tsquery(
                 CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                                 WHEN 'en' THEN 'english'::regconfig
                                 WHEN 'ru' THEN 'russian'::regconfig
                                 ELSE 'simple'::regconfig END,
                 ${q}),
               'MaxFragments=2,MaxWords=40,MinWords=15'
             ) AS snippet,
             ts_rank("searchVector",
               websearch_to_tsquery(
                 CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                                 WHEN 'en' THEN 'english'::regconfig
                                 WHEN 'ru' THEN 'russian'::regconfig
                                 ELSE 'simple'::regconfig END,
                 ${q})) AS rank
        FROM "knowledge_docs"
       WHERE "workspaceId" = ${workspaceId}
         AND "status" = 'ACTIVE'
         ${idFilter}
         AND "searchVector" @@ websearch_to_tsquery(
               CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                               WHEN 'en' THEN 'english'::regconfig
                               WHEN 'ru' THEN 'russian'::regconfig
                               ELSE 'simple'::regconfig END,
               ${q})
       ORDER BY rank DESC
       LIMIT ${limit};
    `;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, rank: r.rank }));
  }
}
