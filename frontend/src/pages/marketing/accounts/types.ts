export type Capability = 'PUBLISH' | 'INBOX' | 'ADS' | 'WHATSAPP' | 'CALLS';
export type Provider =
  | 'META'
  | 'LINKEDIN'
  | 'TIKTOK'
  | 'TWITTER'
  | 'PINTEREST'
  | 'GOOGLE'
  | 'SMS'
  | 'EMAIL'
  | 'WEBCHAT'
  | 'VOICE';
export type Health = 'HEALTHY' | 'REAUTH_REQUIRED' | 'DISABLED' | 'PARTIAL';

export interface SourceRef {
  capability: Capability;
  model: string;
  id: string;
  status: string;
  /** Setup URL to paste into the provider (Meta webhook / NetGSM inbound / email). */
  setupUrl?: string | null;
  setupKind?: 'META_WEBHOOK' | 'SMS_CALLBACK' | 'EMAIL_WEBHOOK' | 'TIKTOK_WEBHOOK';
  /** WEBCHAT — the embed <script> is built from this widget key. */
  widgetKey?: string | null;
  /** EMAIL — what the mailbox card needs that `status` cannot say: whether it
   *  was connected by OAuth consent (so re-consent is the repair, not a
   *  password), whether that consent has been revoked, and the address mail
   *  actually leaves from. Absent on a server that predates the field, which is
   *  why `mailboxOf()` in ./hooks reads it defensively. */
  mailbox?: { consent: boolean; reauthRequired: boolean; address: string | null };
}
export interface ConnectionGroup {
  identityKey: string;
  externalId: string | null;
  displayName: string;
  connectedVia: 'OAUTH' | 'MANUAL';
  capabilities: Capability[];
  health: Health;
  sources: SourceRef[];
}
export interface ProviderBlock {
  provider: Provider;
  displayName: string;
  connectMethod: 'OAUTH' | 'MANUAL';
  configured: boolean;
  connections: ConnectionGroup[];
}
export interface AccountCenterResponse {
  secretBoxConfigured: boolean;
  features: { conversationAi: boolean };
  networkStatus: Record<string, boolean>;
  providers: ProviderBlock[];
}
