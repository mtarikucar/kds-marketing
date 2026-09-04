import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import Anthropic from '@anthropic-ai/sdk';

export type AiModelTier = 'default' | 'balanced' | 'light' | 'conversation';

export interface AiCallOpts {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** Force a specific tool (or `any`/`auto`) — e.g. a mandatory final submit. */
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
  maxTokens?: number;
  tier?: AiModelTier;
  /** Cache the (large, stable) system prompt across calls. */
  cacheSystem?: boolean;
  /**
   * Cache the TOOL DEFINITIONS across the turns of one loop.
   *
   * A tool loop re-sends every schema on every turn, and schemas dwarf the
   * conversation: the MCP command bar ships ~12.000 tokens of them per turn,
   * so an 8-turn command paid Opus input price for ~98.000 tokens of text
   * that never changed. Anthropic caches everything up to the breakpoint, so
   * one `cache_control` on the LAST tool covers the whole block (and the
   * system prompt before it) at 0.1x on every turn after the first.
   *
   * Only worth setting on multi-turn loops — a one-shot call pays the 1.25x
   * cache-write premium for a cache nothing will read.
   */
  cacheTools?: boolean;
  /**
   * Cache the CONVERSATION PREFIX between the turns of one loop.
   *
   * `cacheSystem`/`cacheTools` only cover the static header. In a tool loop
   * that header is the small part: research re-sends every prior tool result
   * on every turn, each sliced to 8.000 characters, so by turn eight the
   * transcript dwarfs the ~611 tokens of tool schema. August's invoice shows
   * it — 2,59M Opus input tokens against only 233k cache reads, i.e. 92% of
   * the input paid full price for text the model had already been sent.
   *
   * Marking the last block of the final message makes everything before it a
   * cache prefix, so the next turn reads the whole transcript at 0.1x and
   * writes only its own increment at 1.25x. Anthropic ignores a breakpoint
   * under the minimum cacheable length, so a short conversation simply gets
   * nothing rather than an error.
   */
  cacheConversation?: boolean;
  /**
   * Pass BOTH to record measured token usage (AiUsageLog). Optional so no call
   * site is forced to change, but every metered action should supply them:
   * without measurement every credit price in ai-credit-costs.ts stays a
   * max_tokens-ceiling guess, which is what they all are today.
   */
  workspaceId?: string;
  action?: string;
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
/**
 * How long the platform key stays shut after the vendor refuses the ACCOUNT.
 *
 * Short, because the cure is a top-up and the operator should not have to
 * restart anything for the product to come back; long enough that a dry key
 * is not re-probed by every one of the two dozen callers. Each expiry costs
 * exactly one failed call to re-learn.
 */
export const PLATFORM_AI_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Does this error mean the ACCOUNT cannot serve, as opposed to this call
 * failing?
 *
 * The distinction is the whole safety of the breaker. A rate limit, an
 * overload, a socket timeout — all transient, all already handled by the SDK's
 * retries, and tripping on any of them would take AI down for every workspace
 * over a blip. What belongs here is only what a retry cannot fix: no credit, a
 * rejected key, a revoked permission.
 *
 * The credit case is matched on the message because Anthropic reports it as a
 * generic `invalid_request_error` with a 400 — the same shape as a malformed
 * request, which must NOT trip anything. Matching the wording is a bounded
 * risk: if it changes we stop tripping and behave exactly as before.
 */
export function isAccountLevelAiFailure(err: unknown): false | string {
  const e = err as { status?: number; error?: { error?: { type?: string; message?: string } }; message?: string };
  const status = e?.status;
  const inner = e?.error?.error;
  const message = String(inner?.message ?? e?.message ?? '');
  if (status === 401) return 'the API key was rejected';
  if (status === 403) return 'the API key lacks permission';
  if (status === 400 && /credit balance is too low/i.test(message)) return 'the account is out of credit';
  return false;
}

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private client: Anthropic | null = null;

  /**
   * When the platform key is known not to work, and why.
   *
   * ── WHY A GATE AND NOT JUST A LOG ───────────────────────────────────────
   *
   * `isEnabled()` used to ask "is a key configured", and every one of the two
   * dozen callers treats a false from it as "AI is off" and takes a graceful
   * path it already implements — declining a reply with a reason, returning
   * `skipped: 'ai-not-configured'`, marking a brand-safety verdict UNAVAILABLE.
   * Those paths are good, and a dry key reached none of them: the key EXISTED,
   * so the gate said yes, the call went out, and a raw vendor 400 came back
   * through whatever surface asked — including, verbatim, out of an MCP tool
   * result.
   *
   * The daily digest already spots this after the fact (`scheduled_jobs
   * .lastError contains 'credit balance'), which reports the outage but does
   * not stop it. This is the other half: the system behaves correctly WHILE it
   * is happening, and every existing decline path starts working for the case
   * they were written for.
   *
   * Per-process and in-memory on purpose. It is a cache of a fact the vendor
   * will happily repeat, so a second instance costs one extra failed call to
   * learn the same thing — which is far cheaper than a table, a write on the
   * AI hot path, and a second source of truth to keep fresh.
   */
  private unusableUntil = 0;
  private unusableReason: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What the operator has to fix, or null while the platform key is fine.
   *
   * Exposed so a panel or a health check can say WHICH failure this is —
   * "out of credit" and "key rejected" have different fixes, and a caller that
   * only sees `isEnabled(): false` cannot tell either from "AI was never set
   * up".
   */
  platformAiUnavailable(): { reason: string; until: Date } | null {
    if (Date.now() >= this.unusableUntil || !this.unusableReason) return null;
    return { reason: this.unusableReason, until: new Date(this.unusableUntil) };
  }

  isEnabled(): boolean {
    // A key that the vendor is refusing is not a configured key, for every
    // purpose a caller uses this for.
    if (Date.now() < this.unusableUntil) return false;
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
    if (tier === 'light') {
      // Dated id, not the bare alias — see the conversation tier below.
      return this.config.get<string>('AI_MODEL_LIGHT') || 'claude-haiku-4-5-20251001';
    }
    if (tier === 'balanced') {
      // Between Haiku and Opus there was nothing, so every action needing more
      // than a classifier got Opus by default — 19 of the 26 metered actions.
      // Sonnet is ~40% of Opus input and ~60% of output, and for drafting and
      // Q&A over the workspace's own data the quality difference does not show.
      return this.config.get<string>('AI_MODEL_BALANCED') || 'claude-sonnet-4-6';
    }
    if (tier === 'conversation') {
      // Inbound customer replies are short + KB-grounded — a fast/cheap tier
      // handles them well. Defaults to Haiku; override with AI_MODEL_CONVERSATION
      // (e.g. claude-sonnet-4-6 or claude-opus-4-8) to A/B without a code change.
      //
      // `claude-haiku-4-5` is NOT a resolvable id. Opus and Sonnet publish bare
      // aliases (claude-opus-4-8, claude-sonnet-4-6, both in use here and both
      // working); Haiku 4.5 does not, and every call on this tier failed at the
      // API before a token was billed.
      //
      // The proof was in this repo's own usage: 30 days of AiUsageLog show
      // claude-opus-4-8, claude-sonnet-4-6 and claude-haiku-4-5-20251001 — the
      // dated form, from NativeWebProvider, 106 successful calls — and not one
      // call on the bare alias. Every action on the conversation and light
      // tiers had zero recorded usage, including conversation.reply: the AI had
      // never answered a customer, on any channel, ever.
      return this.config.get<string>('AI_MODEL_CONVERSATION') || 'claude-haiku-4-5-20251001';
    }
    return this.config.get<string>('AI_MODEL_DEFAULT') || 'claude-opus-4-8';
  }

  /**
   * Stamp the cache breakpoint on the LAST tool. Anthropic caches the prefix
   * up to and including the marked block, so one breakpoint at the end covers
   * every tool — and the system prompt ahead of it — in a single cache entry.
   * Marking each tool individually would burn the four-breakpoint budget for
   * no extra benefit.
   */
  private buildTools(tools: Anthropic.Tool[], cache: boolean): Anthropic.Tool[] {
    if (!cache || tools.length === 0) return tools;
    return tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t,
    );
  }

  /**
   * Put one cache breakpoint at the very end of the conversation, which makes
   * everything before it a reusable prefix on the NEXT turn.
   *
   * String content is promoted to a text block first — `cache_control` lives
   * on a content block, and a plain string has nowhere to carry it. The input
   * is copied rather than mutated: callers keep their own `messages` array
   * across turns and a stray breakpoint left in it would accumulate, blowing
   * the four-breakpoint budget after a few iterations.
   */
  private cachePrefix(
    messages: Anthropic.MessageParam[],
    cache: boolean,
  ): Anthropic.MessageParam[] {
    if (!cache || messages.length === 0) return messages;
    const last = messages[messages.length - 1];
    const blocks: Anthropic.ContentBlockParam[] =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }]
        : [...(last.content as Anthropic.ContentBlockParam[])];
    if (blocks.length === 0) return messages;

    const tail = blocks[blocks.length - 1];
    blocks[blocks.length - 1] = {
      ...tail,
      cache_control: { type: 'ephemeral' as const },
    } as Anthropic.ContentBlockParam;

    return [...messages.slice(0, -1), { ...last, content: blocks }];
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
    let res: Anthropic.Message;
    try {
      res = await client.messages.create({
        model: this.modelFor(opts.tier ?? 'default'),
        max_tokens: opts.maxTokens ?? 1024,
        system: this.buildSystem(opts.system, opts.cacheSystem ?? false),
        messages: this.cachePrefix(opts.messages, opts.cacheConversation ?? false),
        ...(opts.tools && opts.tools.length
          ? { tools: this.buildTools(opts.tools, opts.cacheTools ?? false) }
          : {}),
        ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      });
    } catch (err) {
      // Only an ACCOUNT-level refusal closes the gate. Everything else — a
      // rate limit, an overload, a timeout — is this call's problem and is
      // rethrown untouched, because taking AI down for every workspace over a
      // transient blip is a worse outage than the one being prevented.
      const accountLevel = isAccountLevelAiFailure(err);
      if (accountLevel) {
        this.unusableUntil = Date.now() + PLATFORM_AI_COOLDOWN_MS;
        this.unusableReason = accountLevel;
        // ERROR, and naming the operator's fix: this is a platform-wide
        // outage of every AI feature for every workspace, and until now its
        // only trace was whatever surface the raw 400 happened to reach.
        this.logger.error(
          `platform AI unavailable — ${accountLevel}. All AI features will decline for the next ` +
            `${Math.round(PLATFORM_AI_COOLDOWN_MS / 60000)} minutes, then retry once.`,
        );
      }
      throw err;
    }

    let text = '';
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolUses.push(block);
    }

    void this.recordUsage(opts, res.usage);

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
   * Persist what the call actually consumed.
   *
   * Fire-and-forget on purpose: this is telemetry, and losing a row must never
   * fail a customer's AI call or add latency to it. Silently skipped when the
   * caller did not identify itself — a log line with no workspace and no action
   * cannot be turned into a price.
   */
  /**
   * Record a call this service did NOT make.
   *
   * `complete()` is meant to be the single LLM entry point, but a caller that
   * needs Anthropic's SERVER tools (web_search) cannot express that through
   * its options — so NativeWebProvider holds its own client, and every token
   * and every billed search it spent was invisible. This is the narrow door
   * that keeps such a caller inside the accounting instead of outside it.
   */
  async recordExternalUsage(
    workspaceId: string,
    action: string,
    usage: Anthropic.Usage,
    model: string,
  ): Promise<void> {
    await this.recordUsage({ workspaceId, action } as AiCallOpts, usage, model);
  }

  private async recordUsage(
    opts: AiCallOpts,
    usage: Anthropic.Usage,
    modelOverride?: string,
  ): Promise<void> {
    if (!opts.workspaceId || !opts.action) return;
    // Cache tokens are reported OUTSIDE `input_tokens` and billed at their own
    // rates (write 1.25x, read 0.1x). Once tool-schema caching is on, most of
    // the input volume lives in these two fields — recording only
    // `input_tokens` would report the saving as total instead of ~90%.
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
    try {
      await this.prisma.aiUsageLog.create({
        data: {
          workspaceId: opts.workspaceId,
          action: opts.action,
          model: modelOverride ?? this.modelFor(opts.tier ?? 'default'),
          inputTokens,
          outputTokens,
          cacheWriteTokens,
          cacheReadTokens,
          webSearches,
        },
      });
    } catch (e) {
      this.logger.warn(`ai usage log failed (${opts.action}): ${(e as Error)?.message ?? e}`);
    }
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
