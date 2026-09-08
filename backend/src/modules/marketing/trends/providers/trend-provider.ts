/**
 * A trend provider turns one external source (Google Trends RSS, an Apify
 * TikTok actor, YouTube mostPopular) into region-scoped candidates the
 * TrendSignalService upserts. Every provider is env-gated through `enabled()`
 * so an unset key means "silently skipped", never "fails the refresh".
 */
export interface TrendCandidate {
  /** GOOGLE | TIKTOK | YOUTUBE — the surface the trend was observed on. */
  network: string;
  kind: 'TOPIC' | 'HASHTAG' | 'SOUND' | 'FORMAT';
  title: string;
  ref?: string;
  /** 0..100, comparable across providers only after decay + relevance. */
  score: number;
  halfLifeHours?: number;
  raw?: unknown;
}

export interface TrendProvider {
  name: string;
  enabled(): boolean;
  fetch(region: string): Promise<TrendCandidate[]>;
}

/** Trend sources answer in a few hundred ms or not at all; a hung socket must
 *  not stall the shared scheduled-job worker, so every call is bounded. */
export const TREND_FETCH_TIMEOUT_MS = Number(process.env.TREND_FETCH_TIMEOUT_MS ?? 10_000);

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = TREND_FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** log10(n + 10) · 10 clipped to 0..100: 0 → 10, 1 000 → 30, 100 000 → 50,
 *  1e9 → 100. Shared by traffic- and view-count-based providers so a Google
 *  "20.000+" and a YouTube 20 000 views land on the same rung. */
export function logScore(n: number): number {
  const v = Math.log10(Math.max(0, n) + 10) * 10;
  return Math.min(100, Math.max(0, v));
}

/** Titles are the dedupe key in the DB; keep them one-line and bounded. */
export function cleanTitle(s: unknown, max = 200): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
