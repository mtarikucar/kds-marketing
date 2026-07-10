import { linkedinRest, LinkedinResult } from '../../../common/util/linkedin-api.util';

/**
 * LinkedIn Marketing API DMP-segment WRITE client. Creates a matched-audience
 * DMP segment on a sponsored account and batch-adds SHA-256-hashed emails to it.
 * Distinct from linkedin-ads.client.ts which is read-only insights. Needs a
 * token with the `rw_dmp_segments` scope.
 *
 * Kept a plain module (built on linkedinRest, like linkedin-ads.client) so tests
 * mock `linkedinRest` at the module seam. Mirrors the Meta write client's flat
 * result shape ({ ok, id?, error?, isAuthError? }) so the caller treats providers
 * uniformly.
 *
 * LinkedIn DMP supports SHA256_EMAIL (+ device ids) only — NO phone hashing — so
 * this is email-only; the caller ignores includePhone for LINKEDIN. Matching is
 * async: an audience needs ~300 matched members before it is targetable, so a
 * SYNCED status does not yet mean live.
 */

/** LinkedIn caps a dmpSegment user batch-add; keep each request comfortably under. */
const USERS_BATCH = 500;

export interface LinkedinWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  isAuthError?: boolean;
}

export interface LinkedinDmpUsersResult {
  ok: boolean;
  /** Count of hashed emails submitted across all batches (LinkedIn matches async). */
  numAccepted?: number;
  error?: string;
  isAuthError?: boolean;
}

function fail(result: LinkedinResult, prefix: string): { ok: false; error: string; isAuthError: boolean } {
  return {
    ok: false,
    error: `${prefix} ${result.status}: ${String(result.error?.message ?? '').slice(0, 300)}`,
    isAuthError: !!result.error?.isAuthError,
  };
}

/**
 * Create an empty USER-type DMP segment on the sponsored account. Population is a
 * separate call (addLinkedinDmpUsers). The new segment's id comes back in the
 * `x-restli-id` RESPONSE header (surfaced as result.restliId), NOT the body.
 */
export async function createLinkedinDmpSegment(
  token: string,
  sponsoredAccountId: string,
  input: { name: string },
): Promise<LinkedinWriteResult> {
  const result = await linkedinRest('/rest/dmpSegments', {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name.slice(0, 100),
      account: `urn:li:sponsoredAccount:${sponsoredAccountId}`,
      sourcePlatform: 'PROGRAMMATIC_MEDIA',
      type: 'USER',
      accessPolicy: 'PRIVATE',
    },
    timeoutMs: 20_000,
  });
  if (!result.ok) return fail(result, 'LinkedIn create dmpSegment');
  const id = result.restliId ?? (result.data?.id != null ? String(result.data.id) : undefined);
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Batch-add SHA-256-hashed emails to a DMP segment. `sha256Emails` is already
 * normalized + hashed hex by the caller (blanks are dropped). Sends the rest.li
 * BATCH_CREATE method header — without it the POST is read as a single-entity
 * create and the elements are rejected — and splits into <=USERS_BATCH requests.
 *
 * NOTE: the `headers` passthrough on LinkedinFetchOptions is required for the
 * BATCH_CREATE header (see the shared linkedin-api.util seam).
 */
export async function addLinkedinDmpUsers(
  token: string,
  dmpSegmentId: string,
  sha256Emails: string[],
): Promise<LinkedinDmpUsersResult> {
  const hashes = sha256Emails.filter((h) => !!h);
  if (hashes.length === 0) return { ok: true, numAccepted: 0 };

  let numAccepted = 0;
  for (let i = 0; i < hashes.length; i += USERS_BATCH) {
    const batch = hashes.slice(i, i + USERS_BATCH);
    const elements = batch.map((hash) => ({
      action: 'ADD',
      userIds: [{ idType: 'SHA256_EMAIL', idValue: hash }],
    }));
    const result = await linkedinRest(`/rest/dmpSegments/${dmpSegmentId}/users`, {
      accessToken: token,
      method: 'POST',
      headers: { 'X-RestLi-Method': 'BATCH_CREATE' },
      body: { elements },
      timeoutMs: 30_000,
    } as any);
    if (!result.ok) return fail(result, 'LinkedIn add dmpSegment users');
    numAccepted += batch.length;
  }
  return { ok: true, numAccepted };
}
