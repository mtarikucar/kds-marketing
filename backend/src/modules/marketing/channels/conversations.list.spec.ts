import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * The inbox list's optional filters.
 *
 * The lead detail page renders "this lead's conversations", which needs the
 * inbox list narrowed to one lead. The filter has to be OPTIONAL in the same
 * way `status`/`channelId`/`assignedToId` already are: the unfiltered inbox is
 * the primary caller, and a `leadId` clause that is always present would empty
 * it. So both halves are asserted — present when asked for, ABSENT when not.
 *
 * `workspaceId` is unconditional in every case; the lead filter narrows within
 * a tenant, it never replaces the tenant line.
 */
describe('ConversationsService.list — optional leadId filter', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any);
    // Empty result short-circuits enrich(), which this spec is not about.
    prisma.conversation.findMany.mockResolvedValue([] as any);
  });

  const whereOf = () => (prisma.conversation.findMany.mock.calls[0][0] as any).where;

  it('filters by lead when asked, and does not when not', async () => {
    await svc.list(WS, { leadId: 'lead-1' });
    expect(whereOf()).toMatchObject({ workspaceId: WS, leadId: 'lead-1' });

    prisma.conversation.findMany.mockClear();
    await svc.list(WS, {});
    expect(whereOf()).toEqual({ workspaceId: WS });
    expect(whereOf()).not.toHaveProperty('leadId');
  });

  it('keeps the workspace line and the existing filters alongside leadId', async () => {
    await svc.list(WS, {
      leadId: 'lead-1',
      status: 'OPEN',
      channelId: 'ch-1',
      assignedToId: 'user-1',
    });

    expect(whereOf()).toEqual({
      workspaceId: WS,
      status: 'OPEN',
      channelId: 'ch-1',
      assignedToId: 'user-1',
      leadId: 'lead-1',
    });
  });
});
