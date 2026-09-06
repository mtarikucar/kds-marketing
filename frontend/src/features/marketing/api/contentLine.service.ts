import marketingApi from './marketingApi';

/**
 * The content line: one idea, the concepts distilled from it, what they became,
 * and what the line has learned from what went out.
 *
 * `marketing/content-line/*`. Backed by read models that walk
 * `ContentConcept → SocialCampaignItem → SocialPost → SocialPostTarget →
 * SocialPostMetric`; the panel never assembles that chain itself.
 *
 * The two GETs are deliberately SEPARATE calls rather than one payload. The hub
 * renders both, and if angle history breaks the batch cards must still arrive
 * with the failure named — a single endpoint would make one broken query empty
 * the whole studio.
 */

export interface BatchSummary {
  batchId: string;
  /** The idea exactly as it was pasted — the card's own title. */
  sourceIdea: string;
  createdAt: string;
  concepts: {
    total: number;
    awaitingReview: number;
    approved: number;
    discarded: number;
  };
  production: {
    generating: number;
    needsApproval: number;
    scheduled: number;
    published: number;
    failed: number;
  };
  /**
   * Reach across everything this batch published, or `null` when it has
   * published nothing.
   *
   * Render null as "not published yet", never as `0`. Zero means measured and
   * unseen; on unpublished work that reads as a failure that has not happened.
   */
  reach: number | null;
}

export interface AngleStat {
  angle: string;
  posts: number;
  impressions: number;
  engagements: number;
  /** `engagements / impressions`, or null when nothing was ever shown. */
  rate: number | null;
  /** Too few posts to rank. Show it, say "not enough data", never weight it. */
  insufficient: boolean;
}

export interface AnglePerformance {
  /** Nothing published yet — say "no data yet", not "every angle scored zero". */
  cold: boolean;
  angles: AngleStat[];
  weights: Record<string, number>;
}

export interface PlannedConcept {
  id: string;
  batchId: string;
  ordinal: number;
  angle: string;
  hook: string;
  title: string;
  rationale: string | null;
  status: 'PROPOSED';
  /** Why this angle is in the batch. Null when the batch was planned cold. */
  selectionReason: string | null;
}

export interface PlanResult {
  batchId: string;
  sourceIdea: string;
  concepts: PlannedConcept[];
  /** Planned with no history to lean on. Say so rather than implying guidance. */
  cold: boolean;
  weights: Record<string, number>;
}

export interface PlanInput {
  idea: string;
  count?: number;
  socialCampaignId?: string;
  personaId?: string;
  /** Set by hand to override what the measurements say, for this batch only. */
  angleWeights?: Record<string, number>;
}

/**
 * THE STORYBOARD FRAME of one beat — the still the beat is animated from.
 *
 * Mirrors the backend `Keyframe` (video-pipeline.service.ts). It lives on the
 * concept's plan, so the same GET that lists a batch carries every frame; the
 * hub polls that GET while any frame is QUEUED/GENERATING.
 */
export interface Keyframe {
  assetId: string;
  status: 'QUEUED' | 'GENERATING' | 'READY' | 'FAILED' | 'BLOCKED';
  url?: string;
  model: string;
  seed?: number;
  attempts: number;
  error?: string;
}

export interface Shot {
  ord: number;
  scene: string;
  onScreenText?: string;
  voiceover: string;
  prompt: string;
  durationSec: number;
  cameraNote: string;
  description?: string;
  keyframePrompt?: string;
  keyframe?: Keyframe;
}

/** What the plan will buy — the reviewer approves this number. */
export interface ShotProduction {
  model: string;
  modelSource: 'campaign' | 'workspace' | 'platform' | 'persona' | 'storyboard';
  replacedModel?: string;
  aspectRatio: string | null;
  frameNote?: string;
  billedSecPerBeat: number[];
  billedSec: number;
  keyframes?: { model: string; perFrameCredits: number; credits: number; usd: number };
  credits: number;
  usd: number;
}

export interface ShotPlan {
  aspectRatio?: string;
  durationSec: number;
  shots: Shot[];
  production?: ShotProduction;
  /** Present on plans made since storyboards — the frames are part of the buy. */
  storyboard?: { imageModel: string; seed: number; requestedAt?: string; requestedById?: string };
  captionSuggestion?: string;
}

/** One concept as `GET /content-line/batches/:batchId` returns it. */
export interface ConceptRow {
  id: string;
  batchId: string;
  ordinal: number;
  angle: string;
  hook: string;
  title: string;
  rationale: string | null;
  status: 'PROPOSED' | 'APPROVED' | 'DISCARDED';
  selectionReason: string | null;
  promotedItemId: string | null;
  shotPlan: ShotPlan;
  destinations?: unknown[];
}

export const listBatches = (limit?: number): Promise<BatchSummary[]> =>
  marketingApi.get('/content-line/batches', { params: { limit } }).then((r) => r.data);

export const getAnglePerformance = (): Promise<AnglePerformance> =>
  marketingApi.get('/content-line/angles').then((r) => r.data);

export const getBatch = (batchId: string): Promise<ConceptRow[]> =>
  marketingApi.get(`/content-line/batches/${batchId}`).then((r) => r.data);

export const planConcepts = (input: PlanInput): Promise<PlanResult> =>
  marketingApi.post('/content-line/plan', input).then((r) => r.data);

/** Draw one still per beat of a proposed concept. Frames land on the plan as
 *  they finish; re-read the batch to see them. */
export const requestStoryboard = (conceptId: string): Promise<ConceptRow> =>
  marketingApi.post(`/content-line/concepts/${conceptId}/storyboard`).then((r) => r.data);

/** Redraw exactly one beat's frame, with a fresh seed. */
export const regenerateKeyframe = (conceptId: string, ord: number): Promise<ConceptRow> =>
  marketingApi.post(`/content-line/concepts/${conceptId}/storyboard/${ord}/regenerate`).then((r) => r.data);
