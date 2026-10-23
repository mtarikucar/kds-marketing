import type { ConnectorHealth, CredentialKind, KindKey, Provider } from '@/api/types';

// The connector rules the panel needs to offer only what the server accepts, mirrored from
// `jt_connector::provider_for_kind` and `jt_app::usecases::connector`. The server checks again.

/** The capability kinds each provider serves, in the order the connect page lists them. */
export const PROVIDER_KINDS: Record<Provider, readonly KindKey[]> = {
  meta: ['facebook_page', 'instagram', 'instagram_dm', 'messenger', 'whatsapp_cloud', 'meta_ads', 'review_facebook'],
  netgsm: ['sms_line', 'netgsm_pbx'],
  x: ['x'],
  mail: ['mailbox'],
};

/** A provider's name as shown (brand names, the same in every language). */
export const PROVIDER_NAMES: Record<Provider, string> = { meta: 'Meta', netgsm: 'NetGSM', x: 'X', mail: 'Email' };

/** The provider that serves `kind`, or `null` for a kind none serves yet. */
export function providerOf(kind: string): Provider | null {
  for (const provider of Object.keys(PROVIDER_KINDS) as Provider[]) {
    if ((PROVIDER_KINDS[provider] as readonly string[]).includes(kind)) return provider;
  }
  return null;
}

/** Meta and X kinds connect by signing in at the provider (OAuth). */
export function connectsByOAuth(kind: string): boolean {
  const provider = providerOf(kind);
  return provider === 'meta' || provider === 'x';
}

/** The credentials a NetGSM kind takes by hand, or `null` for any other kind. */
export function netgsmCredentialKind(kind: string): Extract<CredentialKind, 'netgsm_sms' | 'netgsm_pbx'> | null {
  if (kind === 'sms_line') return 'netgsm_sms';
  if (kind === 'netgsm_pbx') return 'netgsm_pbx';
  return null;
}

/** A pasted Page or WhatsApp token needs the id of its page or phone number. */
export function tokenNeedsExternalId(kind: string): boolean {
  return kind === 'facebook_page' || kind === 'whatsapp_cloud';
}

/** How soon an expiring token is flagged. */
export const TOKEN_WARNING_DAYS = 7;

/** A connector's health, as the badge shows it, most pressing first. */
export type HealthView =
  | { kind: 'reconnect' }
  | { kind: 'expired' }
  | { kind: 'expiresSoon'; at: string }
  | { kind: 'failed'; at: string; errorKind: string | null }
  | { kind: 'ok'; at: string }
  | { kind: 'never' };

export function healthView(health: ConnectorHealth, now: Date = new Date()): HealthView {
  if (health.reconnect_required) return { kind: 'reconnect' };
  if (health.token_expires_at) {
    const left = new Date(health.token_expires_at).getTime() - now.getTime();
    if (left <= 0) return { kind: 'expired' };
    if (left <= TOKEN_WARNING_DAYS * 86_400_000) return { kind: 'expiresSoon', at: health.token_expires_at };
  }
  if (health.last_probe_at && health.ok === false) {
    return { kind: 'failed', at: health.last_probe_at, errorKind: health.error_kind };
  }
  if (health.last_probe_at && health.ok) return { kind: 'ok', at: health.last_probe_at };
  return { kind: 'never' };
}

/** The `jt_connector::ConnectorError` kinds the panel names. */
export const ERROR_KINDS = ['auth', 'permission', 'throttle', 'transient', 'permanent'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}
