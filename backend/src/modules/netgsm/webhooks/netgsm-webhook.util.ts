import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * NetGSM hub — unified public webhook receiver token. NetGSM signs nothing, so
 * every push URL (santral events, İYS, voice/autocall reports) carries an HMAC
 * token derived from MARKETING_SECRET_KEY; only a holder of that key can mint
 * a matching token, so the URL is unforgeable. The "netgsm-hub:" label
 * domain-separates this MAC from other secrets derived from the same master
 * key (e.g. the "netgsm-mo:" per-channel MO callback token).
 */
export type NetgsmWebhookPurpose = 'events' | 'iys' | 'voice-report' | 'autocall-report';
const LABEL = 'netgsm-hub';

function hmacKey(): Buffer {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) throw new Error('MARKETING_SECRET_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

/** token = HMAC-SHA256(masterKey, "netgsm-hub:<workspaceId>:<purpose>") hex. */
export function netgsmWebhookToken(workspaceId: string, purpose: NetgsmWebhookPurpose): string {
  return createHmac('sha256', hmacKey()).update(`${LABEL}:${workspaceId}:${purpose}`).digest('hex');
}

/** Constant-time check; never throws (a missing key / bad input → false). */
export function verifyNetgsmWebhookToken(
  workspaceId: string,
  purpose: NetgsmWebhookPurpose,
  token: string,
): boolean {
  let expected: string;
  try {
    expected = netgsmWebhookToken(workspaceId, purpose);
  } catch {
    return false;
  }
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The public receiver URL the account owner pastes into NetGSM's panel for the
 * given purpose. Returns null when the base URL or the master key is
 * unavailable (so a masked settings view degrades gracefully rather than
 * throwing). Path mirrors NetgsmEventsController's `:workspaceId/:token/:purpose`.
 */
export function netgsmWebhookUrl(
  baseUrl: string | undefined,
  workspaceId: string,
  purpose: NetgsmWebhookPurpose,
): string | null {
  if (!baseUrl) return null;
  let token: string;
  try {
    token = netgsmWebhookToken(workspaceId, purpose);
  } catch {
    return null;
  }
  return `${baseUrl.replace(/\/+$/, '')}/api/public/netgsm/${workspaceId}/${token}/${purpose}`;
}

/** Fallback external id when the payload carries none: sha256 of the raw body. */
export function payloadDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
