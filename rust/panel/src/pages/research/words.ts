import type { Area, ListedTask, Recorder, ResearchTask } from '@/api/types';
import type { TaskCopy } from './copy';

// How a research task reads to a person: its name, its brief in one line, where it stands.

/**
 * What a task is called: a standing task by the audience its ICP entry prospects for (as the
 * pool names it), else by what it looks for; a one-off task by the opening of what it looks for.
 */
export function taskName(copy: TaskCopy, task: ResearchTask, segments: ReadonlyMap<string, string>): string {
  const segment = task.brief.segment_key ? segments.get(task.brief.segment_key) : undefined;
  if (task.kind.type === 'standing' && segment) return segment;
  const sought = soughtText(copy, task.brief.sectors, 2);
  return sought || copy(task.kind.type === 'standing' ? 'fromStrategy' : 'oneOff');
}

/** The first `shown` of `items`, then how many more. */
export function soughtText(copy: TaskCopy, items: readonly string[], shown: number): string {
  const head = items.slice(0, shown).join(', ');
  return items.length > shown ? `${head} ${copy('moreItems', { n: items.length - shown })}` : head;
}

/** A place as written: `İzmir` or `İzmir / Alsancak`. */
export const placeText = (a: Area) => (a.district ? `${a.city} / ${a.district}` : a.city);

/** Where a brief looks, short: one or two places by name, else how many cities (or one city's districts). */
export function placesSummary(copy: TaskCopy, areas: readonly Area[]): string {
  if (areas.length <= 2) return areas.map(placeText).join(', ');
  const cities = [...new Set(areas.map((a) => a.city.toLocaleLowerCase(copy.language)))];
  if (cities.length === 1) return copy('districts', { city: areas[0].city, n: areas.length });
  return copy('cities', { n: cities.length });
}

/** A brief in one line: what it looks for (for a standing task named by its audience) and where. */
export function briefLine(copy: TaskCopy, task: ResearchTask, named: boolean): string {
  const parts = [named ? soughtText(copy, task.brief.sectors, 2) : '', placesSummary(copy, task.brief.areas)];
  if (task.kind.type === 'ad_hoc') parts.push(copy('oneOff'));
  return parts.filter(Boolean).join(' · ');
}

/** A language tag in the panel's language (`tr` → `Türkçe`), or the tag itself when unknown. */
export function languageName(tag: string, language: string): string {
  try {
    const name = new Intl.DisplayNames([language], { type: 'language' }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name.charAt(0).toLocaleUpperCase(language) + name.slice(1) : tag;
  } catch {
    return tag;
  }
}

/** A claim still running at `now`. */
function liveClaim(task: ResearchTask, now = Date.now()) {
  return task.claim && Date.parse(task.claim.until) > now ? task.claim : null;
}

/** Whether `by` is the signed-in person themselves (an agent connected under their name is not). */
const isMe = (by: Recorder, userId: string | undefined) => by.kind === 'human' && !!userId && by.user_id === userId;

export type TaskState =
  | { kind: 'held'; by: 'agent' | 'you' | 'member'; who: Recorder; until: string }
  | { kind: 'waiting' }
  | { kind: 'doneToday' }
  | { kind: 'pausedToday' }
  | { kind: 'closed'; status: 'done' | 'canceled' | 'superseded'; at: string | null };

/** Where a listed task stands, from the server's answer only. */
export function taskState(item: ListedTask, userId: string | undefined, now = Date.now()): TaskState {
  const { task } = item;
  if (task.status !== 'open') return { kind: 'closed', status: task.status, at: task.closed_at };
  const claim = liveClaim(task, now);
  if (claim) return { kind: 'held', by: isMe(claim.by, userId) ? 'you' : claim.by.kind === 'agent' ? 'agent' : 'member', who: claim.by, until: claim.until };
  if (item.remaining_today > 0) return { kind: 'waiting' };
  // Nothing more today: the cap is reached, or (a standing task) its audience's backlog is full.
  return item.found_today >= task.daily_cap ? { kind: 'doneToday' } : { kind: 'pausedToday' };
}

/** The share of a one-off task's target found, 0 to 100. */
export const targetShare = (found: number, target: number) => Math.min(100, Math.round((found / Math.max(1, target)) * 100));
