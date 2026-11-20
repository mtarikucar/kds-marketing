import type { AccountDetail } from '@/api/social';
import type { PostOut, PostingSettings, PostFormat } from '@/api/posts';

// The one-tap times offered for "Zaman seç" (design 2026-11-19 §2.6 `pick_time`), kept from the
// social page's timeline (design 2026-11-18) when the server's join replaced the rest of it.

type Recent = AccountDetail['recent'][number];

// --- Time in the posting zone ------------------------------------------------------------------

interface Parts { y: number; m: number; d: number; h: number; mi: number }

function formatter(tz: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
  } catch {
    // The server reads an unknown zone as its default.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'Europe/Istanbul' });
  }
}

/** `at`'s date and time in zone `tz`. */
export function zoned(at: number, tz: string): Parts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** The instant that is `p` in zone `tz` (the earlier one across a change of the clocks). */
export function fromZoned(p: Parts, tz: string): number {
  const wanted = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const seen = zoned(guess, tz);
    const diff = wanted - Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

const dayKey = (p: Parts) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const capGroup = (format: string | null) => (format === 'story' ? 'story' : format === 'tiktok_video' ? 'tiktok' : 'feed');

/** Whether local hour `hour` is quiet: `start..end`, wrapping past midnight; none when equal. */
export function isQuietHour(policy: PostingSettings['policy'], hour: number): boolean {
  const { quiet_start_hour: start, quiet_end_hour: end } = policy;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Times a person may give a waiting version with one tap, derived from what the page read and
 * nothing else: the account's usual time (the most frequent local time of its posts, planned and
 * published; the latest post's on a tie) on the next days that have no post of the same kind on
 * that account, within the rules the posting engine checks (the format's lead, the horizon, the
 * quiet hours, the spacing). An account with no post has no usual time: no suggestion.
 */
export function suggestTimes({
  format,
  capabilityId,
  settings,
  posts,
  published,
  now = Date.now(),
  count = 3,
}: {
  format: PostFormat;
  capabilityId: string;
  settings: PostingSettings;
  /** The planned posts (`studio.posts_list`): every account's, the retired ones too. */
  posts: PostOut[];
  /** The account's posts that went out (`social.account_get`'s `recent`). */
  published: Recent[];
  now?: number;
  count?: number;
}): string[] {
  const { policy, tz } = settings;
  const withPost = new Set(posts.map((p) => p.post.slot_id));
  // What the engine counts on the account: every planned post not taken back, and what went out
  // with no planned post behind it (as a feed post).
  const existing: { at: number; format: string | null }[] = [
    ...posts.filter((p) => p.post.capability_id === capabilityId && p.post.retired === null && p.slot.state !== 'retired').map((p) => ({ at: Date.parse(p.post.publish_at), format: p.post.format })),
    ...published.filter((r) => !withPost.has(r.slot_id)).map((r) => ({ at: Date.parse(r.published_at), format: r.format ?? 'feed_post' })),
  ].filter((e) => Number.isFinite(e.at));
  if (!existing.length) return [];
  const tally = new Map<string, { n: number; last: number; h: number; mi: number }>();
  for (const e of existing) {
    const p = zoned(e.at, tz);
    const key = `${p.h}:${p.mi}`;
    const t = tally.get(key) ?? { n: 0, last: 0, h: p.h, mi: p.mi };
    tally.set(key, { ...t, n: t.n + 1, last: Math.max(t.last, e.at) });
  }
  const usual = [...tally.values()].sort((a, b) => b.n - a.n || b.last - a.last)[0];
  if (isQuietHour(policy, usual.h)) return [];
  const group = capGroup(format);
  const same = existing.filter((e) => capGroup(e.format) === group);
  const busy = new Set(same.map((e) => dayKey(zoned(e.at, tz))));
  const spacing = (format === 'story' ? policy.story_cap : format === 'tiktok_video' ? policy.tiktok_video_cap : policy.feed_cap).spacing_minutes * 60_000;
  // Ten minutes over the lead: a time offered now must still pass when it is tapped.
  const earliest = now + (policy.lead_minutes[format] + 10) * 60_000;
  const latest = now + policy.horizon_days * 86_400_000;
  const today = zoned(now, tz);
  const out: string[] = [];
  for (let i = 0; i <= policy.horizon_days && out.length < count; i += 1) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const at = fromZoned({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h: usual.h, mi: usual.mi }, tz);
    if (at < earliest || at > latest) continue;
    if (busy.has(dayKey(zoned(at, tz)))) continue;
    if (same.some((e) => Math.abs(e.at - at) < spacing)) continue;
    out.push(new Date(at).toISOString());
  }
  return out;
}
