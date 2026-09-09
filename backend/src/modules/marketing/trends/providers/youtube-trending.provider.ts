import { Injectable } from '@nestjs/common';
import { TrendCandidate, TrendProvider, cleanTitle, fetchWithTimeout, logScore } from './trend-provider';

const API_BASE = process.env.YOUTUBE_API_BASE ?? 'https://www.googleapis.com/youtube/v3';
/** A mostPopular chart entry stays relevant for several days. */
const HALF_LIFE_HOURS = 72;
const MAX_RESULTS = 25;

type RawVideo = {
  id?: string;
  snippet?: { title?: string; channelTitle?: string; categoryId?: string; tags?: string[]; publishedAt?: string };
  statistics?: { viewCount?: string | number; likeCount?: string | number };
};

/**
 * YouTube Data API `videos.list(chart=mostPopular)` — one quota unit per call,
 * so 12-hourly refreshes cost nothing against the 10k/day default. Enabled by
 * `YOUTUBE_API_KEY` alone (an API key, not OAuth: the chart is public data).
 */
@Injectable()
export class YoutubeTrendingProvider implements TrendProvider {
  readonly name = 'youtube-trending';

  enabled(): boolean {
    return !!process.env.YOUTUBE_API_KEY;
  }

  async fetch(region: string): Promise<TrendCandidate[]> {
    if (!this.enabled()) return [];
    const qs = new URLSearchParams({
      part: 'snippet,statistics', chart: 'mostPopular', regionCode: region,
      maxResults: String(MAX_RESULTS), key: process.env.YOUTUBE_API_KEY as string,
    });
    const res = await fetchWithTimeout(`${API_BASE}/videos?${qs.toString()}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`youtube mostPopular failed (${res.status})`);
    const body = (await res.json()) as { items?: RawVideo[] };
    return this.map(Array.isArray(body?.items) ? body.items : []);
  }

  map(items: RawVideo[]): TrendCandidate[] {
    const out: TrendCandidate[] = [];
    for (const v of items) {
      const title = cleanTitle(v.snippet?.title);
      if (!title || !v.id) continue;
      const viewCount = Number(v.statistics?.viewCount ?? 0) || 0;
      out.push({
        network: 'YOUTUBE',
        kind: 'TOPIC',
        title,
        ref: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
        score: logScore(viewCount),
        halfLifeHours: HALF_LIFE_HOURS,
        raw: {
          videoId: v.id, viewCount, channelTitle: v.snippet?.channelTitle ?? null,
          categoryId: v.snippet?.categoryId ?? null, tags: v.snippet?.tags ?? [], publishedAt: v.snippet?.publishedAt ?? null,
        },
      });
    }
    return out;
  }
}
