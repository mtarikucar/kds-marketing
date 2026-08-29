import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The conversation fields the PERSON list carries — the data half of the
 * "one object, the person; a conversation is a field of the person" surface.
 *
 * All of it is raw SQL for one reason: `conversations` carries NO foreign key
 * to `leads` (schema.prisma declares a bare `leadId String`, with only
 * `@@index([leadId])` beside it). There is no relation to `include`, no `some`
 * to nest, and no `_count` to ask for — the aggregate has to be computed and
 * stitched back onto the page, exactly as `waiting-reply-leads.ts` already does
 * for the "Bekleyen" chip.
 *
 * The missing foreign key is also a tenant hazard, not just an inconvenience:
 * nothing in the database stops a conversation row in workspace B from naming
 * a lead id that belongs to workspace A. So every statement below carries its
 * own `workspaceId` predicate — on the conversation AND on the message — and
 * the real-DB e2e keeps a row shaped precisely like that around to prove it.
 *
 * Cost: the two page-scoped reads take the ids of ONE page (<= 100 leads), so
 * they are two queries per request, never one per row.
 *
 * ## Measured, because this is now the default surface's hot path
 *
 * `workspaceLastMessageAt` and `workspaceLastActivityAt` below are not page-
 * scoped and cannot be: they feed the `lastActivityAt` ORDER, and an order has
 * to be settled across the whole filtered set before a page can be cut from it
 * (see MarketingLeadsService.findAll's `sortByActivity` branch). That branch is
 * what `/inbox` and `/leads` — the app's default surface — sort by, so it runs
 * on essentially every list request.
 *
 * Against local Postgres at 50 000 leads / 20 000 conversations / 200 000
 * messages, the same 2000x-the-real-workload fixture `waiting-reply-leads.ts`
 * documents its own numbers against:
 *
 *   - the message aggregate (`workspaceLastMessageAt`)   ~147 ms
 *   - the activity aggregate (`workspaceLastActivityAt`)  ~41 ms
 *   - the candidate id scan                               ~12 ms
 *   - plus hydrating 50 000 rows into Node and sorting them in JS
 *
 * Deliberately NOT optimised. This product's live figure is ~400 leads, where
 * the whole branch is noise; a covering index or a materialised
 * `lastActivityAt` column would be work spent on a workload nobody has, and the
 * reason the ORDER is in JS at all is that moving it into SQL means a SECOND
 * copy of the lead filter — the divergence that once made the CSV export
 * disagree with the on-screen list. The numbers are here so that the day
 * someone DOES have 50 000 leads, the measurement already exists instead of
 * having to be discovered from a support ticket.
 *
 * The multiplier to know about when reading them: neither `PeopleList` nor
 * `LeadsPage` debounces its search input — both are a plain
 * `onChange -> setSearch`, which is a new query key and therefore a new request
 * per KEYSTROKE. At 400 leads that is invisible. Whoever raises the ceiling
 * should fix the debounce first; it is one hook and it divides all of the above
 * by the length of what someone types.
 */

/**
 * How much of a message body the list row shows. Long enough to tell two
 * threads apart at a glance, short enough that a page of 100 previews is a few
 * KB rather than a few hundred.
 */
export const PREVIEW_MAX = 160;

export interface LeadConversationSummary {
  /**
   * Newest message across ALL of this person's threads. Null when the person
   * has threads but nothing has been said in them yet — an outbound thread
   * opened by `conversations/start` is exactly that state.
   */
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  /** Summed across the person's threads, not taken from one of them. */
  unreadCount: number;
}

/**
 * One line of a message body.
 *
 * Newlines collapse because the row is a single line — a raw body would
 * otherwise render as its first line only and silently hide the rest. The cut
 * appends an ellipsis so a truncated preview cannot be mistaken for a short
 * message, which is the same "say it, don't imply it" rule the timeline's
 * `truncated` list follows.
 */
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

/**
 * Newest message + unread sum for a page of people.
 *
 * Two statements rather than one: the preview is an argmax (the body belonging
 * to the newest row, which needs DISTINCT ON) and the unread count is a plain
 * SUM over conversations that must include threads with no messages at all.
 * Folding them together would either drop the second group or need a join that
 * re-counts unread once per message.
 *
 * An empty page returns an empty map WITHOUT touching the database. That is
 * not just an optimisation: `Prisma.join([])` throws, and the id list is the
 * only thing narrowing these statements to the page.
 */
export async function leadConversationSummaries(
  prisma: PrismaService,
  workspaceId: string,
  leadIds: string[],
): Promise<Map<string, LeadConversationSummary>> {
  const out = new Map<string, LeadConversationSummary>();
  if (leadIds.length === 0) return out;

  const [newest, unread] = await Promise.all([
    prisma.$queryRaw<Array<{ leadId: string; body: string; createdAt: Date }>>`
      SELECT DISTINCT ON (c."leadId")
             c."leadId" AS "leadId", m."body" AS "body", m."createdAt" AS "createdAt"
      FROM "conversations" c
      JOIN "messages" m
        ON m."conversationId" = c."id"
       AND m."workspaceId" = ${workspaceId}
      WHERE c."workspaceId" = ${workspaceId}
        AND c."leadId" IN (${Prisma.join(leadIds)})
      ORDER BY c."leadId", m."createdAt" DESC
    `,
    prisma.$queryRaw<Array<{ leadId: string; unread: number }>>`
      SELECT c."leadId" AS "leadId", COALESCE(SUM(c."unreadCount"), 0)::int AS "unread"
      FROM "conversations" c
      WHERE c."workspaceId" = ${workspaceId}
        AND c."leadId" IN (${Prisma.join(leadIds)})
      GROUP BY c."leadId"
    `,
  ]);

  const bodyByLead = new Map(newest.map((r) => [r.leadId, r]));
  const unreadByLead = new Map(unread.map((r) => [r.leadId, Number(r.unread) || 0]));
  // Built from the UNION of the two statements, not from the newest-message
  // rows alone: a person whose thread was opened outbound has an unread count
  // and no message, and keying off `newest` would drop them entirely.
  for (const leadId of new Set([...bodyByLead.keys(), ...unreadByLead.keys()])) {
    const msg = bodyByLead.get(leadId);
    out.set(leadId, {
      lastMessageAt: msg?.createdAt ?? null,
      lastMessagePreview: msg ? previewOf(msg.body) : null,
      unreadCount: unreadByLead.get(leadId) ?? 0,
    });
  }
  return out;
}

/**
 * Newest message time per person for the WHOLE workspace.
 *
 * Workspace-scoped rather than page-scoped on purpose: this feeds the
 * `lastActivityAt` ORDER, which has to be settled across the entire filtered
 * set before a page can be cut from it. Its size is bounded by the number of
 * people who have ever been messaged, not by the number of messages.
 */
export async function workspaceLastMessageAt(
  prisma: PrismaService,
  workspaceId: string,
): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<Array<{ leadId: string; at: Date }>>`
    SELECT c."leadId" AS "leadId", MAX(m."createdAt") AS "at"
    FROM "conversations" c
    JOIN "messages" m
      ON m."conversationId" = c."id"
     AND m."workspaceId" = ${workspaceId}
    WHERE c."workspaceId" = ${workspaceId}
    GROUP BY c."leadId"
  `;
  return new Map(rows.map((r) => [r.leadId, r.at]));
}

/**
 * Newest LeadActivity time per person for the WHOLE workspace.
 *
 * `lead_activities` has no `workspaceId` column of its own — it reaches the
 * tenant only through its (real, this time) foreign key to `leads` — so the
 * join to `leads` IS the tenant predicate here, not a convenience.
 */
export async function workspaceLastActivityAt(
  prisma: PrismaService,
  workspaceId: string,
): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<Array<{ leadId: string; at: Date }>>`
    SELECT a."leadId" AS "leadId", MAX(a."createdAt") AS "at"
    FROM "lead_activities" a
    JOIN "leads" l ON l."id" = a."leadId"
    WHERE l."workspaceId" = ${workspaceId}
    GROUP BY a."leadId"
  `;
  return new Map(rows.map((r) => [r.leadId, r.at]));
}

/** The newest of a set of instants, ignoring the ones that are absent. */
export function newestOf(...dates: Array<Date | null | undefined>): Date {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  // Callers always pass the lead's own createdAt, which is never null.
  return best as Date;
}
