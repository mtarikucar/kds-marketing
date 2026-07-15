import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isGoogleOAuthConfigured } from '../../../common/util/google-oauth-env';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';

/** A provider review normalized to our Review columns. */
export interface SyncedReview {
  externalReviewId: string;
  rating: number | null;
  text: string | null;
  authorName: string | null;
  authoredAt: Date | null;
}

export interface ReviewSourceRow {
  id: string;
  type: string; // GOOGLE | FACEBOOK
  placeId: string | null;
  externalRef: string | null;
  accessToken: string | null; // SEALED
}

/** True when the platform app for a review-source type is configured (env). */
export function isReviewSyncConfigured(type: string): boolean {
  switch (type) {
    case 'GOOGLE':
      return isGoogleOAuthConfigured();
    case 'FACEBOOK':
      return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
    default:
      return false;
  }
}

/** Any review provider configured ⇒ the sweep should run. */
export function anyReviewSyncConfigured(): boolean {
  return isReviewSyncConfigured('GOOGLE') || isReviewSyncConfigured('FACEBOOK');
}

function revealToken(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return openSecret(sealed);
  } catch {
    return null;
  }
}

function toIntStars(v: unknown): number | null {
  // Google returns starRating as an enum word (ONE..FIVE); FB returns a number.
  const words: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(1, Math.min(5, Math.round(v)));
  if (typeof v === 'string' && words[v]) return words[v];
  return null;
}

/**
 * Google Business Profile — accounts.locations.reviews.list. externalRef is the
 * `accounts/{a}/locations/{l}` resource. Inert (empty) unless the GMB app env +
 * a sealed token are present.
 */
async function fetchGoogleReviews(source: ReviewSourceRow): Promise<SyncedReview[]> {
  // Inert (not a failure): the provider app isn't configured, or the source has
  // no token / no discovered location yet. These legitimately sync nothing and
  // must NOT stamp an error on the source.
  if (!isReviewSyncConfigured('GOOGLE')) return [];
  const token = revealToken(source.accessToken);
  if (!token || !source.externalRef) return [];
  // A real API failure (401 revoked/expired token, 429, 5xx, network) THROWS so
  // the sweep stamps lastError instead of swallowing it to [] and marking the
  // source healthy forever (an expired connection would otherwise look fine).
  const res = await safeFetch(`https://mybusiness.googleapis.com/v4/${source.externalRef}/reviews`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Google reviews API returned ${res.status}`);
  const json = (await res.json()) as Record<string, any>;
    const rows: any[] = Array.isArray(json?.reviews) ? json.reviews : [];
  return rows
    .map((r) => ({
      externalReviewId: String(r?.reviewId ?? r?.name ?? ''),
      rating: toIntStars(r?.starRating),
      text: typeof r?.comment === 'string' ? r.comment.slice(0, 4000) : null,
      authorName: typeof r?.reviewer?.displayName === 'string' ? r.reviewer.displayName.slice(0, 200) : null,
      authoredAt: r?.createTime ? new Date(r.createTime) : null,
    }))
    .filter((r) => r.externalReviewId);
}

/**
 * Facebook page ratings — Graph /{page-id}/ratings. placeId is the page id.
 * Inert (empty) unless the Meta app env + a sealed page token are present.
 */
async function fetchFacebookReviews(source: ReviewSourceRow): Promise<SyncedReview[]> {
  // Inert (not a failure) — same rationale as fetchGoogleReviews.
  if (!isReviewSyncConfigured('FACEBOOK')) return [];
  const token = revealToken(source.accessToken);
  if (!token || !source.placeId) return [];
  const result = await metaGraphFetch(`/${encodeURIComponent(source.placeId)}/ratings`, {
    accessToken: token,
    method: 'GET',
    query: { fields: 'review_text,rating,recommendation_type,reviewer,created_time,open_graph_story' },
    timeoutMs: 15_000,
  });
  // A real Graph failure THROWS so the sweep stamps lastError (see Google above).
  if (!result.ok) throw new Error(`Facebook ratings API returned ${(result as { status?: number }).status ?? 'error'}`);
  const json = result.data as Record<string, any>;
    const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  return rows
    .map((r) => ({
      externalReviewId: String(r?.open_graph_story?.id ?? r?.id ?? ''),
      // Since 2018 FB replaced star ratings with binary Recommendations: modern
      // Pages return `recommendation_type` (positive|negative) and no numeric
      // `rating`. Normalize both to the 1-5 scale the low-rating alert uses, so a
      // negative recommendation still raises ReviewReceived.
      rating:
        toIntStars(r?.rating) ??
        (r?.recommendation_type === 'negative' ? 1 : r?.recommendation_type === 'positive' ? 5 : null),
      text: typeof r?.review_text === 'string' ? r.review_text.slice(0, 4000) : null,
      authorName: typeof r?.reviewer?.name === 'string' ? r.reviewer.name.slice(0, 200) : null,
      authoredAt: r?.created_time ? new Date(r.created_time) : null,
    }))
    .filter((r) => r.externalReviewId);
}

/** Dispatch to the per-provider review fetcher. Inert sources return []. */
export function fetchSourceReviews(source: ReviewSourceRow): Promise<SyncedReview[]> {
  switch (source.type) {
    case 'GOOGLE':
      return fetchGoogleReviews(source);
    case 'FACEBOOK':
      return fetchFacebookReviews(source);
    default:
      return Promise.resolve([]);
  }
}
