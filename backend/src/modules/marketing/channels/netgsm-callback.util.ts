import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Per-channel secret for NetGSM's inbound (MO) callback. NetGSM doesn't sign
 * callbacks, so the public MO URL carries the channelId plus this token; only
 * someone holding MARKETING_SECRET_KEY can mint a matching token, so the URL is
 * unforgeable. The "netgsm-mo:" label domain-separates this MAC from the
 * AES-256-GCM secret-box that reuses the same master key.
 */
const LABEL = 'netgsm-mo';

function hmacKey(): Buffer {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) throw new Error('MARKETING_SECRET_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

/** token = HMAC-SHA256(masterKey, "netgsm-mo:<channelId>") as lowercase hex. */
export function netgsmMoToken(channelId: string): string {
  return createHmac('sha256', hmacKey()).update(`${LABEL}:${channelId}`).digest('hex');
}

/** Constant-time check; never throws (a missing key / bad input → false). */
export function verifyNetgsmMoToken(channelId: string, token: string): boolean {
  let expected: string;
  try {
    expected = netgsmMoToken(channelId);
  } catch {
    return false;
  }
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The public MO callback URL the account owner pastes into NetGSM's "İnteraktif
 * SMS → URL Adresine Yönlendir" panel. Returns null when the base URL or the
 * master key is unavailable (so a masked channel view degrades gracefully rather
 * than throwing). Path mirrors NetgsmPublicController's `:channelId/:token/mo`.
 */
export function netgsmMoCallbackUrl(
  baseUrl: string | undefined,
  channelId: string,
): string | null {
  if (!baseUrl) return null;
  let token: string;
  try {
    token = netgsmMoToken(channelId);
  } catch {
    return null;
  }
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/public/channels/netgsm/${channelId}/${token}/mo`;
}
