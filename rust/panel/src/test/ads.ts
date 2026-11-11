import type { Campaign, PlatformRules } from '@/api/ads';
import type { Breakdown, Stop } from '@/api/budget';
import type { BudgetItemOut } from '@/api/types';
import { studioAnswers } from './studio';
import { budgetItems } from './fixtures';

export const campaign = {
  id: 'campaign-1',
  revision: 4,
  title: 'Kupa serisi lansmanı',
  goal: 'Yeni kupaları tanıt',
  budget_minor: 500000,
  currency: 'TRY',
  start_at: '2026-11-11T09:00:00Z',
  end_at: null,
  account_hint: null,
  opened_by: { kind: 'human', user: 'u1' },
  approval: null,
  refused: 0,
  plan: {
    ad_account: 'account',
    result: 'lead_form',
    destination: { kind: 'website', url: 'https://example.com/kupa' },
    special_ad_categories: [],
    audience: {
      countries: ['TR'],
      regions: [],
      cities: [],
      age_min: 18,
      age_max: 65,
      genders: [],
      interests: [],
      broad: true,
    },
    placements: { platforms: ['facebook', 'instagram'] },
    end_at: '2026-11-20T09:00:00Z',
    ads: [
      {
        name: 'Mavi kupa',
        material_ids: [],
        primary_text: 'El yapımı kupalar',
        headline: 'Yeni seri',
        description: null,
        call_to_action: 'LEARN_MORE',
        page: 'page',
        instagram: null,
        hypothesis_id: 'h1',
      },
    ],
    summary: 'Yeni seriyi tanıtıyoruz',
    audience_summary: 'Türkiye’de yaşayan 18–65 yaş arası kişiler.',
  },
  built: {
    account: 'account',
    platform: 'meta',
    ads: [{ index: 0, status: 'active', feedback: null }],
    activated_at: '2026-11-11T09:00:00Z',
  },
  moves: [
    {
      at: '2026-11-12T09:00:00Z',
      kind: 'pause_ad',
      ad: 0,
      reason: 'Sonuç başına maliyet yükseldi',
      outcome: 'done',
      detail: null,
    },
  ],
  stop: null,
  ended: null,
  state: { state: 'live', note: null },
  totals: { spent_minor: 325000, results: 41, result_kind: 'lead_form', impressions: 4000, clicks: 200 },
} satisfies Campaign;
/** What a plan carries on each ad platform, as `GET /api/ads/campaigns/{id}` answers it. */
export const platforms = [
  { platform: 'meta', account_kind: 'meta_ads', image: true, min_run_hours: 24, max_run_days: 90, hard_budget_cap: true, preview: true },
  { platform: 'google', account_kind: 'google_ads', image: false, min_run_hours: 72, max_run_days: 89, hard_budget_cap: true, preview: false },
] satisfies PlatformRules[];
export const generalBudget = {
  ...budgetItems[0],
  item: {
    ...budgetItems[0].item,
    kind: 'ad_budget',
    general: true,
    unit: { kind: 'currency', value: 'TRY' },
    cap: 3000000,
    period: 'monthly',
  },
  spent_in_period: 915000,
  remaining: 2085000,
} satisfies BudgetItemOut;
export const stop = { revision: 8, all: false, modules: [], paused: [] } satisfies Stop;
export const breakdown = {
  items: [
    {
      item_id: generalBudget.item.id,
      modules: [
        {
          module: 'ads',
          spent_minor: 325000,
          campaigns: [{ campaign_id: campaign.id, title: campaign.title, spent_minor: 325000 }],
        },
      ],
    },
  ],
  stop,
} satisfies Breakdown;
export const adsAnswers = {
  ...studioAnswers,
  'GET /api/budget/items': [generalBudget],
  'GET /api/budget/breakdown': breakdown,
  'GET /api/ads/campaigns': { campaigns: [campaign], next_before: null },
  'GET /api/ads/campaigns/campaign-1': {
    campaign,
    materials: [],
    platforms,
    days: [
      { day: '2026-11-12', ad: 0, spent_minor: 10000, impressions: 100, clicks: 20, results: 3 },
      { day: '2026-11-12', ad: 1, spent_minor: 20000, impressions: 200, clicks: 30, results: 4 },
    ],
  },
};
