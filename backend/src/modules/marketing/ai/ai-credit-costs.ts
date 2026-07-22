import { AiModelTier } from './anthropic.service';

/**
 * Credit cost per AI action — the unit customers are metered/billed on.
 * Pinned by ai-credit-costs.tripwire.spec.ts so a new AI action can't ship
 * without an explicit cost decision. ~1 credit ≈ one default-tier action.
 */
export const AI_CREDIT_COSTS = {
  'conversation.reply': { credits: 1, tier: 'conversation' as AiModelTier },
  'conversation.followup': { credits: 1, tier: 'conversation' as AiModelTier },
  'content.compose': { credits: 1, tier: 'default' as AiModelTier },
  'workflow.ai_generate': { credits: 1, tier: 'default' as AiModelTier },
  'workflow.ai_classify': { credits: 1, tier: 'light' as AiModelTier },
  'ask_ai.question': { credits: 2, tier: 'default' as AiModelTier },
  'workflow.draft': { credits: 2, tier: 'default' as AiModelTier },
  'funnel.draft': { credits: 3, tier: 'default' as AiModelTier },
  'review.reply_draft': { credits: 1, tier: 'default' as AiModelTier },
  'voice.turn': { credits: 2, tier: 'default' as AiModelTier },
  // Voice-AI Phase 5.2 cost decisions (were numeric literals in the services):
  'voice.analysis': { credits: 3, tier: 'default' as AiModelTier },
  'voice.copilot': { credits: 1, tier: 'conversation' as AiModelTier },
  // AI Social Content Studio — per-model estimate (media-models.config) governs
  // the reserve; these are the registered floor + tripwire-pinned cost decision.
  'media.image.generate': { credits: 3, tier: 'default' as AiModelTier },
  'media.video.generate': { credits: 15, tier: 'default' as AiModelTier },
  // AI Research engine — one prospect-research agent run (multi-step Opus tool-loop
  // over firecrawl/apify sources). The reserve is a per-run ceiling; the loop's
  // hard caps bound actual spend. firecrawl/apify money is metered separately via
  // the RESEARCH SpendLedger channel.
  'research.qualify': { credits: 3, tier: 'default' as AiModelTier },
  // Social publishing — X (Twitter) is the ONLY network with a real per-post API
  // cost, so it's the only publish action metered into AI credits (Meta/IG/
  // LinkedIn/TikTok publishing is free and stays uncharged). X charges ~$0.015/plain
  // post and ~$0.20/link post; at ~$0.01/credit (rounded up to never under-charge,
  // per media-models.config's anchor) → 2 and 20 credits. `tier` is unused here
  // (publishing never calls an LLM) — 'light' is a harmless placeholder.
  'social.publish.x': { credits: 2, tier: 'light' as AiModelTier },
  'social.publish.x_link': { credits: 20, tier: 'light' as AiModelTier },
  // Brand Brain — one synthesis call over all gathered source material (website
  // crawl + GBP + social + uploads) into a structured brand draft. Firecrawl/Apify
  // money is metered separately via the RESEARCH SpendLedger channel.
  'brand.analyze': { credits: 5, tier: 'default' as AiModelTier },
  // Strategy Engine — one adaptive-interview turn (a bounded onboarding tool-loop
  // that asks only the gaps + strategic intent). Cheap per-turn; the loop's hard
  // turn cap bounds total spend.
  'strategy.interview': { credits: 2, tier: 'default' as AiModelTier },
  // Strategy Engine — one full synthesis: a multi-step Claude tool-loop over
  // firecrawl/apify research that classifies the archetype and produces the
  // validated brief + ActionPlan. Firecrawl/apify money is metered separately via
  // the RESEARCH SpendLedger channel; this reserve is the per-run credit ceiling.
  'strategy.synthesize': { credits: 8, tier: 'default' as AiModelTier },
} as const;

export type AiAction = keyof typeof AI_CREDIT_COSTS;

export function creditCost(action: AiAction): number {
  return AI_CREDIT_COSTS[action].credits;
}

export function tierFor(action: AiAction): AiModelTier {
  return AI_CREDIT_COSTS[action].tier;
}
