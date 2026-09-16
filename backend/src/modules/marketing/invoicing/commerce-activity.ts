import { Prisma } from '@prisma/client';

/**
 * The person-stream trace of a commerce moment.
 *
 * `lead-stream.service.ts` builds the person's akış from exactly two sources —
 * messages and `LeadActivity` — and until this file existed the whole selling
 * half of the relationship wrote neither. A quote could be emailed, accepted by
 * the customer, converted, invoiced and PAID without one line of it appearing
 * on the person, so someone who had just paid looked identical to someone who
 * never replied. `opportunity-activity.ts` solved exactly this for deal moves;
 * this is the same shape for the four moments that carry money.
 *
 * Three decisions live here rather than at the call sites, so four writers
 * cannot drift into four vocabularies:
 *
 * 1. **`type: 'COMMERCE'`, a new activity type.** `opportunity-activity.ts`
 *    reused `STATUS_CHANGE` because a deal moving IS a status change; a paid
 *    invoice is not, and saying so would be a small lie on the one surface a
 *    human reads. `kindOfActivity()` maps an unknown type to `'activity'` and
 *    keeps its name in `activityType` — the reader was written for exactly
 *    this, so the new type needs no frontend change to render honestly. It is
 *    deliberately NOT added to `ActivityType` in create-activity.dto.ts, so
 *    `@IsEnum` still refuses to let a human hand-write one of these rows.
 *
 * 2. **Minor units are converted HERE, once.** `Invoice.total` and
 *    `Estimate.total` are Int MINOR units; every other number in the product
 *    (deal value, plan price) is major. Four call sites each dividing by 100
 *    is four chances to render a ₺50 invoice as "5000 TRY". A total of zero
 *    says nothing rather than saying "0 TRY".
 *
 * 3. **`metadata.kind = 'commerce'`** — deliberately not `'assignment'` (the
 *    only value `assignmentOf()` reacts to) and not `'call'` (the only value
 *    `salesCallIdOf()` reacts to). Without that separation a paid invoice
 *    would render wearing an assignment badge, or offering a recording that
 *    does not exist. The spec asserts both readers answer null.
 */
export type CommerceEvent = 'quote_sent' | 'quote_answered' | 'invoice_sent' | 'invoice_paid';

export interface CommerceActivityInput {
  event: CommerceEvent;
  /** Invoice or Estimate row id. */
  docId: string;
  /** The human-facing number: `INV-1042`, `EST-7`. */
  number: string;
  /** Integer MINOR units, exactly as the column stores it. */
  totalMinor?: number | null;
  currency?: string | null;
  /** `quote_sent` / `invoice_sent`: the address it was delivered to. */
  to?: string | null;
  /** `quote_sent` / `invoice_sent`: which transport carried it. */
  via?: 'mailbox' | 'platform' | null;
  /** `quote_answered`: what the customer said on the public page. */
  answer?: 'ACCEPTED' | 'DECLINED' | null;
  /** `invoice_paid`: MANUAL | STRIPE | PAYTR | IYZICO | WALLET. */
  paidVia?: string | null;
}

/** `50 TRY` from 5000 minor units, or null when there is no sum worth saying. */
function money(totalMinor: number | null | undefined, currency: string | null | undefined): string | null {
  if (totalMinor === null || totalMinor === undefined) return null;
  const n = Number(totalMinor);
  if (!Number.isFinite(n) || n === 0) return null;
  return `${Math.round(n) / 100} ${currency || 'TRY'}`;
}

/** The `LeadActivity` row a commerce moment leaves on the person. */
export function commerceActivity(input: CommerceActivityInput): {
  type: string;
  title: string;
  description: string | null;
  metadata: Prisma.InputJsonValue;
} {
  const {
    event,
    number,
    totalMinor = null,
    currency = null,
    to = null,
    via = null,
    answer = null,
    paidVia = null,
  } = input;
  const amount = money(totalMinor, currency);

  let title: string;
  const parts: Array<string | null> = [];
  if (event === 'quote_sent') {
    title = `Quote ${number} emailed`;
    parts.push(to, amount);
  } else if (event === 'quote_answered') {
    title = `Quote ${number} ${answer === 'DECLINED' ? 'declined' : 'accepted'} by the customer`;
    parts.push(amount);
  } else if (event === 'invoice_sent') {
    title = `Invoice ${number} emailed`;
    parts.push(to, amount);
  } else {
    title = `Invoice ${number} paid`;
    parts.push(amount, paidVia);
  }

  return {
    type: 'COMMERCE',
    title,
    description: parts.filter((p): p is string => !!p).join(' · ') || null,
    metadata: {
      kind: 'commerce',
      event,
      docId: input.docId,
      number,
      totalMinor: totalMinor === null || totalMinor === undefined ? null : Number(totalMinor),
      currency: currency ?? null,
      via: via ?? null,
      answer: answer ?? null,
      paidVia: paidVia ?? null,
    },
  };
}
