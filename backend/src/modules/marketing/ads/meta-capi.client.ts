import { createHash } from 'node:crypto';
import { metaGraphFetch, MetaGraphResult } from '../../../common/util/meta-graph.util';

/**
 * Meta Conversions API (CAPI) client. Sends server-side conversion events to a
 * pixel/dataset so the ad algorithm can optimize on real downstream outcomes
 * (won deals, paid orders) that the browser pixel never sees. The join key +
 * hashed PII come from the CRM: the click-id captured at lead birth + the
 * lead's normalized email/phone.
 *
 * Kept a plain module (like meta-graph.util) so it mocks + imports cleanly.
 */

/** SHA-256 hex of an already-normalized (lowercased/trimmed) value, per Meta's
 *  Advanced Matching spec. Returns undefined for empty input so the field is
 *  simply omitted from user_data. */
export function sha256(value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return undefined;
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

/**
 * Meta wants the phone as digits WITH country code (no '+') before hashing. Our
 * normalizePhone strips to bare digits but does NOT add a country code, so a
 * Turkish local `05xxxxxxxxx` would hash to a non-matching value. Default a bare
 * `0`-led 10–11 digit number to +90 (Turkey); pass through anything that already
 * looks international. Returns undefined when there's nothing usable.
 */
export function toE164Digits(phoneDigits: string | null | undefined, defaultCc = '90'): string | undefined {
  const d = (phoneDigits ?? '').replace(/\D/g, '');
  if (!d) return undefined;
  if (d.startsWith('0')) return `${defaultCc}${d.replace(/^0+/, '')}`;
  // Already looks international (has a country code) — leave as-is.
  if (d.length >= 11) return d;
  // Bare national number without a leading 0 — prepend the default country code.
  return `${defaultCc}${d}`;
}

export interface CapiUserData {
  /** SHA-256 hex of the normalized email. */
  em?: string;
  /** SHA-256 hex of the E.164 phone digits. */
  ph?: string;
  /** SHA-256 hex of the city. */
  ct?: string;
  /** Facebook click id, formatted `fb.1.<ts_ms>.<fbclid>` (NOT hashed). */
  fbc?: string;
  /** Click-to-WhatsApp click id (NOT hashed). */
  ctwa_clid?: string;
}

export interface CapiEvent {
  event_name: string; // Purchase | Lead | ...
  event_time: number; // unix seconds
  event_id: string; // dedup key — Meta dedupes server+pixel on this
  action_source: string; // 'system_generated' for CRM-originated conversions
  user_data: CapiUserData;
  custom_data?: { value?: number; currency?: string };
}

/** Build the `fbc` parameter Meta expects from a raw fbclid + a timestamp. */
export function buildFbc(fbclid: string | null | undefined, at: Date): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${at.getTime()}.${fbclid}`;
}

/**
 * POST one conversion event to `/<pixelId>/events`. Best-effort — returns the
 * MetaGraphResult; the caller logs and never throws into the event bus. A
 * platform-set META_CAPI_TEST_EVENT_CODE routes events to Events Manager > Test
 * Events during rollout.
 */
export async function sendConversionEvent(
  token: string,
  pixelId: string,
  event: CapiEvent,
): Promise<MetaGraphResult> {
  const body: Record<string, unknown> = { data: [event] };
  const testCode = process.env.META_CAPI_TEST_EVENT_CODE;
  if (testCode) body.test_event_code = testCode;
  return metaGraphFetch(`/${pixelId}/events`, {
    accessToken: token,
    method: 'POST',
    body,
    timeoutMs: 10_000,
  });
}
