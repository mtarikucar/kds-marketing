const mockCreate = jest.fn();
const mockStream = jest.fn();
const mockCtor = jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate, stream: mockStream },
}));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: mockCtor,
}));

import { AnthropicService } from './anthropic.service';

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
