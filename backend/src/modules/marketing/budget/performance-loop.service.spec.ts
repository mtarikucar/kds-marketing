import { Prisma } from '@prisma/client';
import { PerformanceLoopService } from './performance-loop.service';

const D = (n: number) => new Prisma.Decimal(n);

function makePrisma(opts: {
  wonOpps?: any[];
  invoices?: any[];
  offers?: any[];
  estimates?: any[];
  attributions?: any[];
  anchor?: any;
  existing?: any;
}) {
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = {
    opportunity: { findMany: jest.fn().mockResolvedValue(opts.wonOpps ?? []) },
    invoice: { findMany: jest.fn().mockResolvedValue(opts.invoices ?? []) },
    leadOffer: { findMany: jest.fn().mockResolvedValue(opts.offers ?? []) },
    estimate: { findMany: jest.fn().mockResolvedValue(opts.estimates ?? []) },
    leadAttribution: { findMany: jest.fn().mockResolvedValue(opts.attributions ?? []) },
    adMetric: {
      findFirst: jest.fn().mockResolvedValue(opts.anchor ?? null),
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      upsert,
    },
  } as any;
  return { prisma, upsert };
}

describe('PerformanceLoopService', () => {
  it('is a no-op with no won opportunities', async () => {
    const { prisma, upsert } = makePrisma({ wonOpps: [] });
    const svc = new PerformanceLoopService(prisma);
    const r = await svc.reconcile('ws1');
    expect(r.attributed).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('attributes won revenue to the sourcing campaign and computes ROAS from spend', async () => {
    const { prisma, upsert } = makePrisma({
      wonOpps: [
        { leadId: 'L1', value: D(1000), wonAt: new Date('2026-07-03T10:00:00Z') },
        { leadId: 'L2', value: D(500), wonAt: new Date('2026-07-03T20:00:00Z') }, // same campaign+day
      ],
      attributions: [
        { leadId: 'L1', sourceAdCampaignId: 'camp-9' },
        { leadId: 'L2', sourceAdCampaignId: 'camp-9' },
      ],
      anchor: { adAccountId: 'acc-1' },
      existing: { spend: D(300) },
    });
    const svc = new PerformanceLoopService(prisma);
    const r = await svc.reconcile('ws1');
    expect(r.attributed).toBe(2);
    expect(r.campaignDaysUpdated).toBe(1);
    expect(r.revenueAttributed).toBe(1500);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      adAccountId_date_campaignId: { adAccountId: 'acc-1', date: new Date('2026-07-03T00:00:00.000Z'), campaignId: 'camp-9' },
    });
    expect(arg.update.revenue.toString()).toBe('1500');
    expect(arg.update.roas.toString()).toBe('5'); // 1500 / 300
  });

  it('attributes PAID-invoice revenue for a lead with no opportunity (source-agnostic loop, D9)', async () => {
    const { prisma, upsert } = makePrisma({
      invoices: [{ leadId: 'L1', total: 150000, paidAt: new Date('2026-07-03T10:00:00Z') }], // 1500 major
      attributions: [{ leadId: 'L1', sourceAdCampaignId: 'camp-9' }],
      anchor: { adAccountId: 'acc-1' },
      existing: { spend: D(300) },
    });
    const svc = new PerformanceLoopService(prisma);
    const r = await svc.reconcile('ws1');
    expect(r.attributed).toBe(1);
    expect(r.revenueAttributed).toBe(1500);
    const arg = upsert.mock.calls[0][0];
    expect(arg.update.revenue.toString()).toBe('1500');
  });

  it('skips a campaign that has never been pulled (no anchor AdMetric)', async () => {
    const { prisma, upsert } = makePrisma({
      wonOpps: [{ leadId: 'L1', value: D(1000), wonAt: new Date('2026-07-03T10:00:00Z') }],
      attributions: [{ leadId: 'L1', sourceAdCampaignId: 'camp-x' }],
      anchor: null,
    });
    const svc = new PerformanceLoopService(prisma);
    const r = await svc.reconcile('ws1');
    expect(r.attributed).toBe(1);
    expect(r.campaignDaysUpdated).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('ignores won opps whose lead has no ad-campaign attribution', async () => {
    const { prisma, upsert } = makePrisma({
      wonOpps: [{ leadId: 'L1', value: D(1000), wonAt: new Date('2026-07-03T10:00:00Z') }],
      attributions: [], // no attribution row
    });
    const svc = new PerformanceLoopService(prisma);
    const r = await svc.reconcile('ws1');
    expect(r.attributed).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('leaves roas null when there is no spend on the day', async () => {
    const { prisma, upsert } = makePrisma({
      wonOpps: [{ leadId: 'L1', value: D(200), wonAt: new Date('2026-07-03T10:00:00Z') }],
      attributions: [{ leadId: 'L1', sourceAdCampaignId: 'camp-9' }],
      anchor: { adAccountId: 'acc-1' },
      existing: null, // no existing row => spend 0
    });
    const svc = new PerformanceLoopService(prisma);
    await svc.reconcile('ws1');
    expect(upsert.mock.calls[0][0].create.roas).toBeUndefined();
  });
});
