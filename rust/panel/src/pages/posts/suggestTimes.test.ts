import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/test/posts';
import { fromZoned, suggestTimes, zoned } from './suggestTimes';
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
