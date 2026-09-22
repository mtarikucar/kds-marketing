import { createHmac } from 'crypto';
import { constantTimeEquals, timestampFresh, VerifyOutcome, WebhookRequest, WebhookVerifier } from './index';

/**
 * Mailgun: `HMAC-SHA256(signing key, timestamp + token)`, hex, carried in the
 * BODY as `{ signature: { timestamp, token, signature } }`.
 *
 * Mailgun is the one provider whose signature is not in a header, so this
 * verifier has to read the payload it is about to authenticate. That is safe
 * here and only here because the URL — not the payload — already chose this
 * verifier: the parse below cannot change WHICH secret is demanded, it can only
 * fail. It reads three strings out of a bounded JSON parse inside a try, and
 * treats anything else as `MALFORMED`.
 *
 * The signed material is the timestamp and the token, NOT the body, so the
 * token is what stops a captured signature being re-used for a different
 * payload; that is why a mismatched token has to fail (Mailgun's own docs make
 * the token single-use on their side).
 */
export const mailgunVerifier: WebhookVerifier = {
  provider: 'mailgun',
  requires: ['MAILGUN_WEBHOOK_SIGNING_KEY'],

  configured(): boolean {
    return !!process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  },

  verify(req: WebhookRequest): VerifyOutcome {
    const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!key) return { ok: false, reason: 'NOT_CONFIGURED' };

    let block: { timestamp?: unknown; token?: unknown; signature?: unknown } | undefined;
    try {
      const body = JSON.parse(req.rawBody.toString('utf8')) as Record<string, unknown>;
      const sig = body?.signature;
      if (sig && typeof sig === 'object') block = sig as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'MALFORMED' };
    }

    const timestamp = typeof block?.timestamp === 'string' || typeof block?.timestamp === 'number'
      ? String(block.timestamp)
      : '';
    const token = typeof block?.token === 'string' ? block.token : '';
    const signature = typeof block?.signature === 'string' ? block.signature : '';
    if (!timestamp || !token || !signature) return { ok: false, reason: 'MALFORMED' };

    const expected = createHmac('sha256', key).update(timestamp + token).digest('hex');
    if (!constantTimeEquals(signature, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };

    // Freshness AFTER the signature check: an unsigned timestamp is just a
    // number an attacker chose, so rejecting on it first would leak nothing and
    // prove nothing.
    return timestampFresh(timestamp) ? { ok: true } : { ok: false, reason: 'STALE_TIMESTAMP' };
  },
};
