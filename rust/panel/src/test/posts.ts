import { WS_ID } from './fixtures';
import { materialsAnswers } from './materials';

// Shared fixtures of the Paylaşımlar screens: planned posts, post requests, a weekly summary and
// the posting settings, in the server's serde shapes (`jt_studio::{package, posts}`).

export const X_CHANNEL = '00000000-0000-4000-8000-0000000000c1';
export const HYPOTHESIS = '00000000-0000-4000-8000-0000000000a1';

export const defaultSettings = {
  tz: 'Europe/Istanbul',
  policy: {
    lead_minutes: { story: 120, feed_post: 1440, carousel: 1440, reel: 2880, tiktok_video: 2880 },
    grace_minutes: { story: 60, feed_post: 360, carousel: 360, reel: 360, tiktok_video: 360 },
    feed_cap: { per_day: 2, spacing_minutes: 180 },
    story_cap: { per_day: 25, spacing_minutes: 10 },
    tiktok_video_cap: { per_day: 3, spacing_minutes: 0 },
    quiet_start_hour: 0,
    quiet_end_hour: 8,
    floor_days: 4,
    debounce_minutes: 30,
    horizon_days: 30,
  },
};

/** A planned post of slot `slot` publishing at `at`, its slot in `state`. */
export function postOut(
  slot: string,
  at: string,
  patch: { state?: string; pending?: boolean; retired?: unknown; format?: string } = {},
) {
  const publish = Date.parse(at);
  return {
    post: {
      slot_id: slot,
      workspace_id: WS_ID,
      format: patch.format ?? 'feed_post',
      capability_id: X_CHANNEL,
      publish_at: at,
      prep_start_at: new Date(publish - 86400_000).toISOString(),
      grace_until: new Date(publish + 6 * 3600_000).toISOString(),
      olay_id: null,
      package_request_id: 'q1',
      material_ids: ['m1', 'm2'],
      subject: { kind: 'generic' },
      hypothesis_id: HYPOTHESIS,
      content_type: 'text',
      retired: patch.retired ?? null,
      created_at: '2026-10-22T09:00:00Z',
    },
    slot: {
      id: slot,
      chain: { workspace_id: WS_ID, born_version_id: 'v1', hypothesis_id: HYPOTHESIS, arm_id: 'a1' },
      capability_id: X_CHANNEL,
      scheduled_at: at,
      state: patch.state ?? 'planned',
      revision: 0,
    },
    pending: patch.pending ?? false,
  };
}

export function postRequest(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_ID,
    key: `olay:o1:0:${id}`,
    trigger: 'olay',
    status: 'open',
    olay_id: 'o1',
    occasion: null,
    year: null,
    capability_id: null,
    material_ids: ['m1', 'm2', 'm3'],
    best_formats: [
      { format: 'reel', mean: 0.2, posts: 3 },
      { format: 'feed_post', mean: null, posts: 0 },
    ],
    hints: {},
    created_at: '2026-10-22T09:00:00Z',
    answered_at: null,
    closed_at: null,
    ...patch,
  };
}

export const weekSummary = {
  week_start: '2026-10-19',
  tz: 'Europe/Istanbul',
  from: '2026-10-18T21:00:00Z',
  until: '2026-10-25T21:00:00Z',
  published: [
    {
      slot_id: 's1',
      publication_id: 'p1',
      capability_id: X_CHANNEL,
      format: 'feed_post',
      published_at: '2026-10-20T07:00:00Z',
      url: 'https://x.com/jeeta/status/1',
    },
  ],
  planned: [
    {
      slot_id: 's2',
      capability_id: X_CHANNEL,
      format: 'carousel',
      publish_at: '2026-10-24T07:00:00Z',
      prep_start_at: '2026-10-23T07:00:00Z',
      state: 'ready',
    },
  ],
  cancelled: [
    { slot_id: 's3', capability_id: X_CHANNEL, format: 'feed_post', reason: 'missed_grace', at: '2026-10-21T13:00:00Z' },
    { slot_id: 's4', capability_id: X_CHANNEL, format: null, reason: 'replanned', at: '2026-10-19T08:00:00Z' },
  ],
  scores: [
    { format: 'reel', olay_kind: 'workshop', hypothesis_id: HYPOTHESIS, mean: 0.25, posts: 2 },
  ],
};

export const channels = [
  {
    capability: { id: X_CHANNEL, name: 'Jeeta X', kind_key: 'x' },
    effective_status: 'verified',
  },
];

/** The Studio page's own reads and the Paylaşımlar tab's. */
export const postsAnswers = {
  ...materialsAnswers,
  'GET /api/capabilities': channels,
  'GET /api/studio/posts': { posts: [], settings: defaultSettings },
  'GET /api/studio/post-requests': [],
  'GET /api/studio/summary': weekSummary,
};
