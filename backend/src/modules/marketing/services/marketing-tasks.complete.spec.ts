import { MarketingTasksService } from './marketing-tasks.service';

/**
 * complete() must preserve the ORIGINAL completedAt when a task is re-completed.
 * The first completion time is the record of truth for reporting/SLAs; a later
 * duplicate "complete" click (or a retry) must not overwrite it with `now`.
 */
describe('MarketingTasksService.complete — completedAt preservation', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let svc: MarketingTasksService;

  beforeEach(() => {
    outbox = { append: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      marketingTask: {
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 't1', ...data })),
      },
    };
    svc = new MarketingTasksService(prisma as any, { create: jest.fn() } as any, outbox as any);
  });

  it('stamps completedAt + emits the workflow event on the FIRST completion', async () => {
    prisma.marketingTask.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS, status: 'PENDING', assignedToId: 'rep-a', leadId: null });
    const res = await svc.complete(WS, 't1', 'rep-a', 'REP');
    expect(prisma.marketingTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date) }) }),
    );
    expect(res.completedAt).toBeInstanceOf(Date);
    // The task.completed automation trigger fires exactly once, on the transition.
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('does NOT overwrite completedAt (or re-fire the event) on a re-complete', async () => {
    const original = new Date('2026-01-01T09:00:00.000Z');
    prisma.marketingTask.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS, status: 'COMPLETED', completedAt: original, assignedToId: 'rep-a', leadId: null });
    const res = await svc.complete(WS, 't1', 'rep-a', 'REP');
    // No write at all — the already-COMPLETED task is returned untouched.
    expect(prisma.marketingTask.update).not.toHaveBeenCalled();
    expect(res.completedAt).toBe(original);
    // No duplicate automation trigger on the second click.
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
