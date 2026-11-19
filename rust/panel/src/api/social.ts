import { request } from './client';
import type { PostingSettings } from './posts';

export type AccountKind = 'instagram' | 'facebook_page' | 'tiktok' | 'x' | 'linkedin_page' | 'linkedin_member' | 'youtube' | 'pinterest' | 'google_business';
export type Metric = 'followers' | 'reach' | 'views' | 'engagement' | 'profile_visits';
export type Numbers = Record<Metric, number | null>;
export interface AccountDay extends Numbers { day: string }
/** A person's step before a post goes out: an approval (the account's policy) or the platform's own posting screen (TikTok). */
export type HumanGate = 'approval' | 'posting_screen';
/** What a stop is about (`social::ready::StopCode`). */
export type StopCode =
  | 'reconnect' | 'paused' | 'braked' | 'no_approved_strategy' | 'channel_not_in_strategy' | 'no_hypothesis'
  | 'media_missing' | 'only_format' | 'posting_screen' | 'approval' | 'lead';
export type StopAction = 'reconnect' | 'resume' | 'approve_strategy' | 'prepare_strategy' | 'add_material';
/** One thing between a request and a post on an account, worked out from the facts now: it goes the moment its cause does. */
export interface Stop {
  code: StopCode;
  /** Nothing goes out on the account while it holds; otherwise it is said now so it does not surprise later. */
  blocking: boolean;
  action?: StopAction;
  format?: string;
  hours?: number;
}
export interface AccountStops { capability_id: string; stops: Stop[] }
export interface SocialAccount {
  capability_id: string;
  name: string;
  kind: AccountKind;
  status: 'verified' | 'unreachable' | 'declared' | 'retired';
  paused: boolean;
  /** Every post planned on it waits for a person: the account's policy, or TikTok's posting screen. */
  requires_human_approval: boolean;
  human_gate?: HumanGate;
  /** What would stop a post on it now, and what a post there will meet. */
  stops?: Stop[];
  latest: AccountDay | null;
  next: { publish_at: string; format: string } | null;
}
export interface AccountDetail {
  account: SocialAccount;
  days: AccountDay[];
  upcoming: { slot_id: string; publish_at: string; format: string; title: string; held_at_provider: boolean; state: 'ready' | 'waiting_person' | 'held'; waits_for: 'tiktok_screen' | 'approval' | null }[];
  /** `format` is `null` for a post that went out without a planned post behind it (an older slot). */
  recent: { slot_id: string; published_at: string; format: string | null; title: string; url: string | null; metrics: Pick<Numbers, 'reach' | 'views' | 'engagement'> }[];
  totals: { posts: number | null; reach: number | null; views: number | null; engagement: number | null };
  /** What the platform's own scheduler holds for the account now; absent when it has none to read. `known` is false for a post Jeeta does not hold there. */
  at_platform?: { external_id: string; publish_at: string; title: string; known: boolean }[];
}
export interface WaitingPackage {
  project_id: string;
  goal: string;
  summary: string;
  delivered_at: string;
  /** `blocked`: why no account can take the version now, when none can. */
  versions: {
    version_id: string; format: string; text: string; material_ids: string[]; accounts: string[];
    /** The same accounts, each with the person's step there and the hypothesis it goes out under. */
    choices?: { capability_id: string; human_gate?: HumanGate; attribution: 'version' | 'segment' | 'channel' | 'owner_request' }[];
    blocked?: string;
  }[];
}
export interface SocialPostingSettings extends PostingSettings { paused_capability_ids: string[]; revision: number }
const root = '/api/social';
export const accountsList = () => request<SocialAccount[]>('GET', `${root}/accounts`);
export const accountGet = (id: string, from: string, until: string) =>
  request<AccountDetail>('GET', `${root}/accounts/${encodeURIComponent(id)}`, { query: { from, until } });
export const packagesWaiting = () => request<WaitingPackage[]>('GET', `${root}/packages`);
/** Gives a waiting version its account and time (`social.version_schedule`); replayed by `request_key`. */
export const versionSchedule = (body: { project_id: string; version_id: string; capability_id: string; publish_at: string; request_key: string }) =>
  request<unknown>('POST', `${root}/versions/schedule`, { body });
export const accountPause = (id: string, paused: boolean, expected_revision: number) =>
  request<SocialPostingSettings>('POST', `${root}/accounts/${encodeURIComponent(id)}/pause`, { body: { paused, expected_revision } });
