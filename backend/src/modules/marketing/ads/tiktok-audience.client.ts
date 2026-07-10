import { createHash } from 'node:crypto';
import { safeFetch } from '../../../common/util/safe-fetch';

/**
 * TikTok Business DMP Custom-Audience WRITE client. Uploads a hashed customer
 * list as a file, creates a Custom Audience from that file, then APPENDs on
 * re-sync so the same audience is reused instead of duplicated. Distinct from
 * tiktok-ads.client.ts which is read-only insights. Every call needs a
 * TikTok-for-Business token scoped for Ads Management.
 *
 * Kept a plain module (like tiktok-ads.client / meta-capi.client) so tests mock
 * `safeFetch` at the module seam. Mirrors the Meta write client's flat result
 * shape ({ ok, id?, error?, isAuthError? }) so the caller treats providers
 * uniformly.
 *
 * TikTok allows exactly ONE calculate_type per audience/file, so email and phone
 * cannot share one audience — EMAIL_SHA256 is the primary; a phone audience is a
 * separate file/audience if ever needed.
 */

const TIKTOK_BASE = 'https://business-api.tiktok.com';
const API_VERSION = 'v1.3';

/**
 * TikTok response codes that mean the access token is invalid/revoked/expired
 * (→ mark the account TOKEN_EXPIRED / reauth). Everything else stays a plain
 * error so the caller does not needlessly force a reconnect.
 */
const AUTH_CODES = new Set([40001, 40002, 40105]);

export type TiktokCalculateType = 'EMAIL_SHA256' | 'PHONE_SHA256';

export interface TiktokWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  isAuthError?: boolean;
}

export interface TiktokUploadResult {
  ok: boolean;
  /** The server-side file handle returned by the upload, fed into create/append. */
  filePath?: string;
  error?: string;
  isAuthError?: boolean;
}

function fail(
  code: any,
  message: any,
  prefix: string,
): { error: string; isAuthError: boolean } {
  // Include the numeric code so the caller can classify auth failures reliably,
  // not just by parsing the English message (mirrors tiktok-ads.client.ts).
  const c = Number(code);
  return {
    error: `${prefix} [${code}]: ${String(message ?? '').slice(0, 300)}`,
    isAuthError: AUTH_CODES.has(c),
  };
}

/** POST a JSON body with the Access-Token header; returns the parsed envelope. */
async function tiktokPost(
  token: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<any> {
  const res = await safeFetch(`${TIKTOK_BASE}${path}`, {
    method: 'POST',
    headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
  return res.json().catch(() => ({}));
}

/**
 * Upload one hashed customer-list file. `hashedValues` is one SHA-256 hex value
 * per line (already normalized + hashed by the caller). `calculateType` names
 * the key the file holds (EMAIL_SHA256 | PHONE_SHA256). Returns the server
 * `file_path` handle to pass into createTiktokCustomAudience / append.
 *
 * NOTE: multipart/form-data (unlike the JSON insights call) — the `file` field
 * carries the text blob and `file_signature` is the MD5 of the exact bytes so
 * TikTok can verify integrity. No explicit Content-Type header: fetch sets the
 * multipart boundary itself from the FormData body.
 */
export async function uploadTiktokAudienceFile(
  token: string,
  advertiserId: string,
  calculateType: TiktokCalculateType,
  hashedValues: string[],
): Promise<TiktokUploadResult> {
  const fileContent = hashedValues.join('\n');
  const fileSignature = createHash('md5').update(fileContent, 'utf8').digest('hex');
  const form = new FormData();
  form.append('advertiser_id', advertiserId);
  form.append('calculate_type', calculateType);
  form.append('file_signature', fileSignature);
  form.append('file', new Blob([fileContent], { type: 'text/plain' }), 'audience.txt');

  const res = await safeFetch(
    `${TIKTOK_BASE}/open_api/${API_VERSION}/dmp/custom_audience/file/upload/`,
    { method: 'POST', headers: { 'Access-Token': token }, body: form as any, timeoutMs: 30_000 },
  );
  const json: any = await res.json().catch(() => ({}));
  if (json?.code !== 0) {
    return { ok: false, ...fail(json?.code, json?.message ?? res.status, 'TikTok audience upload') };
  }
  const filePath = json?.data?.file_path;
  return { ok: true, filePath: filePath ? String(filePath) : undefined };
}

/**
 * Create a Custom Audience from already-uploaded file handle(s). Returns the
 * `custom_audience_id` (store in SegmentAudienceSync.externalAudienceId). All
 * `filePaths` must share the same `calculateType`.
 */
export async function createTiktokCustomAudience(
  token: string,
  advertiserId: string,
  input: { name: string; filePaths: string[]; calculateType: TiktokCalculateType },
): Promise<TiktokWriteResult> {
  const json = await tiktokPost(token, `/open_api/${API_VERSION}/dmp/custom_audience/create/`, {
    advertiser_id: advertiserId,
    custom_audience_name: input.name.slice(0, 100),
    file_paths: input.filePaths,
    calculate_type: input.calculateType,
  });
  if (json?.code !== 0) {
    return { ok: false, ...fail(json?.code, json?.message, 'TikTok create audience') };
  }
  const id = json?.data?.custom_audience_id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * APPEND already-uploaded file handle(s) to an existing Custom Audience so a
 * re-sync grows the same audience instead of creating a duplicate. `calculateType`
 * must match the audience's key.
 */
export async function appendTiktokAudienceUsers(
  token: string,
  advertiserId: string,
  input: { customAudienceId: string; filePaths: string[]; calculateType: TiktokCalculateType },
): Promise<TiktokWriteResult> {
  const json = await tiktokPost(token, `/open_api/${API_VERSION}/dmp/custom_audience/update/`, {
    advertiser_id: advertiserId,
    custom_audience_id: input.customAudienceId,
    action: 'APPEND',
    file_paths: input.filePaths,
    calculate_type: input.calculateType,
  });
  if (json?.code !== 0) {
    return { ok: false, ...fail(json?.code, json?.message, 'TikTok update audience') };
  }
  return { ok: true, id: input.customAudienceId };
}
