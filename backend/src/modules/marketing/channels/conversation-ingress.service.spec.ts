import { Prisma } from '@prisma/client';
import { ConversationIngressService } from './conversation-ingress.service';
import { InboundMessage } from './channel-adapter.interface';

/**
 * The inbound funnel contract: a first-touch creates a workspace-scoped lead +
 * identity + conversation + message and emits the engine's trigger; a known
 * identity reuses the lead and its open thread; a redelivered provider message
 * dedupes. Every write must carry the workspaceId (multi-tenant isolation).
 */
describe('ConversationIngressService', () => {
  const WS = 'ws-1';
  const channel = { id: 'ch-1', workspaceId: WS, type: 'WHATSAPP' };
  let prisma: any;
  let autoAssigner: { pickAssignee: jest.Mock };
  let outbox: { append: jest.Mock };
  let stream: { push: jest.Mock };
  let leadAttribution: { capture: jest.Mock };
  let svc: ConversationIngressService;

  const inbound: InboundMessage = {
    externalUserId: '+905551112233',
    kind: 'WA',
    externalMessageId: 'wamid.AAA',
    text: 'Merhaba',
    displayName: 'Ayşe',
  };

  beforeEach(() => {
    prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      lead: { create: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    outbox = { append: jest.fn().mockResolvedValue('evt') };
    stream = { push: jest.fn() };
    leadAttribution = { capture: jest.fn().mockResolvedValue(undefined) };
    svc = new ConversationIngressService(
      prisma as any,
      autoAssigner as any,
      outbox as any,
      stream as any,
      leadAttribution as any,
    );
  });

  it('first-touch: creates a workspace-scoped lead, identity, conversation, message + emits events', async () => {
    const res = await svc.ingest(channel, inbound);

    expect(res).toMatchObject({ conversationId: 'conv-1', messageId: 'msg-1', isNewConversation: true, deduped: false });
    // workspace scoping on every create
    expect(prisma.lead.create.mock.calls[0][0].data.workspaceId).toBe(WS);
    expect(prisma.contactIdentity.create.mock.calls[0][0].data.workspaceId).toBe(WS);
    expect(prisma.conversation.create.mock.calls[0][0].data.workspaceId).toBe(WS);
    expect(prisma.message.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: WS,
      direction: 'INBOUND',
      authorType: 'CUSTOMER',
    });
    // phone-bearing channel seeds the lead phone/whatsapp
    expect(prisma.lead.create.mock.calls[0][0].data.whatsapp).toBe(inbound.externalUserId);
    // a first-touch new lead emits lead.created (workflow trigger) + started + received
    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toEqual([
      'marketing.lead.created.v1',
      'marketing.conversation.started.v1',
      'marketing.conversation.message.received.v1',
    ]);
    expect(stream.push).toHaveBeenCalled();
    // The inbound frame already knows whose it is — the funnel just resolved
    // the lead. Naming it here is what lets the person surface refresh the one
    // record on screen instead of every record on screen.
    expect(stream.push).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ kind: 'message', conversationId: 'conv-1', leadId: 'lead-1' }),
    );
  });

  it('does not cache a NULL sentinel — a SYSTEM user created after the first message is picked up', async () => {
    // First inbound: the workspace has no SYSTEM user yet → no activity note,
    // and the miss must NOT be cached.
    prisma.marketingUser.findFirst.mockReset();
    prisma.marketingUser.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'sys-1' });

    await svc.ingest(channel, { ...inbound, externalMessageId: 'wamid.s1' });
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();

    // Second inbound: the SYSTEM user now exists. Because the null wasn't cached,
    // resolveSentinel re-checks (2nd findFirst) and the note is written.
    await svc.ingest(channel, { ...inbound, externalMessageId: 'wamid.s2' });
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.leadActivity.create).toHaveBeenCalledTimes(1);
  });

  it('redelivered provider message dedupes (no tx, no new rows) — scoped to the workspace', async () => {
    prisma.message.findFirst.mockResolvedValue({ id: 'msg-9', conversationId: 'conv-9' });
    prisma.conversation.findFirst.mockResolvedValue({ leadId: 'lead-9' });

    const res = await svc.ingest(channel, inbound);

    expect(res).toMatchObject({ conversationId: 'conv-9', messageId: 'msg-9', deduped: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
    // The dedup lookup MUST be workspace-scoped (provider message ids are not
    // globally unique → a cross-tenant collision must never short-circuit here).
    expect(prisma.message.findFirst.mock.calls[0][0].where).toMatchObject({
      externalMessageId: 'wamid.AAA',
      workspaceId: WS,
    });
  });

  it('does NOT dedupe an externalMessageId that exists only in ANOTHER workspace (no cross-tenant leak)', async () => {
    // The scoped lookup finds nothing in THIS workspace → must proceed to insert,
    // never return the foreign conversation id as "deduped".
    prisma.message.findFirst.mockResolvedValue(null);
    const res = await svc.ingest(channel, inbound);
    expect(res).toMatchObject({ isNewConversation: true, deduped: false });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('caps oversize inbound text to 8000 chars before persist + emit', async () => {
    const huge: InboundMessage = { ...inbound, externalMessageId: 'wamid.BIG', text: 'a'.repeat(8000 + 500) };

    await svc.ingest(channel, huge);

    // Persisted body is capped.
    expect(prisma.message.create.mock.calls[0][0].data.body).toHaveLength(8000);
    // Emitted ConversationMessageReceived text is capped too.
    const received = outbox.append.mock.calls.find((c) => c[0].type === 'marketing.conversation.message.received.v1');
    expect(received[0].payload.text).toHaveLength(8000);
    // SSE fan-out body is capped.
    expect(stream.push.mock.calls[0][1].payload.body).toHaveLength(8000);
  });

  it('D10b: a first-touch CTWA ad referral captures attribution (ctwaClid + ad source) inside the tx', async () => {
    const withReferral: InboundMessage = {
      ...inbound,
      referral: { sourceId: '1209', ctwaClid: 'CTWA-1', sourceUrl: 'https://fb.me/x', sourceType: 'ad' },
    };
    await svc.ingest(channel, withReferral);
    expect(leadAttribution.capture).toHaveBeenCalledTimes(1);
    const [ws, leadId, input, source, tx] = leadAttribution.capture.mock.calls[0];
    expect(ws).toBe(WS);
    expect(leadId).toBe('lead-1');
    expect(input).toMatchObject({ ctwaClid: 'CTWA-1', url: 'https://fb.me/x' });
    expect(source).toMatchObject({ sourceAdCampaignId: '1209' });
    expect(tx).toBe(prisma); // enrolled in the ingest transaction
  });

  it('a non-ad referral does NOT map its source id onto sourceAdCampaignId', async () => {
    const withPostReferral: InboundMessage = {
      ...inbound,
      referral: { sourceId: 'fb-post-1', ctwaClid: null, sourceUrl: null, sourceType: 'post' },
    };
    await svc.ingest(channel, withPostReferral);
    expect(leadAttribution.capture).toHaveBeenCalledTimes(1);
    expect(leadAttribution.capture.mock.calls[0][3]).toEqual({});
  });

  it('no referral → no attribution capture call', async () => {
    await svc.ingest(channel, inbound);
    expect(leadAttribution.capture).not.toHaveBeenCalled();
  });

  it('a referral on a KNOWN identity does not re-capture (first-touch only)', async () => {
    prisma.contactIdentity.findUnique.mockResolvedValue({ id: 'ci-2', leadId: 'lead-2' });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-2' });
    await svc.ingest(channel, {
      ...inbound,
      referral: { sourceId: '1209', ctwaClid: 'CTWA-1', sourceUrl: null, sourceType: 'ad' },
    });
    expect(leadAttribution.capture).not.toHaveBeenCalled();
  });

  it('known identity reuses the lead + its open conversation (no new lead)', async () => {
    prisma.contactIdentity.findUnique.mockResolvedValue({ id: 'ci-2', leadId: 'lead-2' });
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-2' });

    const res = await svc.ingest(channel, inbound);

    expect(res).toMatchObject({ conversationId: 'conv-2', isNewConversation: false });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    // only the message.received event (no conversation.started for an existing thread)
    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['marketing.conversation.message.received.v1']);
  });
});

/**
 * Matching a reply to the thread it belongs to.
 *
 * Every side of a conversation normalized differently: NetGSM inbound writes
 * "+905551112233", WhatsApp inbound the wa_id "905551112233", and an
 * outbound-started thread was opened on whatever normalizePhone left behind,
 * "05551112233". The lookup was an exact match on one spelling, so a reply to a
 * thread WE started matched nothing — and the miss is invisible: ingest just
 * creates a fresh "SMS contact / Unknown" lead and a second conversation. The
 * thread you opened stays unanswered forever and the CRM gains a duplicate of a
 * lead you already had.
 *
 * addressFor now writes canonical E.164, but rows written before that are still
 * in the old shapes, which is why this searches rather than assuming.
 */
describe('ConversationIngressService — phone identity matching', () => {
  const WS = 'ws-1';
  const channel = { id: 'ch-1', workspaceId: WS, type: 'SMS' };
  let prisma: any;
  let svc: ConversationIngressService;

  const reply: InboundMessage = {
    externalUserId: '+905551112233', // what NetGSM ingress produces
    kind: 'PHONE',
    externalMessageId: 'netgsm-mo:1',
    text: 'evet ilgileniyorum',
    displayName: '',
  };

  beforeEach(() => {
    prisma = {
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      },
      contactIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-1', leadId: 'lead-1' }),
      },
      lead: { create: jest.fn().mockResolvedValue({ id: 'lead-new' }) },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conv-existing', status: 'OPEN' }),
        create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    svc = new ConversationIngressService(
      prisma as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { append: jest.fn().mockResolvedValue('evt') } as any,
      { push: jest.fn() } as any,
      { capture: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  it('finds an identity stored in the old 0-prefixed shape and does NOT fork a new lead', async () => {
    // The thread we opened before the fix: value "05551112233".
    prisma.contactIdentity.findFirst.mockResolvedValue({ id: 'ci-old', leadId: 'lead-1' });

    await svc.ingest(channel, reply);

    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.contactIdentity.create).not.toHaveBeenCalled();
  });

  it('searches the other spellings of the number', async () => {
    await svc.ingest(channel, reply);

    const where = prisma.contactIdentity.findFirst.mock.calls[0][0].where;
    expect(where.value.in).toEqual(expect.arrayContaining(['05551112233', '905551112233']));
    // The exact spelling was already tried by findUnique — re-querying it here
    // would be dead weight in the IN list.
    expect(where.value.in).not.toContain('+905551112233');
  });

  it('still creates a lead when the number is genuinely new', async () => {
    await svc.ingest(channel, reply);

    expect(prisma.lead.create).toHaveBeenCalled();
  });

  it('does not run a variant search for non-phone kinds', async () => {
    await svc.ingest(channel, { ...reply, kind: 'EMAIL', externalUserId: 'a@b.com' });

    // An email address has exactly one spelling; a fuzzy second lookup here
    // could only ever attach a message to the wrong contact.
    expect(prisma.contactIdentity.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * The P2002 backstop.
 *
 * The unique is now (workspaceId, externalMessageId), so a foreign tenant's
 * identical id no longer blocks the insert. The handler's workspace scoping
 * stays anyway — it is what makes the handler correct rather than merely lucky,
 * and it is the difference between "deduped" and handing a caller someone
 * else's conversation id.
 */
describe('ConversationIngressService — P2002 handling', () => {
  const WS = 'ws-1';
  const channel = { id: 'ch-1', workspaceId: WS, type: 'WHATSAPP' };
  const inbound: InboundMessage = {
    externalUserId: '+905551112233',
    kind: 'WA',
    externalMessageId: 'wamid.DUP',
    text: 'merhaba',
    displayName: 'Ayşe',
  };

  const build = (onConflictFinds: any) => {
    const prisma: any = {
      message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      contactIdentity: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async () => {
        const err: any = new Error('unique');
        err.constructor = { name: 'PrismaClientKnownRequestError' };
        Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
        err.code = 'P2002';
        throw err;
      }),
    };
    // Second lookup (inside the catch) is what decides dedup vs re-throw.
    prisma.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(onConflictFinds);
    const svc = new ConversationIngressService(
      prisma as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { append: jest.fn().mockResolvedValue('e') } as any,
      { push: jest.fn() } as any,
      { capture: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { svc, prisma };
  };

  it('reports deduped when the conflicting row is in THIS workspace', async () => {
    const { svc } = build({ id: 'm-1', conversationId: 'conv-1' });

    const res = await svc.ingest(channel, inbound);

    expect(res).toMatchObject({ deduped: true, conversationId: 'conv-1' });
  });

  it('re-throws when the scoped lookup finds nothing — never hands back a foreign thread', async () => {
    const { svc } = build(null);

    await expect(svc.ingest(channel, inbound)).rejects.toThrow();
  });
});
