/**
 * Response types for the workspace Connections settings area (SSO + Google
 * Calendar + Slack). These mirror the masked shapes the backend returns — see
 * backend/src/modules/marketing/integrations/{sso,google-calendar,slack}*.
 *
 * Secrets are NEVER echoed: SSO carries `clientSecretSet: boolean`, Google
 * carries `tokenSet`/`syncEnabled` flags, Slack returns no webhook URL at all.
 */

// ── SSO (OIDC) ────────────────────────────────────────────────────────────────

export interface SsoConnection {
  id: string;
  workspaceId: string;
  provider: string; // always 'OIDC' today
  issuer: string;
  clientId: string;
  /** True when a sealed client secret is stored — the raw value is never sent. */
  clientSecretSet: boolean;
  enabled: boolean;
  allowedDomains: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Google Calendar ───────────────────────────────────────────────────────────

export interface GoogleCalendarConnection {
  id: string;
  workspaceId: string;
  marketingUserId: string;
  googleCalendarId: string;
  /** True when sealed access + refresh tokens are stored. */
  tokenSet: boolean;
  tokenExpiresAt: string;
  syncEnabled: boolean;
  pushChannelActive: boolean;
  lastSyncToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleCalendarStatus {
  /** False ⇒ operator hasn't supplied GOOGLE_OAUTH_* / MARKETING_SECRET_KEY. */
  configured: boolean;
  connections: GoogleCalendarConnection[];
}

// ── Slack ─────────────────────────────────────────────────────────────────────

export type SlackStatus = 'ACTIVE' | 'DISABLED';

export interface SlackIntegration {
  id: string;
  channel: string | null;
  /** Stored as JSON on the backend; the empty array means "all whitelisted events". */
  events: string[];
  status: SlackStatus;
  lastNotifiedAt: string | null;
  createdAt: string;
}

/** The whitelisted domain events a Slack integration can subscribe to. */
export const SLACK_EVENTS = [
  'marketing.lead.created.v1',
  'marketing.lead.converted.v1',
  'marketing.form.submitted.v1',
  'marketing.booking.created.v1',
] as const;

export type SlackEvent = (typeof SLACK_EVENTS)[number];

export const SLACK_EVENT_LABELS: Record<SlackEvent, string> = {
  'marketing.lead.created.v1': 'Lead created',
  'marketing.lead.converted.v1': 'Lead converted',
  'marketing.form.submitted.v1': 'Form submitted',
  'marketing.booking.created.v1': 'Booking created',
};
