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
 * ## There is no backfill
 *
 * Every CALL activity written before this shipped has `metadata: null`, and
 * nothing anywhere pairs those rows to their call: the mirror kept no id, and
 * matching by (lead, timestamp, status) would guess. `salesCallIdOf` answers
 * null for them, and the stream renders them exactly as it does today — a
 * line of history with no player under it, rather than a player pointed at a
 * call that might be someone else's.
 */
export function callActivityMetadata(salesCallId: string): Prisma.InputJsonValue {
  return { kind: 'call', salesCallId };
}

/**
 * `LeadActivity.metadata` -> the SalesCall it mirrors, or null.
 *
 * Null for a legacy row (no metadata), for another writer's shape, and for an
 * id that is not a usable string — a stream item's `callId` is fetched against
 * as soon as it is non-null, so "present but unusable" has to answer the same
 * way "absent" does.
 */
export function salesCallIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  if (m.kind !== 'call') return null;
  const id = m.salesCallId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
