/**
 * Strategy Engine — shared types.
 *
 * The engine is the single brain that turns a hybrid onboarding into a living,
 * archetype-adaptive `MarketingStrategy` driving lead/content/channel/ad
 * execution. These types are the contract shared across intake → synthesis →
 * orchestrator → executors, defined once here and referenced everywhere.
 */

/**
 * The typed action kinds the synthesis emits as an ActionPlan; each maps to one
 * executor adapter under the orchestrator.
 */
export type ActionKind =
  | 'LEAD_HUNT'
  | 'CONTENT'
  | 'CHANNEL_SETUP'
  | 'AD_CAMPAIGN'
  | 'COMMUNITY_ENGAGE';

/**
 * The business archetype the synthesis classifies a workspace into; drives the
 * channel priors, interview question deltas, and the lead approach. Tripwire-
 * pinned in archetypes.tripwire.spec.ts — adding one is a config change, never a
 * migration.
 */
export type BusinessArchetype =
  | 'B2B_LOCAL_SERVICE'
  | 'B2B_SAAS'
  | 'B2C_ECOMMERCE'
  | 'B2C_COMMUNITY_NICHE'
  | 'CREATOR_MEDIA'
  | 'LOCAL_RETAIL_FOOD'
  | 'OTHER';

/**
 * One executor adapter — the orchestrator hands it a plain executor-ready
 * payload for its kind and gets back an optional reference to the produced
 * entity (research run, staged post, ad campaign…). Executors don't know about
 * the Strategy model; they take plain config.
 */
export interface Executor {
  kind: ActionKind;
  run(workspaceId: string, payload: unknown): Promise<{ resultRef?: string }>;
}

/** A channel the strategy recommends, with its archetype-adjusted fit score. */
export interface StrategyChannel {
  /** Channel key (e.g. 'reddit', 'google-maps', 'linkedin', 'instagram'). */
  key: string;
  /** 0–1 fit score for this channel given the archetype + research. */
  fitScore: number;
  /** Why this channel fits (audience gathers here, high-intent, etc.). */
  rationale: string;
}

/** A content pillar — a recurring theme the content executor drafts against. */
export interface StrategyContentPillar {
  title: string;
  angle: string;
  /** Formats to produce for this pillar (e.g. ['reel', 'carousel', 'meme']). */
  formats: string[];
  tone: string;
}

/**
 * The full synthesized strategy. Stored as `MarketingStrategy.brief` (Json) so
 * the shape can evolve without migrations; strategy.schema.ts validates it.
 */
export interface MarketingStrategyBrief {
  identity: {
    product: string;
    voice: string;
    positioning: string;
    usp: string;
  };
  /** The ICP / audience description the executors target. */
  audience: string;
  channels: StrategyChannel[];
  contentPillars: StrategyContentPillar[];
  goals: {
    objective: string;
    kpis: string[];
  };
  /** Free-form budget description (e.g. '$500/mo ad spend, bootstrap content'). */
  budget: string;
  competitors: string[];
}

/**
 * One synthesized ActionPlan item — what synthesis emits inside its
 * `submit_strategy` finalize tool and what the orchestrator persists as a
 * `StrategyAction` row (status PROPOSED) before dispatching to the matching
 * executor. `payload` is the executor-ready config for `kind`; the executor
 * (not this type) knows how to run it.
 */
export interface StrategyActionItem {
  kind: ActionKind;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
}
