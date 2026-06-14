import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export type AiModelTier = 'default' | 'light';

export interface AiCallOpts {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  tier?: AiModelTier;
  /** Cache the (large, stable) system prompt across calls. */
  cacheSystem?: boolean;
}

export interface AiCompletion {
  text: string;
  toolUses: Anthropic.ToolUseBlock[];
  stopReason: string | null;
  usage: { input: number; output: number };
}

/**
 * Thin wrapper around the Anthropic SDK — the single runtime LLM entry point.
 *
 * Hard rules baked in (Opus 4.8 surface):
 *  - NO sampling params (temperature/top_p/top_k) — they 400 on Opus 4.8/4.7.
 *  - adaptive thinking is the only on-mode; we omit `thinking` for chat-speed
 *    replies and rely on `effort` for depth where it matters.
 *  - every call carries a hard `max_tokens` cap.
 *  - the system block is cache_control'd when `cacheSystem` is set (min 4096
 *    cacheable-prefix tokens on Opus 4.8 — engages only for fat KB prompts,
 *    harmless otherwise).
 *
 * Credit metering is the caller's job (AiCreditsService.reserve before the
 * call, refund on failure) — this service only talks to the API.
 */
@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return (
      !!this.config.get<string>('ANTHROPIC_API_KEY') &&
      this.config.get<string>('AI_DISABLED') !== '1'
    );
  }

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      // Bound the per-request + retry budget so a slow/hung call can't outlive
      // the 15-min job STUCK_AFTER_MS watchdog: 120s timeout × (1 + 2 retries)
      // = ~6.5min worst case, comfortably under the 900s stuck threshold.
      this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
    }
    return this.client;
  }

  private modelFor(tier: AiModelTier): string {
    return tier === 'light'
      ? this.config.get<string>('AI_MODEL_LIGHT') || 'claude-haiku-4-5'
      : this.config.get<string>('AI_MODEL_DEFAULT') || 'claude-opus-4-8';
  }

  private buildSystem(system: string, cache: boolean): Anthropic.MessageCreateParams['system'] {
    if (!cache) return system;
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  /**
   * One-shot completion. Returns the assistant's text + any tool_use blocks;
   * the caller runs the tool loop (see conversation-ai-engine). Tool inputs
   * arrive pre-parsed on `block.input` — never string-match the raw JSON.
   */
  async complete(opts: AiCallOpts): Promise<AiCompletion> {
    const client = this.getClient();
    const res = await client.messages.create({
      model: this.modelFor(opts.tier ?? 'default'),
      max_tokens: opts.maxTokens ?? 1024,
      system: this.buildSystem(opts.system, opts.cacheSystem ?? false),
      messages: opts.messages,
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    });

    let text = '';
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolUses.push(block);
    }
    return {
      text,
      toolUses,
      stopReason: res.stop_reason,
      usage: {
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
      },
    };
  }

  /**
   * Streaming text generation (no tools) for SSE surfaces. Yields text deltas;
   * `finalMessage()` is awaited internally to surface usage if the caller
   * wants it via the returned async iterator's completion.
   */
  async *streamText(opts: AiCallOpts): AsyncIterable<string> {
    const client = this.getClient();
    const stream = client.messages.stream({
      model: this.modelFor(opts.tier ?? 'default'),
      max_tokens: opts.maxTokens ?? 1024,
      system: this.buildSystem(opts.system, opts.cacheSystem ?? false),
      messages: opts.messages,
    });
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
    }
    // Surface usage in logs for the ai.tokens.out runaway-cost alarm input.
    try {
      const final = await stream.finalMessage();
      this.logger.debug(
        `stream usage in=${final.usage.input_tokens} out=${final.usage.output_tokens}`,
      );
    } catch {
      /* stream already errored/aborted — nothing to log */
    }
  }
}
