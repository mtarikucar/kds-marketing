import { Prisma } from '@prisma/client';
import { collectRevenueEvents } from './revenue-events.util';

const D = (n: string | number) => new Prisma.Decimal(n);

/**
 * D9 unified sale signal: per lead in the window, revenue = WON opportunities
 * if any; else PAID invoices; else ACCEPTED offers; else ACCEPTED estimates.
 * The per-lead precedence prevents double-counting ONE deal that was recorded
 * as offer + invoice + opportunity along the way.
 */
function makeDb(opts: {
  opps?: any[];
  invoices?: any[];
  offers?: any[];
  estimates?: any[];
}) {
  return {
    opportunity: { findMany: jest.fn().mockResolvedValue(opts.opps ?? []) },
    invoice: { findMany: jest.fn().mockResolvedValue(opts.invoices ?? []) },
    leadOffer: { findMany: jest.fn().mockResolvedValue(opts.offers ?? []) },
    estimate: { findMany: jest.fn().mockResolvedValue(opts.estimates ?? []) },
  };
}

const SINCE = new Date('2026-06-01T00:00:00.000Z');
const AT = new Date('2026-06-10T12:00:00.000Z');

describe('collectRevenueEvents', () => {
  it('scopes every query to the workspace with status + window filters', async () => {
    const db = makeDb({});
    await collectRevenueEvents(db, 'ws1', SINCE);

    expect(db.opportunity.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws1',
      status: 'WON',
      wonAt: { gte: SINCE },
      leadId: { not: null },
    });
    expect(db.invoice.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws1',
      status: 'PAID',
      paidAt: { gte: SINCE },
      leadId: { not: null },
    });
    expect(db.leadOffer.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws1',
      status: 'ACCEPTED',
      respondedAt: { gte: SINCE },
    });
    expect(db.estimate.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws1',
      status: 'ACCEPTED',
      acceptedAt: { gte: SINCE },
      leadId: { not: null },
    });
  });

  it('maps a WON opportunity to an OPPORTUNITY event with a Decimal value', async () => {
    const db = makeDb({ opps: [{ leadId: 'L1', value: D(1000), wonAt: AT }] });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ leadId: 'L1', at: AT, source: 'OPPORTUNITY' });
    expect(events[0].value).toBeInstanceOf(Prisma.Decimal);
    expect(events[0].value.toString()).toBe('1000');
  });

  it('converts invoice/estimate minor-unit totals to major-unit Decimals', async () => {
    const db = makeDb({
      invoices: [{ leadId: 'L1', total: 12345, paidAt: AT }], // 123.45 in minor units
      estimates: [{ leadId: 'L2', total: 40000, acceptedAt: AT }],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    const inv = events.find((e) => e.source === 'INVOICE')!;
    const est = events.find((e) => e.source === 'ESTIMATE')!;
    expect(inv.value.toString()).toBe('123.45');
    expect(est.value.toString()).toBe('400');
  });

  it('values an accepted offer as customPrice ?? planMonthlyPrice (repo convention)', async () => {
    const db = makeDb({
      offers: [
        { leadId: 'L1', customPrice: D(1000), planMonthlyPrice: D(800), respondedAt: AT },
        { leadId: 'L2', customPrice: null, planMonthlyPrice: D(500), respondedAt: AT },
      ],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events.find((e) => e.leadId === 'L1')!.value.toString()).toBe('1000');
    expect(events.find((e) => e.leadId === 'L2')!.value.toString()).toBe('500');
    expect(events.every((e) => e.source === 'OFFER')).toBe(true);
  });

  it('PER-LEAD PRECEDENCE: a WON opportunity suppresses the same lead’s invoice/offer/estimate', async () => {
    const db = makeDb({
      opps: [{ leadId: 'L1', value: D(1000), wonAt: AT }],
      invoices: [{ leadId: 'L1', total: 99900, paidAt: AT }],
      offers: [{ leadId: 'L1', customPrice: D(999), planMonthlyPrice: null, respondedAt: AT }],
      estimates: [{ leadId: 'L1', total: 99900, acceptedAt: AT }],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ leadId: 'L1', source: 'OPPORTUNITY' });
  });

  it('a PAID invoice suppresses the same lead’s offer + estimate (but not other leads)', async () => {
    const db = makeDb({
      invoices: [{ leadId: 'L1', total: 20000, paidAt: AT }],
      offers: [
        { leadId: 'L1', customPrice: D(999), planMonthlyPrice: null, respondedAt: AT },
        { leadId: 'L2', customPrice: D(300), planMonthlyPrice: null, respondedAt: AT },
      ],
      estimates: [{ leadId: 'L1', total: 5000, acceptedAt: AT }],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.leadId === 'L1')).toMatchObject({ source: 'INVOICE' });
    expect(events.find((e) => e.leadId === 'L2')).toMatchObject({ source: 'OFFER' });
  });

  it('an accepted offer suppresses the same lead’s estimate', async () => {
    const db = makeDb({
      offers: [{ leadId: 'L1', customPrice: D(700), planMonthlyPrice: null, respondedAt: AT }],
      estimates: [{ leadId: 'L1', total: 70000, acceptedAt: AT }],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('OFFER');
  });

  it('keeps MULTIPLE same-tier events of one lead (two paid invoices = two sales)', async () => {
    const db = makeDb({
      invoices: [
        { leadId: 'L1', total: 10000, paidAt: AT },
        { leadId: 'L1', total: 20000, paidAt: new Date('2026-06-11T09:00:00.000Z') },
      ],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.value.toString()).sort()).toEqual(['100', '200']);
  });

  it('skips records without a leadId or timestamp (defensive, beyond the query filters)', async () => {
    const db = makeDb({
      opps: [
        { leadId: null, value: D(10), wonAt: AT },
        { leadId: 'L1', value: D(10), wonAt: null },
      ],
      invoices: [{ leadId: null, total: 100, paidAt: AT }],
      offers: [{ leadId: 'L2', customPrice: D(5), planMonthlyPrice: null, respondedAt: null }],
      estimates: [{ leadId: 'L3', total: 100, acceptedAt: null }],
    });
    const events = await collectRevenueEvents(db, 'ws1', SINCE);
    expect(events).toHaveLength(0);
  });
});
