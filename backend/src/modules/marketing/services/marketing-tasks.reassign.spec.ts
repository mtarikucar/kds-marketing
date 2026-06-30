import { MarketingTasksService } from './marketing-tasks.service';

/**
 * update() must notify the NEW assignee on a reassignment — the most common
 * assign path. create() already notifies on first assignment; before this fix
 * a manager moving a task from rep A to rep B left rep B with no signal.
 */
describe('MarketingTasksService.update — reassignment notification', () => {
  const WS = 'ws-1';
  let prisma: any;
  let notifications: { create: jest.Mock };
  let svc: MarketingTasksService;

  const existing = { id: 't1', workspaceId: WS, assignedToId: 'rep-a', title: 'Call back', status: 'PENDING' };

  beforeEach(() => {
    prisma = {
      marketingTask: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue({ id: 't1', title: 'Call back', assignedToId: 'rep-b' }),
      },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'rep-b' }) },
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    svc = new MarketingTasksService(prisma as any, notifications as any, {} as any);
  });

  it('notifies the new assignee when the task is reassigned to someone else', async () => {
    await svc.update(WS, 't1', { assignedToId: 'rep-b' } as any, 'manager-1', 'MANAGER');
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      userId: 'rep-b',
      type: 'TASK_ASSIGNED',
      metadata: { taskId: 't1' },
    });
  });

  it('does NOT notify when the assignee is unchanged', async () => {
    await svc.update(WS, 't1', { assignedToId: 'rep-a' } as any, 'manager-1', 'MANAGER');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does NOT notify when a user reassigns the task to themselves', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'manager-1' });
    prisma.marketingTask.update.mockResolvedValue({ id: 't1', title: 'Call back', assignedToId: 'manager-1' });
    await svc.update(WS, 't1', { assignedToId: 'manager-1' } as any, 'manager-1', 'MANAGER');
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
