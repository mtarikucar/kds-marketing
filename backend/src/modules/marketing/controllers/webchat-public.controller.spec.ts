import { NotFoundException } from '@nestjs/common';
import { WebchatPublicController } from './webchat-public.controller';

/**
 * Public read auth (history/stream) binds (channel, conversation, visitorId):
 * "a leaked conversationId alone can't surface another visitor's thread". The
 * visitor binding must be FAIL-CLOSED — a conversation with no contact identity
 * (no visitor to match against) must not be readable by an arbitrary visitorId.
 */
function makeCtrl() {
  const prisma: any = {
    conversation: { findFirst: jest.fn() },
    contactIdentity: { findFirst: jest.fn() },
    message: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const resolver: any = {
    byWidgetKey: jest.fn().mockResolvedValue({
      id: 'ch1', workspaceId: 'ws-1', type: 'WEBCHAT', status: 'ACTIVE', configPublic: {},
    }),
  };
  const ctrl = new WebchatPublicController(prisma, resolver, {} as any, {} as any, {} as any);
  return { ctrl, prisma };
}

describe('WebchatPublicController.history — visitor binding', () => {
  it('fails closed when the conversation has no contact identity (no visitor to match)', async () => {
    const { ctrl, prisma } = makeCtrl();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'co1', contactIdentityId: null });
    await expect(ctrl.history('wk', 'co1', 'visitor-x')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('rejects a visitorId that does not match the conversation identity', async () => {
    const { ctrl, prisma } = makeCtrl();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'co1', contactIdentityId: 'ci1' });
    prisma.contactIdentity.findFirst.mockResolvedValue({ value: 'real-visitor' });
    await expect(ctrl.history('wk', 'co1', 'attacker')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the thread for the matching visitor', async () => {
    const { ctrl, prisma } = makeCtrl();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'co1', contactIdentityId: 'ci1' });
    prisma.contactIdentity.findFirst.mockResolvedValue({ value: 'real-visitor' });
    prisma.message.findMany.mockResolvedValue([{ id: 'm1' }]);
    const out = await ctrl.history('wk', 'co1', 'real-visitor');
    expect(out.messages).toEqual([{ id: 'm1' }]);
  });
});
