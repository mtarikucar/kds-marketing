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

// The calendar grid sends bare YYYY-MM-DD bounds (dateTo = last day of the visible
// month). A plain `lte: new Date(dateTo)` is UTC midnight, so EVERY task due later on
// that last day silently drops off the calendar. findAll already fixes this via
// rangeEndInclusive; findCalendar must too.
describe('MarketingTasksService.findCalendar — dueDate end-of-day inclusive', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingTasksService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingTasksService(prisma as any, {} as any, {} as any);
    prisma.marketingTask.findMany.mockResolvedValue([] as any);
  });

  it('makes the calendar dateTo bound end-of-day inclusive (last day not dropped)', async () => {
    await svc.findCalendar(WS, '2026-07-01', '2026-07-31', 'u1', 'OWNER');
    const where = (prisma.marketingTask.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.dueDate.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(where.dueDate.lte.toISOString()).toBe('2026-07-31T23:59:59.999Z');
  });
});

// findToday built its "today" window from server-LOCAL midnight (setHours), but the
// API runs UTC — so a Turkey (UTC+3) rep's Tasks→Today missed/mis-showed tasks due
// in the first offset-hours of the local day. It must bound the day in the
// WORKSPACE's timezone (mirrors the dashboard fix). Asserted with Asia/Tokyo (UTC+9,
// no DST) so the expectation is wrong for BOTH a UTC and a Turkey test runner.
describe('MarketingTasksService.findToday — workspace-timezone day window', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingTasksService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingTasksService(prisma as any, {} as any, {} as any);
    prisma.marketingTask.findMany.mockResolvedValue([] as any);
  });
  afterEach(() => jest.useRealTimers());

  it('bounds "today" in the workspace timezone, not server-local', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T20:00:00.000Z')); // Tokyo: Jul 2 05:00
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ timezone: 'Asia/Tokyo' });

    await svc.findToday(WS, 'u1', 'MANAGER');

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS }, select: { timezone: true } }),
    );
    // Tokyo day Jul 2 = [2026-07-01T15:00Z, 2026-07-02T15:00Z).
    const where = (prisma.marketingTask.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.dueDate.gte.toISOString()).toBe('2026-07-01T15:00:00.000Z');
    expect(where.dueDate.lt.toISOString()).toBe('2026-07-02T15:00:00.000Z');
  });
});
