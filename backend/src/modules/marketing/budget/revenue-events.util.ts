import { Prisma } from '@prisma/client';

export type RevenueSource = 'OPPORTUNITY' | 'INVOICE' | 'OFFER' | 'ESTIMATE';

export interface RevenueEvent {
  leadId: string;
  /** Major units (Decimal) — invoice/estimate minor-unit Ints are converted. */
  value: Prisma.Decimal;
  at: Date;
  source: RevenueSource;
}

/** The minimal prisma surface the collector needs (works with a tx too). */
export interface RevenueEventsDb {
  opportunity: { findMany(args: unknown): Promise<unknown[]> };
  invoice: { findMany(args: unknown): Promise<unknown[]> };
  leadOffer: { findMany(args: unknown): Promise<unknown[]> };
  estimate: { findMany(args: unknown): Promise<unknown[]> };
}

/**
 * Unified sale signal (Growth Autopilot spec D9). Collects every money event
 * in the window from the four revenue records, then applies PER-LEAD
 * PRECEDENCE — WON Opportunity > PAID Invoice > ACCEPTED LeadOffer > ACCEPTED
 * Estimate — so one deal that was recorded as offer → invoice → opportunity
 * along the way is only counted once (at the strongest tier). Same-tier
 * multiples for one lead are all kept (two paid invoices = two sales).
 * Workspace-scoped; defensive against missing leadId/timestamp.
 */
export async function collectRevenueEvents(
  db: RevenueEventsDb,
  workspaceId: string,
  since: Date,
): Promise<RevenueEvent[]> {
  const [opps, invoices, offers, estimates] = await Promise.all([
    db.opportunity.findMany({
      where: { workspaceId, status: 'WON', wonAt: { gte: since }, leadId: { not: null } },
      select: { leadId: true, value: true, wonAt: true },
    }) as Promise<Array<{ leadId: string | null; value: unknown; wonAt: Date | null }>>,
    db.invoice.findMany({
      where: { workspaceId, status: 'PAID', paidAt: { gte: since }, leadId: { not: null } },
      select: { leadId: true, total: true, paidAt: true },
    }) as Promise<Array<{ leadId: string | null; total: number | null; paidAt: Date | null }>>,
    db.leadOffer.findMany({
      where: { workspaceId, status: 'ACCEPTED', respondedAt: { gte: since } },
      select: { leadId: true, customPrice: true, planMonthlyPrice: true, respondedAt: true },
    }) as Promise<Array<{ leadId: string | null; customPrice: unknown; planMonthlyPrice: unknown; respondedAt: Date | null }>>,
    db.estimate.findMany({
      where: { workspaceId, status: 'ACCEPTED', acceptedAt: { gte: since }, leadId: { not: null } },
      select: { leadId: true, total: true, acceptedAt: true },
    }) as Promise<Array<{ leadId: string | null; total: number | null; acceptedAt: Date | null }>>,
  ]);

  const tiers: Array<{ source: RevenueSource; events: RevenueEvent[] }> = [
    {
      source: 'OPPORTUNITY',
      events: mapEvents(opps, 'OPPORTUNITY', (o) => o.wonAt, (o) => toDecimal(o.value)),
    },
    {
      source: 'INVOICE',
      events: mapEvents(invoices, 'INVOICE', (i) => i.paidAt, (i) => minorToMajor(i.total)),
    },
    {
      source: 'OFFER',
      events: mapEvents(
        offers,
        'OFFER',
        (o) => o.respondedAt,
        // Repo convention: an accepted offer is worth its custom price when one
        // was negotiated, else the snapshotted plan monthly price.
        (o) => toDecimal(o.customPrice ?? o.planMonthlyPrice),
      ),
    },
    {
      source: 'ESTIMATE',
      events: mapEvents(estimates, 'ESTIMATE', (e) => e.acceptedAt, (e) => minorToMajor(e.total)),
    },
  ];

  // Per-lead precedence: a lead claimed by a stronger tier suppresses its
  // weaker-tier events entirely.
  const claimed = new Set<string>();
  const out: RevenueEvent[] = [];
  for (const tier of tiers) {
    const tierLeads = new Set<string>();
    for (const ev of tier.events) {
      if (claimed.has(ev.leadId)) continue;
      out.push(ev);
      tierLeads.add(ev.leadId);
    }
    for (const leadId of tierLeads) claimed.add(leadId);
  }
  return out;
}

function mapEvents<T extends { leadId: string | null }>(
  rows: T[],
  source: RevenueSource,
  at: (row: T) => Date | null | undefined,
  value: (row: T) => Prisma.Decimal | null,
): RevenueEvent[] {
  const out: RevenueEvent[] = [];
  for (const row of rows) {
    const ts = at(row);
    const val = value(row);
    if (!row.leadId || !ts || val == null) continue;
    out.push({ leadId: row.leadId, value: val, at: ts, source });
  }
  return out;
}

function toDecimal(v: unknown): Prisma.Decimal | null {
  if (v == null) return null;
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v as number | string);
}

/** Invoice/Estimate totals are Int minor units (kuruş/cents) — convert. */
function minorToMajor(v: number | null | undefined): Prisma.Decimal | null {
  if (v == null) return null;
  return new Prisma.Decimal(v).div(100);
}
