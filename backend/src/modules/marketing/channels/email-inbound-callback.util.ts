import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Per-channel secret for the inbound-mail callback URL.
 *
 * The route this protects replaces two broken things at once.
 *
 * The first is the platform-global `EMAIL_INBOUND_SECRET` HMAC on
 * `POST webhook`: no inbound-parse provider on earth can produce an
 * `x-email-signature` of that shape, so every tenant who followed the dialog's
 * instructions got a silent 401 forever — and the only way to make it work was
 * for an operator to hand the one platform secret to a tenant, at which point
 * that tenant could forge mail into every other tenant's inbox
 * (`inbound-webhook-unusable`).
 *
 * The second is how that route picked the destination workspace: out of the
 * `To:` header, which the sender writes. A Bcc, a mailing-list rewrite or a
 * crafted header delivered one tenant's mail into another's inbox
 * (`webhook-to-header-routing`).
 *
 * Both go away with the same move, the one `netgsm-callback.util.ts` already
 * proved for unsigned SMS callbacks: **the URL names the tenant**. The channel
 * id travels in the path, the token makes that path unguessable, and only the
 * holder of `MARKETING_SECRET_KEY` can mint one. A relay needs no secret of its
 * own, and a token holder cannot address a channel other than the one their URL
 * names — so the cross-tenant surface is not narrowed, it is gone.
 *
 * The `email-inbound:` label domain-separates this MAC from the AES-256-GCM
 * secret-box and from the NetGSM MO token, which are derived from the very same
 * master key: without it, an SMS channel's MO token would open that id's mail
 * endpoint.
 */
const LABEL = 'email-inbound';

function hmacKey(): Buffer {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) throw new Error('MARKETING_SECRET_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

/** token = HMAC-SHA256(masterKey, "email-inbound:<channelId>") as lowercase hex. */
export function emailInboundToken(channelId: string): string {
  return createHmac('sha256', hmacKey()).update(`${LABEL}:${channelId}`).digest('hex');
}

/** Constant-time check; never throws (a missing key / bad input → false). */
export function verifyEmailInboundToken(channelId: string, token: string): boolean {
  let expected: string;
  try {
    expected = emailInboundToken(channelId);
  } catch {
    return false;
  }
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The public URL the tenant points their mail relay (or their provider's
 * inbound-parse route) at. Returns null when the base URL or the master key is
 * unavailable, so a masked channel view degrades to "not available yet" rather
 * than throwing. Path mirrors `EmailWebhookController`'s
 * `:channelId/:token/inbound`.
 */
export function emailInboundCallbackUrl(
  baseUrl: string | undefined,
  channelId: string,
): string | null {
  if (!baseUrl) return null;
  let token: string;
  try {
    token = emailInboundToken(channelId);
  } catch {
    return null;
  }
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/public/channels/email/${channelId}/${token}/inbound`;
}
