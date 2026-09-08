import { Injectable } from '@nestjs/common';
import { TrendCandidate, TrendProvider, cleanTitle, fetchWithTimeout, logScore } from './trend-provider';

const FEED_BASE = process.env.TREND_GOOGLE_RSS_BASE ?? 'https://trends.google.com/trending/rss';
/** Daily search trends turn over within a day or two; 36h keeps yesterday's
 *  hit alive for one planning pass and lets it fade before the next. */
const HALF_LIFE_HOURS = 36;

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const unwrap = (s: string): string => decodeEntities(s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unwrap(m[1].trim()) : undefined;
};

/** "20.000+" / "2,000+" / "500+" → 20000 / 2000 / 500; anything unparsable → 0. */
export function parseApproxTraffic(s: string | undefined): number {
  const digits = String(s ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/**
 * Google Trends "daily search trends" RSS — keyless, region-scoped, the one
 * source that is always on. Parsed with a hand-rolled tag matcher rather than an
 * XML library: the feed is a flat list of <item>s with three fields we care
 * about, and adding a parser dependency for that would be the bigger risk.
 */
@Injectable()
export class GoogleTrendsRssProvider implements TrendProvider {
  readonly name = 'google-trends';

  enabled(): boolean {
    return process.env.TREND_GOOGLE_DISABLED !== '1';
  }

  async fetch(region: string): Promise<TrendCandidate[]> {
    const res = await fetchWithTimeout(`${FEED_BASE}?geo=${encodeURIComponent(region)}`, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) throw new Error(`google trends rss failed (${res.status})`);
    return this.parse(await res.text());
  }

  parse(xml: string): TrendCandidate[] {
    const out: TrendCandidate[] = [];
    for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
      const item = m[1];
      const title = cleanTitle(tag(item, 'title'));
      if (!title) continue;
      const approxTraffic = tag(item, 'ht:approx_traffic');
      const traffic = parseApproxTraffic(approxTraffic);
      const ref = tag(item, 'ht:news_item_url');
      out.push({
        network: 'GOOGLE',
        kind: 'TOPIC',
        title,
        ref: ref || undefined,
        score: logScore(traffic),
        halfLifeHours: HALF_LIFE_HOURS,
        raw: { traffic, approxTraffic: approxTraffic ?? null, pubDate: tag(item, 'pubDate') ?? null, newsTitle: tag(item, 'ht:news_item_title') ?? null },
      });
    }
    return out;
  }
}
