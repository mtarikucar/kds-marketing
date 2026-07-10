import { sha256, toE164Digits } from './meta-capi.client';
import { tiktokBusinessFetch, TiktokBusinessResult } from '../channels/tiktok-business.util';

/**
 * TikTok Events API (server-side CAPI) client. Sends server-side conversion
 * events to a pixel (event_source_id = the pixel *code*, not a numeric id) so
 * the ad algorithm can optimize on real downstream outcomes (won deals, paid
 * orders) the browser pixel never sees. The join key + hashed PII come from the
 * CRM: the ttclid captured at lead birth + the lead's normalized email/phone.
 *
 * Sibling to meta-capi.client.ts. Kept a plain module (like the TikTok business
 * util + Meta CAPI client) so it mocks + imports cleanly at the transport seam.
 * Sends through `tiktokBusinessFetch`, which already carries the Access-Token
 * header, the { code, message, request_id } envelope, and auth classification
 * (isTiktokBusinessAuthError) the consumer uses to flag reauth.
 *
 * PII is SHA-256 hashed exactly like Meta (email lowercased/trimmed; phone in
 * E.164 digits then hashed). TikTok's user object takes email/phone as ARRAYS
 * of hashes; ttclid is passed RAW (not hashed).
 */

export interface TiktokCapiUserData {
  /** SHA-256 hex hashes of the normalized email(s). */
  email?: string[];
  /** SHA-256 hex hashes of the E.164 phone digits. */
  phone?: string[];
  /** TikTok click id captured at lead birth — passed RAW (never hashed). */
  ttclid?: string;
  /** Client IP (optional, improves match). */
  ip?: string;
  /** Client user-agent (optional, improves match). */
  user_agent?: string;
}

export interface TiktokCapiEventProperties {
  value?: number;
  currency?: string;
  content_type?: string;
}

export interface TiktokCapiEvent {
  /** TikTok event taxonomy — 'CompletePayment' | 'Purchase' | 'Lead' | ... */
  event: string;
  /** Unix seconds. */
  event_time: number;
  /** Dedup key — TikTok dedupes on event_id (use the domain event id). */
  event_id: string;
  user: TiktokCapiUserData;
  properties?: TiktokCapiEventProperties;
}

export interface TiktokUserInput {
  email?: string | null;
  phone?: string | null;
  /** Raw ttclid — only set when the lead's clickIdType is 'TTCLID'. */
  ttclid?: string | null;
}

/**
 * Assemble TikTok user-matching data from the lead's PII + click id. Mirrors the
 * Meta buildUserData shape: email/phone are SHA-256 hashed (as single-element
 * arrays, per the TikTok user object); ttclid is passed through raw. Empty
 * fields are omitted so an unmatched value is simply left off the payload.
 */
export function buildTiktokUserData(input: TiktokUserInput): TiktokCapiUserData {
  const out: TiktokCapiUserData = {};
  const em = sha256(input.email);
  if (em) out.email = [em];
  const ph = sha256(toE164Digits(input.phone));
  if (ph) out.phone = [ph];
  if (input.ttclid) out.ttclid = input.ttclid;
  return out;
}

/**
 * POST one conversion event to `/event/track/` for the given pixel code.
 * Best-effort — returns the TiktokBusinessResult; the caller logs, flags reauth
 * on an auth error, and never throws into the event bus. A platform-set
 * TIKTOK_CAPI_TEST_EVENT_CODE routes events to Events Manager > Test Events
 * during rollout.
 */
export async function sendTiktokEvent(
  token: string,
  pixelCode: string,
  event: TiktokCapiEvent,
): Promise<TiktokBusinessResult> {
  const body: Record<string, unknown> = {
    event_source: 'web',
    event_source_id: pixelCode,
    data: [event],
  };
  const testCode = process.env.TIKTOK_CAPI_TEST_EVENT_CODE;
  if (testCode) body.test_event_code = testCode;
  return tiktokBusinessFetch('/event/track/', {
    accessToken: token,
    method: 'POST',
    body,
    timeoutMs: 10_000,
  });
}
