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
    const seen: ConversationStreamEvent[] = [];
    svc.forConversation('ws-1', 'c-1').subscribe((e) => seen.push(e));

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
    const seen: ConversationStreamEvent[] = [];
    svc.forConversation('ws-1', 'c-1').subscribe((e) => seen.push(e));

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
