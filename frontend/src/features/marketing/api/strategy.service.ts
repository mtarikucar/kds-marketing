/**
 * strategy.service.ts — typed client for the Strategy Engine (Task 9).
 * Thin wrappers over `marketingApi` (base `${API_URL}/marketing`), matching the
 * repo convention: a plain fn per endpoint returning `r.data`; React Query
 * hooks live in the pages. The onboarding wizard drives the adaptive intake
 * (start → answer* → finish); the console renders the MarketingStrategy brief +
 * the ActionPlan approval queue + the autonomy lane.
 */
import marketingApi from './marketingApi';

export type AutonomyLevel = 'SHADOW' | 'ASSISTED' | 'AUTONOMOUS';
export type StrategyStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ActionStatus = 'PROPOSED' | 'APPROVED' | 'DISMISSED' | 'DONE';

// ── Brief shape (mirrors backend strategy.types.ts MarketingStrategyBrief) ──────
export interface BriefIdentity {
  product: string;
  voice: string;
  positioning: string;
  usp: string;
}

export interface BriefChannel {
  key: string;
  /** 0–100 fit score for this channel. */
  fitScore: number;
  rationale: string;
}

export interface BriefPillar {
  title: string;
  angle: string;
  formats: string[];
  tone: string;
}

export interface BriefGoals {
  objective: string;
  kpis: string[];
}

export interface MarketingStrategyBrief {
  identity: BriefIdentity;
  audience: string;
  channels: BriefChannel[];
  contentPillars: BriefPillar[];
  goals: BriefGoals;
  budget: string;
  competitors: string[];
}

// ── Strategy + Action rows ──────────────────────────────────────────────────────
export interface MarketingStrategy {
  id: string;
  archetype: string;
  brief: MarketingStrategyBrief;
  autonomyLevel: AutonomyLevel;
  status: StrategyStatus;
  version: number;
}

export interface StrategyAction {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  priority: number;
  status: ActionStatus;
}

// ── Intake (adaptive Q&A) ───────────────────────────────────────────────────────
/** The three networks the intake auto-analysis supports (Brand Brain source
 *  adapters). Must match the backend StartIntakeDto (strategy-intake.controller). */
export type IntakeSocialNetwork = 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN';

export interface IntakeSocial {
  network: IntakeSocialNetwork;
  /** handle or profile URL, ≤200 chars (backend cap). */
  handle: string;
}

export interface StartIntakePayload {
  url: string;
  socials?: IntakeSocial[];
  oneLiner?: string;
}

/** `skipped` is returned when the AI provider isn't configured server-side. */
export type StartIntakeResult =
  | { sessionId: string; questions: string[]; skipped?: false }
  | { skipped: true };

export type AnswerIntakeResult = { questions: string[]; done?: false } | { done: true };

export type FinishIntakeResult =
  | { strategyId: string; actionCount: number; skipped?: false }
  | { skipped: true };

export const startIntake = (payload: StartIntakePayload) =>
  marketingApi.post<StartIntakeResult>('/strategy/intake/start', payload).then((r) => r.data);

export const answerIntake = (sessionId: string, answers: string[]) =>
  marketingApi
    .post<AnswerIntakeResult>('/strategy/intake/answer', { sessionId, answers })
    .then((r) => r.data);

export const finishIntake = (sessionId: string) =>
  marketingApi.post<FinishIntakeResult>('/strategy/intake/finish', { sessionId }).then((r) => r.data);

// ── Strategy + actions + autonomy ───────────────────────────────────────────────

/** The workspace's current strategy, or null when none exists yet (404 → null). */
export const getStrategy = () =>
  marketingApi
    .get<MarketingStrategy | null>('/strategy')
    .then((r) => r.data ?? null)
    .catch((e) => {
      if (e?.response?.status === 404) return null;
      throw e;
    });

export const listStrategyActions = (status: ActionStatus = 'PROPOSED') =>
  marketingApi
    .get<StrategyAction[]>('/strategy/actions', { params: { status } })
    .then((r) => r.data);

export const approveAction = (id: string) =>
  marketingApi.post<StrategyAction>(`/strategy/actions/${id}/approve`).then((r) => r.data);

export const dismissAction = (id: string) =>
  marketingApi.post<StrategyAction>(`/strategy/actions/${id}/dismiss`).then((r) => r.data);

export const setStrategyAutonomy = (level: AutonomyLevel) =>
  marketingApi.post<MarketingStrategy>('/strategy/autonomy', { level }).then((r) => r.data);

// ── Community channels (Discord webhook + Reddit OAuth) ──────────────────────────
export type CommunityProvider = 'DISCORD' | 'REDDIT';

export interface CommunityChannelMeta {
  username?: string;
  channelName?: string;
  subreddit?: string;
}

export interface CommunityChannel {
  provider: CommunityProvider;
  status: string;
  meta?: CommunityChannelMeta;
}

/** Connected community channels for the workspace. */
export const listCommunityChannels = () =>
  marketingApi.get<CommunityChannel[]>('/strategy/channels').then((r) => r.data);

/** Connect a Discord community by its server webhook URL (validated server-side). */
export const connectDiscord = (payload: { webhookUrl: string; channelName?: string }) =>
  marketingApi
    .post<CommunityChannel>('/strategy/channels/discord', payload)
    .then((r) => r.data);

/** Kick off Reddit OAuth — open the returned `url` to reach the consent screen. */
export const getRedditAuthorizeUrl = () =>
  marketingApi.get<{ url: string }>('/strategy/channels/reddit/authorize').then((r) => r.data);

/** Disconnect a connected community channel. */
export const disconnectCommunityChannel = (provider: CommunityProvider) =>
  marketingApi.delete<void>(`/strategy/channels/${provider}`).then((r) => r.data);
