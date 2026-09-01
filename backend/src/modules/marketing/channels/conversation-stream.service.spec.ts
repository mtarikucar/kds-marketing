import { ConversationStreamService, ConversationStreamEvent } from './conversation-stream.service';

/**
 * The wire format the agent surface reads, and the ONE thing the public widget
 * must never read.
 *
 * `leadId` was added so a client can tell WHOSE event a frame is. The person
 * surface subscribes to the whole-workspace stream and, until now, refetched
 * the selected person's record on every frame in the workspace — because
 * `conversationId` alone does not say who the frame is about. With `leadId` the
 * client refreshes the person it names and leaves the rest alone.
 *
 * The same field is a LEAK on the other stream. `forConversation` is the public
 * web-chat widget's feed: it is subscribed by a visitor holding nothing but a
 * conversation token, and a lead id is an internal identifier for a CRM record
 * they are not a party to. The kind allowlist already stops internal EVENT
 * KINDS from reaching them; this is the same rule one level down, on a field.
 */
describe('ConversationStreamService — leadId on the wire', () => {
  let svc: ConversationStreamService;

  beforeEach(() => {
    svc = new ConversationStreamService();
  });

  const event = (over: Partial<ConversationStreamEvent> = {}): ConversationStreamEvent => ({
    kind: 'message',
    conversationId: 'c-1',
    leadId: 'lead-1',
    payload: { body: 'hi' },
    ...over,
  });

  it('carries leadId to the agent surface, which is what it is for', () => {
    const seen: ConversationStreamEvent[] = [];
    svc.forWorkspace('ws-1').subscribe((e) => seen.push(e));

    svc.push('ws-1', event());

    expect(seen).toEqual([event()]);
    expect(seen[0].leadId).toBe('lead-1');
  });

  it('never sends leadId to the public web-chat widget', () => {
    const seen: Array<Record<string, unknown>> = [];
    svc.forConversation('ws-1', 'c-1').subscribe((e) => seen.push(e as never));

    svc.push('ws-1', event());

    expect(seen).toHaveLength(1);
    // Not merely undefined — ABSENT. A key serialized as `"leadId":null` still
    // tells the visitor the field exists and that their thread has one.
    expect(Object.keys(seen[0])).not.toContain('leadId');
    // The rest of the frame is untouched: stripping one field must not cost
    // the visitor their message.
    expect(seen[0]).toEqual({
      kind: 'message',
      conversationId: 'c-1',
      payload: { body: 'hi' },
    });
  });

  it('leaves a frame that never had a leadId alone', () => {
    const seen: Array<Record<string, unknown>> = [];
    svc.forConversation('ws-1', 'c-1').subscribe((e) => seen.push(e as never));

    svc.push('ws-1', { kind: 'ai_typing', conversationId: 'c-1', payload: { typing: true } });

    expect(seen).toEqual([{ kind: 'ai_typing', conversationId: 'c-1', payload: { typing: true } }]);
  });


  it('still keeps workspaces apart once the field exists', () => {
    const seen: ConversationStreamEvent[] = [];
    svc.forWorkspace('ws-1').subscribe((e) => seen.push(e));

    svc.push('ws-2', event({ leadId: 'lead-of-other-tenant' }));

    expect(seen).toEqual([]);
  });
});

/**
 * The OTHER half of the same rule, and the bigger leak of the two.
 *
 * Stopping `leadId` was one field on the envelope. `payload` is where the row
 * itself rides, and `message-sender.service.ts` pushes the whole `Message`
 * straight off `tx.message.create` with no `select` — so before this, a
 * visitor holding nothing but a conversation token received `workspaceId`,
 * `authorId` (an internal MarketingUser id), `externalMessageId`, `status`,
 * `error`, `meta`, `smsSegments` and `costAmount`: the per-message cost of
 * talking to them.
 *
 * The endpoint BESIDE it already knew better. `GET /webchat/:widgetKey/history`
 * selects exactly `id, direction, authorType, body, createdAt`, and the two
 * feed one widget — history paints the thread on load, the stream appends to
 * it live. Two shapes for one conversation, and the live one leaked strictly
 * more than the REST one.
 *
 * These pin the KEY SET rather than the values, because the key set is what
 * regresses: values are what a test author looks at, and a new column arrives
 * without anybody writing a line about it.
 */
describe('ConversationStreamService — what a visitor may see of a message', () => {
  let svc: ConversationStreamService;

  beforeEach(() => {
    svc = new ConversationStreamService();
  });

  /** The five columns webchat-public.controller.ts's /history selects. */
  const HISTORY_FIELDS = ['id', 'direction', 'authorType', 'body', 'createdAt'];

  /** A `Message` row as Prisma hands it back — every column, which is exactly
   *  what the sender pushes. */
  const fullRow = () => ({
    id: 'm-1',
    workspaceId: 'ws-1',
    conversationId: 'c-1',
    direction: 'OUTBOUND',
    authorType: 'AGENT',
    authorId: 'internal-user-7',
    body: 'merhaba',
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    externalMessageId: 'wamid.abc',
    status: 'SENT',
    error: null,
    meta: { provider: 'meta' },
    smsSegments: 2,
    costAmount: '0.0431',
  });

  const collect = () => {
    const seen: Array<Record<string, unknown>> = [];
    svc.forConversation('ws-1', 'c-1').subscribe((e) => seen.push(e as never));
    return seen;
  };

  const pushFullRow = () =>
    svc.push('ws-1', {
      kind: 'message',
      conversationId: 'c-1',
      leadId: 'lead-1',
      payload: fullRow(),
    });

  it('sends the visitor EXACTLY the five fields /history selects', () => {
    const seen = collect();
    pushFullRow();

    expect(seen).toHaveLength(1);
    const payload = seen[0].payload as Record<string, unknown>;
    // Sorted: the ORDER of a projection is not a promise, its membership is.
    expect(Object.keys(payload).sort()).toEqual([...HISTORY_FIELDS].sort());
    expect(payload).toEqual({
      id: 'm-1',
      direction: 'OUTBOUND',
      authorType: 'AGENT',
      body: 'merhaba',
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
    });
  });

  it('never sends the per-message COST, or any other internal column', () => {
    const seen = collect();
    pushFullRow();

    const keys = Object.keys(seen[0].payload as object);
    // Named one at a time rather than as "not in the allowlist", so a failure
    // reads as the sentence it is: the customer was shown what we charge.
    for (const internal of [
      'costAmount',
      'smsSegments',
      'authorId',
      'workspaceId',
      'externalMessageId',
      'status',
      'error',
      'meta',
    ]) {
      expect(keys).not.toContain(internal);
    }
  });

  it('rebuilds rather than filters, so a NEW column cannot leak by default', () => {
    const seen = collect();

    svc.push('ws-1', {
      kind: 'message',
      conversationId: 'c-1',
      payload: { ...fullRow(), aColumnNobodyHasWrittenYet: 'internal' },
    });

    expect(Object.keys(seen[0].payload as object)).not.toContain('aColumnNobodyHasWrittenYet');
  });

  it('keeps the ENVELOPE to three keys for the same reason', () => {
    const seen = collect();
    pushFullRow();

    expect(Object.keys(seen[0]).sort()).toEqual(['conversationId', 'kind', 'payload']);
  });

  it('still gives the AGENT stream the whole row — the projection is per-audience', () => {
    // The narrowing belongs to the visitor, not to the product. The agent
    // Inbox reads delivery status and errors off these frames, so a test that
    // pinned the narrow shape on forWorkspace would be pinning a regression.
    const seen: ConversationStreamEvent[] = [];
    svc.forWorkspace('ws-1').subscribe((e) => seen.push(e));

    pushFullRow();

    expect(seen[0].payload).toEqual(fullRow());
    expect(seen[0].leadId).toBe('lead-1');
  });
});
