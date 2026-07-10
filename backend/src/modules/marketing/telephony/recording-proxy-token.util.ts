import { createHmac, timingSafeEqual } from 'crypto';

/**
 * NetGSM Phase 4 Task 3, fix round 1 (HIGH privacy finding) — short-lived,
 * call-scoped token for the recording PROXY route. `RecordingProxyController`
 * streams an R2-stored call recording's bytes through our own backend rather
 * than ever handing the browser R2's public (no-auth, no-TTL) object URL —
 * that public URL would otherwise survive in browser history, devtools, and
 * error-tracker breadcrumbs well past the auth boundary that guards
 * `SalesCallService.getRecordingUrl`. This mirrors two existing patterns in
 * the codebase for the same underlying problem (a browser element that can't
 * carry an `Authorization` header needs SOME token in the URL itself):
 *  - `netgsm-webhook.util`'s HMAC-token-in-path for NetGSM's own unsigned
 *    public callbacks (no TTL there — this adds one, since a leaked recording
 *    link should not stay playable indefinitely).
 *  - `SseTokenGuard` / `social-oauth-state.util`'s short-lived signed token
 *    for `EventSource`/OAuth redirects that can't set a header either.
 *
 * `exp` travels in the clear (not a secret, just a Unix-ms timestamp) so
 * verification never needs a DB round-trip; the HMAC binds it to this EXACT
 * workspaceId+salesCallId so a token minted for one call can't be replayed
 * against a different call/workspace, nor have its `exp` extended, without
 * detection. The "recording-proxy:" label domain-separates this MAC from
 * every other secret derived from the same MARKETING_SECRET_KEY.
 */
const LABEL = 'recording-proxy';

/** ~5 minutes — long enough for the SPA to fetch {url} and start `<audio>` playback. */
export const RECORDING_PROXY_TOKEN_TTL_MS = 5 * 60 * 1000;

function hmacKey(): Buffer {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) throw new Error('MARKETING_SECRET_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

function sign(workspaceId: string, salesCallId: string, exp: number): string {
  return createHmac('sha256', hmacKey())
    .update(`${LABEL}:${workspaceId}:${salesCallId}:${exp}`)
    .digest('hex');
}

/** token = "<expUnixMs>.<hmacHex>". */
export function mintRecordingProxyToken(
  workspaceId: string,
  salesCallId: string,
  ttlMs: number = RECORDING_PROXY_TOKEN_TTL_MS,
): string {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(workspaceId, salesCallId, exp)}`;
}

/**
 * Constant-time check; never throws (missing key / malformed token / expired /
 * mismatched workspace-call → false, which the controller turns into a plain
 * 404 — never a 401/403 that would confirm a workspaceId+callId combination
 * even exists).
 */
export function verifyRecordingProxyToken(
  workspaceId: string,
  salesCallId: string,
  token: string,
): boolean {
  try {
    const [expRaw, mac] = (token ?? '').split('.');
    if (!expRaw || !mac) return false;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = sign(workspaceId, salesCallId, exp);
    const a = Buffer.from(mac, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The proxy URL the frontend's `<audio src>` is pointed at instead of R2's
 * public URL. `baseUrl` is `PUBLIC_BASE_URL` (same env var every other public
 * callback URL in this codebase is built from — see `netgsmWebhookUrl`);
 * falls back to a root-relative path when unset (same-origin deployments
 * still resolve it correctly from the SPA's own origin).
 */
export function recordingProxyUrl(
  baseUrl: string | undefined,
  workspaceId: string,
  salesCallId: string,
  token: string,
): string {
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  return `${base}/api/public/telephony/recording/${workspaceId}/${salesCallId}/${token}`;
}
