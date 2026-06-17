import { MessageSenderService } from './message-sender.service';

/**
 * Outbound 1:1 send pipeline. The reserved message quota must never leak: a send
 * that fails is refunded, and — critically — a SUCCESSFUL provider send whose
 * persistence then fails must also refund (otherwise the customer is metered for
 * a message that vanished, and a caller retry compounds the leak). The message
 * row + its domain event are written in one transaction so a crash can't lose
 * the event.
 */
describe('MessageSenderService.send', () => {
  let prisma: any;
  let registry: any;
  let quota: any;
  let outbox: any;
  let stream: any;
  let adapter: any;
  let tx: any;
  let service: MessageSenderService;

  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', contactIdentityId: 'ci1' };
  const channel = { id: 'ch1', workspaceId: 'w1', type: 'SMS', configSealed: 'x', configPublic: null };
  const identity = { id: 'ci1', workspaceId: 'w1', value: '+905551112233' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'hi', authorType: 'AGENT' as const, authorId: 'u1' };

  beforeEach(() => {
    adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'bulk-1', status: 'SENT' }) };
    tx = {
      message: { create: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: { findFirst: jest.fn().mockResolvedValue(channel) },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue(identity) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    registry = {
      get: jest.fn().mockReturnValue(adapter),
      resolveConfig: jest.fn().mockReturnValue({ secrets: {} }),
    };
    quota = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
    outbox = { append: jest.fn().mockResolvedValue('evt-1') };
    stream = { push: jest.fn() };
    service = new MessageSenderService(prisma, registry, quota, outbox, stream);
  });

  it('reserves, sends, persists message + outbox event in one tx, and does not refund', async () => {
    const msg = await service.send(input);
    expect(quota.reserve).toHaveBeenCalledWith('w1', 'SMS');
    expect(adapter.send).toHaveBeenCalledWith({ config: { secrets: {} }, to: '+905551112233', text: 'hi' });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', externalMessageId: 'bulk-1' }) }),
    );
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'conv-msg-sent:m1' }),
      tx,
    );
    expect(quota.refund).not.toHaveBeenCalled();
    expect(msg).toEqual({ id: 'm1', status: 'SENT' });
  });

  it('refunds exactly once and still persists a FAILED send', async () => {
    adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: 'NetGSM 30' });
    tx.message.create.mockResolvedValue({ id: 'm2', status: 'FAILED' });
    const msg = await service.send(input);
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith('w1', 'SMS');
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(msg).toEqual({ id: 'm2', status: 'FAILED' });
  });

  it('[P0] refunds the reserved quota when persistence fails after a successful send', async () => {
    prisma.$transaction.mockRejectedValue(new Error('DB write failed'));
    await expect(service.send(input)).rejects.toThrow('DB write failed');
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith('w1', 'SMS');
  });

  it('[P0] does not double-refund when persistence fails after an already-refunded FAILED send', async () => {
    adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: 'x' });
    prisma.$transaction.mockRejectedValue(new Error('DB write failed'));
    await expect(service.send(input)).rejects.toThrow('DB write failed');
    expect(quota.refund).toHaveBeenCalledTimes(1);
  });

  it('does not push to the SSE stream when persistence fails', async () => {
    prisma.$transaction.mockRejectedValue(new Error('DB write failed'));
    await expect(service.send(input)).rejects.toThrow();
    expect(stream.push).not.toHaveBeenCalled();
  });
});
