import { Prisma } from '@prisma/client';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { AttributionInput } from '../leads/attribution-capture.util';
import { localMsisdnVariants, normalizeEmail, normalizePhone, toE164 } from '../utils/lead-normalize';
import { AttributionDto, CustomerDto } from './dto/order-event.dto';

export type LeadMatched = 'email' | 'phone' | 'created' | 'none';

export interface LeadMatch {
  leadId: string | null;
  leadMatched: LeadMatched;
  created: boolean;
}

export interface LeadMatcherDeps {
  attribution: Pick<LeadAttributionService, 'capture'>;
  outbox: Pick<OutboxService, 'append'>;
}

/** The payload's attribution, in the shape the web-form path captures (contract §4.6). */
export function toAttributionInput(a: AttributionDto): AttributionInput {
  return {
    url: a.landingUrl ?? undefined,
    referrer: a.referrer ?? undefined,
    fields: {
      utm_source: a.utmSource,
      utm_medium: a.utmMedium,
      utm_campaign: a.utmCampaign,
      utm_content: a.utmContent,
      utm_term: a.utmTerm,
      fbclid: a.fbclid,
      gclid: a.gclid,
      ttclid: a.ttclid,
    },
  };
}

/**
 * Find the person who placed an order, or open a lead for them (contract §4).
 *
 * - No email and no phone → no lead. An anonymous order still counts in the
 *   store totals; it just has nobody to attach to.
 * - The lookup is the standard one (forms.service.ts): normalized email, or any
 *   stored spelling of the phone, skipping merged-away and deleted leads,
 *   oldest first.
 * - A found lead is LINKED, never edited: its source stays whatever first
 *   brought it in, and its status is not touched (an order is not a CRM deal).
 * - Nobody found → a `COMMERCE` lead, with `externalRef` left empty so the same
 *   customer's next order finds it again by contact rather than by order id.
 * - Attribution is offered in every case; `capture` keeps the first touch, so
 *   an existing lead's attribution is never overwritten.
 *
 * Runs inside the caller's transaction: the lead is as durable as the order.
 */
export async function matchOrderLead(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: { customer?: CustomerDto | null; attribution?: AttributionDto | null },
  deps: LeadMatcherDeps,
): Promise<LeadMatch> {
  const customer = input.customer ?? undefined;
  const email = customer?.email?.trim() || null;
  const phone = toE164(customer?.phone ?? null);
  const emailNormalized = normalizeEmail(email);
  const phoneNormalized = normalizePhone(phone);
  if (!emailNormalized && !phoneNormalized) return { leadId: null, leadMatched: 'none', created: false };

  const existing = await tx.lead.findFirst({
    where: {
      workspaceId,
      mergedIntoId: null,
      deletedAt: null,
      OR: [
        ...(emailNormalized ? [{ emailNormalized }] : []),
        ...(phoneNormalized ? [{ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } }] : []),
      ],
    },
    select: { id: true, emailNormalized: true },
    orderBy: { createdAt: 'asc' },
  });

  let match: LeadMatch;
  if (existing) {
    const byEmail = !!emailNormalized && existing.emailNormalized === emailNormalized;
    match = { leadId: existing.id, leadMatched: byEmail ? 'email' : 'phone', created: false };
  } else {
    const name = customer?.name?.trim() || email || phone!;
    const lead = await tx.lead.create({
      data: {
        workspaceId,
        businessName: name,
        contactPerson: name,
        businessType: 'OTHER',
        source: 'COMMERCE',
        status: 'NEW',
        ...(email ? { email, emailNormalized } : {}),
        ...(phone ? { phone, phoneNormalized } : {}),
      },
      select: { id: true },
    });
    await deps.outbox.append(
      {
        type: MarketingEventTypes.LeadCreated,
        idempotencyKey: `lead-created:${lead.id}`,
        payload: { workspaceId, leadId: lead.id, source: 'COMMERCE', occurredAt: new Date().toISOString() },
      },
      tx as never,
    );
    match = { leadId: lead.id, leadMatched: 'created', created: true };
  }

  if (input.attribution) {
    await deps.attribution.capture(workspaceId, match.leadId!, toAttributionInput(input.attribution), {}, tx);
  }
  return match;
}
