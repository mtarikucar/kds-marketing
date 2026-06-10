import { AiModelTier } from './anthropic.service';

/**
 * Credit cost per AI action — the unit customers are metered/billed on.
 * Pinned by ai-credit-costs.tripwire.spec.ts so a new AI action can't ship
 * without an explicit cost decision. ~1 credit ≈ one default-tier action.
 */
export const AI_CREDIT_COSTS = {
  'conversation.reply': { credits: 1, tier: 'default' as AiModelTier },
  'conversation.followup': { credits: 1, tier: 'default' as AiModelTier },
  'content.compose': { credits: 1, tier: 'default' as AiModelTier },
  'workflow.ai_generate': { credits: 1, tier: 'default' as AiModelTier },
  'workflow.ai_classify': { credits: 1, tier: 'light' as AiModelTier },
  'ask_ai.question': { credits: 2, tier: 'default' as AiModelTier },
  'workflow.draft': { credits: 2, tier: 'default' as AiModelTier },
  'funnel.draft': { credits: 3, tier: 'default' as AiModelTier },
  'review.reply_draft': { credits: 1, tier: 'default' as AiModelTier },
  'voice.turn': { credits: 2, tier: 'default' as AiModelTier },
} as const;

export type AiAction = keyof typeof AI_CREDIT_COSTS;

export function creditCost(action: AiAction): number {
  return AI_CREDIT_COSTS[action].credits;
}

export function tierFor(action: AiAction): AiModelTier {
  return AI_CREDIT_COSTS[action].tier;
}
