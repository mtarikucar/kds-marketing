import { MarketingTasksService } from './marketing-tasks.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * The tasks list dueDate filter receives a bare YYYY-MM-DD. A plain
 * `lte: new Date(dateTo)` is UTC midnight, excluding tasks due later on the
 * selected end day. Mirror the reports/analytics rangeEndInclusive() fix.
 */
describe('MarketingTasksService.findAll — dueDate range', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingTasksService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingTasksService(prisma as any, {} as any, {} as any);
    prisma.marketingTask.findMany.mockResolvedValue([] as any);
    prisma.marketingTask.count.mockResolvedValue(0 as any);
  });

  it('makes the dateTo dueDate filter end-of-day inclusive', async () => {
    await svc.findAll(WS, { dateFrom: '2026-06-01', dateTo: '2026-06-27' } as any, 'u1', 'OWNER');
    const where = (prisma.marketingTask.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.dueDate.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(where.dueDate.lte.toISOString()).toBe('2026-06-27T23:59:59.999Z');
  });
});
