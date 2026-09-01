import { BadRequestException } from '@nestjs/common';
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

  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', leadId: 'lead-9', contactIdentityId: 'ci1' };
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

  // The agent surface keeps one PERSON open beside a whole-workspace stream.
  // A frame that does not say whose it is forces that client to refetch the
  // open person's record on every event in the workspace — so the send that
  // already has the conversation in hand names its lead.
  it('names the person the outbound message is about', async () => {
    await service.send(input);
    expect(stream.push).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ kind: 'message', conversationId: 'c1', leadId: 'lead-9' }),
    );
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

/**
 * A DISABLED channel must not keep sending.
 *
 * Disabling a channel silenced INBOUND immediately — PublicChannelResolver
 * .byExternalId only resolves ACTIVE rows — but outbound kept working, so the
 * channel went on sending and went on burning message quota (reserve() runs
 * before the adapter call) while nothing could ever come back on it.
 *
 * OutboundConversationService already refused to OPEN a thread on a non-ACTIVE
 * channel. Replying inside an existing thread was the gap, which is the more
 * likely case: the channel gets disabled while conversations are already open.
 */
describe('MessageSenderService.send — channel status', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', leadId: 'lead-9', contactIdentityId: 'ci1' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'hi', authorType: 'AGENT' as const, authorId: 'u1' };

  const build = (status: string | null) => {
    const adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'x', status: 'SENT' }) };
    const quota = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn() };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: 'w1', type: 'SMS', status, configSealed: 'x', configPublic: null,
        }),
      },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue({ id: 'ci1', workspaceId: 'w1', value: '+905551112233' }) },
      $transaction: jest.fn(async (cb: any) => cb({
        message: { create: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
        conversation: { update: jest.fn().mockResolvedValue({}) },
      })),
    };
    const svc = new MessageSenderService(
      prisma,
      { get: jest.fn().mockReturnValue(adapter), resolveConfig: jest.fn().mockReturnValue({ secrets: {} }) } as any,
      quota as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue({ amount: 1, quantity: 1, unitCost: 1 }) } as any,
    );
    return { svc, adapter, quota };
  };

  it('refuses to send on a DISABLED channel', async () => {
    const { svc, adapter } = build('DISABLED');
    await expect(svc.send(input)).rejects.toThrow(BadRequestException);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('refuses BEFORE reserving quota, so a dead channel cannot burn the allowance', async () => {
    const { svc, quota } = build('DISABLED');
    await expect(svc.send(input)).rejects.toThrow(BadRequestException);
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('sends normally on an ACTIVE channel', async () => {
    const { svc, adapter } = build('ACTIVE');
    await svc.send(input);
    expect(adapter.send).toHaveBeenCalled();
  });

  it('tolerates a null status — older rows and fixtures carry none', async () => {
    const { svc, adapter } = build(null);
    await svc.send(input);
    expect(adapter.send).toHaveBeenCalled();
  });
});

/**
 * What the thread shows has to be what the customer got.
 *
 * The WhatsApp adapter's precedence is template > media > text, and an approved
 * template is rendered by Meta from a name + language — the rendered text never
 * exists on our side. Persisting `text` therefore stored something the customer
 * never received: empty for a template-only send (start() passes
 * `text: input.text ?? ''`), and the IGNORED text when both were supplied. A rep
 * opening the thread saw a blank outbound message, or copy that never went out.
 */
describe('MessageSenderService.send — template body', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', leadId: 'lead-9', contactIdentityId: 'ci1' };
  const TPL = { name: 'intro', languageCode: 'tr' };

  const build = () => {
    const created: any[] = [];
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo), update: jest.fn() },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: 'w1', type: 'WHATSAPP', status: 'ACTIVE', configSealed: 'x', configPublic: null,
        }),
      },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue({ id: 'ci1', workspaceId: 'w1', value: '+905551112233' }) },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          message: {
            create: jest.fn(async (args: any) => {
              created.push(args.data);
              return { id: 'm1', status: 'SENT' };
            }),
          },
          conversation: { update: jest.fn() },
        }),
      ),
    };
    const svc = new MessageSenderService(
      prisma,
      {
        get: jest.fn().mockReturnValue({ send: jest.fn().mockResolvedValue({ externalMessageId: 'x', status: 'SENT' }) }),
        resolveConfig: jest.fn().mockReturnValue({ secrets: {} }),
      } as any,
      { reserve: jest.fn(), refund: jest.fn() } as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue({ amount: 0, quantity: 0, unitCost: 0 }) } as any,
    );
    return { svc, created };
  };

  const base = { workspaceId: 'w1', conversationId: 'c1', authorType: 'AI' as const };

  it('records the template that was sent instead of an empty body', async () => {
    const { svc, created } = build();

    await svc.send({ ...base, text: '', template: TPL as any });

    expect(created[0].body).toBe('[template: intro (tr)]');
  });

  it('labels caller text as context rather than presenting it as the message', async () => {
    const { svc, created } = build();

    // The adapter sent the TEMPLATE; this text never reached the customer.
    await svc.send({ ...base, text: 'merhaba', template: TPL as any });

    expect(created[0].body).toBe('[template: intro (tr)] merhaba');
  });

  it('keeps the template identity queryable in meta', async () => {
    const { svc, created } = build();

    await svc.send({ ...base, text: '', template: TPL as any });

    expect(created[0].meta).toEqual({ template: { name: 'intro', languageCode: 'tr' } });
  });

  it('leaves a plain text send exactly as it was', async () => {
    const { svc, created } = build();

    await svc.send({ ...base, text: 'merhaba' });

    expect(created[0].body).toBe('merhaba');
    expect(created[0].meta).toBeUndefined();
  });
});
