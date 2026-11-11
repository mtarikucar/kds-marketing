import { request, seg } from './client';
import type { Material } from './materials';

export type CampaignState =
  | 'proposed'
  | 'queued'
  | 'planning'
  | 'building'
  | 'in_review'
  | 'live'
  | 'paused'
  | 'rejected'
  | 'ended'
  | 'held'
  | 'expired'
  | 'declined';
/** Where a Meta campaign's ads are shown. */
export type MetaPlatform = 'facebook' | 'instagram';
/** What the campaign list filters by: Meta's two surfaces, or another ad platform. */
export type Platform = MetaPlatform | 'google';
/** The ad platform a campaign's ad account is of (`jt_app::ports::ads::AdsPlatform`). */
export type AdsPlatform = 'meta' | 'google';
/**
 * What a plan carries on one ad platform (`jt_app::usecases::ads::platform::PlatformRules`);
 * only what the panel shows is listed.
 */
export interface PlatformRules {
  platform: AdsPlatform;
  account_kind: string;
  image: boolean;
  min_run_hours: number;
  max_run_days: number;
  hard_budget_cap: boolean;
  preview: boolean;
}
export type Placement = 'facebook_feed' | 'instagram_feed' | 'instagram_story' | 'instagram_reels';
/** One ad of a plan. Which fields it carries is its platform's: one left out is absent. */
export interface Ad {
  name: string;
  material_ids?: string[];
  primary_text?: string;
  headline?: string;
  description: string | null;
  call_to_action?: string;
  page?: string;
  instagram: string | null;
  /** A search ad's headlines and descriptions. */
  headlines?: string[];
  descriptions?: string[];
  hypothesis_id: string;
}
/** One finding of a refused plan (`jt_app::usecases::ads::plan`). */
export interface PlanFinding {
  field: string;
  reason: string;
  /** `below_the_accounts_minimum`: the least budget the ad account takes for the run. */
  least?: number;
  /** `currency_mismatch`. */
  account_currency?: string;
  budget_currency?: string;
  /** `credential_scope_missing`: the permissions one of which the connection must hold. */
  needs?: string[];
  /** `duration_not_supported`: how long the ad account's platform lets a campaign run. */
  least_hours?: number;
  most_days?: number;
}
export interface CampaignPlan {
  ad_account: string;
  result: 'link_click' | 'lead_form';
  destination:
    | { kind: 'website'; url: string }
    | {
        kind: 'lead_form';
        page: string;
        name: string;
        questions: string[];
        privacy_policy_url: string;
        thank_you_url: string;
      };
  special_ad_categories: string[];
  audience: {
    countries: string[];
    regions: string[];
    cities: string[];
    age_min: number;
    age_max: number;
    genders: number[];
    interests: { id: string; name: string }[];
    broad: boolean;
  };
  placements: 'automatic' | { platforms: MetaPlatform[] };
  /** The searches a search campaign's ads answer. */
  keywords?: string[];
  end_at: string;
  ads: Ad[];
  summary: string;
  audience_summary: string;
}
export interface Campaign {
  id: string;
  revision: number;
  title: string;
  goal: string;
  budget_minor: number;
  currency: string;
  start_at: string;
  end_at: string | null;
  account_hint: string | null;
  opened_by: { kind: 'human'; user: string } | { kind: 'system'; agent: string };
  approval: { by: string; at: string } | null;
  refused: number;
  /** Why the agent's last plan was refused, field by field; gone once a plan is accepted. */
  refusal?: PlanFinding[];
  plan: CampaignPlan | null;
  built: {
    account: string;
    platform: AdsPlatform;
    ads: {
      index: number;
      status: 'active' | 'paused' | 'in_review' | 'disapproved';
      feedback: string | null;
    }[];
    activated_at: string | null;
  } | null;
  moves: {
    at: string;
    kind: 'pause_ad' | 'resume_ad' | 'add_ad' | 'fix_ad' | 'none';
    ad: number | null;
    reason: string;
    outcome: 'done' | 'refused';
    detail: string | null;
  }[];
  stop: { by: 'person' | 'budget' | 'agent'; at: string; reason: string } | null;
  ended: { at: string; reason: 'budget_spent' | 'end_date' | 'person' } | null;
  state: { state: CampaignState; note: string | null };
  totals: {
    spent_minor: number;
    results: number | null;
    result_kind: 'lead_form' | 'link_click' | null;
    impressions: number | null;
    clicks: number | null;
  };
}
/** One ad's numbers on one day. A number the ad platform does not give is `null`, never zero. */
export interface AdDay {
  day: string;
  ad: number;
  spent_minor: number | null;
  impressions: number | null;
  clicks: number | null;
  results: number | null;
}
export interface CampaignDetail {
  campaign: Campaign;
  days: AdDay[];
  materials: Material[];
  /** What a plan carries on each ad platform. */
  platforms: PlatformRules[];
}
export interface OpenCampaign {
  request_key: string;
  goal: string;
  budget_minor: number;
  start_at: string;
  title?: string;
  account?: string;
  end_at?: string;
}
export type CampaignAction = 'approve' | 'decline' | 'pause' | 'resume' | 'end';
export function listCampaigns(scope: 'open' | 'closed', before?: string) {
  return request<{ campaigns: Campaign[]; next_before: string | null }>('GET', '/api/ads/campaigns', {
    query: { scope, before },
  });
}
export function getCampaign(id: string) {
  return request<CampaignDetail>('GET', `/api/ads/campaigns/${seg(id)}`);
}
export function openCampaign(body: OpenCampaign) {
  return request<Campaign>('POST', '/api/ads/campaigns', { body });
}
export function actOnCampaign(
  id: string,
  action: CampaignAction,
  expected_revision: number,
  reason?: string,
) {
  return request<Campaign>('POST', `/api/ads/campaigns/${seg(id)}/${action}`, {
    body: { expected_revision, ...(reason === undefined ? {} : { reason }) },
  });
}
export function updateCampaign(
  id: string,
  body: { expected_revision: number; budget_minor?: number; end_at?: string | null },
) {
  return request<Campaign>('PATCH', `/api/ads/campaigns/${seg(id)}`, { body });
}
export function adPreview(id: string, index: number, placement: Placement) {
  return request<{ html: string }>('GET', `/api/ads/campaigns/${seg(id)}/ads/${index}/preview`, {
    query: { placement },
  });
}
