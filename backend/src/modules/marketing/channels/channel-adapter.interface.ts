/**
 * Channel adapter abstraction — one implementation per messaging transport
 * (web-chat, WhatsApp Cloud, NetGSM SMS, Instagram, Messenger). Mirrors the
 * TelephonyProvider/PaymentProvider registry pattern so adding a channel is a
 * registry entry, not a rewrite of the conversation engine.
 *
 * Secrets never reach an adapter raw from the DB: the registry opens the
 * AES-256-GCM sealed config and hands the adapter a ResolvedChannelConfig.
 */
export type ChannelType =
  | 'WEBCHAT'
  | 'WHATSAPP'
  | 'SMS'
  | 'INSTAGRAM'
  | 'MESSENGER'
  | 'TIKTOK' // TikTok DM (Business Messaging) — gated API; inert without creds
  | 'EMAIL' // two-way email — per-workspace SMTP send + provider inbound webhook
  | 'VOICE'; // inbound AI phone (Twilio) — config-only, no text send

export type ChannelCapability =
  | 'send'
  | 'receive'
  | 'delivery-receipts'
  | 'session-window'; // provider enforces a reply window (e.g. WhatsApp 24h)

/** How an external identity maps to a ContactIdentity.kind. */
export type ContactKind = 'PHONE' | 'WA' | 'PSID' | 'IGSID' | 'WEBCHAT' | 'TIKTOKID' | 'EMAIL';

/** A normalized inbound message, transport-agnostic. */
export interface InboundMessage {
  /** Provider-side sender identity (E.164 / wa-id / psid / igsid / visitorId). */
  externalUserId: string;
  kind: ContactKind;
  /** Provider message id for dedup; null when the provider supplies none. */
  externalMessageId: string | null;
  text: string;
  /** Display name the provider supplied, if any (used to name a new lead). */
  displayName?: string | null;
  /** Raw provider payload, stored on Message.meta for audit/debug. */
  raw?: unknown;
}

/** Decrypted, ready-to-use channel config. Built by the registry, never the DB. */
export interface ResolvedChannelConfig {
  channelId: string;
  workspaceId: string;
  type: ChannelType;
  externalId: string | null;
  /** Decrypted secret credentials (provider tokens/keys). */
  secrets: Record<string, string>;
  /** Non-secret public settings (display name, allowed origins, greeting…). */
  public: Record<string, unknown>;
}

/** WhatsApp template send — reopens a closed 24h session window with an
 *  already-approved template (name + language + optional body components). */
export interface OutboundTemplate {
  name: string;
  languageCode: string;
  components?: unknown[];
}

/** Media-by-URL send (image/document). The provider fetches the URL itself —
 *  no upload/hosting on our side. */
export interface OutboundMedia {
  url: string;
  kind: 'image' | 'document';
  filename?: string;
  caption?: string;
}

export interface OutboundSend {
  config: ResolvedChannelConfig;
  /** Recipient identity (E.164 / wa-id / psid / …). */
  to: string;
  text: string;
  /** Optional richer payloads. Adapters pick the shape: template > media > text.
   *  Templates are WhatsApp-only (ignored by Messenger/Instagram). */
  template?: OutboundTemplate;
  media?: OutboundMedia;
}

export interface SendResult {
  externalMessageId: string | null;
  status: 'SENT' | 'FAILED';
  error?: string;
}

/** A provider delivery/read receipt, transport-agnostic. Advances an OUTBOUND
 *  Message's status (keyed by externalMessageId). Not a conversation message —
 *  applied by MessageReceiptService, never through ConversationIngress. */
export interface StatusUpdate {
  externalMessageId: string;
  status: 'DELIVERED' | 'READ' | 'FAILED';
  reason?: string | null;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: readonly ChannelCapability[];

  /** Deliver an outbound message. MUST NOT throw for provider 4xx/5xx — return
   *  a FAILED SendResult so the caller can mark the Message + refund quota. */
  send(send: OutboundSend): Promise<SendResult>;

  /** Parse a raw inbound webhook body into normalized messages. Adapters that
   *  can't receive (e.g. a pure outbound SMS line) omit this. */
  parseInbound?(config: ResolvedChannelConfig, body: unknown): InboundMessage[];

  /** Parse provider delivery/read receipts from a webhook body into status
   *  updates (keyed by our externalMessageId). Adapters without receipts omit
   *  this. Applied by MessageReceiptService, NOT ConversationIngress. */
  parseStatusUpdates?(config: ResolvedChannelConfig, body: unknown): StatusUpdate[];

  /** Validate the channel's config (called on save / "verify" button). */
  healthCheck(
    config: ResolvedChannelConfig,
  ): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
}
