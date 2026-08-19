import { AnthropicService } from './anthropic.service';

/**
 * August's invoice: 2,59M Opus input tokens against 233k cache reads. 92% of
 * the input paid full price for text the model had already been sent, because
 * only the static header was cached and in a tool loop the header is the small
 * part — research re-sends every prior tool result, 8.000 chars each, on every
 * turn.
 */
describe('AnthropicService — prompt caching', () => {
  let create: jest.Mock;
  let svc: AnthropicService;

  const usage = { input_tokens: 1, output_tokens: 1 };

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ content: [], stop_reason: 'end_turn', usage });
    svc = new AnthropicService(
      { get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'test-key' : undefined) } as never,
      { aiUsageLog: { create: jest.fn() } } as never,
    );
    (svc as never as { client: unknown }).client = { messages: { create } };
    jest.spyOn(svc as never as { getClient: () => unknown }, 'getClient').mockReturnValue({
      messages: { create },
    });
  });

  const call = (extra: Record<string, unknown>) =>
    svc.complete({
      system: 'sys',
      messages: [
        { role: 'user', content: 'find me leads' },
        { role: 'assistant', content: [{ type: 'text', text: 'searching' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first result' },
            { type: 'text', text: 'second result' },
          ],
        },
      ],
      ...extra,
    } as never);

  const body = () => create.mock.calls[0][0];

  it('adds no breakpoint unless asked', async () => {
    await call({});
    const msgs = body().messages;
    expect(JSON.stringify(msgs)).not.toContain('cache_control');
  });

  it('marks the LAST block of the LAST message — everything before it becomes the prefix', async () => {
    await call({ cacheConversation: true });
    const msgs = body().messages;

    const last = msgs[msgs.length - 1].content;
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // Exactly one breakpoint: the budget is four, and system/tools want theirs.
    expect(JSON.stringify(msgs).match(/cache_control/g)).toHaveLength(1);
    expect(last[0].cache_control).toBeUndefined();
  });

  it('promotes string content to a block, since a string cannot carry the marker', async () => {
    await svc.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'plain string' }],
      cacheConversation: true,
    } as never);
    const last = create.mock.calls[0][0].messages[0].content;
    expect(last[0]).toMatchObject({ type: 'text', text: 'plain string' });
    expect(last[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not mutate the caller\'s array — breakpoints would pile up across turns', async () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'turn one' }] },
    ];
    await svc.complete({ system: 'sys', messages, cacheConversation: true } as never);
    await svc.complete({ system: 'sys', messages, cacheConversation: true } as never);

    // The caller keeps `messages` across turns of one loop. A marker left
    // behind each turn would exhaust the four-breakpoint budget in four
    // iterations.
    expect(JSON.stringify(messages)).not.toContain('cache_control');
    expect(JSON.stringify(create.mock.calls[1][0].messages).match(/cache_control/g)).toHaveLength(1);
  });

  it('caches the tool block on its last entry only', async () => {
    await call({
      cacheTools: true,
      tools: [
        { name: 'a', description: 'a', input_schema: { type: 'object' } },
        { name: 'b', description: 'b', input_schema: { type: 'object' } },
      ],
    });
    const tools = body().tools;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('stays within the four-breakpoint budget with everything switched on', async () => {
    await call({
      cacheSystem: true,
      cacheTools: true,
      cacheConversation: true,
      tools: [{ name: 'a', description: 'a', input_schema: { type: 'object' } }],
    });
    const all = JSON.stringify(body()).match(/cache_control/g) ?? [];
    expect(all.length).toBeLessThanOrEqual(4);
  });
});
