import { MessageReceiptService } from './message-receipt.service';

function makeSvc(currentStatus: string | null) {
  const msg = currentStatus
    ? { id: 'm1', status: currentStatus, conversationId: 'c1', direction: 'OUTBOUND' }
    : null;
  const prisma = {
    message: {
      findFirst: jest.fn().mockResolvedValue(msg),
      update: jest.fn().mockResolvedValue({}),
    },
    // A Message row carries no leadId and has no `conversation` relation to
    // include, so naming the person costs this one primary-key lookup. See the
    // service for why it is worth it.
    conversation: { findFirst: jest.fn().mockResolvedValue({ leadId: 'lead-7' }) },
  };
  const stream = { push: jest.fn() };
  return { prisma, stream, svc: new MessageReceiptService(prisma as any, stream as any) };
}

describe('MessageReceiptService.apply', () => {
  it('advances SENT → DELIVERED → READ and pushes an SSE status tick', async () => {
    const { prisma, stream, svc } = makeSvc('SENT');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }]);
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { status: 'DELIVERED' } });
    expect(stream.push).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ kind: 'status', conversationId: 'c1' }),
    );
  });

  it('does NOT regress READ back to DELIVERED (out-of-order webhook)', async () => {
    const { prisma, svc } = makeSvc('READ');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }]);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('sets FAILED + reason when current is SENT', async () => {
    const { prisma, svc } = makeSvc('SENT');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'FAILED', reason: 'blocked' }]);
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'FAILED', error: 'blocked' },
    });
  });

  it('does NOT overwrite a confirmed DELIVERED with FAILED', async () => {
    const { prisma, svc } = makeSvc('DELIVERED');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'FAILED' }]);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('does NOT resurrect a terminal FAILED message to DELIVERED/READ (out-of-order)', async () => {
    const { prisma, svc } = makeSvc('FAILED');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }]);
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'READ' }]);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown externalMessageId', async () => {
    const { prisma, stream, svc } = makeSvc(null);
    await svc.apply('w1', [{ externalMessageId: 'nope', status: 'DELIVERED' }]);
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(stream.push).not.toHaveBeenCalled();
  });

  it('names the person a delivery receipt is about', async () => {
    const { stream, svc } = makeSvc('SENT');
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }]);
    expect(stream.push).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ kind: 'status', conversationId: 'c1', leadId: 'lead-7' }),
    );
  });

  // The lookup is a nicety, the tick is not: a receipt whose conversation
  // cannot be read still has to reach the inbox, where the client's broad
  // refresh takes over. Degrading to "refresh nothing" would hide a delivery
  // failure from the rep who sent it.
  it('still ticks when the conversation lookup fails, just without a name', async () => {
    const { prisma, stream, svc } = makeSvc('SENT');
    prisma.conversation.findFirst.mockRejectedValueOnce(new Error('db down'));
    await svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }]);
    expect(stream.push).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ kind: 'status', conversationId: 'c1' }),
    );
    expect(stream.push.mock.calls[0][1].leadId).toBeUndefined();
  });

  it('never throws when the DB errors (best-effort)', async () => {
    const { prisma, svc } = makeSvc('SENT');
    prisma.message.update.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.apply('w1', [{ externalMessageId: 'x', status: 'DELIVERED' }])).resolves.toBeUndefined();
  });
});
