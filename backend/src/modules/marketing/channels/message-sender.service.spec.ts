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
  let conversationSpend: any;
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
    conversationSpend = { settleSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) };
    service = new MessageSenderService(prisma, registry, quota, outbox, stream, conversationSpend);
  });

  // Let any fire-and-forget settleSms promise (and its .catch handler) drain
  // before assertions run — `send()` does not await it.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

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

  it('forwards optional template/media through to the adapter', async () => {
    const template = { name: 'promo', languageCode: 'tr' };
    const media = { url: 'http://img', kind: 'image' as const };
    await service.send({ ...input, template, media });
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+905551112233', text: 'hi', template, media }),
    );
    expect(quota.refund).not.toHaveBeenCalled();
  });

  describe('SMS settlement', () => {
    it('settles the SMS cost with the message id + text after a successful send', async () => {
      const msg = await service.send(input);
      expect(conversationSpend.settleSms).toHaveBeenCalledWith('w1', { messageId: 'm1', text: 'hi' });
      expect(msg).toEqual({ id: 'm1', status: 'SENT' });
    });

    it('does not settle a FAILED send', async () => {
      adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: 'NetGSM 30' });
      tx.message.create.mockResolvedValue({ id: 'm2', status: 'FAILED' });
      await service.send(input);
      expect(conversationSpend.settleSms).not.toHaveBeenCalled();
    });

    it('does not settle a non-SMS channel', async () => {
      prisma.channel.findFirst.mockResolvedValue({ ...channel, type: 'WHATSAPP' });
      await service.send(input);
      expect(conversationSpend.settleSms).not.toHaveBeenCalled();
    });

    it('[P0] a settlement failure is logged but never fails (or blocks) the send', async () => {
      conversationSpend.settleSms.mockRejectedValue(new Error('tariff lookup failed'));
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const msg = await service.send(input);
      expect(msg).toEqual({ id: 'm1', status: 'SENT' });
      await flush();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SMS settlement failed'));
    });
  });
});
