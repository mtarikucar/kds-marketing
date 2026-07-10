import {
  googleAdsFetch,
  refreshAccessToken,
  normalizeCustomerId,
  GoogleAdsResult,
  GoogleWriteResult,
} from './google-ads.util';

/**
 * Google Ads OFFLINE CLICK-CONVERSION upload client — the gclid feedback loop,
 * the Google analog of meta-capi.client / tiktok-capi.client. When a CRM deal is
 * WON or an invoice PAID, POST a server-side conversion keyed by the `gclid`
 * captured at lead birth so Smart Bidding can optimize on real downstream
 * outcomes the on-site tag never saw.
 *
 * IMPORTANT: this is `customers/{cid}:uploadClickConversions` (the gclid path),
 * NOT `offlineUserDataJobs` (which is Customer-Match / Store-Sales by hashed
 * user identifier — the audience-sync analog, a separate future feature).
 *
 * Takes the account REFRESH token and mints a short-lived access token itself
 * (same seam as the other Google clients). `partialFailure:true` means a single
 * bad conversion is reported in the 200 body's `partialFailureError` rather than
 * failing the whole request — so we inspect it and surface a non-ok result.
 * Kept a plain module so it mocks at the safeFetch seam.
 */

export interface GoogleClickConversionInput {
  /** Google Click Id captured at lead birth (clickIdType === 'GCLID'). Raw. */
  gclid: string;
  /** The conversion action to credit — a full resource name
   *  `customers/{cid}/conversionActions/{id}` or a bare id (expanded here). */
  conversionAction: string;
  /** Purchase value in the account currency's MAJOR units. Omitted → no value. */
  conversionValue?: number | null;
  /** ISO-4217 currency (defaults to TRY when a value is present). */
  currencyCode?: string | null;
  /** `yyyy-mm-dd hh:mm:ss+|-hh:mm`. Defaults to now in the configured offset. */
  conversionDateTime?: string | null;
  /** Optional merchant order id (helps Google dedupe alongside gclid+action+time). */
  orderId?: string | null;
}

export interface GoogleConversionUploadResult extends GoogleWriteResult {
  /** Count of conversions Google accepted (partial-failure survivors). */
  receivedCount?: number;
}

interface CustomerScope {
  loginCustomerId?: string | null;
}

function fail(r: GoogleAdsResult, prefix: string): { error: string; isAuthError: boolean } {
  return { error: `${prefix}: ${r.error.message}`.slice(0, 400), isAuthError: r.error.isAuthError };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format an instant as Google's required `yyyy-mm-dd hh:mm:ss±hh:mm` wall-clock
 * string at a fixed UTC offset (default +180 min = Europe/Istanbul, UTC+3). The
 * components are the local time at that offset for the same instant, with the
 * offset appended — so it round-trips to the correct moment regardless of the
 * host's timezone. Configurable via GOOGLE_ADS_CONVERSION_TZ_OFFSET_MIN.
 */
export function formatGoogleConversionDateTime(at: Date, offsetMinutes?: number): string {
  const envOff = Number(process.env.GOOGLE_ADS_CONVERSION_TZ_OFFSET_MIN);
  const off =
    typeof offsetMinutes === 'number'
      ? offsetMinutes
      : Number.isFinite(envOff)
        ? envOff
        : 180;
  const shifted = new Date(at.getTime() + off * 60_000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const date =
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${date}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Upload ONE offline click conversion (gclid) to
 * `customers/{cid}:uploadClickConversions`. Best-effort — returns a
 * GoogleConversionUploadResult; the caller logs, flags reauth on isAuthError,
 * and never throws into the event bus. At-least-once safe: Google dedupes on
 * gclid + conversionAction + conversionDateTime, so a redelivery is harmless.
 */
export async function uploadClickConversion(
  refreshToken: string,
  customerId: string,
  conversion: GoogleClickConversionInput,
  scope: CustomerScope = {},
): Promise<GoogleConversionUploadResult> {
  const accessToken = await refreshAccessToken(refreshToken);
  const cid = normalizeCustomerId(customerId);
  const conversionAction = String(conversion.conversionAction).includes('/')
    ? String(conversion.conversionAction)
    : `customers/${cid}/conversionActions/${conversion.conversionAction}`;

  const payload: Record<string, unknown> = {
    gclid: conversion.gclid,
    conversionAction,
    conversionDateTime: conversion.conversionDateTime ?? formatGoogleConversionDateTime(new Date()),
  };
  if (conversion.conversionValue !== undefined && conversion.conversionValue !== null) {
    payload.conversionValue = conversion.conversionValue;
    payload.currencyCode = String(conversion.currencyCode ?? 'TRY').toUpperCase();
  }
  if (conversion.orderId) payload.orderId = conversion.orderId;

  const r = await googleAdsFetch(`/customers/${cid}:uploadClickConversions`, {
    accessToken,
    customerId: cid,
    loginCustomerId: scope.loginCustomerId,
    method: 'POST',
    body: { conversions: [payload], partialFailure: true },
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Google upload conversion') };

  // partialFailure:true → a rejected conversion rides back on an HTTP 200 in
  // `partialFailureError` (a google.rpc.Status). Surface it as a non-ok result;
  // it is a data/config problem, not an auth failure.
  const pfErr = r.data?.partialFailureError;
  if (pfErr && pfErr.message) {
    return {
      ok: false,
      error: `Google upload conversion (partial): ${String(pfErr.message).slice(0, 300)}`,
      isAuthError: false,
    };
  }
  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  return { ok: true, receivedCount: results.length, id: conversion.gclid };
}
