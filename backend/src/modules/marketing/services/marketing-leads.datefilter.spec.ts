import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * The leads list date filter receives a bare YYYY-MM-DD from the picker. A plain
 * `lte: new Date(dateTo)` is UTC midnight, which silently excludes every lead
 * created DURING the selected end day — the same off-by-one the reports/analytics
 * services already fix with rangeEndInclusive().
 */
describe('MarketingLeadsService.findAll — date range', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    prisma.lead.findMany.mockResolvedValue([] as any);
    prisma.lead.count.mockResolvedValue(0 as any);
  });

  it('makes the dateTo filter end-of-day inclusive (whole final day)', async () => {
    await svc.findAll(WS, { dateFrom: '2026-06-01', dateTo: '2026-06-27' } as any, 'u1', 'OWNER');
    const where = (prisma.lead.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-06-27T23:59:59.999Z');
  });
});
