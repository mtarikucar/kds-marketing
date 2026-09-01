import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Single-conversation assign must resolve the assignee against WorkspaceMembership.
 *
 * Both assign paths used to read `MarketingUser {id, workspaceId}` — a mirror
 * stamped at user creation and never re-derived (the 6th instance of that class
 * this session; see the lead/task assign guards). It fails in both directions:
 * a teammate who joined by membership but was created elsewhere is rejected
 * outright, while someone whose membership was revoked still passes. Neither
 * path checked STATUS at all, so a deactivated member could be handed live
 * customer conversations and the thread would leave the unassigned queue for
 * someone who cannot log in.
 */
describe('ConversationsService.assign — assignee membership guard', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let notifications: { create: jest.Mock };
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    notifications = { create: jest.fn().mockResolvedValue({}) };
    svc = new ConversationsService(
      prisma as any,
      {} as any,
      { push: jest.fn() } as any,
      notifications as any,
    );
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'c1',
      workspaceId: WS,
      leadId: 'lead-1',
    } as any);
    prisma.conversation.update.mockResolvedValue({ id: 'c1' } as any);
  });

  it('rejects assigning to someone with no membership here (no write)', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(null as any);
    await expect(svc.assign(WS, 'c1', 'foreign-user')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('rejects a deactivated member — a live thread must not land with someone who cannot log in', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ status: 'SUSPENDED' } as any);
    await expect(svc.assign(WS, 'c1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('assigns to an active member and reads membership, not the frozen user mirror', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ status: 'ACTIVE' } as any);
    await svc.assign(WS, 'c1', 'u1');
    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', workspaceId: WS } }),
    );
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedToId: 'u1' } }),
    );
  });

  /**
   * Lead assignment and task assignment both notify. The inbox — where a
   * customer is actually waiting — was the one assignment verb that stayed
   * silent, so a handed-off thread sat unseen until someone opened the inbox
   * and filtered by themselves.
   */
  it('tells the new owner a customer is waiting, and carries the lead so the click lands', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ status: 'ACTIVE' } as any);
    await svc.assign(WS, 'c1', 'u1');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: 'u1',
        type: 'CONVERSATION_ASSIGNED',
        // conversationId alone has no URL — the inbox picks a person in React
        // state. leadId is what the notification bell can actually route on.
        metadata: expect.objectContaining({ conversationId: 'c1', leadId: 'lead-1' }),
      }),
    );
  });

  it('keeps the assignment when the notification fails', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ status: 'ACTIVE' } as any);
    notifications.create.mockRejectedValue(new Error('down'));
    await expect(svc.assign(WS, 'c1', 'u1')).resolves.toBeDefined();
    expect(prisma.conversation.update).toHaveBeenCalled();
  });

  it('unassign (null) needs no lookup and announces nothing — there is no new owner', async () => {
    await svc.assign(WS, 'c1', null);
    expect(prisma.workspaceMembership.findFirst).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedToId: null } }),
    );
  });
});
