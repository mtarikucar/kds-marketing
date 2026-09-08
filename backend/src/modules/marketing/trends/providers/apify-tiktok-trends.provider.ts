import { Injectable } from '@nestjs/common';
import { TrendCandidate, TrendProvider, cleanTitle, fetchWithTimeout } from './trend-provider';

const APIFY_BASE = process.env.APIFY_BASE_URL ?? 'https://api.apify.com';
/** TikTok hashtags/sounds outlive a Google search spike but not a YouTube chart. */
const HALF_LIFE_HOURS = 48;

/** The TikTok trend actors on the Apify store disagree on field names; this
 *  is the union we have seen, read in order of specificity. */
type RawItem = Record<string, unknown> & {
  hashtagName?: string; hashtag?: string; name?: string; title?: string;
  soundName?: string; musicName?: string; soundTitle?: string;
  type?: string; kind?: string;
  url?: string; link?: string; shareUrl?: string;
  videoCount?: number; publishCnt?: number; useCount?: number; viewCount?: number; count?: number;
  rank?: number;
};

/**
 * Apify TikTok trends — enabled only when BOTH `APIFY_TOKEN` and
 * `TREND_TIKTOK_ACTOR` are set, because there is no canonical actor: ops picks
 * one from the store and its id is configuration, not code. Items are scored by
 * their position in the actor's list (the actor already ranks by momentum, and
 * the count fields it returns are not comparable between hashtags and sounds).
 */
@Injectable()
export class ApifyTiktokTrendsProvider implements TrendProvider {
  readonly name = 'apify-tiktok';

  enabled(): boolean {
    return !!process.env.APIFY_TOKEN && !!process.env.TREND_TIKTOK_ACTOR;
  }

  async fetch(region: string): Promise<TrendCandidate[]> {
    if (!this.enabled()) return [];
    const actor = process.env.TREND_TIKTOK_ACTOR as string;
    const url = `${APIFY_BASE}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN as string)}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region }),
    });
    if (!res.ok) throw new Error(`apify tiktok trends actor ${actor} failed (${res.status})`);
    const body = (await res.json()) as unknown;
    return this.map(Array.isArray(body) ? (body as RawItem[]) : []);
  }

  map(items: RawItem[]): TrendCandidate[] {
    const seen = new Set<string>();
    const picked: Array<{ kind: 'HASHTAG' | 'SOUND'; title: string; ref?: string; raw: RawItem; count: number | null }> = [];
    for (const it of items) {
      const sound = it.soundName ?? it.musicName ?? it.soundTitle;
      const typed = String(it.type ?? it.kind ?? '').toLowerCase();
      const isSound = sound != null || typed === 'sound' || typed === 'music';
      const rawTitle = isSound ? (sound ?? it.title ?? it.name) : (it.hashtagName ?? it.hashtag ?? it.name ?? it.title);
      const title = cleanTitle(rawTitle).replace(/^#/, '');
      if (!title) continue;
      const kind = isSound ? 'SOUND' : 'HASHTAG';
      const key = `${kind}:${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const count = [it.videoCount, it.publishCnt, it.useCount, it.viewCount, it.count].find((n) => typeof n === 'number') ?? null;
      picked.push({ kind, title, ref: it.url ?? it.link ?? it.shareUrl, raw: it, count });
    }
    const n = picked.length;
    return picked.map((p, i) => ({
      network: 'TIKTOK',
      kind: p.kind,
      title: p.title,
      ref: p.ref || undefined,
      score: Math.round(100 * (1 - i / n)),
      halfLifeHours: HALF_LIFE_HOURS,
      raw: { rank: i + 1, count: p.count, author: p.raw.author ?? null },
    }));
  }
}
