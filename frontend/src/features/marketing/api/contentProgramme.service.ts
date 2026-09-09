import marketingApi from './marketingApi';

/**
 * The content programme: the loop that plans a calendar of typed slots ahead,
 * produces each one without an approval gate, measures what published, and
 * moves the type weights toward what worked.
 *
 * `marketing/content-programme/*`. Every shape here mirrors the REST contract
 * field for field — the panel renders these rows, it never derives them.
 * Dates arrive as ISO strings (JSON has no Date); the panel parses at the edge
 * it displays them, never in this file, so a bad string fails where it is
 * shown rather than where it is cached.
 *
 * ONE programme per workspace: `GET /` answers with the newest one that is not
 * killed, or `null`, plus the dashboard the compact strip renders from. The
 * dashboard already carries the slot window, the types, the learning table,
 * the trends and the last events, so the panel needs ONE request to draw
 * everything it shows by default. The narrower GETs below exist for the tabs
 * that want a different window or a fresh read after a mutation.
 */

export const PROGRAMME_GOALS = ['ENGAGEMENT', 'VIEWS', 'SAVES_SHARES', 'LEADS', 'COMPOSITE'] as const;
export type ProgrammeGoal = (typeof PROGRAMME_GOALS)[number];

export type ProgrammeStatus = 'ACTIVE' | 'PAUSED' | 'KILLED';
export type ProgrammePhase = 'SEED' | 'LEARN' | 'EXPLOIT';
export type SlotStatus =
  | 'PLANNED'
  | 'IDEATED'
  | 'PRODUCING'
  | 'READY'
  | 'PUBLISHED'
  | 'MEASURED'
  | 'SKIPPED'
  | 'FAILED';

/** The programme row as the backend stores it. */
export interface ContentProgramme {
  id: string;
  workspaceId: string;
  name: string;
  status: ProgrammeStatus;
  socialCampaignId: string;
  goal: ProgrammeGoal | string;
  brief: string;
  personaId: string | null;
  perWeek: number;
  weeklyCreditCap: number;
  explorationRate: number;
  maturityHours: number;
  halfLifeDays: number;
  editWindowHours: number;
  lookaheadDays: number;
  planLeadHours: number;
  produceLeadHours: number;
  seedWeeks: number;
  phase: ProgrammePhase | string;
  killSwitch: boolean;
  lastPlannedAt: string | null;
  lastMeasuredAt: string | null;
  lastReweightedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** The slot row as stored — only `slotMetrics` returns it raw. */
export interface ContentSlot {
  id: string;
  workspaceId: string;
  programmeId: string;
  scheduledFor: string;
  status: SlotStatus | string;
  contentTypeId: string;
  contentTypeKey: string;
  selectionReason: string;
  trendSignalId: string | null;
  trendTitle: string | null;
  idea: string;
  conceptId: string | null;
  campaignItemId: string | null;
  socialPostId: string | null;
  quotedCredits: number | null;
  editableUntil: string;
  publishedAt: string | null;
  measuredAt: string | null;
  reward: number | null;
  rewardBreakdown: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlotView {
  id: string;
  scheduledFor: string;
  status: SlotStatus | string;
  contentTypeKey: string;
  contentTypeName: string;
  /** Why this type, in words a person can audit. */
  selectionReason: string;
  trendTitle: string | null;
  idea: string;
  conceptId: string | null;
  campaignItemId: string | null;
  socialPostId: string | null;
  quotedCredits: number | null;
  /**
   * What the slot has actually cost so far. Kept on SKIPPED and FAILED slots
   * too, because a production that was paid for and then thrown away is the
   * number an owner wants next to the quote, not a dash.
   */
  spentCredits: number;
  editableUntil: string;
  /** `now < editableUntil` and the slot is PLANNED, IDEATED or READY. */
  editable: boolean;
  publishedAt: string | null;
  reward: number | null;
  error: string | null;
  concept: { title: string; hook: string; angle: string } | null;
}

export interface TypeView {
  id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  minShare: number;
  maxShare: number;
  defaultDurationSec: number;
  networks: string[];
  /** The latest 'ALL' weight, or 0 before the first reweight. */
  weight: number;
  samples: number;
  meanReward: number | null;
  /** Share of the upcoming non-skipped slots this type currently holds. */
  plannedShare: number;
}

export interface LearningRow {
  typeKey: string;
  network: string;
  samples: number;
  alpha: number;
  beta: number;
  meanReward: number;
  weight: number;
  computedAt: string;
}

export interface LearningView {
  phase: ProgrammePhase | string;
  lastReweightedAt: string | null;
  networks: string[];
  /** Latest row per type × network, 'ALL' included. */
  rows: LearningRow[];
  /** The last 12 'ALL' reweights, oldest first. */
  history: Array<{ computedAt: string; weights: Record<string, number> }>;
}

export interface TrendView {
  id: string;
  network: string;
  kind: string;
  title: string;
  ref: string | null;
  decayed: number;
  relevance: number;
  suggestion: number;
  observedAt: string;
}

export interface EventView {
  id: string;
  kind: string;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface Dashboard {
  phase: ProgrammePhase | string;
  status: ProgrammeStatus | string;
  killSwitch: boolean;
  week: { weekStart: string; spent: number; cap: number };
  /** From now − 1 day to now + lookaheadDays. */
  slots: SlotView[];
  types: TypeView[];
  learning: LearningView;
  trends: TrendView[];
  /** The last 30. */
  events: EventView[];
}

export interface ProgrammeResponse {
  programme: ContentProgramme | null;
  dashboard: Dashboard | null;
}

export interface CreateProgrammeInput {
  name: string;
  brief: string;
  accountIds: string[];
  perWeek?: number;
  goal?: ProgrammeGoal | string;
  weeklyCreditCap?: number;
  personaId?: string;
  /** 'HH:MM'. */
  timeOfDay?: string;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek?: number[];
}

/** The settings an owner may change after creation; everything else is the engine's. */
export interface UpdateProgrammeInput {
  name?: string;
  brief?: string;
  goal?: ProgrammeGoal | string;
  perWeek?: number;
  weeklyCreditCap?: number;
  explorationRate?: number;
  maturityHours?: number;
  halfLifeDays?: number;
  editWindowHours?: number;
  lookaheadDays?: number;
  planLeadHours?: number;
  produceLeadHours?: number;
  personaId?: string | null;
}

export interface ContentTypeBeat {
  role: string;
  durationSec: number;
  guidance: string;
}

export interface CreateContentTypeInput {
  key: string;
  name: string;
  description?: string;
  structure?: ContentTypeBeat[];
  defaultDurationSec?: number;
  networks?: string[];
  minShare?: number;
  maxShare?: number;
}

export type UpdateContentTypeInput = Partial<Omit<CreateContentTypeInput, 'key'>> & { active?: boolean };

export interface SlotPatch {
  contentTypeKey?: string;
  idea?: string;
  /** ISO instant. */
  scheduledFor?: string;
}

export interface SlotMetricsTarget {
  network: string;
  status: string;
  latest: {
    impressions: number;
    reach: number;
    engagements: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    videoViews: number;
    leads: number;
    date: string;
  } | null;
}

export interface SlotMetricsView {
  slot: ContentSlot;
  concept: {
    id: string;
    title: string;
    hook: string;
    angle: string;
    contentTypeKey: string;
    beats: number;
    durationSec: number;
  } | null;
  item: { id: string; status: string; scheduledFor: string; error: string | null } | null;
  post: { id: string; publishedAt: string | null; content: string } | null;
  targets: SlotMetricsTarget[];
  reward: number | null;
  rewardBreakdown: unknown;
}

/**
 * Query keys, spelled once. Everything under `['content-programme']` is
 * invalidated by every mutation — a slot edit changes the dashboard's chips,
 * the types' planned share AND the event log, and enumerating which is how a
 * near-miss key leaves one tab describing yesterday.
 */
export const programmeKeys = {
  root: ['content-programme'] as const,
  slots: (id: string, from: string, to: string) => ['content-programme', id, 'slots', from, to] as const,
  learning: (id: string) => ['content-programme', id, 'learning'] as const,
  trends: (id: string) => ['content-programme', id, 'trends'] as const,
  events: (id: string) => ['content-programme', id, 'events'] as const,
  slotMetrics: (id: string, slotId: string) =>
    ['content-programme', id, 'slot', slotId, 'metrics'] as const,
};

const BASE = '/content-programme';

export const getProgramme = (): Promise<ProgrammeResponse> =>
  marketingApi.get(BASE).then((r) => r.data);

export const createProgramme = (input: CreateProgrammeInput): Promise<ProgrammeResponse> =>
  marketingApi.post(BASE, input).then((r) => r.data);

export const updateProgramme = (id: string, patch: UpdateProgrammeInput): Promise<ProgrammeResponse> =>
  marketingApi.patch(`${BASE}/${id}`, patch).then((r) => r.data);

export const pauseProgramme = (id: string): Promise<ProgrammeResponse> =>
  marketingApi.post(`${BASE}/${id}/pause`).then((r) => r.data);

export const resumeProgramme = (id: string): Promise<ProgrammeResponse> =>
  marketingApi.post(`${BASE}/${id}/resume`).then((r) => r.data);

/** Terminal. The programme keeps its history; `getProgramme` stops returning it. */
export const killProgramme = (id: string): Promise<ProgrammeResponse> =>
  marketingApi.post(`${BASE}/${id}/kill`).then((r) => r.data);

export const listTypes = (id: string): Promise<TypeView[]> =>
  marketingApi.get(`${BASE}/${id}/types`).then((r) => r.data);

export const createType = (id: string, input: CreateContentTypeInput): Promise<TypeView> =>
  marketingApi.post(`${BASE}/${id}/types`, input).then((r) => r.data);

export const updateType = (id: string, typeId: string, patch: UpdateContentTypeInput): Promise<TypeView> =>
  marketingApi.patch(`${BASE}/${id}/types/${typeId}`, patch).then((r) => r.data);

/** `from`/`to` are ISO instants. */
export const listSlots = (id: string, from: string, to: string): Promise<SlotView[]> =>
  marketingApi.get(`${BASE}/${id}/slots`, { params: { from, to } }).then((r) => r.data);

/** Send only what changed: the backend treats every present field as an override. */
export const updateSlot = (id: string, slotId: string, patch: SlotPatch): Promise<SlotView> =>
  marketingApi.patch(`${BASE}/${id}/slots/${slotId}`, patch).then((r) => r.data);

export const skipSlot = (id: string, slotId: string): Promise<SlotView> =>
  marketingApi.post(`${BASE}/${id}/slots/${slotId}/skip`).then((r) => r.data);

export const regenerateSlot = (id: string, slotId: string): Promise<SlotView> =>
  marketingApi.post(`${BASE}/${id}/slots/${slotId}/regenerate`).then((r) => r.data);

/**
 * A FAILED slot back into the loop from where it broke — as opposed to
 * `regenerateSlot`, which throws the clips away and re-produces a slot that
 * has a campaign item. Retry is what a slot that failed BEFORE it had an item
 * (ideation, planning) needs, so the panel offers it on every FAILED slot.
 */
export const retrySlot = (id: string, slotId: string): Promise<SlotView> =>
  marketingApi.post(`${BASE}/${id}/slots/${slotId}/retry`).then((r) => r.data);

export const slotMetrics = (id: string, slotId: string): Promise<SlotMetricsView> =>
  marketingApi.get(`${BASE}/${id}/slots/${slotId}/metrics`).then((r) => r.data);

export const getLearning = (id: string): Promise<LearningView> =>
  marketingApi.get(`${BASE}/${id}/learning`).then((r) => r.data);

export const getTrends = (id: string): Promise<TrendView[]> =>
  marketingApi.get(`${BASE}/${id}/trends`).then((r) => r.data);

export const getEvents = (id: string): Promise<EventView[]> =>
  marketingApi.get(`${BASE}/${id}/events`).then((r) => r.data);
