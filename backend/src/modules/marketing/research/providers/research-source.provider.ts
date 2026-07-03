/**
 * The outbound web-research source seam. Concrete providers (Firecrawl, Apify)
 * are platform-keyed + env-gated (inert until the key is set), timeout-bounded,
 * and are the ONLY place the backend reaches the live web for prospecting. The
 * research agent calls these as tools; the toolset meters each call's cost into
 * the workspace budget (RESEARCH channel) — providers themselves are pure fetchers.
 */

export interface Geo {
  country?: string | null;
  regions?: string[] | null;
  cities?: string[] | null;
}

export interface PlaceReview {
  text: string;
  rating?: number;
  date?: string;
}

export interface PlaceHit {
  placeId?: string;
  name: string;
  address?: string;
  city?: string;
  region?: string;
  phone?: string;
  website?: string;
  instagram?: string;
  category?: string;
  rating?: number;
  reviewsCount?: number;
  permanentlyClosed?: boolean;
  latestReviews?: PlaceReview[];
}

export interface WebHit {
  url: string;
  title?: string;
  description?: string;
}

export interface ScrapeResult {
  markdown: string;
  meta: Record<string, unknown>;
}

export interface SocialHit {
  handle: string;
  fullName?: string;
  bio?: string;
  followers?: number;
  website?: string;
  isBusiness?: boolean;
}
