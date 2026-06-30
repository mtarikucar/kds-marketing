import { NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Single-conversation assign must validate the assignee is in the workspace —
 * the SAME guard the bulk path already enforces ("no cross-tenant assign").
 * Without it, a foreign/unknown user id is silently written as assignedToId.
 */
describe('ConversationsService.assign — assignee workspace guard', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new ConversationsService(prisma as any, {} as any, { push: jest.fn() } as any);
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS } as any);
    prisma.conversation.update.mockResolvedValue({ id: 'c1' } as any);
  });

  it('rejects assigning to a user outside the workspace (no write)', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue(null as any); // not in this workspace
    await expect(svc.assign(WS, 'c1', 'foreign-user')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('assigns to an in-workspace user', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u1' } as any);
    await svc.assign(WS, 'c1', 'u1');
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedToId: 'u1' } }),
    );
  });

  it('unassign (null) needs no user lookup', async () => {
    await svc.assign(WS, 'c1', null);
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedToId: null } }),
    );
  });
});
