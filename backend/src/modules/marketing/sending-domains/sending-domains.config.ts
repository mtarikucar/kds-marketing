/**
 * Sending-domains / DKIM feature gate (GHL parity, Epic 13 — inert).
 *
 * A workspace can register its own sending domain, publish DKIM/SPF/DMARC DNS
 * records, and (once verified) have its marketing email sent From that domain.
 * Actually routing mail through a per-domain identity needs a transactional ESP
 * (Postmark/SendGrid/Mailgun/SES) that the platform's shared SMTP is not.
 *
 * WHY THIS IS NOT ONE BOOLEAN: `SENDING_DOMAIN_ESP=1` used to arm the whole
 * path. That handed the tenant an SPF record pointing at `spf.platform.example`
 * — a placeholder that authorises nobody — told them it was verified, and then
 * sent noreply@<their domain> out of the platform's own SMTP. Naming a provider
 * is a statement of intent; the path may only arm when the configuration behind
 * that intent actually exists. `missing` names what is still absent so the ops
 * health panel can answer "why is this off" without an operator guessing.
 *
 * Both keys are already plumbed through deploy.yml (see deploy-env-parity.spec),
 * so this gate adds no new deploy surface. Nothing here fails a deploy when
 * unset — unset is simply the off state.
 */

/** Providers whose domain provisioning this path knows how to talk to. An
 *  unrecognised value is a typo or a leftover `1`, and must not arm anything. */
export const SENDING_DOMAIN_ESP_PROVIDERS = ['postmark', 'sendgrid', 'mailgun', 'ses', 'resend'] as const;
export type SendingDomainEspProvider = (typeof SENDING_DOMAIN_ESP_PROVIDERS)[number];

export interface SendingDomainEspStatus {
  /** True only when a real tenant-domain send could be authenticated today. */
  armed: boolean;
  /** What the operator asked for, even when it is not usable — for the panel. */
  provider: string | null;
  /** Env keys an operator still has to set. Empty exactly when `armed`. */
  missing: string[];
}

/** The value the feature shipped with; it authorises nothing and must never
 *  reach a tenant's DNS zone. */
const PLACEHOLDER_SPF_INCLUDE = 'spf.platform.example';

/**
 * The platform host tenants include in their SPF record, or null when there is
 * nothing honest to ask for. Callers must handle null by omitting the record
 * rather than inventing one.
 */
export function platformSpfInclude(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env.SENDING_DOMAIN_SPF_INCLUDE ?? '').trim().toLowerCase();
  if (!value || value === PLACEHOLDER_SPF_INCLUDE) return null;
  // A bare hostname: anything else would be pasted into a zone file verbatim.
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value) ? value : null;
}

export function sendingDomainEspStatus(
  // The env bag is a parameter so a caller that is ALREADY answering "what is
  // inert on this deployment" from an explicit bag (the mail-health panel, and
  // its spec) asks this gate rather than re-deriving a looser version of it.
  // Production passes nothing and reads process.env, exactly as before.
  env: Record<string, string | undefined> = process.env,
): SendingDomainEspStatus {
  const named = (env.SENDING_DOMAIN_ESP ?? '').trim().toLowerCase();
  const missing: string[] = [];
  if (!named || !(SENDING_DOMAIN_ESP_PROVIDERS as readonly string[]).includes(named)) {
    missing.push('SENDING_DOMAIN_ESP');
  }
  if (!platformSpfInclude(env)) missing.push('SENDING_DOMAIN_SPF_INCLUDE');
  return { armed: missing.length === 0, provider: named || null, missing };
}

/** Every env key the sending-domain path reads, for the "what is inert" panel. */
export const SENDING_DOMAIN_ENV_KEYS = ['SENDING_DOMAIN_ESP', 'SENDING_DOMAIN_SPF_INCLUDE'] as const;

/**
 * The single answer to "may the tenant-domain path do anything at all" — the
 * `sendingDomains` entitlement, `request()`, and `resolveFrom()` all read it, so
 * the nav item, the form and the From-override can never disagree.
 */
export function isSendingDomainsConfigured(): boolean {
  return sendingDomainEspStatus().armed;
}

export const SENDING_DOMAIN_VERIFY_KIND = 'sending-domain.verify';
/** Re-poll DNS this often, and give up (FAILED) after this many polls. */
export const SENDING_DOMAIN_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h
export const SENDING_DOMAIN_MAX_POLLS = 24 * 14; // ~14 days
/** A resolver that did not answer gets a shorter, cheaper retry than a poll
 *  that established something — it costs nothing against the tenant's budget. */
export const SENDING_DOMAIN_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10m
