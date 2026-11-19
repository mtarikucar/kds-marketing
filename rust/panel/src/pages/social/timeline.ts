import type { AccountDetail, SocialAccount, WaitingPackage } from '@/api/social';
import type { Overview, Slot } from '@/api/studio';
import { instant } from '@/api/studio';
import type { PostOut, PostingSettings, PostFormat } from '@/api/posts';
import type { WaitKind } from './location';

type Pending = Overview['today'];
type Blocker = Pending['blockers'][number];
type Upcoming = AccountDetail['upcoming'][number];
type Recent = AccountDetail['recent'][number];

/**
 * A post's state in plain words, from the server's answers only: one that waits for a person
 * (an approval, TikTok's posting screen, a failed send), one still to go out (held, being
 * processed by the platform, due and being sent, left with the platform's scheduler, or to be
 * sent by Jeeta at its time), or one that went out.
 */
export type PostState = 'approval' | 'tiktok' | 'failed' | 'held' | 'processing' | 'due' | 'at_provider' | 'by_jeeta' | 'published';

export interface TimelinePost {
  slot_id: string;
  capability_id: string;
  /** `null` for a post that went out with no planned post behind it. */
  format: string | null;
  /** When it goes out, or went out. */
  at: string;
  /** The opening of its text; empty when only the pending work names the post. */
  title: string;
  state: PostState;
  /** What the pending work says holds or stops it. */
  blockers: Blocker[];
  /** Its materials (the planned post's), the first one its visual. */
  material_ids: string[];
  url?: string | null;
  metrics?: Recent['metrics'];
  /** The slot as the pending work read it: the revision an approval names. */
  slot?: Slot;
}

export interface TimelineVersion {
  pack: WaitingPackage;
  version: WaitingPackage['versions'][number];
}

export interface Timeline {
  waiting: { approvals: TimelinePost[]; tiktok: TimelinePost[]; failed: TimelinePost[]; times: TimelineVersion[]; blocked: TimelineVersion[] };
  queued: TimelinePost[];
  published: TimelinePost[];
}

export const WAIT_STATES: Partial<Record<PostState, WaitKind>> = { approval: 'approvals', tiktok: 'tiktok', failed: 'failed' };

const slotOf = (b: Blocker) => ('slot' in b.target ? b.target.slot : undefined);
const iso = (value: Slot['scheduled_at']) => instant(value).toISOString();
/** A send that did not go through: any `publish_*` reason but the platform still processing it. */
export const isFailure = (reason: string) => reason.startsWith('publish_') && reason !== 'publish_processing';

/**
 * Every account's posts as one timeline (or `scope`'s alone): what waits for a person first,
 * then what is still to go out, soonest first, then what went out, newest first; and the
 * finished versions with no time yet, the ones some account can take apart from the blocked.
 */
export function buildTimeline({
  details,
  pending,
  posts,
  packages,
  scope,
  now = Date.now(),
}: {
  details: AccountDetail[];
  pending?: Pending;
  posts?: PostOut[];
  packages?: WaitingPackage[];
  scope?: string;
  now?: number;
}): Timeline {
  const blockers = new Map<string, Blocker[]>();
  for (const b of pending?.blockers ?? []) {
    const id = slotOf(b);
    if (id) blockers.set(id, [...(blockers.get(id) ?? []), b]);
  }
  const pendingSlots = new Map((pending?.slots ?? []).map((s) => [s.slot.id, s.slot]));
  const planned = new Map((posts ?? []).map((p) => [p.post.slot_id, p]));
  const of = (id: string) => blockers.get(id) ?? [];
  const tiktok = (id: string) => of(id).some((b) => b.next_action === 'tiktok_posting_screen');
  const failed = (id: string) => of(id).some((b) => isFailure(b.reason));
  const approval = new Set((pending?.approvals ?? []).flatMap((t) => ('slot' in t ? [t.slot] : [])));
  const waitState = (id: string, waits: Upcoming['waits_for'] | undefined): PostState | null =>
    failed(id) ? 'failed' : waits === 'tiktok_screen' || tiktok(id) ? 'tiktok' : waits === 'approval' || approval.has(id) ? 'approval' : null;

  const seen = new Set<string>();
  const items: TimelinePost[] = [];
  for (const d of details) {
    const capability = d.account.capability_id;
    if (scope && capability !== scope) continue;
    for (const r of d.recent) {
      if (seen.has(r.slot_id)) continue;
      seen.add(r.slot_id);
      items.push({
        slot_id: r.slot_id, capability_id: capability, format: r.format, at: r.published_at, title: r.title, state: 'published',
        blockers: [], material_ids: planned.get(r.slot_id)?.post.material_ids ?? [], url: r.url, metrics: r.metrics,
      });
    }
    for (const u of d.upcoming) {
      if (seen.has(u.slot_id)) continue;
      seen.add(u.slot_id);
      const waits = u.state === 'waiting_person' ? u.waits_for : null;
      const state: PostState = waitState(u.slot_id, waits)
        ?? (u.state === 'held' ? 'held'
          : of(u.slot_id).some((b) => b.reason === 'publish_processing') ? 'processing'
            : Date.parse(u.publish_at) <= now ? 'due'
              : u.held_at_provider ? 'at_provider' : 'by_jeeta');
      items.push({
        slot_id: u.slot_id, capability_id: capability, format: u.format, at: u.publish_at, title: u.title, state,
        blockers: of(u.slot_id), material_ids: planned.get(u.slot_id)?.post.material_ids ?? [],
      });
    }
  }
  // What the pending work says waits for a person, though no account's list carries it (past
  // the lists' fifty, or on an account whose list was not read): the pending work names it.
  for (const [id, slot] of pendingSlots) {
    if (seen.has(id) || (scope && slot.capability_id !== scope)) continue;
    const state = waitState(id, null);
    if (!state) continue;
    seen.add(id);
    const post = planned.get(id)?.post;
    items.push({
      slot_id: id, capability_id: slot.capability_id, format: post?.format ?? null, at: post?.publish_at ?? iso(slot.scheduled_at),
      title: '', state, blockers: of(id), material_ids: post?.material_ids ?? [], slot,
    });
  }
  for (const item of items) item.slot ??= pendingSlots.get(item.slot_id) ?? planned.get(item.slot_id)?.slot;

  const soonest = (a: { at: string }, b: { at: string }) => Date.parse(a.at) - Date.parse(b.at);
  const by = (state: PostState) => items.filter((i) => i.state === state).sort(soonest);
  const versions = (packages ?? []).flatMap((pack) => pack.versions.map((version) => ({ pack, version })));
  return {
    waiting: {
      approvals: by('approval'),
      tiktok: by('tiktok'),
      failed: by('failed'),
      times: versions.filter((v) => v.version.accounts.length > 0 && (!scope || v.version.accounts.includes(scope))),
      // A version no account can take belongs to no account: it shows with every account's posts.
      blocked: scope ? [] : versions.filter((v) => v.version.accounts.length === 0),
    },
    queued: items.filter((i) => !WAIT_STATES[i.state] && i.state !== 'published').sort(soonest),
    published: items.filter((i) => i.state === 'published').sort((a, b) => -soonest(a, b)),
  };
}

export const waitCount = (t: Timeline, kind: WaitKind) => t.waiting[kind].length;

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
