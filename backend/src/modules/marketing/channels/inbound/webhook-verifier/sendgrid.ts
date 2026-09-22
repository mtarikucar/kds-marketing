import { createPublicKey, createVerify, KeyObject } from 'crypto';
import { header, timestampFresh, VerifyOutcome, WebhookRequest, WebhookVerifier } from './index';

/**
 * SendGrid (Twilio) Signed Event Webhook: ECDSA P-256 over
 * `timestamp || rawBody`, signature base64 DER in
 * `x-twilio-email-event-webhook-signature`, timestamp in `…-timestamp`.
 *
 * The verification key is a PUBLIC key — `SENDGRID_EVENT_PUBLIC_KEY`, the
 * base64 SPKI blob SendGrid prints when signing is switched on. It is not a
 * secret, which is the point: nothing we hold can mint an event, so a leak of
 * our env cannot forge a suppression.
 *
 * The signed bytes are the timestamp CONCATENATED with the body, which is why
 * the raw buffer has to survive all the way here — re-serialising the JSON
 * would change a space and fail every signature.
 */
const HEADER_SIGNATURE = 'x-twilio-email-event-webhook-signature';
const HEADER_TIMESTAMP = 'x-twilio-email-event-webhook-timestamp';

function publicKey(): KeyObject | null {
  const b64 = process.env.SENDGRID_EVENT_PUBLIC_KEY;
  if (!b64) return null;
  try {
    return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    // A pasted-wrong key is an operator error, not an authenticated event.
    return null;
  }
}

export const sendgridVerifier: WebhookVerifier = {
  provider: 'sendgrid',
  requires: ['SENDGRID_EVENT_PUBLIC_KEY'],

  configured(): boolean {
    return !!process.env.SENDGRID_EVENT_PUBLIC_KEY;
  },

  verify(req: WebhookRequest): VerifyOutcome {
    if (!process.env.SENDGRID_EVENT_PUBLIC_KEY) return { ok: false, reason: 'NOT_CONFIGURED' };

    const key = publicKey();
    if (!key) return { ok: false, reason: 'BAD_SIGNATURE' };

    const signature = header(req, HEADER_SIGNATURE);
    const timestamp = header(req, HEADER_TIMESTAMP);
    if (!signature || !timestamp) return { ok: false, reason: 'MALFORMED' };

    let verified = false;
    try {
      const v = createVerify('sha256');
      v.update(Buffer.concat([Buffer.from(timestamp, 'utf8'), req.rawBody]));
      v.end();
      verified = v.verify(key, Buffer.from(signature, 'base64'));
    } catch {
      verified = false;
    }
    if (!verified) return { ok: false, reason: 'BAD_SIGNATURE' };

    return timestampFresh(timestamp) ? { ok: true } : { ok: false, reason: 'STALE_TIMESTAMP' };
  },
};
