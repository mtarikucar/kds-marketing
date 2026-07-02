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
