/**
 * Sending-domains / DKIM feature gate (GHL parity, Epic 13 — inert).
 *
 * A workspace can register its own sending domain, publish DKIM/SPF/DMARC DNS
 * records, and (once verified) have its marketing email sent From that domain.
 * Actually routing mail through a per-domain identity needs a transactional ESP
 * (Postmark/SendGrid/Mailgun/SES) that the platform's shared SMTP is not — so
 * the whole feature stays INERT until an operator sets SENDING_DOMAIN_ESP:
 * request() returns 503 and the campaign From-override never activates (mail
 * keeps using the platform default).
 */
export function isSendingDomainsConfigured(): boolean {
  return !!process.env.SENDING_DOMAIN_ESP;
}

/** The platform host that tenants include in their SPF record. */
export function platformSpfInclude(): string {
  return process.env.SENDING_DOMAIN_SPF_INCLUDE || 'spf.platform.example';
}

export const SENDING_DOMAIN_VERIFY_KIND = 'sending-domain.verify';
/** Re-poll DNS this often, and give up (FAILED) after this many polls. */
export const SENDING_DOMAIN_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h
export const SENDING_DOMAIN_MAX_POLLS = 24 * 14; // ~14 days
