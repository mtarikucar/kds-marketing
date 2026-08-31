import { Prisma } from '@prisma/client';

/**
 * The person-stream trace of a sales move.
 *
 * A deal moving is a thing that HAPPENED TO A PERSON, and until this file
 * existed it happened nowhere a reader could see: `opportunities.service.ts`
 * wrote no `LeadActivity` at all, so a deal could be opened, dragged across
 * four stages and won without one line of it in the person's history. v2.284.0
 * merged messages and activities onto one axis and left the sales half of the
 * relationship outside it.
 *
 * Three decisions live here rather than at the four call sites, so the four
 * cannot drift into four different vocabularies:
 *
 * 1. **Every deal move is a `STATUS_CHANGE`**, which `lead-stream.service.ts`
 *    already maps to `kind: 'status'`. No new activity type, no new stream
 *    discriminator — the design asked for the sales move to appear in the
 *    stream that exists, not for a fifth kind beside it.
 *
 * 2. **The stage NAME is the title.** Ids are unreadable and the person's
 *    history is read by humans, so `Deal stage: Yeni → Teklif gönderildi`
 *    follows the idiom `marketing-leads.service.ts` already writes
 *    (`Reassigned: Ahmet → Mehmet`, `Reopened: LOST → NEW`).
 *
 * 3. **A won or lost drop reads as won/lost, not as a stage move.** Landing a
 *    card on the win column IS the win; writing both lines would put two rows
 *    in the stream for one gesture. The stage pair it came from is kept in the
 *    description so nothing is lost.
 *
 * `metadata` carries `kind: 'opportunity'` — deliberately NOT `'assignment'`,
 * the only value `assignmentOf()` in lead-stream.service.ts reacts to. Without
 * that separation every deal move would render in the timeline wearing an
 * assignment badge.
 */
export type DealEvent = 'opened' | 'stage_changed' | 'won' | 'lost';

export interface DealActivityInput {
  event: DealEvent;
  opportunityId: string;
  /** The deal's own name, as the rep typed it. */
  dealName: string;
  /** Null when the deal is being opened, or when the old stage no longer exists. */
  fromStageName?: string | null;
  fromStageId?: string | null;
  /** Null only when a pipeline has no terminal stage and win()/lose() did not move the card. */
  toStageName?: string | null;
  toStageId?: string | null;
  value?: number | null;
  currency?: string | null;
  /** `LoseOpportunityDto.reason`, when one was given. */
  reason?: string | null;
}

/** `45000 TRY`, or null when the deal carries no value worth saying out loud. */
function money(value: number | null | undefined, currency: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return `${Math.round(n * 100) / 100} ${currency || 'TRY'}`;
}

/** `A → B`, or just `B`, or just `A` — whichever of the two stages is known. */
function stagePair(from: string | null | undefined, to: string | null | undefined): string | null {
  if (from && to) return `${from} → ${to}`;
  return to || from || null;
}

/**
 * The `LeadActivity` row a sales move leaves on the person, or null when the
 * move says nothing worth a line (a card reordered inside its own stage).
 */
export function dealActivity(input: DealActivityInput): {
  type: string;
  title: string;
  description: string | null;
  metadata: Prisma.InputJsonValue;
} {
  const {
    event,
    dealName,
    fromStageName = null,
    toStageName = null,
    value = null,
    currency = null,
    reason = null,
  } = input;
  const amount = money(value, currency);
  const pair = stagePair(fromStageName, toStageName);

  let title: string;
  const parts: Array<string | null> = [];
  if (event === 'stage_changed') {
    // The one case where the stages ARE the headline; the deal name moves into
    // the description because a person may have several deals at once.
    title = `Deal stage: ${pair ?? 'unknown'}`;
    parts.push(dealName, amount);
  } else if (event === 'opened') {
    title = `Deal opened: ${dealName}`;
    parts.push(toStageName ? `Stage: ${toStageName}` : null, amount);
  } else if (event === 'won') {
    title = `Deal won: ${dealName}`;
    parts.push(pair ? `Stage: ${pair}` : null, amount);
  } else {
    title = `Deal lost: ${dealName}`;
    parts.push(pair ? `Stage: ${pair}` : null, reason ? `Reason: ${reason}` : null);
  }

  return {
    type: 'STATUS_CHANGE',
    title,
    description: parts.filter((p): p is string => !!p).join(' · ') || null,
    metadata: {
      kind: 'opportunity',
      event,
      opportunityId: input.opportunityId,
      fromStageId: input.fromStageId ?? null,
      toStageId: input.toStageId ?? null,
      value: value === null || value === undefined ? null : Number(value),
      currency: currency ?? null,
    },
  };
}

/**
 * The name a card shows for a person.
 *
 * `contactPerson || businessName` — the SAME rule `PeopleList.tsx:233` and
 * `PersonPane.tsx:234` already apply, computed once on the server so the board
 * card and the person list cannot name the same human two different ways.
 */
export function personDisplayName(lead: {
  businessName?: string | null;
  contactPerson?: string | null;
}): string {
  return (lead.contactPerson || lead.businessName || '').trim();
}
