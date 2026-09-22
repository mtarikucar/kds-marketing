import { createHmac } from 'crypto';
import { constantTimeEquals, header, VerifyOutcome, WebhookRequest, WebhookVerifier } from './index';

/**
 * The relay we ship for: HMAC-SHA256 over the RAW body, hex, in
 * `x-esp-signature`, keyed by the platform-global `ESP_FEEDBACK_SECRET`.
 *
 * No ESP speaks this — it is the contract for a self-hosted relay somebody
 * writes against us, and it is the verifier the bare `POST public/esp/feedback`
 * path keeps using. The comparison is therefore reproduced BYTE FOR BYTE from
 * the controller it was lifted out of, `s=` split included: an existing relay
 * must keep verifying across this refactor, so nothing here is "improved".
 */
export const genericHmacVerifier: WebhookVerifier = {
  provider: 'generic',
  requires: ['ESP_FEEDBACK_SECRET'],

  configured(): boolean {
    return !!process.env.ESP_FEEDBACK_SECRET;
  },

  verify(req: WebhookRequest): VerifyOutcome {
    const secret = process.env.ESP_FEEDBACK_SECRET;
    if (!secret) return { ok: false, reason: 'NOT_CONFIGURED' };

    const sig = header(req, 'x-esp-signature');
    if (typeof sig !== 'string') return { ok: false, reason: 'BAD_SIGNATURE' };

    // Stripe-style `t=…,s=…` envelope or a bare hex digest — both were accepted
    // before the registry existed.
    const provided = sig.includes('s=') ? sig.split('s=').pop()!.trim() : sig.trim();
    const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    return constantTimeEquals(provided, expected) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  },
};
