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
  | 'LINKEDIN' // LinkedIn engagement (comments on OWNED org posts) — gated; inert without Community Management approval
  | 'EMAIL' // two-way email — per-workspace SMTP send + provider inbound webhook
  | 'VOICE'; // inbound AI phone (Twilio) — config-only, no text send

export type ChannelCapability =
  | 'send'
  | 'receive'
  | 'delivery-receipts'
  | 'session-window'; // provider enforces a reply window (e.g. WhatsApp 24h)

/** How an external identity maps to a ContactIdentity.kind. */
export type ContactKind = 'PHONE' | 'WA' | 'PSID' | 'IGSID' | 'WEBCHAT' | 'TIKTOKID' | 'EMAIL' | 'LINKEDIN';

/** Ad/post referral context a provider attaches to an inbound message (Meta
 *  click-to-WhatsApp / click-to-Messenger). Soft provider ids — consumed by
 *  first-touch lead attribution (D10b) at conversation ingress. */
export interface InboundReferral {
  /** Provider referral source id (Meta ads referrals carry the AD id here). */
  sourceId?: string | null;
  /** Meta click-to-WhatsApp click id (`ctwa_clid`). */
  ctwaClid?: string | null;
  /** The URL the click came from (WA `source_url` / Messenger `referer_uri`). */
  sourceUrl?: string | null;
  /** Provider-declared referral type (`ad` | `post` | `ADS` | …). */
  sourceType?: string | null;
}

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
  /** Ad/post referral the provider attached (CTWA / CTM), when present. */
  referral?: InboundReferral | null;
  /** Raw provider payload, stored on Message.meta for audit/debug. */
  raw?: unknown;
  /**
   * This is a message the ACCOUNT sent, observed on the webhook — Meta's own
   * `is_echo`. Almost always it is the owner replying from the Instagram or
   * Messenger app on their phone, which is a real message in the thread that
   * this product would otherwise never see.
   *
   * `externalUserId` is still the CUSTOMER. An echo inverts the envelope —
   * `sender` is the business and `recipient` is the person — so the adapter
   * reads the other side; passing the raw sender would file every outbound
   * message into one conversation with the business itself.
   *
   * Our OWN sends echo back too, and need no special handling: their `mid` is
   * already stored, so ingest's dedup resolves them to the existing row.
   */
  echo?: boolean;

  /**
   * Whether the transport could PROVE the sender is who the From claims —
   * SPF/DKIM/DMARC on the EMAIL path, via `inbound/mail-auth.ts`.
   *
   * Three states, and the third is the default: `undefined` means the transport
   * offered no opinion (every non-email channel, and mail with no
   * `Authentication-Results` header), and behaves exactly as this product
   * always has. Only an explicit `false` — a DMARC fail, or SPF *and* DKIM both
   * failing — changes anything.
   *
   * An explicit `false` does NOT drop the mail. It is still stored and still
   * attached to the lead, because silence is the failure mode being removed: a
   * customer whose own mail server is misconfigured must still reach a human.
   * What it suppresses is everything that would act on the mail by itself —
   * the AI reply, the `LeadCreated` fan-out and the tool use behind them — so
   * a forged "please send the invoice to this new account" cannot be answered
   * automatically.
   */
  senderVerified?: boolean;
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
  /**
   * Email-only. Every other adapter ignores both: SMS and the chat networks
   * have no subject line and no markup.
   *
   * `subject` exists because the email adapter was written for INBOUND replies,
   * where the subject is a property of the thread and lives on the channel
   * config. A campaign has a different subject per send, which that shape
   * could not express.
   */
  subject?: string;
  html?: string;
  /**
   * Email-only. The display name beside the From address — a SEPARATE field,
   * never folded into the address itself: the OAuth transports want a bare
   * address, and the inbound echo guard parses the stored one.
   */
  fromName?: string;
  /**
   * Email-only. Where a human reply should land when it is not the address the
   * mail was sent from — the platform transport sends as `jeetagrowth.com`
   * (DMARC `p=reject`, so the From cannot change) and points replies at the
   * tenant.
   */
  replyTo?: string;
  /**
   * Email-only. Threading: the Message-ID this mail answers, and the chain
   * behind it. Top-level rather than raw headers, because the transport owns
   * the bracket spelling.
   */
  inReplyTo?: string;
  references?: string[];
  /**
   * Email-only, RFC 3834. Set when a machine wrote the body, so the other
   * side's auto-responder does not answer ours forever.
   */
  autoSubmitted?: 'auto-generated' | 'auto-replied';
  /**
   * Email-only. The Message-ID the ledger already recorded for this mail, so
   * a bounce report and a Sent-folder copy point back at the same row instead
   * of at an id only the transport ever saw.
   */
  messageId?: string;
  /**
   * Email-only, and BULK-only. Present turns into the RFC 8058
   * `List-Unsubscribe` / `List-Unsubscribe-Post` header pair; absent means this
   * is a one-to-one message, which must never claim to be a mailing list.
   * Per-recipient, because the token behind it is what identifies who opted out.
   */
  listUnsubscribeUrl?: string;
}

export interface SendResult {
  externalMessageId: string | null;
  status: 'SENT' | 'FAILED';
  error?: string;
  /**
   * Would sending THIS message again, unchanged, have a different answer?
   * A bare `false` used to mean all three of "the relay blinked", "this mailbox
   * is gone" and "the password is wrong", so the campaign sender retried what
   * could never work and gave up on what would have. Optional: an adapter that
   * cannot tell says nothing rather than guessing.
   */
  retriable?: boolean;
  /** The 3-digit SMTP status the server answered with, when there was one. */
  smtpCode?: number;
  /** Its enhanced status code (RFC 3463) — `5.1.1` is a dead mailbox, `5.7.1`
   *  is a policy refusal, and treating the second as the first suppresses an
   *  address that was never invalid. */
  smtpEnhanced?: string;
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
