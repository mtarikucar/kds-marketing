import { constantTimeEquals, header, VerifyOutcome, WebhookRequest, WebhookVerifier } from './index';

/**
 * Postmark signs nothing. What it offers is the credentials you embed in the
 * webhook URL (`https://user:pass@host/…`), which arrive as HTTP basic auth,
 * plus a published egress range.
 *
 * So the gate is the credential pair, compared in constant time, and the IP
 * allow-list is an OPTIONAL second factor: unset, it is not enforced at all,
 * because Postmark changes that range from time to time and a stale list would
 * silently drop every bounce. `POSTMARK_WEBHOOK_IPS` is a comma-separated list
 * for an operator who wants belt and braces.
 */
export const postmarkVerifier: WebhookVerifier = {
  provider: 'postmark',
  requires: ['POSTMARK_WEBHOOK_USER', 'POSTMARK_WEBHOOK_PASSWORD'],

  configured(): boolean {
    return !!process.env.POSTMARK_WEBHOOK_USER && !!process.env.POSTMARK_WEBHOOK_PASSWORD;
  },

  verify(req: WebhookRequest): VerifyOutcome {
    const user = process.env.POSTMARK_WEBHOOK_USER;
    const pass = process.env.POSTMARK_WEBHOOK_PASSWORD;
    if (!user || !pass) return { ok: false, reason: 'NOT_CONFIGURED' };

    const auth = header(req, 'authorization') ?? '';
    const [scheme, value] = auth.split(' ');
    if (!value || scheme.toLowerCase() !== 'basic') return { ok: false, reason: 'BAD_SIGNATURE' };

    const expected = Buffer.from(`${user}:${pass}`).toString('base64');
    if (!constantTimeEquals(value.trim(), expected)) return { ok: false, reason: 'BAD_SIGNATURE' };

    const allowed = (process.env.POSTMARK_WEBHOOK_IPS ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (allowed.length) {
      // Node reports an IPv4 peer over a dual-stack socket as ::ffff:a.b.c.d.
      const ip = (req.ip ?? '').replace(/^::ffff:/i, '');
      if (!allowed.includes(ip)) return { ok: false, reason: 'BAD_SIGNATURE' };
    }
    return { ok: true };
  },
};
