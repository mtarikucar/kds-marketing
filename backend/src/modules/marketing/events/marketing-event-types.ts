/**
 * Marketing-produced domain events. Versioned dotted names under the
 * `marketing.` prefix — allowlisted in outbox/event-types.ts
 * (DYNAMIC_EVENT_TYPE_PREFIXES) so the unregistered-type warning doesn't fire,
 * and dedup-required (outbox.service.ts DEDUP_REQUIRED_PREFIXES) so producers
 * must pass a deterministic idempotencyKey.
 *
 * Marketing owns these; at the Phase-5 split they move with the marketing
 * service. Payloads are intentionally minimal and self-contained.
 */
export const MarketingEventTypes = {
  LeadConverted: "marketing.lead.converted.v1",
  CommissionCredited: "marketing.commission.credited.v1",
  CallLogged: "marketing.call.logged.v1",
  InstallationScheduled: "marketing.installation.scheduled.v1",
  InstallationCompleted: "marketing.installation.completed.v1",
  // Raised by the core catalog when a tenant requests a quote on a
  // QUOTE_ONLY device (yazarkasa / YN ÖKC). Consumed by the marketing
  // HardwareQuoteConsumer, which creates + auto-assigns the lead — so the
  // core module never writes the marketing-owned `leads` table directly.
  HardwareQuoteRequested: "marketing.lead.hardware_quote.v1",

  // Phase F P2 — omnichannel conversations. ConversationMessageReceived is the
  // inbound trigger the Conversation AI engine (P2) and workflow triggers (P3)
  // both subscribe to; MessageSent is emitted after a successful outbound send.
  ConversationStarted: "marketing.conversation.started.v1",
  ConversationMessageReceived: "marketing.conversation.message.received.v1",
  ConversationMessageSent: "marketing.conversation.message.sent.v1",

  // Phase F P3 — workflow-automation trigger sources. LeadCreated +
  // ConversationMessageReceived fire from P3; the rest are emitted by their
  // own phases (form/booking P5, review P6) and the workflow trigger service
  // already listens for them.
  LeadCreated: "marketing.lead.created.v1",
  LeadStatusChanged: "marketing.lead.status_changed.v1",
  FormSubmitted: "marketing.form.submitted.v1",
  BookingCreated: "marketing.booking.created.v1",
  ReviewReceived: "marketing.review.received.v1",
  TaskCompleted: "marketing.task.completed.v1",
  // Phase F P9 — end-customer invoicing.
  InvoicePaid: "marketing.invoice.paid.v1",

  // Opportunities / pipelines (GoHighLevel parity). Emitted by the
  // OpportunitiesService when a deal is created or moves stage / resolves.
  // Forward-compatible trigger sources for workflow automation (wired in a
  // later epic) and pipeline reporting.
  OpportunityCreated: "marketing.opportunity.created.v1",
  OpportunityStageChanged: "marketing.opportunity.stage_changed.v1",
  OpportunityWon: "marketing.opportunity.won.v1",
  OpportunityLost: "marketing.opportunity.lost.v1",
} as const;

export type MarketingEventType =
  (typeof MarketingEventTypes)[keyof typeof MarketingEventTypes];

export interface MarketingLeadConvertedPayload {
  leadId: string;
  tenantId: string;
  /** Assigned rep, if any. null when the lead was unassigned at conversion. */
  marketingUserId: string | null;
  /** The SIGNUP commission minted on conversion, if a rep was assigned. */
  commissionId: string | null;
  occurredAt: string;
}

/**
 * A hardware-quote request from an existing tenant. Self-contained: the
 * consumer creates the lead purely from this payload (it never reads core
 * tables). `dedupRef` is the deterministic idempotency/dedup key so resubmits
 * collapse into one lead.
 */
export interface MarketingHardwareQuotePayload {
  tenantId: string;
  dedupRef: string;
  businessName: string;
  contactPerson: string;
  phone: string | null;
  email: string | null;
  notes: string;
  productSnapshot: Record<string, unknown>;
  occurredAt: string;
}

export interface MarketingCommissionCreditedPayload {
  commissionId: string;
  tenantId: string;
  marketingUserId: string;
  type: "SIGNUP" | "RENEWAL" | "UPSELL";
  amount: number;
  /** Accrual period, `YYYY-MM`. */
  period: string;
  occurredAt: string;
}

export interface MarketingCallLoggedPayload {
  callId: string;
  marketingUserId: string;
  leadId: string | null;
  status: string;
  durationSec: number | null;
  occurredAt: string;
}

export interface MarketingInstallationScheduledPayload {
  jobId: string;
  tenantId: string;
  crewId: string;
  scheduledDate: string; // YYYY-MM-DD
  occurredAt: string;
}

export interface MarketingInstallationCompletedPayload {
  jobId: string;
  tenantId: string;
  crewId: string | null;
  occurredAt: string;
}

/**
 * An inbound customer message landed on a conversation. The engine re-reads
 * conversation/channel/agent/lead for fresh state, so the payload is minimal;
 * `text` + `channelType` are carried so workflow filters can match without an
 * extra read. `workspaceId` is the scope anchor (marketing events often have a
 * null core `tenantId`).
 */
export interface MarketingConversationMessageReceivedPayload {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  channelType: string;
  leadId: string;
  messageId: string;
  text: string;
  occurredAt: string;
}

export interface MarketingConversationStartedPayload {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  channelType: string;
  leadId: string;
  occurredAt: string;
}

export interface MarketingConversationMessageSentPayload {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  messageId: string;
  authorType: string; // AI | AGENT
  occurredAt: string;
}
