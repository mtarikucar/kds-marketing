import { MarketingOffersService } from './marketing-offers.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

/**
 * findAll must honour the list filters the Offers page sends — a status
 * <Select> and a from/to date range. These were previously dropped on the
 * floor (the controller only read page/limit), so picking "SENT" or a date
 * range silently returned every offer in the workspace.
 */
describe('MarketingOffersService.findAll — filtering', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingOffersService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingOffersService(prisma as any, { describePlan: jest.fn() } as any);
    (prisma.leadOffer.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.leadOffer.count as jest.Mock).mockResolvedValue(0);
  });

  const whereOf = () =>
    (prisma.leadOffer.findMany as jest.Mock).mock.calls[0][0].where;

  it('applies the status filter to the where clause', async () => {
    await svc.findAll('ws-1', 'mgr-1', 'MANAGER', 1, 20, { status: 'SENT' });
    expect(whereOf()).toMatchObject({ workspaceId: 'ws-1', status: 'SENT' });
    // count() must share the SAME filtered where so totals/pagination match.
    expect((prisma.leadOffer.count as jest.Mock).mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      status: 'SENT',
    });
  });

  it('applies dateFrom/dateTo as an inclusive createdAt range', async () => {
    await svc.findAll('ws-1', 'mgr-1', 'MANAGER', 1, 20, {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-25',
    });
    const where = whereOf();
    expect(where.createdAt.gte).toEqual(new Date('2026-06-01'));
    // End date is bumped to end-of-day so the final day's offers aren't dropped.
    expect(where.createdAt.lte).toEqual(new Date('2026-06-25T23:59:59.999Z'));
  });

  it('still scopes a REP to their own offers alongside the filters', async () => {
    await svc.findAll('ws-1', 'rep-1', 'REP', 1, 20, { status: 'DRAFT' });
    expect(whereOf()).toMatchObject({
      workspaceId: 'ws-1',
      createdById: 'rep-1',
      status: 'DRAFT',
    });
  });

  it('omits the filters entirely when none are given (no empty createdAt clause)', async () => {
    await svc.findAll('ws-1', 'mgr-1', 'MANAGER');
    const where = whereOf();
    expect(where).toEqual({ workspaceId: 'ws-1' });
    expect(where).not.toHaveProperty('createdAt');
    expect(where).not.toHaveProperty('status');
  });
});
