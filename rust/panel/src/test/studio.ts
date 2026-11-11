import { inboxAnswers, inboxMe } from './inbox';
export const h = {
  id: 'h1',
  title: 'Kısa hikâyeler',
  metric: 'engagement',
  prior_confidence: 0.4,
  derived_confidence: 0.7,
  channel: 'x',
  cadence: {},
  state: 'kept',
};
const chain = { workspace_id: 'w', born_version_id: 'v1', hypothesis_id: 'h1', arm_id: 'a1' };
export const slot = {
  id: 's1',
  chain,
  capability_id: 'c1',
  scheduled_at: new Date().toISOString(),
  state: 'ready',
  revision: 1,
};
export const overview = {
  strategy: { id: 'v1', number: 3 },
  goals: { objective: 'Daha çok yanıt', kpis: [{ name: 'engagement', target: '10' }] },
  hypotheses: [h],
  control: { revision: 2, brake_engaged: false, lanes: {} },
  lane_support: {
    organic: { visible: true, supported: true },
    paid: { visible: false, supported: false },
  },
  slots: [slot],
  today: {
    slots: [{ slot, overdue: true }],
    approvals: [{ slot: 's1' }],
    budget_moves: [],
    blockers: [
      { target: { slot: 's1' }, reason: 'human_approval_required' },
      {
        target: { slot: 's1' },
        reason: 'publish_unknown',
        next_action: 'review_publication_duplicate_risk',
      },
    ],
    paid_alerts: [],
  },
  learned: {
    hypotheses: [],
    arms: [
      {
        arm: {
          id: 'a1',
          key: { hypothesis_id: 'h1', lane: 'organic', channel: 'x', content_type: 'text' },
          alpha: 2,
          beta: 3,
          weight: 0.4,
        },
        evidence: [],
      },
    ],
    lane_performance: [],
    spend_vs_cap: [],
    trends: [],
    judgments: [],
  },
  bindings: [],
};
export const studioAnswers = {
  ...inboxAnswers,
  'GET /api/auth/me': {
    ...inboxMe,
    memberships: [
      {
        ...inboxMe.memberships[0],
        permissions: [...inboxMe.memberships[0].permissions, 'materials.work', 'content.work', 'content.manage', 'social.work', 'social.manage', 'ads.work', 'ads.manage', 'team.manage'],
      },
    ],
  },
  'GET /api/studio/overview': overview,
  'GET /api/studio/ledger': { entries: [], next_before: null },
  'GET /api/work/pending': {
    items: [],
    agent: { overdue: true, interval_minutes: 60, last_seen_at: null },
    strategy: { approved: { number: 3 } },
  },
  'GET /api/capabilities': [],
  'GET /api/studio/slots/s1': {
    slot,
    piece: { text: 'Örnek içerik', media: [], adaptations: {} },
    hypothesis: h,
    brand_rules: { identity: { voice: 'Sade' }, prohibitions: [] },
    learned: overview.learned.arms[0].arm,
    attempts: [],
    measurements: [],
  },
};
