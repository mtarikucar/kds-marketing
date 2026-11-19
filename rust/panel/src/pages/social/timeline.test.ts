import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/test/posts';
import { buildTimeline, fromZoned, suggestTimes, zoned } from './timeline';
import { legacyTarget } from './location';
import type { PostOut } from '@/api/posts';

const tz = 'Europe/Istanbul';
const settings = { ...defaultSettings, policy: { ...defaultSettings.policy, quiet_start_hour: 22, quiet_end_hour: 8 } };
// Wednesday 2026-11-18 08:00 in Istanbul.
const now = Date.parse('2026-11-18T05:00:00Z');
const at = (day: number, hour: number, minute = 0) => new Date(fromZoned({ y: 2026, m: 11, d: day, h: hour, mi: minute }, tz)).toISOString();
const post = (id: string, iso: string, format = 'feed_post', capability = 'ig1', retired: unknown = null) => ({
  post: { slot_id: id, capability_id: capability, format, publish_at: iso, material_ids: [`m-${id}`], retired },
  slot: { id, capability_id: capability, scheduled_at: iso, state: retired ? 'retired' : 'ready', revision: 3 },
  pending: false,
}) as unknown as PostOut;

describe('suggested times', () => {
  it('reads and writes times in the posting zone', () => {
    expect(zoned(Date.parse('2026-11-18T09:00:00Z'), tz)).toEqual({ y: 2026, m: 11, d: 18, h: 12, mi: 0 });
    expect(new Date(fromZoned({ y: 2026, m: 11, d: 18, h: 12, mi: 0 }, tz)).toISOString()).toBe('2026-11-18T09:00:00.000Z');
  });

  it('takes the usual time and skips the days with a post of the same kind, the lead and the spacing', () => {
    const posts = [post('a', at(15, 12)), post('b', at(16, 12)), post('c', at(19, 12)), post('d', at(21, 12)), post('e', at(20, 18, 30), 'story')];
    const times = suggestTimes({ format: 'feed_post', capabilityId: 'ig1', settings, posts, published: [], now });
    // The 18th is inside the 24-hour lead; the 19th and 21st have a feed post; a story leaves the 20th free.
    expect(times).toEqual([at(20, 12), at(22, 12), at(23, 12)]);
  });

  it('ignores other accounts and posts taken back, and counts a publication with no planned post', () => {
    const posts = [post('a', at(15, 12)), post('b', at(20, 12), 'feed_post', 'other'), post('c', at(20, 12), 'feed_post', 'ig1', { reason: 'cancelled', at: at(17, 9) })];
    const published = [{ slot_id: 'old', published_at: at(10, 12), format: null, title: '', url: null, metrics: { reach: null, views: null, engagement: null } }];
    const times = suggestTimes({ format: 'feed_post', capabilityId: 'ig1', settings, posts, published, now, count: 2 });
    expect(times).toEqual([at(19, 12), at(20, 12)]);
  });

  it('offers nothing with no post to learn the time from, or when the usual time is quiet', () => {
    expect(suggestTimes({ format: 'reel', capabilityId: 'ig1', settings, posts: [], published: [], now })).toEqual([]);
    expect(suggestTimes({ format: 'reel', capabilityId: 'ig1', settings, posts: [post('a', at(15, 23))], published: [], now })).toEqual([]);
  });

  it('stays inside the horizon', () => {
    const short = { ...settings, policy: { ...settings.policy, horizon_days: 2 } };
    expect(suggestTimes({ format: 'feed_post', capabilityId: 'ig1', settings: short, posts: [post('a', at(15, 12))], published: [], now })).toEqual([at(19, 12)]);
  });
});

describe('the timeline', () => {
  const detail = {
    account: { capability_id: 'ig1' },
    days: [],
    upcoming: [
      { slot_id: 'ok', publish_at: at(25, 12), format: 'feed_post', title: 'Hazır', held_at_provider: false, state: 'ready', waits_for: null },
      { slot_id: 'ap', publish_at: at(24, 12), format: 'feed_post', title: 'Onay', held_at_provider: false, state: 'waiting_person', waits_for: 'approval' },
      { slot_id: 'f', publish_at: at(17, 12), format: 'feed_post', title: 'Gitmedi', held_at_provider: false, state: 'ready', waits_for: null },
    ],
    recent: [{ slot_id: 'p', published_at: at(10, 12), format: 'reel', title: 'Gitti', url: null, metrics: { reach: 1, views: null, engagement: null } }],
    totals: { posts: 1, reach: 1, views: null, engagement: null },
  };
  const pending = {
    slots: [{ slot: { id: 'tt', capability_id: 'tt1', scheduled_at: at(19, 9), state: 'ready', revision: 2 }, overdue: false }],
    approvals: [{ slot: 'ap' }, { slot: 'tt' }],
    blockers: [{ target: { slot: 'f' }, reason: 'publish_permanent' }, { target: { slot: 'tt' }, reason: 'human_approval_required', next_action: 'tiktok_posting_screen' }],
    budget_moves: [], paid_alerts: [],
  };

  it('puts each post in its one place, the pending work’s own ones too', () => {
    const t = buildTimeline({ details: [detail as never], pending: pending as never, posts: [post('ok', at(25, 12))], now });
    expect(t.waiting.approvals.map((p) => p.slot_id)).toEqual(['ap']);
    expect(t.waiting.failed.map((p) => p.slot_id)).toEqual(['f']);
    expect(t.waiting.tiktok.map((p) => [p.slot_id, p.capability_id, p.slot?.revision])).toEqual([['tt', 'tt1', 2]]);
    expect(t.queued.map((p) => [p.slot_id, p.state, p.material_ids])).toEqual([['ok', 'by_jeeta', ['m-ok']]]);
    expect(t.published.map((p) => p.slot_id)).toEqual(['p']);
  });

  it('keeps to one account when scoped, and leaves blocked versions to every account’s view', () => {
    const packages = [{ project_id: 'x', goal: '', summary: '', delivered_at: at(1, 1), versions: [
      { version_id: 'v1', format: 'reel', text: '', material_ids: [], accounts: ['ig1'] },
      { version_id: 'v2', format: 'reel', text: '', material_ids: [], accounts: ['tt1'] },
      { version_id: 'v3', format: 'reel', text: '', material_ids: [], accounts: [], blocked: 'no_connected_account' },
    ] }];
    const t = buildTimeline({ details: [detail as never], pending: pending as never, packages, scope: 'ig1', now });
    expect(t.waiting.tiktok).toEqual([]);
    expect(t.waiting.times.map((v) => v.version.version_id)).toEqual(['v1']);
    expect(t.waiting.blocked).toEqual([]);
    expect(buildTimeline({ details: [], packages, now }).waiting.blocked.map((v) => v.version.version_id)).toEqual(['v3']);
  });
});

describe('old addresses', () => {
  it.each([
    ['?tab=packages', '', '/social?filter=times'],
    ['?tab=packages', '#version-v%2F1', '/social?version=v%2F1'],
    ['?tab=settings', '', '/social?settings=1'],
    ['?section=settings', '', '/social?settings=1'],
    ['?tab=posts&view=settings', '', '/social?settings=1'],
    ['?tab=posts&view=week', '', '/social'],
    ['?tab=accounts&account=ig1', '', '/social?account=ig1'],
  ])('rewrites %s%s', (search, hash, target) => {
    expect(legacyTarget(search, hash)).toBe(target);
  });

  it('leaves the current addresses alone', () => {
    expect(legacyTarget('?slot=s1', '')).toBeNull();
    expect(legacyTarget('?view=all&filter=failed', '')).toBeNull();
  });
});
