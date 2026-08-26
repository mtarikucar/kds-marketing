// The factory must be SELF-CONTAINED: `import` bindings are hoisted above
// module-scope `const`s, so ./anthropic.service (which touches the SDK at
// require time) would read a still-uninitialised outer variable. The doubles
// are therefore created inside the factory and re-exposed on the ctor.
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const stream = jest.fn();
  const ctor: any = jest.fn().mockImplementation(() => ({
    messages: { create, stream },
  }));
  ctor.__create = create;
  ctor.__stream = stream;
  return { __esModule: true, default: ctor };
});

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicService } from './anthropic.service';
import { priceFor } from './ai-model-prices';

const mockCtor = Anthropic as unknown as jest.Mock & {
  __create: jest.Mock;
  __stream: jest.Mock;
};
const mockCreate = mockCtor.__create;
const mockStream = mockCtor.__stream;

/**
 * The single runtime LLM entry point. The hard rules it must enforce on the
 * Opus 4.8 surface are what this spec pins: NO sampling params (they 400), a
 * per-call max_tokens cap, and the env-driven model-tier selection +
 * isEnabled() kill-switch (a missing key or AI_DISABLED disables AI cleanly).
 */
describe('AnthropicService', () => {
  function make(env: Record<string, string | undefined>) {
    const config = { get: jest.fn((k: string) => env[k]) };
    return new AnthropicService(config as any);
  }

  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCtor.mockClear();
  });

  describe('client construction', () => {
    it('bounds the request budget under the 15-min job STUCK_AFTER_MS', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const svc = make({ ANTHROPIC_API_KEY: 'sk-x' });
      // Client is lazily constructed on first call.
      await svc.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });

      const opts = mockCtor.mock.calls[0][0];
      expect(opts.apiKey).toBe('sk-x');
      expect(opts.timeout).toBeLessThanOrEqual(120_000);
      expect(opts.maxRetries).toBeLessThanOrEqual(2);
      // Worst-case wall clock = timeout * (1 + maxRetries) must stay < 15 min.
      expect(opts.timeout * (1 + opts.maxRetries)).toBeLessThan(15 * 60 * 1000);
    });
  });

  describe('isEnabled', () => {
    it('is true with a key and no kill-switch', () => {
      expect(make({ ANTHROPIC_API_KEY: 'sk-x' }).isEnabled()).toBe(true);
    });
    it('is false without a key', () => {
      expect(make({}).isEnabled()).toBe(false);
    });
    it('is false when AI_DISABLED=1 even with a key', () => {
      expect(make({ ANTHROPIC_API_KEY: 'sk-x', AI_DISABLED: '1' }).isEnabled()).toBe(false);
    });
  });

  describe('complete', () => {
    it('parses text + tool_use, returns usage, and sends NO sampling params', async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use', id: 't1', name: 'capture', input: { a: 1 } },
          { type: 'text', text: 'world' },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 7 },
      });

      const svc = make({ ANTHROPIC_API_KEY: 'sk-x' });
      const res = await svc.complete({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(res.text).toBe('hello world');
      expect(res.toolUses).toHaveLength(1);
      expect(res.toolUses[0].name).toBe('capture');
      expect(res.stopReason).toBe('tool_use');
      expect(res.usage).toEqual({ input: 12, output: 7 });

      const arg = mockCreate.mock.calls[0][0];
      expect(arg.model).toBe('claude-opus-4-8'); // default-tier fallback
      expect(arg.max_tokens).toBe(1024); // default cap
      expect(arg).not.toHaveProperty('temperature');
      expect(arg).not.toHaveProperty('top_p');
      expect(arg).not.toHaveProperty('top_k');
      expect(arg).not.toHaveProperty('tools'); // none requested → key omitted
    });

    it('routes the light tier to the configured light model', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const svc = make({ ANTHROPIC_API_KEY: 'sk-x', AI_MODEL_LIGHT: 'claude-haiku-4-5' });
      await svc.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tier: 'light', maxTokens: 256 });

      const arg = mockCreate.mock.calls[0][0];
      expect(arg.model).toBe('claude-haiku-4-5');
      expect(arg.max_tokens).toBe(256);
    });
  });

  describe('streamText', () => {
    it('yields only text deltas', async () => {
      async function* gen() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } };
      }
      const it: any = gen();
      it.finalMessage = async () => ({ usage: { input_tokens: 1, output_tokens: 2 } });
      mockStream.mockReturnValue(it);

      const svc = make({ ANTHROPIC_API_KEY: 'sk-x' });
      const chunks: string[] = [];
      for await (const t of svc.streamText({ system: 's', messages: [{ role: 'user', content: 'x' }] })) {
        chunks.push(t);
      }
      expect(chunks).toEqual(['he', 'llo']);
    });
  });
});

/**
 * Model ids have to be RESOLVABLE, not merely plausible.
 *
 * The conversation and light tiers both defaulted to `claude-haiku-4-5`. Opus
 * and Sonnet publish bare aliases — claude-opus-4-8 and claude-sonnet-4-6 are
 * used here and both work — so a bare Haiku alias looked right by symmetry. It
 * is not one, and every call on those two tiers failed at the API before a
 * token was billed.
 *
 * The evidence was in the product's own AiUsageLog: 30 days showed
 * claude-opus-4-8, claude-sonnet-4-6 and claude-haiku-4-5-20251001 (the dated
 * form, from NativeWebProvider, 106 successful calls) — and not one call on the
 * bare alias. Every action on the conversation and light tiers had zero
 * recorded usage, conversation.reply included: the AI had never answered a
 * customer on any channel.
 *
 * A wrong model id fails from the OUTSIDE of this service — an exception in the
 * SDK, no usage row, no cost — so nothing in the product reports it. Pinned
 * here because that silence is what let it survive.
 */
describe('AnthropicService — tier model ids are resolvable', () => {
  const HAIKU = 'claude-haiku-4-5-20251001';

  const modelSentFor = async (tier: string, env: Record<string, string> = {}) => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const svc = new AnthropicService({
      get: (k: string) => ({ ANTHROPIC_API_KEY: 'sk-x', ...env })[k],
    } as never);
    await svc.complete({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tier: tier as never,
    });
    return mockCreate.mock.calls[0][0].model as string;
  };

  it('sends the conversation tier to the dated Haiku id, never the bare alias', async () => {
    await expect(modelSentFor('conversation')).resolves.toBe(HAIKU);
  });

  it('sends the light tier to the dated Haiku id too', async () => {
    await expect(modelSentFor('light')).resolves.toBe(HAIKU);
  });

  it('still lets the env override either tier', async () => {
    await expect(
      modelSentFor('conversation', { AI_MODEL_CONVERSATION: 'claude-sonnet-4-6' }),
    ).resolves.toBe('claude-sonnet-4-6');
  });

  it('prices the dated id as Haiku rather than falling back to the dearest tier', () => {
    // priceFor matches on substring and defaults UNKNOWN ids to the most
    // expensive tier, so a dated id that stopped matching would silently
    // inflate every cost report instead of failing.
    expect(priceFor(HAIKU)).toEqual(priceFor('claude-haiku-4-5'));
    expect(priceFor(HAIKU)).not.toEqual(priceFor('some-unknown-model'));
  });
});
