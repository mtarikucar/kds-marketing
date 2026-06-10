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
    if (limit !== -1) {
      const count = await this.prisma.knowledgeDoc.count({ where: { workspaceId } });
      if (count >= limit) {
        throw new BadRequestException(
          `Knowledge doc limit reached (${limit}) — upgrade your package`,
        );
      }
    }
    return this.prisma.knowledgeDoc.create({
      data: {
        workspaceId,
        title: dto.title,
        content: dto.content,
        language: dto.language ?? 'tr',
        source: dto.source ?? 'MANUAL',
        sourceRef: dto.sourceRef ?? null,
      },
      select: { id: true, title: true, language: true, status: true, updatedAt: true },
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
   */
  async search(
    workspaceId: string,
    query: string,
    docIds?: string[],
    limit = 4,
  ): Promise<KnowledgeSnippet[]> {
    if (!query.trim()) return [];
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
                 ${query}),
               'MaxFragments=2,MaxWords=40,MinWords=15'
             ) AS snippet,
             ts_rank("searchVector",
               websearch_to_tsquery(
                 CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                                 WHEN 'en' THEN 'english'::regconfig
                                 WHEN 'ru' THEN 'russian'::regconfig
                                 ELSE 'simple'::regconfig END,
                 ${query})) AS rank
        FROM "knowledge_docs"
       WHERE "workspaceId" = ${workspaceId}
         AND "status" = 'ACTIVE'
         ${idFilter}
         AND "searchVector" @@ websearch_to_tsquery(
               CASE "language" WHEN 'tr' THEN 'turkish'::regconfig
                               WHEN 'en' THEN 'english'::regconfig
                               WHEN 'ru' THEN 'russian'::regconfig
                               ELSE 'simple'::regconfig END,
               ${query})
       ORDER BY rank DESC
       LIMIT ${limit};
    `;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, rank: r.rank }));
  }
}
