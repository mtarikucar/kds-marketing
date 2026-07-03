import { Injectable, Logger } from '@nestjs/common';
import { Geo, PlaceHit, SocialHit } from './research-source.provider';

const APIFY_BASE = process.env.APIFY_BASE_URL ?? 'https://api.apify.com';
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS ?? 90_000);
// Actor slugs are env-overridable so ops can swap actors without a deploy.
const PLACES_ACTOR = process.env.APIFY_PLACES_ACTOR ?? 'compass~crawler-google-places';
const INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify~instagram-scraper';

type RawPlace = {
  placeId?: string; title?: string; address?: string; city?: string; state?: string;
  phone?: string; phoneUnformatted?: string; website?: string; categoryName?: string;
  totalScore?: number; reviewsCount?: number; permanentlyClosed?: boolean;
  reviews?: Array<{ text?: string; stars?: number; publishedAtDate?: string }>;
};
type RawIg = { username?: string; fullName?: string; biography?: string; followersCount?: number; externalUrl?: string; isBusinessAccount?: boolean };

/**
 * Apify REST provider — runs the Google-Maps places actor and the Instagram
 * actor synchronously and returns their dataset items. Inert until APIFY_TOKEN
 * is set. One actor run = one billable APIFY_RUN unit the caller meters. The
 * long timeout reflects that actor runs are slower than a single HTTP fetch.
 */
@Injectable()
export class ApifyProvider {
  readonly name = 'apify';
  private readonly logger = new Logger(ApifyProvider.name);

  isConfigured(): boolean {
    return !!process.env.APIFY_TOKEN;
  }

  private async runActor<T>(actor: string, input: unknown): Promise<T[]> {
    if (!this.isConfigured()) return [];
    try {
      const url = `${APIFY_BASE}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN as string)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(APIFY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`apify actor ${actor} failed (${res.status})`);
        return [];
      }
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? (body as T[]) : [];
    } catch (e) {
      this.logger.warn(`apify actor ${actor} error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Google Maps places search for an ICP query within a geo. */
  async searchPlaces(opts: { query: string; geo: Geo; limit: number }): Promise<PlaceHit[]> {
    const loc = [opts.geo.cities?.join(', '), opts.geo.regions?.join(', '), opts.geo.country].filter(Boolean).join(', ');
    const search = loc ? `${opts.query} ${loc}` : opts.query;
    const rows = await this.runActor<RawPlace>(PLACES_ACTOR, {
      searchStringsArray: [search],
      maxCrawledPlacesPerSearch: Math.min(Math.max(opts.limit, 1), 50),
      language: 'tr',
      reviewsSort: 'newest',
      maxReviews: 5,
    });
    return rows.map((p) => ({
      placeId: p.placeId,
      name: p.title ?? 'Unknown',
      address: p.address,
      city: p.city,
      region: p.state,
      phone: p.phoneUnformatted ?? p.phone,
      website: p.website,
      category: p.categoryName,
      rating: p.totalScore,
      reviewsCount: p.reviewsCount,
      permanentlyClosed: p.permanentlyClosed,
      latestReviews: (p.reviews ?? [])
        .filter((r) => !!r.text)
        .slice(0, 5)
        .map((r) => ({ text: (r.text as string).slice(0, 500), rating: r.stars, date: r.publishedAtDate })),
    }));
  }

  /** Look up a single Instagram business handle. */
  async lookupInstagram(handle: string): Promise<SocialHit | null> {
    const clean = handle.replace(/^@/, '').trim();
    if (!clean) return null;
    const rows = await this.runActor<RawIg>(INSTAGRAM_ACTOR, { usernames: [clean], resultsLimit: 1 });
    const r = rows[0];
    if (!r?.username) return null;
    return {
      handle: `@${r.username}`,
      fullName: r.fullName,
      bio: r.biography?.slice(0, 500),
      followers: r.followersCount,
      website: r.externalUrl,
      isBusiness: r.isBusinessAccount,
    };
  }
}
