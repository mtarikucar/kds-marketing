import { request } from './client';
import type { Slot } from './studio';
import type { OlayKind, Subject } from './materials';

// Olay-driven publishing of Growth Studio (spec 2026-11-03 §14): the post requests the planner's
// triggers write for agents, the planned posts, the weekly summary and the posting policy. Shapes
// are the serde forms of `jt_studio::{package, posts}` and `jt_app::usecases::studio::posts`;
// instants are RFC 3339, days `YYYY-MM-DD`.

/** `jt_studio::PostFormat`, every variant, in its order. */
export const POST_FORMATS = ['story', 'feed_post', 'carousel', 'reel', 'tiktok_video'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export type FormatMinutes = Record<PostFormat, number>;
/** A protective cap (D29): per channel and local day, at least `spacing_minutes` apart. */
export interface PostCap {
  per_day: number;
  spacing_minutes: number;
}
/** `jt_studio::PostingPolicy`. */
export interface PostingPolicy {
  lead_minutes: FormatMinutes;
  grace_minutes: FormatMinutes;
  feed_cap: PostCap;
  story_cap: PostCap;
  tiktok_video_cap: PostCap;
  quiet_start_hour: number;
  quiet_end_hour: number;
  floor_days: number;
  debounce_minutes: number;
  horizon_days: number;
}
/** The posting policy and the IANA zone its hours and days are read in. */
export interface PostingSettings {
  policy: PostingPolicy;
  tz: string;
  /** Leave a post with its platform's own scheduler where it has one (off unless switched on). */
  provider_scheduling?: boolean;
}

export type RetirementReason =
  | 'cancelled'
  | 'hypothesis_retired'
  | 'strategy_archived'
  | 'week_ended'
  | 'measurements_complete'
  | 'replanned'
  | 'missed_grace';

/** `jt_studio::PlannedPost`: what a slot of olay-driven publishing carries. */
export interface PlannedPost {
  slot_id: string;
  workspace_id: string;
  format: PostFormat;
  capability_id: string;
  publish_at: string;
  /** When it enters the agent's pending work. */
  prep_start_at: string;
  /** Until when it may still go out. */
  grace_until: string;
  olay_id: string | null;
  package_request_id: string;
  material_ids: string[];
  subject: Subject;
  hypothesis_id: string;
  content_type: string;
  retired: { reason: RetirementReason; at: string } | null;
  created_at: string;
}
export interface PostOut {
  post: PlannedPost;
  slot: Slot;
  /** In the agent's pending work now: its preparation started, still to prepare or send. */
  pending: boolean;
}
export interface PostsOut {
  posts: PostOut[];
  settings: PostingSettings;
}

export type RequestTrigger = 'olay' | 'calendar' | 'floor' | 'project';
export type RequestStatus = 'open' | 'answered' | 'expired';
export interface FormatScore {
  format: PostFormat;
  mean: number | null;
  posts: number;
}
/** `jt_studio::PackageRequest`: a post request, work for an agent, never a post. */
export interface PostRequest {
  id: string;
  workspace_id: string;
  key: string;
  trigger: RequestTrigger;
  status: RequestStatus;
  olay_id: string | null;
  occasion: string | null;
  year: number | null;
  /** A floor request's channel; the others may post anywhere. */
  capability_id: string | null;
  material_ids: string[];
  best_formats: FormatScore[];
  hints: {
    max_posts?: number;
    subject?: Subject;
    hypothesis_id?: string;
    content_type?: string;
    window_start?: string;
    window_end?: string;
  };
  created_at: string;
  answered_at: string | null;
  closed_at: string | null;
}

export interface WeeklySummary {
  week_start: string;
  tz: string;
  from: string;
  until: string;
  published: {
    slot_id: string;
    publication_id: string;
    capability_id: string;
    format: PostFormat | null;
    published_at: string;
    url: string | null;
  }[];
  planned: {
    slot_id: string;
    capability_id: string;
    format: PostFormat;
    publish_at: string;
    prep_start_at: string;
    state: 'planned' | 'ready';
  }[];
  cancelled: {
    slot_id: string;
    capability_id: string;
    format: PostFormat | null;
    reason: RetirementReason;
    at: string;
  }[];
  scores: {
    format: PostFormat;
    olay_kind: OlayKind | null;
    hypothesis_id: string;
    mean: number;
    posts: number;
  }[];
}

/** How long an open request waits for an agent (spec §14.2). */
export const REQUEST_DAYS = 7;

const root = '/api/studio';
export const postRequests = (status?: RequestStatus | 'all') =>
  request<PostRequest[]>('GET', `${root}/post-requests`, { query: { status } });
export const postsList = (q: { from?: string; until?: string } = {}) =>
  request<PostsOut>('GET', `${root}/posts`, { query: { ...q } });
/** `week`: its Monday (`YYYY-MM-DD`) in the posting zone; this week when left out. */
export const weeklySummary = (week?: string) =>
  request<WeeklySummary>('GET', `${root}/summary`, { query: { week } });
/** An owner or manager, in person (panel only). */
export const postingPolicySet = (settings: PostingSettings) =>
  request<PostingSettings>('PUT', `${root}/posting-policy`, { body: settings });

/** `at` as a date and time in zone `tz` (the posting policy's). */
export function formatAt(at: string, lang: string, tz: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };
  try {
    return d.toLocaleString(lang, { ...options, timeZone: tz });
  } catch {
    return d.toLocaleString(lang, { ...options, timeZone: 'Europe/Istanbul' });
  }
}

/** The Monday `weeks` weeks from Monday `week` (`YYYY-MM-DD`; negative for earlier weeks). */
export function shiftWeek(week: string, weeks: number): string {
  const d = new Date(`${week}T00:00:00Z`);
  return new Date(d.getTime() + weeks * 7 * 86400_000).toISOString().slice(0, 10);
}

/** Day `day` (`YYYY-MM-DD`) plus `days` days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + days * 86400_000).toISOString().slice(0, 10);
}
