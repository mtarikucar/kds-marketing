import { studioAnswers, slot } from './studio';
import { defaultSettings } from './posts';

export const socialAccount = {
  capability_id: 'ig1', name: '@atolye', kind: 'instagram', status: 'verified', paused: false,
  latest: { day: '2026-11-10', followers: 1250, reach: 4800, views: null, engagement: 320, profile_visits: 80 },
  next: { publish_at: '2026-11-11T09:00:00Z', format: 'reel' },
};
export const tiktokAccount = { ...socialAccount, capability_id: 'tt1', name: '@atolye.video', kind: 'tiktok', paused: true, latest: null };
export const accountDetail = {
  account: socialAccount,
  days: [
    { day: '2026-11-06', followers: 1200, reach: 4000, views: null, engagement: 280, profile_visits: 60 },
    { day: '2026-11-07', followers: 1210, reach: 4100, views: null, engagement: 290, profile_visits: 65 },
    { day: '2026-11-08', followers: null, reach: null, views: null, engagement: null, profile_visits: null },
    { day: '2026-11-09', followers: 1240, reach: 4700, views: null, engagement: 310, profile_visits: 75 },
    socialAccount.latest,
  ],
  upcoming: [
    { slot_id: 'held', publish_at: '2026-11-11T09:00:00Z', format: 'reel', title: 'Yeni koleksiyon', held_at_provider: true, state: 'ready', waits_for: null },
    { slot_id: 'ready', publish_at: '2026-11-12T09:00:00Z', format: 'feed_post', title: 'Atölyeden', held_at_provider: false, state: 'ready', waits_for: null },
  ],
  recent: [{ slot_id: 'done', published_at: '2026-11-09T09:00:00Z', format: 'feed_post', title: 'Dünkü buluşma', url: 'https://www.instagram.com/p/example', metrics: { reach: 600, views: null, engagement: 0 } }],
  totals: { posts: 3, reach: 12000, views: null, engagement: 600 },
};
export const socialSettings = { ...defaultSettings, revision: 7, paused_capability_ids: ['tt1'] };
export const socialAnswers = {
  ...studioAnswers,
  'GET /api/social/accounts': [socialAccount, tiktokAccount],
  'GET /api/social/accounts/ig1': accountDetail,
  'GET /api/social/accounts/tt1': { ...accountDetail, account: tiktokAccount, days: [], recent: [], upcoming: [{ slot_id: 's1', publish_at: '2026-11-12T09:00:00Z', format: 'tiktok_video', title: 'Atölye videosu', state: 'waiting_person', waits_for: 'tiktok_screen', held_at_provider: false }] },
  'GET /api/social/packages': [{ project_id: 'p1', goal: 'Atölyeyi tanıt', summary: 'Kasım paketi', delivered_at: '2026-11-10T09:00:00Z', versions: [{ version_id: 'v1', format: 'reel', text: 'Birlikte üretelim.', material_ids: ['m1'], accounts: ['ig1'] }] }],
  'GET /api/studio/posts': { posts: [], settings: socialSettings },
  'GET /api/studio/pending': { slots: [], approvals: [{ slot: 's1' }], blockers: [{ target: { slot: 's1' }, reason: 'human_approval_required', next_action: 'tiktok_posting_screen' }], budget_moves: [], paid_alerts: [] },
  'GET /api/studio/slots/s1/tiktok': { slot, creator: { nickname: 'Atölye video', username: 'atolye.video', avatar_url: null, privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600, cannot_post: null }, title: 'Atölye videosu', media: { kind: 'video', duration_ms: 1000 }, max_title_units: 2200, previews: [], approval: null, account_metrics: null, recent_posts: [], drafts_available: false },
};
