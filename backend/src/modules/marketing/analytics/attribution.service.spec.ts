import { AttributionService } from './attribution.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new AttributionService(prisma as any) };
}

/**
 * Seeded scenario (one workspace, two converted leads):
 *
 *   Lead A — value 1000 TRY (accepted offer customPrice = 1000)
 *     touches in order: WEBSITE (source/first) → PHONE (call) → EMAIL (email)
 *
 *   Lead B — value 500 TRY (accepted offer planMonthlyPrice = 500, no customPrice)
 *     touches in order: INSTAGRAM (source/first) → EMAIL (email)
 *
 * Expected per-model channel revenue:
 *   first-touch:  WEBSITE 1000, INSTAGRAM 500
 *   last-touch:   EMAIL 1000 (A) + EMAIL 500 (B) = EMAIL 1500
 *   linear:       A splits 1000 over 3 touches (333.33 each): WEBSITE 333.33, PHONE 333.33, EMAIL 333.33
 *                 B splits 500 over 2 touches (250 each):     INSTAGRAM 250, EMAIL 250
 *                 => WEBSITE 333.33, PHONE 333.33, INSTAGRAM 250, EMAIL 583.33
 */
function seed(prisma: ReturnType<typeof makeSvc>['prisma']) {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-02T00:00:00Z');
  const t2 = new Date('2026-01-03T00:00:00Z');
  const conv = new Date('2026-01-04T00:00:00Z');

  (prisma.lead.findMany as jest.Mock).mockResolvedValue([
    {
      id: 'A',
      workspaceId: WS,
      source: 'WEBSITE',
      status: 'WON',
      createdAt: t0,
      convertedAt: conv,
      offers: [{ status: 'ACCEPTED', customPrice: 1000, planMonthlyPrice: 800 }],
      activities: [
        { type: 'CALL', createdAt: t1 },
        { type: 'EMAIL', createdAt: t2 },
      ],
    },
    {
      id: 'B',
      workspaceId: WS,
      source: 'INSTAGRAM',
      status: 'WON',
      createdAt: t0,
      convertedAt: conv,
      offers: [{ status: 'ACCEPTED', customPrice: null, planMonthlyPrice: 500 }],
      activities: [{ type: 'EMAIL', createdAt: t1 }],
    },
  ]);
}

/**
 * Channel→revenue map of CREDITED channels only. The service deliberately also
 * emits zero-revenue rows for channels that were merely touched (so the UI can
 * show reach + conversionRate), so we filter to revenue>0 when asserting how a
 * model distributes credit.
 */
function byChannel(rows: { channel: string; revenue: number }[]) {
  return Object.fromEntries(
    rows.filter((r) => r.revenue > 0).map((r) => [r.channel, r.revenue]),
  );
}

describe('AttributionService', () => {
  it('pins workspaceId on the lead query', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([]);
    await svc.attribution(WS, { model: 'first' });
    const arg = (prisma.lead.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId).toBe(WS);
  });

  it('makes the `to` end date inclusive (whole final day, not midnight)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([]);
    await svc.attribution(WS, { model: 'first', from: '2026-06-01', to: '2026-06-27' });
    const where = (prisma.lead.findMany as jest.Mock).mock.calls[0][0].where;
    // A bare YYYY-MM-DD end date must cover the ENTIRE day — a plain lte of
    // new Date('2026-06-27') is midnight, silently dropping every lead created
    // during the selected end day (the same fix analytics/reports already have).
    expect(where.createdAt.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-06-27T23:59:59.999Z');
  });

  it('first-touch credits each lead\'s first touch (lead.source)', async () => {
    const { prisma, svc } = makeSvc();
    seed(prisma);
    const out = await svc.attribution(WS, { model: 'first' });
    const rev = byChannel(out.channels);
    expect(rev).toEqual({ WEBSITE: 1000, INSTAGRAM: 500 });
    expect(out.totalRevenue).toBe(1500);
    expect(out.conversions).toBe(2);
  });

  it('last-touch credits the last touch before conversion', async () => {
    const { prisma, svc } = makeSvc();
    seed(prisma);
    const out = await svc.attribution(WS, { model: 'last' });
    const rev = byChannel(out.channels);
    // Both leads end on EMAIL -> all revenue lands on EMAIL.
    expect(rev).toEqual({ EMAIL: 1500 });
    expect(out.totalRevenue).toBe(1500);
  });

  it('linear splits conversion value evenly across touches', async () => {
    const { prisma, svc } = makeSvc();
    seed(prisma);
    const out = await svc.attribution(WS, { model: 'linear' });
    const rev = byChannel(out.channels);
    // A: 1000/3 = 333.33 each (rounded to 2dp); B: 500/2 = 250 each.
    expect(rev.WEBSITE).toBeCloseTo(333.33, 2);
    expect(rev.PHONE).toBeCloseTo(333.33, 2);
    expect(rev.INSTAGRAM).toBeCloseTo(250, 2);
    // EMAIL = 333.33 (A) + 250 (B)
    expect(rev.EMAIL).toBeCloseTo(583.33, 2);
    // total revenue is preserved (sum of conversion values), modulo rounding.
    expect(out.totalRevenue).toBeCloseTo(1500, 1);
  });

  it('first vs last vs linear give DIFFERENT splits on the same data', async () => {
    const { prisma, svc } = makeSvc();
    seed(prisma);
    const first = byChannel((await svc.attribution(WS, { model: 'first' })).channels);
    seed(prisma);
    const last = byChannel((await svc.attribution(WS, { model: 'last' })).channels);
    seed(prisma);
    const linear = byChannel((await svc.attribution(WS, { model: 'linear' })).channels);
    expect(first).not.toEqual(last);
    expect(first).not.toEqual(linear);
    expect(last).not.toEqual(linear);
  });

  it('excludes a second workspace\'s data (isolation)', async () => {
    const { prisma, svc } = makeSvc();
    // The mock would only ever return rows the query asked for; we assert the
    // query is scoped AND that revenue reflects only the rows returned for WS.
    (prisma.lead.findMany as jest.Mock).mockImplementation((args: any) => {
      if (args.where.workspaceId !== WS) return Promise.resolve([]);
      return Promise.resolve([
        {
          id: 'A',
          workspaceId: WS,
          source: 'WEBSITE',
          status: 'WON',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          convertedAt: new Date('2026-01-02T00:00:00Z'),
          offers: [{ status: 'ACCEPTED', customPrice: 1000, planMonthlyPrice: null }],
          activities: [],
        },
      ]);
    });
    const mine = await svc.attribution(WS, { model: 'first' });
    expect(mine.totalRevenue).toBe(1000);
    const other = await svc.attribution('ws-2', { model: 'first' });
    expect(other.totalRevenue).toBe(0);
    expect(other.channels).toEqual([]);
  });

  it('counts only ACCEPTED offers toward conversion value', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'A',
        workspaceId: WS,
        source: 'WEBSITE',
        status: 'WON',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        convertedAt: new Date('2026-01-02T00:00:00Z'),
        offers: [
          { status: 'ACCEPTED', customPrice: 1000, planMonthlyPrice: null },
          { status: 'REJECTED', customPrice: 9999, planMonthlyPrice: null },
          { status: 'DRAFT', customPrice: 9999, planMonthlyPrice: null },
        ],
        activities: [],
      },
    ]);
    const out = await svc.attribution(WS, { model: 'first' });
    expect(out.totalRevenue).toBe(1000);
  });

  it('reports per-channel conversionRate from touched vs converted leads', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'A',
        workspaceId: WS,
        source: 'WEBSITE',
        status: 'WON',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        convertedAt: new Date('2026-01-02T00:00:00Z'),
        offers: [{ status: 'ACCEPTED', customPrice: 1000, planMonthlyPrice: null }],
        activities: [],
      },
      {
        id: 'B',
        workspaceId: WS,
        source: 'WEBSITE',
        status: 'CONTACTED',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        convertedAt: null,
        offers: [],
        activities: [],
      },
    ]);
    const out = await svc.attribution(WS, { model: 'first' });
    const website = out.channels.find((c) => c.channel === 'WEBSITE')!;
    // 2 leads touched WEBSITE, 1 converted -> 50%.
    expect(website.leads).toBe(2);
    expect(website.conversions).toBe(1);
    expect(website.conversionRate).toBe(50);
  });
});
