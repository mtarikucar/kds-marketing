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
import { AnthropicService, PLATFORM_AI_COOLDOWN_MS } from './anthropic.service';
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

  /**
   * THE GATE HAS TO KNOW THE DIFFERENCE BETWEEN "OFF" AND "REFUSED".
   *
   * `isEnabled()` asked whether a key STRING existed, so a key with no credit
   * passed it. Every one of the two dozen callers then took the happy path,
   * called out, and handed a raw vendor 400 to whatever surface had asked —
   * observed in production, coming back verbatim out of an MCP tool result.
   *
   * The risky half of this fix is the false trip: closing the gate on a blip
   * would take AI down for every workspace, which is a worse outage than the
   * one being prevented. So most of what follows pins what must NOT trip it.
   */
  describe('platform-key circuit breaker', () => {
    const KEY = { ANTHROPIC_API_KEY: 'sk-test' };

    // Self-contained rather than borrowing the outer helper: this block lives
    // beside a second describe whose fixtures are about model ids.
    const make = (env: Record<string, string | undefined>) =>
      new AnthropicService({ get: (k: string) => env[k] } as any, undefined as any);

    beforeEach(() => mockCreate.mockReset());

    /** The shape the SDK actually throws: status + a nested error envelope. */
    const apiError = (status: number, type: string, message: string) =>
      Object.assign(new Error(message), { status, error: { error: { type, message } } });

    const CREDIT = () =>
      apiError(400, 'invalid_request_error',
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');

    async function callAndCatch(svc: AnthropicService) {
      await expect(svc.complete({ messages: [{ role: 'user', content: 'hi' }] } as any)).rejects.toBeDefined();
    }

    it('closes the gate when the account is out of credit', async () => {
      const svc = make(KEY);
      expect(svc.isEnabled()).toBe(true);
      mockCreate.mockRejectedValueOnce(CREDIT());
      await callAndCatch(svc);
      expect(svc.isEnabled()).toBe(false);
      expect(svc.platformAiUnavailable()?.reason).toBe('the account is out of credit');
    });

    it('closes it when the key itself is rejected', async () => {
      const svc = make(KEY);
      mockCreate.mockRejectedValueOnce(apiError(401, 'authentication_error', 'invalid x-api-key'));
      await callAndCatch(svc);
      expect(svc.isEnabled()).toBe(false);
      expect(svc.platformAiUnavailable()?.reason).toBe('the API key was rejected');
    });

    it.each([
      ['a rate limit', apiError(429, 'rate_limit_error', 'slow down')],
      ['an overload', apiError(529, 'overloaded_error', 'overloaded')],
      ['a server error', apiError(500, 'api_error', 'internal')],
      ['a socket timeout', Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })],
      ['a MALFORMED request, which is also a 400', apiError(400, 'invalid_request_error', 'messages: field required')],
    ])('leaves the gate open on %s', async (_label, err) => {
      // Every one of these is either transient or this call's own fault. None
      // says the account cannot serve, and closing on any of them would be an
      // outage caused by the outage detector.
      const svc = make(KEY);
      mockCreate.mockRejectedValueOnce(err);
      await callAndCatch(svc);
      expect(svc.isEnabled()).toBe(true);
      expect(svc.platformAiUnavailable()).toBeNull();
    });

    it('still throws the original error, so callers refund and retry as before', async () => {
      // The breaker observes; it must not swallow. Credit reservation is the
      // caller's job and it refunds on the throw.
      const svc = make(KEY);
      const err = CREDIT();
      mockCreate.mockRejectedValueOnce(err);
      await expect(svc.complete({ messages: [{ role: 'user', content: 'hi' }] } as any)).rejects.toBe(err);
    });

    it('reopens on its own, so a top-up needs no restart', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00Z'));
      try {
        const svc = make(KEY);
        mockCreate.mockRejectedValueOnce(CREDIT());
        await callAndCatch(svc);
        expect(svc.isEnabled()).toBe(false);

        jest.setSystemTime(new Date(Date.now() + PLATFORM_AI_COOLDOWN_MS + 1));
        expect(svc.isEnabled()).toBe(true);
        expect(svc.platformAiUnavailable()).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('stays shut for AI_DISABLED regardless, which is a different switch', async () => {
      const svc = make({ ...KEY, AI_DISABLED: '1' });
      expect(svc.isEnabled()).toBe(false);
    });
  });
});
