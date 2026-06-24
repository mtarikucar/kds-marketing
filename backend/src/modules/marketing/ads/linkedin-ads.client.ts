import { linkedinRest, LinkedinResult } from '../../../common/util/linkedin-api.util';
import { AdMetricRow } from './ads.types';

/**
 * LinkedIn Ads insights via the Marketing API adAnalytics finder. Per-day,
 * per-campaign spend / impressions / clicks (+ externalWebsiteConversions as
 * leads), pivoted on CAMPAIGN with DAILY granularity over [since, until].
 *
 * rest.li query encoding is delicate: the `dateRange=(...)` object MUST keep its
 * literal parens/colons (NOT percent-encoded) while each `accounts=List(...)`
 * URN member MUST be percent-encoded. URLSearchParams would double-encode the
 * parens, so we hand-assemble these reduced segments and append them to the path;
 * only `q`/`pivot`/`timeGranularity`/`fields` go through linkedinRest's `query`.
 *
 * Throws on a non-ok result so the caller records lastError; the thrown Error
 * carries `isAuthError` (401 → true, 403 → false) so the caller can mark the
 * account needs-reauth. Returns [] for an empty range. No pagination (15k cap).
 */
export async function pullLinkedinInsights(
  token: string,
  sponsoredAccountId: string,
  since: string,
  until: string,
): Promise<AdMetricRow[]> {
  const s = ymd(since);
  const e = ymd(until);
  // rest.li reduced objects — parens/colons kept literal; only the URN is encoded.
  const dateRange = `(start:(year:${s.y},month:${s.m},day:${s.d}),end:(year:${e.y},month:${e.m},day:${e.d}))`;
  const accountUrn = encodeURIComponent(`urn:li:sponsoredAccount:${sponsoredAccountId}`);
  const accounts = `List(${accountUrn})`;
  const fields =
    'externalWebsiteConversions,dateRange,impressions,clicks,costInLocalCurrency,pivotValues';
  // q + the reduced-object params appended raw (already correctly encoded).
  const path =
    `/rest/adAnalytics?q=analytics` +
    `&pivot=CAMPAIGN` +
    `&timeGranularity=DAILY` +
    `&dateRange=${dateRange}` +
    `&accounts=${accounts}` +
    `&fields=${fields}`;

  const result: LinkedinResult = await linkedinRest(path, {
    accessToken: token,
    method: 'GET',
    timeoutMs: 20_000,
  });

  if (!result.ok) {
    const err: any = new Error(
      `LinkedIn ads ${result.status}: ${String(result.error.message).slice(0, 300)}`,
    );
    err.isAuthError = result.error.isAuthError;
    throw err;
  }

  const elements: any[] = Array.isArray(result.data?.elements) ? result.data.elements : [];
  return elements.map((el) => parseLinkedinRow(el, since));
}

function parseLinkedinRow(el: any, fallbackDate: string): AdMetricRow {
  const pivot = String(el?.pivotValues?.[0] ?? '');
  const campaignId = pivot ? pivot.slice(pivot.lastIndexOf(':') + 1) : '';
  const start = el?.dateRange?.start;
  const date =
    start && typeof start.year === 'number'
      ? isoFromParts(start.year, start.month, start.day)
      : fallbackDate;
  return {
    date,
    campaignId,
    spend: parseFloat(String(el?.costInLocalCurrency ?? '0')) || 0,
    impressions: Number(el?.impressions || 0),
    clicks: Number(el?.clicks || 0),
    leads: Number(el?.externalWebsiteConversions || 0),
    raw: el,
  };
}

function ymd(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  return { y, m, d };
}

function isoFromParts(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}
