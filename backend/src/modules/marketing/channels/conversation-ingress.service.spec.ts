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
    svc = new ConversationIngressService(prisma as any, autoAssigner as any, outbox as any, stream as any);
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
