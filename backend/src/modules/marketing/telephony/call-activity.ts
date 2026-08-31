import { Prisma } from '@prisma/client';

/**
 * The link from a person's stream row back to the CALL it came from.
 *
 * Until this file existed the mirrored `LeadActivity` carried
 * `type/title/description/outcome/duration/leadId/createdById` and nothing
 * else — no reference to the `SalesCall` at all. A rep reading a person's
 * history saw "Sales call: CONNECTED · 3 dk" and could go no further: the
 * recording and the AI analysis both hang off a `SalesCall.id`, and the row
 * did not know one. Playing back a call you just read about meant leaving for
 * /calls and finding the row again by phone number and timestamp.
 *
 * The pattern is `opportunity-activity.ts`'s, which put `{ kind:'opportunity',
 * opportunityId, … }` in `LeadActivity.metadata` for exactly this reason. Two
 * differences worth stating rather than leaving to be re-derived:
 *
 * 1. **This module carries the metadata only, not the whole row.** The two
 *    writers legitimately differ in what the rest of the row says — logCall
 *    knows the final status, the notes and the duration; the inbound mirror in
 *    TelephonyEventConsumer fires as the call ARRIVES and has no duration and
 *    no notes to give. Forcing one row builder over both would have to invent
 *    a shape for the half that does not exist yet. What must NOT differ is the
 *    id, and that is what lives here.
 *
 * 2. **The reader lives here too.** `assignmentOf` keeps its reader in
 *    lead-stream.service.ts and its writers three files away, and the cost is
 *    that the shape's contract is an argument rather than a file. One `kind`
 *    token, written and read in the same twenty lines, cannot drift.
 *
 * `kind: 'call'` is deliberately not `'assignment'` — the only value
 * `assignmentOf()` reacts to. Without that separation every logged call would
 * render in the stream wearing an assignment badge.
 *
 * ## A null answer is PERMANENT, not a backlog
 *
 * `salesCallIdOf` answering null is a standing condition of the data, not a
 * gap waiting to be filled. Three causes, and only the last of them is
 * historical:
 *
 * 1. **A hand-logged call.** `MarketingActivitiesService.create` writes a
 *    `LeadActivity` straight from `CreateActivityDto`, whose `type` enum
 *    includes `CALL` — reachable from `POST /marketing/leads/:leadId/activities`,
 *    from the MCP lead-write tools, and from the Arama button in
 *    LogActivityDialog. A rep who dialled from their own handset and then wrote
 *    down what happened has produced a CALL row with no `SalesCall` anywhere
 *    behind it. There is no id to carry, today or ever, and this is the case
 *    that keeps arriving.
 * 2. **Another writer's metadata, or an unusable id.** `metadata` is a shared
 *    blob; a row carrying `kind:'assignment'`, or `kind:'call'` with a
 *    non-string `salesCallId`, has nothing this function may hand to a fetch.
 * 3. **A call mirrored before this shipped.** Those rows have `metadata: null`
 *    and nothing anywhere pairs them to their call: the mirror kept no id, and
 *    matching by (lead, timestamp, status) would guess.
 *
 * So: do not go looking for a backfill. Only class 3 ever had a `SalesCall` to
 * find, nothing links those rows to it, and classes 1 and 2 would have nothing
 * to point at even if one ran. The stream renders every one of them as a line
 * of history with no player under it — which for a hand-logged call is not a
 * degraded rendering, it is the whole truth about that row.
 */
export function callActivityMetadata(salesCallId: string): Prisma.InputJsonValue {
  return { kind: 'call', salesCallId };
}

/**
 * `LeadActivity.metadata` -> the SalesCall it mirrors, or null.
 *
 * Null for a HAND-LOGGED call (no metadata — the common, permanent case), for a
 * legacy mirrored row (also no metadata), for another writer's shape, and for
 * an id that is not a usable string — a stream item's `callId` is fetched
 * against as soon as it is non-null, so "present but unusable" has to answer
 * the same way "absent" does. See the three classes above: none of them is a
 * backlog.
 */
export function salesCallIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  if (m.kind !== 'call') return null;
  const id = m.salesCallId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
