import { AiModelTier } from './anthropic.service';

/**
 * Credit cost per AI action — the unit customers are metered/billed on.
 * Pinned by ai-credit-costs.tripwire.spec.ts so a new AI action can't ship
 * without an explicit cost decision.
 *
 * THE ANCHOR: 1 credit ≈ $0.01 of vendor spend (media-models.config.ts:26-27).
 * That held for fal.ai and broke badly for the LLM agents, because a single
 * reserve covered a WHOLE tool-loop: `strategy.synthesize` charged 8 credits
 * for up to ten Opus calls at maxTokens 4000, a worst case near $1.50. The
 * same 6.000-credit allowance could therefore cost anywhere from ~$3.60 (all
 * classify) to ~$1.980 (all research) — a 550x spread. A credit cap was not a
 * dollar cap.
 *
 * THE FIX: loops charge PER TURN (`*.turn` below), so cost tracks work done
 * instead of a guessed per-run ceiling, and the loop's own MAX_ITERS bounds
 * the total. Single-call actions are priced from their `maxTokens` ceiling at
 * Opus 4.8 rates ($5/MTok in, $25/MTok out) rounded up — never under-charge.
 *
 * RESEARCH ON SONNET (2026-08-18). Measured: research.turn was 99% of all AI
 * spend, at ~$0.094/turn on Opus with an input:output ratio of 51:1 — the bill
 * is crawled page text, not reasoning. Prompt caching barely helps it either;
 * RESEARCH_TOOLS is only ~611 tokens against ~17.000 input tokens per call, so
 * the cacheable prefix is under 4% of the spend.
 *
 * The task is extract-and-qualify from source material rather than open
 * judgment, and its output is gated: candidates land PENDING and reach the
 * lead pool only through an explicit accept. That bounds the downside of a
 * marginally weaker extraction, which is what makes this the right lever —
 * cutting the cost ~60% beats raising the price, since the customer pays the
 * same and we pay less. At 7 credits it also stops being sold under cost
 * (costRatio was 1.34 on Opus).
 *
 * TIERS (2026-08). There used to be nothing between Haiku and Opus, so every
 * action needing more than a classifier landed on Opus — 19 of 26. The five
 * moved to `balanced` (Sonnet) are drafting and Q&A over the workspace's own
 * data, where the quality difference does not show. The ones left on Opus are
 * the judgment-heavy runs: research, strategy, brand analysis, funnel drafting.
 * Measured cost per action now lives in AiUsageLog — read it with
 * `jeeta.get_ai_usage` before moving anything else.
 *
 * CAVEAT worth knowing before re-tuning: these are derived from token
 * CEILINGS, not measurement. `anthropic.service.ts` returns real `usage` on
 * every call and every caller discards it. Logging that is the honest way to
 * set these numbers; until then they are deliberately conservative.
 */
export const AI_CREDIT_COSTS = {
  // Haiku, ~2 calls, ~0.35k out → ~$0.006. Genuinely a 1-credit action.
  'conversation.reply': { credits: 1, tier: 'conversation' as AiModelTier },
  'conversation.followup': { credits: 1, tier: 'conversation' as AiModelTier },
  // Opus at maxTokens 1500 → ~$0.022.
  'content.compose': { credits: 3, tier: 'default' as AiModelTier },
  // Opus at maxTokens 800 → ~$0.014.
  'workflow.ai_generate': { credits: 2, tier: 'balanced' as AiModelTier },
  // Haiku at maxTokens 16 → ~$0.0006. The most profitable row in the table.
  'workflow.ai_classify': { credits: 1, tier: 'light' as AiModelTier },
  // Base + per-turn: the loop runs up to MAX_ITERS Opus calls (ask-ai.service).
  'ask_ai.question': { credits: 1, tier: 'balanced' as AiModelTier },
  'ask_ai.turn': { credits: 3, tier: 'balanced' as AiModelTier },
  // Opus at maxTokens 1500 → ~$0.022.
  'workflow.draft': { credits: 3, tier: 'balanced' as AiModelTier },
  // Opus at maxTokens 4000 → ~$0.081. Was 3 (≈$0.03) — under-priced 3x.
  'funnel.draft': { credits: 9, tier: 'default' as AiModelTier },
  // Opus at maxTokens 400 → ~$0.012.
  'review.reply_draft': { credits: 2, tier: 'balanced' as AiModelTier },
  'voice.turn': { credits: 2, tier: 'balanced' as AiModelTier },
  // Voice-AI Phase 5.2 cost decisions (were numeric literals in the services):
  'voice.analysis': { credits: 3, tier: 'default' as AiModelTier },
  // Speech-to-text (Deepgram/Whisper via STT_API_KEY — a JEETA-owned key).
  // Charged PER MINUTE of audio, rounded up. This was billed to nobody: the
  // transcription ran before any reserve, so a workspace with zero credits
  // still burned Jeeta's STT money, and a call whose transcript came back
  // empty was never charged at all. `tier` is unused (no LLM call) — 'light'
  // is a harmless placeholder, as with the social-publish rows.
  'stt.minute': { credits: 1, tier: 'light' as AiModelTier },
  'voice.copilot': { credits: 1, tier: 'conversation' as AiModelTier },
  // AI Social Content Studio — per-model estimate (media-models.config) governs
  // the reserve; these are the registered floor + tripwire-pinned cost decision.
  'media.image.generate': { credits: 3, tier: 'default' as AiModelTier },
  'media.video.generate': { credits: 15, tier: 'default' as AiModelTier },
  // AI Research engine — a prospect-research agent run: a multi-step Opus
  // tool-loop over firecrawl/apify sources, up to MAX_ITERS=8 calls at
  // maxTokens 4000 with context growing every turn. A flat 3-credit per-RUN
  // reserve meant a long run cost Jeeta ~$1.00 and the customer $0.03.
  // Charged as a small base + per turn instead, so the meter tracks the work.
  'research.qualify': { credits: 2, tier: 'balanced' as AiModelTier },
  'research.turn': { credits: 7, tier: 'balanced' as AiModelTier },
  // Social publishing — X (Twitter) is the ONLY network with a real per-post API
  // cost, so it's the only publish action metered into AI credits (Meta/IG/
  // LinkedIn/TikTok publishing is free and stays uncharged). X charges ~$0.015/plain
  // post and ~$0.20/link post; at ~$0.01/credit (rounded up to never under-charge,
  // per media-models.config's anchor) → 2 and 20 credits. `tier` is unused here
  // (publishing never calls an LLM) — 'light' is a harmless placeholder.
  'social.publish.x': { credits: 2, tier: 'light' as AiModelTier },
  'social.publish.x_link': { credits: 20, tier: 'light' as AiModelTier },
  // Brand Brain — synthesis over all gathered source material (website crawl +
  // GBP + social + uploads) into a structured brand draft. Bounded, but big:
  // two Opus calls over a digest capped at 40.000 characters → ~$0.23.
  // Firecrawl/Apify money is metered separately via the RESEARCH SpendLedger.
  'brand.analyze': { credits: 15, tier: 'default' as AiModelTier },
  // Strategy Engine — one adaptive-interview turn (a bounded onboarding tool-loop
  // that asks only the gaps + strategic intent). Cheap per-turn; the loop's hard
  // turn cap bounds total spend.
  'strategy.interview': { credits: 2, tier: 'default' as AiModelTier },
  // Strategy Engine — one full synthesis: a multi-step Claude tool-loop over
  // firecrawl/apify research that classifies the archetype and produces the
  // validated brief + ActionPlan. This was the worst offender in the table:
  // 8 credits (≈$0.08 at the anchor) bought up to MAX_ITERS=10 Opus calls at
  // maxTokens 4000, i.e. up to ~$1.52 of vendor spend — a ~19x under-price,
  // and it ran unattended from a nightly cron on top. Charged as base + turn.
  // Firecrawl/apify money is metered separately via the RESEARCH SpendLedger.
  'strategy.synthesize': { credits: 3, tier: 'default' as AiModelTier },
  'strategy.turn': { credits: 8, tier: 'default' as AiModelTier },
  // Command bar — the home screen's "just tell it what you want" loop. Same
  // shape as ask_ai (base + per turn) but priced higher per turn: it carries
  // the advertised MCP catalogue in every request, so input tokens are far
  // larger than ask-ai's four hand-written tools, and maxTokens is 1200.
  // MAX_ITERS=8 bounds the total.
  // Anthropic's own web_search/web_fetch server tools (NativeWebProvider), the
  // keyless research fallback. Cheap Haiku tokens PLUS $0.01 per search, which
  // no token price can express — August's invoice carried 118 of them while
  // the product recorded neither the tokens nor the searches. `tier` is
  // informational here: the provider owns its own request because server tools
  // cannot be expressed through complete().
  'research.native_search': { credits: 2, tier: 'light' as AiModelTier },
  'research.native_scrape': { credits: 1, tier: 'light' as AiModelTier },
  'command.request': { credits: 1, tier: 'default' as AiModelTier },
  'command.turn': { credits: 5, tier: 'default' as AiModelTier },
  // İçerik üretim hattı — one idea into N distinct video concepts, each planned
  // shot by shot. A SINGLE forced-tool Opus call (no loop, so no `.turn` row),
  // but a wide one: the answer is N whole shot plans, so maxTokens is 6000 and
  // the output side dominates. 6000 out at $25/MTok is ~$0.15, plus a small
  // input, so 16 credits at the $0.01 anchor — priced from the ceiling like
  // funnel.draft and brand.analyze, and rounded up rather than down.
  //
  // `default` (Opus) is the point of the action rather than an oversight: the
  // whole value is judgment about which angles on an idea are genuinely
  // different, and a cheaper tier's failure mode here is precisely the five
  // paraphrases the feature exists to prevent.
  'content.concepts': { credits: 16, tier: 'default' as AiModelTier },
} as const;

export type AiAction = keyof typeof AI_CREDIT_COSTS;

export function creditCost(action: AiAction): number {
  return AI_CREDIT_COSTS[action].credits;
}

export function tierFor(action: AiAction): AiModelTier {
  return AI_CREDIT_COSTS[action].tier;
}
