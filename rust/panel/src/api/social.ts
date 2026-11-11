import { request } from './client';
import type { PostingSettings } from './posts';

export type AccountKind = 'instagram' | 'facebook_page' | 'tiktok' | 'x' | 'linkedin_page' | 'linkedin_member' | 'youtube' | 'pinterest' | 'google_business';
export type Metric = 'followers' | 'reach' | 'views' | 'engagement' | 'profile_visits';
export type Numbers = Record<Metric, number | null>;
export interface AccountDay extends Numbers { day: string }
export interface SocialAccount {
  capability_id: string;
  name: string;
  kind: AccountKind;
  status: 'verified' | 'unreachable' | 'declared' | 'retired';
  paused: boolean;
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
  versions: { version_id: string; format: string; text: string; material_ids: string[]; accounts: string[]; blocked?: string }[];
}
export interface SocialPostingSettings extends PostingSettings { paused_capability_ids: string[]; revision: number }
const root = '/api/social';
export const accountsList = () => request<SocialAccount[]>('GET', `${root}/accounts`);
export const accountGet = (id: string, from: string, until: string) =>
  request<AccountDetail>('GET', `${root}/accounts/${encodeURIComponent(id)}`, { query: { from, until } });
export const packagesWaiting = () => request<WaitingPackage[]>('GET', `${root}/packages`);
export const accountPause = (id: string, paused: boolean, expected_revision: number) =>
  request<SocialPostingSettings>('POST', `${root}/accounts/${encodeURIComponent(id)}/pause`, { body: { paused, expected_revision } });
export const postingSettings = () => request<{ settings: SocialPostingSettings }>('GET', '/api/studio/posts');
