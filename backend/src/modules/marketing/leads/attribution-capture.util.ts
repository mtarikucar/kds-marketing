/**
 * First-touch marketing-attribution parsing (Faz 0 measurement plumbing).
 *
 * Pure, dependency-free extraction of UTM params, ad click-ids and the
 * click-to-WhatsApp id from the signals available at lead ingest: the landing
 * URL, the referrer, and any hidden form fields. Kept side-effect free so it is
 * trivially unit-testable and reusable from every ingestion point (site forms,
 * order forms, conversation ingress, booking).
 */

/** Normalized attribution extracted from a lead's first touch. */
export interface ParsedAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  clickId?: string;
  clickIdType?: 'FBCLID' | 'GCLID' | 'TTCLID' | 'LICLID' | 'MSCLKID' | 'OTHER';
  ctwaClid?: string;
  landingUrl?: string;
  referrerUrl?: string;
}

/** Raw signals available at ingest. All optional. */
export interface AttributionInput {
  /** The page URL the lead arrived on (may carry ?utm_*=…&fbclid=…). */
  url?: string | null;
  /** The referrer header / previous page. */
  referrer?: string | null;
  /** Hidden form fields — UTM/click-ids are often posted as fields, not query. */
  fields?: Record<string, unknown> | null;
  /** Meta click-to-WhatsApp referral id, when the lead came from a CTWA ad. */
  ctwaClid?: string | null;
}

/** Recognised platform click-id field/param names → normalized type. */
const CLICK_IDS: Array<[string, ParsedAttribution['clickIdType']]> = [
  ['fbclid', 'FBCLID'],
  ['gclid', 'GCLID'],
  ['ttclid', 'TTCLID'],
  ['li_fat_id', 'LICLID'],
  ['liclid', 'LICLID'],
  ['msclkid', 'MSCLKID'],
];

const MAX_LEN = 512;

function clean(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.slice(0, MAX_LEN);
}

/** Parse the query string of a URL into a case-insensitive lookup. */
function queryOf(url?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = clean(url);
  if (!raw) return out;
  const qIdx = raw.indexOf('?');
  if (qIdx === -1) return out;
  try {
    const params = new URLSearchParams(raw.slice(qIdx + 1));
    for (const [k, v] of params) {
      const cv = v.trim().slice(0, MAX_LEN);
      if (cv) out[k.toLowerCase()] = cv;
    }
  } catch {
    /* malformed query — ignore, best-effort */
  }
  return out;
}

/** Build the [hidden-fields, landing-URL query, referrer query] lookups —
 *  the shared precedence order for every param extraction. */
function buildLookups(input: AttributionInput): Array<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    const cv = clean(v);
    if (cv) fields[k.toLowerCase()] = cv;
  }
  return [fields, queryOf(input.url), queryOf(input.referrer)];
}

/** First hit across the lookups (field wins, then URL query, then referrer). */
function pickFrom(lookups: Array<Record<string, string>>, ...keys: string[]): string | undefined {
  for (const src of lookups) {
    for (const key of keys) {
      const hit = src[key];
      if (hit) return hit.slice(0, MAX_LEN);
    }
  }
  return undefined;
}

/**
 * Extract arbitrary (lowercased) params from the same signals + precedence
 * parseAttribution uses. Used by the deterministic campaign resolver for our
 * own link-decorator params (jg_cid / jg_pid). Absent keys are omitted.
 */
export function pickParams(input: AttributionInput, keys: string[]): Record<string, string> {
  const lookups = buildLookups(input);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const hit = pickFrom(lookups, key.toLowerCase());
    if (hit) out[key] = hit;
  }
  return out;
}

/**
 * Extract first-touch attribution from the available signals. Precedence for
 * each value: explicit hidden field → landing-URL query → referrer query.
 * Returns `null` when no attribution signal is present (so callers can skip
 * writing an empty row).
 */
export function parseAttribution(input: AttributionInput): ParsedAttribution | null {
  const lookups = buildLookups(input);
  const pick = (...keys: string[]): string | undefined => pickFrom(lookups, ...keys);

  const out: ParsedAttribution = {};
  out.utmSource = pick('utm_source', 'utmsource');
  out.utmMedium = pick('utm_medium', 'utmmedium');
  out.utmCampaign = pick('utm_campaign', 'utmcampaign');
  out.utmContent = pick('utm_content', 'utmcontent');
  out.utmTerm = pick('utm_term', 'utmterm');

  for (const [key, type] of CLICK_IDS) {
    const hit = pick(key);
    if (hit) {
      out.clickId = hit;
      out.clickIdType = type;
      break;
    }
  }

  const ctwa = clean(input.ctwaClid) ?? pick('ctwa_clid', 'ctwaclid');
  if (ctwa) out.ctwaClid = ctwa;

  out.landingUrl = clean(input.url);
  out.referrerUrl = clean(input.referrer);

  // Drop keys whose value is undefined so the row/JSON stays lean.
  for (const k of Object.keys(out) as Array<keyof ParsedAttribution>) {
    if (out[k] === undefined) delete out[k];
  }

  // Only meaningful if at least one *attribution* signal was found — the bare
  // landing/referrer URLs alone don't justify a row.
  const hasSignal =
    out.utmSource ||
    out.utmMedium ||
    out.utmCampaign ||
    out.utmContent ||
    out.utmTerm ||
    out.clickId ||
    out.ctwaClid;
  return hasSignal ? out : null;
}
