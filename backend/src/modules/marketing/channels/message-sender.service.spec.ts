import { BadRequestException } from '@nestjs/common';
import { MessageSenderService } from './message-sender.service';

/**
 * Outbound 1:1 send pipeline. The reserved message quota must never leak: a send
 * that fails is refunded, and a mail that actually reached the customer is NOT
 * (the record of it now survives a bookkeeping failure, so refunding it would
 * hand back quota for a message the customer is holding). The message row + its
 * domain event are written in one transaction so a crash can't lose the event.
 */
describe('MessageSenderService.send', () => {
  let prisma: any;
  let registry: any;
  let quota: any;
  let outbox: any;
  let stream: any;
  let conversationSpend: any;
  let suppression: any;
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
      message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: { findFirst: jest.fn().mockResolvedValue(channel) },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue(identity) },
      message: {
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
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
    suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
    service = new MessageSenderService(
      prisma,
      registry,
      quota,
      outbox,
      stream,
      conversationSpend,
      suppression,
    );
  });

  // Let any fire-and-forget settleSms promise (and its .catch handler) drain
  // before assertions run — `send()` does not await it.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('reserves, sends, settles message + outbox event in one tx, and does not refund', async () => {
    const msg = await service.send(input);
    expect(quota.reserve).toHaveBeenCalledWith('w1', 'SMS');
    expect(adapter.send).toHaveBeenCalledWith({ config: { secrets: {} }, to: '+905551112233', text: 'hi' });
    expect(tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({ status: 'SENT', externalMessageId: 'bulk-1' }),
      }),
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
    tx.message.update.mockResolvedValue({ id: 'm2', status: 'FAILED' });
    const msg = await service.send(input);
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith('w1', 'SMS');
    expect(tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(msg).toEqual({ id: 'm2', status: 'FAILED' });
  });

  it('[P0] does not double-refund when persistence fails after an already-refunded FAILED send', async () => {
    adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: 'x' });
    prisma.$transaction.mockRejectedValue(new Error('DB write failed'));
    await expect(service.send(input)).rejects.toThrow('DB write failed');
    expect(quota.refund).toHaveBeenCalledTimes(1);
  });

  it('[P0] refunds the reserve when the record of the send cannot even be opened', async () => {
    // Nothing was sent, so the reserve has to come back — the old code could
    // only reach this state after the provider call, where it already did.
    prisma.message.create.mockRejectedValue(new Error('DB write failed'));
    await expect(service.send(input)).rejects.toThrow('DB write failed');
    expect(adapter.send).not.toHaveBeenCalled();
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
      tx.message.update.mockResolvedValue({ id: 'm2', status: 'FAILED' });
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
 * The record of the send is opened BEFORE the provider is called.
 *
 * `adapter.send` used to run before any durable write, so a bookkeeping failure
 * in the gap left a mail that had reached the customer with nothing on file at
 * all — and the AI retry, seeing no message, generated and sent a SECOND,
 * different one (`pending-row`). The row is now created PENDING first and
 * settled afterwards, so the worst case is a row that says "we do not know how
 * this ended" rather than a mail nobody can account for.
 */
describe('MessageSenderService.send — the row before the send', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', leadId: 'lead-9', contactIdentityId: 'ci1' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'hi', authorType: 'AI' as const };

  const build = () => {
    const order: string[] = [];
    const adapter = {
      send: jest.fn(async () => {
        order.push('provider');
        return { externalMessageId: 'x', status: 'SENT' };
      }),
    };
    const created: any[] = [];
    const tx = {
      message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1', workspaceId: 'w1', type: 'SMS', status: 'ACTIVE', configSealed: 'x',
        }),
      },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue({ id: 'ci1', workspaceId: 'w1', value: '+90555' }) },
      message: {
        create: jest.fn(async (args: any) => {
          order.push('row');
          created.push(args.data);
          return { id: 'm1', status: 'PENDING' };
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const quota = { reserve: jest.fn(), refund: jest.fn() };
    const svc = new MessageSenderService(
      prisma,
      { get: () => adapter, resolveConfig: () => ({ secrets: {} }) } as any,
      quota as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
    );
    return { svc, prisma, quota, adapter, tx, created, order };
  };

  it('writes the PENDING row before the provider call', async () => {
    const { svc, created, order } = build();
    await svc.send(input);
    expect(order).toEqual(['row', 'provider']);
    expect(created[0]).toEqual(
      expect.objectContaining({ status: 'PENDING', externalMessageId: null, direction: 'OUTBOUND' }),
    );
  });

  it('settles that same row instead of writing a second one', async () => {
    const { svc, prisma, tx } = build();
    await svc.send(input);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'SENT', externalMessageId: 'x', error: null },
    });
  });

  it('[P0] a provider success with a DB failure leaves the row, not a lost send', async () => {
    const { svc, prisma } = build();
    prisma.$transaction.mockRejectedValue(new Error('Timed out fetching a connection'));
    await expect(svc.send(input)).rejects.toThrow('Timed out fetching a connection');
    // The mail went out and there IS a row for it — PENDING, which is the
    // honest answer, and the one a retry can recognise.
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    );
  });

  it('[P0] does not refund quota for a mail that reached the customer', async () => {
    // The old code refunded here because the send was otherwise unrecorded.
    // Now the row survives, so the message is real and it is metered.
    const { svc, prisma, quota } = build();
    prisma.$transaction.mockRejectedValue(new Error('DB write failed'));
    await expect(svc.send(input)).rejects.toThrow('DB write failed');
    expect(quota.refund).not.toHaveBeenCalled();
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
      message: {
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: any) => cb({
        message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
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
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
    );
    return { svc, adapter, quota, prisma };
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

  it('refuses before writing any row for it', async () => {
    const { svc, prisma } = build('DISABLED');
    await expect(svc.send(input)).rejects.toThrow(BadRequestException);
    expect(prisma.message.create).not.toHaveBeenCalled();
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
      message: {
        create: jest.fn(async (args: any) => {
          created.push(args.data);
          return { id: 'm1', status: 'PENDING' };
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
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
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
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

/**
 * Email replies used to leave with "Re: your message" — `EmailChannelAdapter`'s
 * last-resort fallback — because nothing on this path ever passed a subject. To
 * the recipient that is a new thread with an English placeholder on it, which
 * is not the thread the conversation view claims to be continuing.
 *
 * The subject is one half of the reply context; the threading headers below are
 * the other, and both are read off the SAME last inbound row.
 */
describe('MessageSenderService.send — the subject of an email reply', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', contactIdentityId: 'ci1' };
  const identity = { id: 'ci1', workspaceId: 'w1', value: 'tarik@example.com' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'merhaba', authorType: 'AI' as const };

  function build(type: string, lastInbound: any) {
    const adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'm', status: 'SENT' }) };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ch1', workspaceId: 'w1', type, configSealed: 'x' }),
      },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue(identity) },
      message: {
        findFirst: jest.fn().mockResolvedValue(lastInbound),
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
      },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
          conversation: { update: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const service = new MessageSenderService(
      prisma,
      { get: () => adapter, resolveConfig: () => ({ secrets: {} }) } as any,
      { reserve: jest.fn(), refund: jest.fn() } as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
    );
    return { service, prisma, adapter };
  }

  it('continues the thread the customer actually opened', async () => {
    const { service, adapter } = build('EMAIL', {
      meta: { raw: { subject: 'Fiyat listesi hakkında' } },
    });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].subject).toBe('Re: Fiyat listesi hakkında');
  });

  it('does not grow a second Re: on every round', async () => {
    // Mail clients thread on the subject; "Re: Re: Re: …" is how a thread stops
    // looking like one.
    const { service, adapter } = build('EMAIL', { meta: { raw: { subject: 'RE: Teklif' } } });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].subject).toBe('RE: Teklif');
  });

  it('reads the capitalised Subject the Postmark payload carries', async () => {
    // `meta.raw` is the provider body VERBATIM, so the key spelling is the
    // provider's. Only the lowercase one was read, so every Postmark-delivered
    // thread fell back to "Re: your message" (`reply-subject-prefix`).
    const { service, adapter } = build('EMAIL', {
      meta: { raw: { Subject: 'Fiyat listesi hakkında', From: 'x@y.com', TextBody: 'merhaba' } },
    });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].subject).toBe('Re: Fiyat listesi hakkında');
  });

  it.each([
    ['YNT: Teklif'],
    ['AW: Angebot'],
    ['Yanıt: Teklif'],
    ['SV: Tilbud'],
    ['Re[2]: Teklif'],
  ])('detects %s as an existing reply prefix and leaves it alone', async (subject) => {
    // DETECT, never rewrite: with no In-Reply-To on the older mail in the
    // thread, the subject is the only handle the recipient's client has, and
    // turning "YNT:" into "Re:" would mutate the customer's own subject.
    const { service, adapter } = build('EMAIL', { meta: { raw: { subject } } });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].subject).toBe(subject);
  });

  it('leaves the adapter fallback alone when there is nothing to reply to', async () => {
    // An outbound thread the customer has not answered yet. Inventing a subject
    // here would put this service in the business of writing copy.
    const { service, adapter } = build('EMAIL', null);
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].subject).toBeUndefined();
  });

  it('uses a caller-supplied subject only when the thread has none', async () => {
    const { service, adapter } = build('EMAIL', null);
    await service.send({ ...input, subject: 'Teklifiniz hazır' });
    expect(adapter.send.mock.calls[0][0].subject).toBe('Teklifiniz hazır');
  });

  it('prefers the thread over a caller-supplied subject', async () => {
    // The thread the customer opened is the thread we are in. A caller's own
    // subject would start a second one in their mail client.
    const { service, adapter } = build('EMAIL', { meta: { raw: { subject: 'Fiyat' } } });
    await service.send({ ...input, subject: 'Teklifiniz hazır' });
    expect(adapter.send.mock.calls[0][0].subject).toBe('Re: Fiyat');
  });

  it('reads the LATEST inbound message, scoped to the workspace', async () => {
    const { service, prisma } = build('EMAIL', { meta: { raw: { subject: 'x' } } });
    await service.send(input);
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'w1', conversationId: 'c1', direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('does not go looking for a subject on a channel that has none', async () => {
    const { service, prisma, adapter } = build('SMS', { meta: { raw: { subject: 'x' } } });
    await service.send(input);
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
    expect(adapter.send.mock.calls[0][0].subject).toBeUndefined();
  });
});

/**
 * A reply has to land IN the thread it answers.
 *
 * Nothing in this codebase has ever set `In-Reply-To` or `References`
 * (`no-threading-headers`), so every AI answer arrived in the customer's client
 * as a brand-new message that merely happened to quote theirs — and a subject
 * beginning "Re:" with no In-Reply-To is exactly what rspamd scores as
 * FAKE_REPLY. Both headers come off the same inbound row the subject does.
 */
describe('MessageSenderService.send — threading headers', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', contactIdentityId: 'ci1' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'merhaba', authorType: 'AI' as const };

  function build(lastInbound: any, type = 'EMAIL') {
    const adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'm', status: 'SENT' }) };
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch1', workspaceId: 'w1', type, configSealed: 'x' }) },
      contactIdentity: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ci1', workspaceId: 'w1', value: 'tarik@example.com' }),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue(lastInbound),
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
      },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
          conversation: { update: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const service = new MessageSenderService(
      prisma,
      { get: () => adapter, resolveConfig: () => ({ secrets: {} }) } as any,
      { reserve: jest.fn(), refund: jest.fn() } as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue(null) } as any,
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
    );
    return { service, adapter };
  }

  it('answers the message it is replying to', async () => {
    const { service, adapter } = build({
      externalMessageId: 'CAF1@mail.example.com',
      meta: { raw: { subject: 'Teklif' } },
    });
    await service.send(input);
    const sent = adapter.send.mock.calls[0][0];
    expect(sent.inReplyTo).toBe('CAF1@mail.example.com');
    expect(sent.references).toEqual(['CAF1@mail.example.com']);
  });

  it("carries the thread's own References, with the parent last", async () => {
    // RFC 5322 §3.6.4: a reply's References is the parent's References plus the
    // parent's own Message-ID. That chain is what a client walks to file the
    // mail under the conversation the customer already has open.
    const { service, adapter } = build({
      externalMessageId: 'c@x.test',
      meta: { raw: { subject: 'Teklif', references: '<a@x.test> <b@x.test>' } },
    });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].references).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
  });

  it('reads the provider spelling of the id when the column is empty', async () => {
    // The webhook path stores the provider body verbatim; older rows predate
    // the externalMessageId column being filled in on this path.
    const { service, adapter } = build({
      externalMessageId: null,
      meta: { raw: { Subject: 'Teklif', MessageID: '<pm-99@example.net>' } },
    });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].inReplyTo).toBe('pm-99@example.net');
  });

  it('normalizes the stored id — one spelling on both sides of the lookup', async () => {
    // Inbound ids are persisted stripped and outbound ones with brackets; a
    // header built from the raw value would never match either.
    const { service, adapter } = build({
      externalMessageId: '  <CAF1@MAIL.Example.COM>  ',
      meta: { raw: { subject: 'Teklif' } },
    });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].inReplyTo).toBe('CAF1@mail.example.com');
  });

  it('sends no threading headers when there is nothing to reply to', async () => {
    const { service, adapter } = build(null);
    await service.send(input);
    const sent = adapter.send.mock.calls[0][0];
    expect(sent.inReplyTo).toBeUndefined();
    expect(sent.references).toBeUndefined();
  });

  it('sends no threading headers when the inbound mail carried no id', async () => {
    const { service, adapter } = build({ externalMessageId: null, meta: { raw: { subject: 'Teklif' } } });
    await service.send(input);
    expect(adapter.send.mock.calls[0][0].inReplyTo).toBeUndefined();
  });

  it('keeps the chain inside a header a receiver will accept', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `<r${i}@x.test>`).join(' ');
    const { service, adapter } = build({
      externalMessageId: 'last@x.test',
      meta: { raw: { subject: 'Teklif', References: long } },
    });
    await service.send(input);
    const refs = adapter.send.mock.calls[0][0].references;
    expect(refs).toHaveLength(20);
    // The root anchors the thread and the recent ids are what clients match on,
    // so the middle is what gets dropped.
    expect(refs[0]).toBe('r0@x.test');
    expect(refs[refs.length - 1]).toBe('last@x.test');
  });

  it('says nothing about threading on a channel that has no headers', async () => {
    const { service, adapter } = build({ externalMessageId: 'x@y.test' }, 'SMS');
    await service.send(input);
    const sent = adapter.send.mock.calls[0][0];
    expect(sent.inReplyTo).toBeUndefined();
    expect(sent.references).toBeUndefined();
  });
});

/**
 * The consent gate on the 1:1 lane (`replies-skip-consent`).
 *
 * The Inbox composer, `jeeta.send_message` and the AI's queued follow-up all
 * reach `send()` directly, and `send()` checked nothing but the channel status
 * and the quota — so commercial mail kept going to a lead who had unsubscribed.
 * The gate runs BEFORE the reserve: a mail we were never allowed to send must
 * cost the tenant nothing.
 */
describe('MessageSenderService.send — consent before quota', () => {
  const convo = { id: 'c1', workspaceId: 'w1', channelId: 'ch1', leadId: 'lead-9', contactIdentityId: 'ci1' };
  const input = { workspaceId: 'w1', conversationId: 'c1', text: 'merhaba', authorType: 'AI' as const };

  function build(verdict: any, type = 'EMAIL') {
    const order: string[] = [];
    const adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'm', status: 'SENT' }) };
    const suppression = {
      check: jest.fn(async () => {
        order.push('consent');
        return verdict;
      }),
    };
    const quota = {
      reserve: jest.fn(async () => {
        order.push('quota');
      }),
      refund: jest.fn(),
    };
    const settled: any[] = [];
    const prisma: any = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch1', workspaceId: 'w1', type, configSealed: 'x' }) },
      contactIdentity: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ci1', workspaceId: 'w1', value: 'tarik@example.com' }),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
      },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          message: {
            update: jest.fn(async (args: any) => {
              settled.push(args.data);
              return { id: 'm1', ...args.data };
            }),
          },
          conversation: { update: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const service = new MessageSenderService(
      prisma,
      { get: () => adapter, resolveConfig: () => ({ secrets: {} }) } as any,
      quota as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue(null) } as any,
      suppression as any,
    );
    return { service, adapter, quota, suppression, settled, order };
  }

  it('asks about consent BEFORE it spends the tenant’s quota', async () => {
    const { service, order } = build({ suppressed: false });
    await service.send(input);
    expect(order).toEqual(['consent', 'quota']);
  });

  it('asks as CONVERSATIONAL, naming the thread that can earn the reply exemption', async () => {
    const { service, suppression } = build({ suppressed: false });
    await service.send(input);
    expect(suppression.check).toHaveBeenCalledWith('w1', 'tarik@example.com', 'CONVERSATIONAL', {
      conversationId: 'c1',
    });
  });

  it('refuses a suppressed recipient without sending or metering', async () => {
    const { service, adapter, quota } = build({ suppressed: true, reason: 'OPT_OUT' });
    await service.send(input);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it('writes the refusal into the thread instead of throwing it at the rep', async () => {
    // G2: nothing new throws. The rep sees WHY in the thread, where the send is.
    const { service, settled } = build({ suppressed: true, reason: 'OPT_OUT' });
    const msg: any = await service.send(input);
    expect(msg.status).toBe('FAILED');
    expect(settled[0].error).toMatch(/opted out/i);
  });

  it('does not ask on a channel this gate does not cover', async () => {
    const { service, suppression } = build({ suppressed: false }, 'SMS');
    await service.send(input);
    expect(suppression.check).not.toHaveBeenCalled();
  });

  it('sends anyway when the consent read itself fails', async () => {
    // A database hiccup is not a customer's refusal, and refusing on it would
    // silence a whole workspace's inbox.
    const { service, adapter, suppression } = build({ suppressed: false });
    suppression.check.mockRejectedValue(new Error('connection pool timeout'));
    await service.send(input);
    expect(adapter.send).toHaveBeenCalled();
  });
});

describe('MessageSenderService.send — what the caller is told, and what the clock says', () => {
  let prisma: any;
  let registry: any;
  let adapter: any;
  let tx: any;
  let service: MessageSenderService;

  const convo = {
    id: 'c1',
    workspaceId: 'w1',
    channelId: 'ch1',
    leadId: 'lead-9',
    contactIdentityId: 'ci1',
    lastMessageAt: new Date('2026-09-01T09:00:00.000Z'),
  };
  const identity = { id: 'ci1', workspaceId: 'w1', value: 'musteri@x.test' };

  const build = (type: string) => {
    adapter = { send: jest.fn().mockResolvedValue({ externalMessageId: 'x-1', status: 'SENT' }) };
    tx = {
      message: { update: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue(convo) },
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ch1',
          workspaceId: 'w1',
          type,
          configSealed: 'x',
          configPublic: null,
        }),
      },
      contactIdentity: { findFirst: jest.fn().mockResolvedValue(identity) },
      message: {
        create: jest.fn().mockResolvedValue({ id: 'm1', status: 'PENDING' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    registry = {
      get: jest.fn().mockReturnValue(adapter),
      resolveConfig: jest.fn().mockReturnValue({ secrets: {} }),
    };
    service = new MessageSenderService(
      prisma,
      registry,
      { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) } as any,
      { append: jest.fn().mockResolvedValue('evt-1') } as any,
      { push: jest.fn() } as any,
      { settleSms: jest.fn().mockResolvedValue({}) } as any,
      { check: jest.fn().mockResolvedValue({ suppressed: false }) } as any,
    );
  };

  const send = (over: Record<string, unknown> = {}) =>
    service.send({ workspaceId: 'w1', conversationId: 'c1', text: 'hi', authorType: 'AGENT', ...(over as any) });

  describe('Auto-Submitted', () => {
    it('marks an AI email reply as unattended, so the peer does not answer it back', async () => {
      build('EMAIL');
      await send({ authorType: 'AI', subject: 'Re: teklif' });
      expect(adapter.send.mock.calls[0][0].autoSubmitted).toBe('auto-replied');
    });

    it('is ABSENT on a human reply', async () => {
      // A person's reply marked auto-replied is filtered by the recipient's
      // own RFC 3834 rules — the customer never sees what a human wrote.
      build('EMAIL');
      await send({ authorType: 'AGENT' });
      expect(adapter.send.mock.calls[0][0].autoSubmitted).toBeUndefined();
    });

    it('is absent on a non-email channel', async () => {
      build('SMS');
      await send({ authorType: 'AI' });
      expect(adapter.send.mock.calls[0][0].autoSubmitted).toBeUndefined();
    });
  });

  describe('retriable', () => {
    it('carries the adapter verdict out to the caller', async () => {
      // Without it a 4xx greylisting and a permanently rejected address read
      // identically to the AI engine, which then treats every refusal as final.
      build('EMAIL');
      adapter.send.mockResolvedValue({
        externalMessageId: null,
        status: 'FAILED',
        error: '451 try later',
        retriable: true,
      });
      tx.message.update.mockResolvedValue({ id: 'm2', status: 'FAILED' });
      const msg: any = await send();
      expect(msg.retriable).toBe(true);
    });

    it('says nothing when the adapter offered no verdict', async () => {
      build('SMS');
      const msg: any = await send();
      expect('retriable' in msg).toBe(false);
    });
  });

  describe('the waiting clock', () => {
    it('does not advance lastMessageAt on a FAILED send', async () => {
      // Stamping it silently disarmed the hourly ai-reply-backfill sweep: it
      // looks for threads whose last message is inbound, and a failed
      // outbound row made every one of them look answered.
      build('EMAIL');
      adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: '550' });
      tx.message.update.mockResolvedValue({ id: 'm2', status: 'FAILED' });
      await send();
      expect(tx.conversation.update.mock.calls[0][0].data.lastMessageAt).toEqual(convo.lastMessageAt);
    });

    it('never writes NULL — Postgres sorts those to the top of the inbox', async () => {
      build('EMAIL');
      prisma.conversation.findFirst.mockResolvedValue({ ...convo, lastMessageAt: null });
      adapter.send.mockResolvedValue({ externalMessageId: null, status: 'FAILED', error: '550' });
      tx.message.update.mockResolvedValue({ id: 'm2', status: 'FAILED' });
      await send();
      expect(tx.conversation.update.mock.calls[0][0].data.lastMessageAt).toBeInstanceOf(Date);
    });

    it('advances it on a SENT one', async () => {
      build('EMAIL');
      await send();
      const written = tx.conversation.update.mock.calls[0][0].data.lastMessageAt;
      expect(written.getTime()).toBeGreaterThan(convo.lastMessageAt.getTime());
    });
  });
});
