import type { PoolCountRow, Rubric, ScoreRow } from '@/api/types';

// What a candidate is for and what it advanced on, as the pool's pages say it. Pure: the business
// words (segment names, ICP entry keys, rubric criteria) are the workspace's data, never this
// file's.

/**
 * A workspace key as words: `toplu_etkinlik` → `Toplu etkinlik`. ICP entries and rubric criteria
 * carry no display name of their own, so their keys stand in for one.
 */
export function keyWords(key: string, language: string): string {
  const words = key.replace(/_+/g, ' ').trim();
  if (!words) return key;
  return words.charAt(0).toLocaleUpperCase(language) + words.slice(1);
}

/** A date as day and month (`12 Kas`), for telling apart tasks of one name. */
export function shortDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const locale = language.startsWith('tr') ? 'tr-TR' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

/** One choice of a filter: its value, its label, and how many prospects hold it (`null`: not counted). */
export interface FilterChoice {
  value: string;
  label: string;
  count: number | null;
}

/**
 * The choices of one filter: the `known` values first, in their order, then every other value the
 * counts carry (in the counts' order: largest first), then `current` when it is neither (a link,
 * or a value no prospect holds now). "Without one" (`key: null`) is never a choice. Once counted, a
 * value no prospect holds counts 0.
 */
export function filterChoices(
  known: readonly string[],
  counted: readonly PoolCountRow[] | undefined,
  current: string,
  label: (value: string) => string,
): FilterChoice[] {
  const counts = new Map<string, number>();
  for (const row of counted ?? []) if (row.key !== null) counts.set(row.key, row.count);
  const values: string[] = [];
  for (const value of [...known, ...counts.keys(), current]) {
    if (value && !values.includes(value)) values.push(value);
  }
  return values.map((value) => ({ value, label: label(value), count: counted ? (counts.get(value) ?? 0) : null }));
}

/** How many prospects hold `key` among `counted`, `null` when nothing was counted. */
export function countOf(counted: readonly PoolCountRow[] | undefined, key: string | null): number | null {
  if (!counted) return null;
  return counted.find((row) => row.key === key)?.count ?? 0;
}

/** A criterion that gave fewer than its points. */
export interface Shortfall {
  criterion: string;
  points: number;
  weight: number;
}

/** What the latest score says about qualifying, under the rubric it was computed under. */
export type Verdict =
  | { kind: 'unscored' }
  /** Scored, but the rubric it was scored under is not at hand. */
  | { kind: 'scored'; score: number }
  | { kind: 'passed'; score: number; threshold: number }
  | { kind: 'below'; score: number; threshold: number; short: Shortfall[] };

/** The criteria of `score` that lost the most of their weight under `rubric`, largest loss first, at most `n`. */
export function shortfalls(score: ScoreRow, rubric: Rubric, n = 2): Shortfall[] {
  return score.reasons
    .map((r) => ({ criterion: r.criterion, points: r.points, weight: rubric.criteria.find((c) => c.key === r.criterion)?.weight ?? r.points }))
    .filter((s) => s.points < s.weight)
    .sort((a, b) => b.weight - b.points - (a.weight - a.points) || a.criterion.localeCompare(b.criterion))
    .slice(0, n);
}

/** The latest score's verdict: above or below the rubric's `qualify_at`, and where it fell short. */
export function verdictOf(latest: ScoreRow | undefined, rubric: Rubric | null): Verdict {
  if (!latest) return { kind: 'unscored' };
  if (!rubric) return { kind: 'scored', score: latest.score };
  const threshold = rubric.qualify_at;
  if (latest.score >= threshold) return { kind: 'passed', score: latest.score, threshold };
  return { kind: 'below', score: latest.score, threshold, short: shortfalls(latest, rubric) };
}
