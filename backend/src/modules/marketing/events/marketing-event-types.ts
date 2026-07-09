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
  // Booking lifecycle beyond creation. Cancelled drives conference/calendar
  // teardown (subscribed by the Google/Outlook sync services); Updated /
  // Rescheduled are emitted by Phase-2 edit/reschedule flows.
  BookingCancelled: "marketing.booking.cancelled.v1",
  BookingUpdated: "marketing.booking.updated.v1",
  BookingRescheduled: "marketing.booking.rescheduled.v1",
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

  // Tag assignment (emitted by TagsService). Backs the `tag.added` workflow
  // trigger; the matching removed event exists for outbound webhooks.
  LeadTagAdded: "marketing.lead.tag.added.v1",

  // Standalone trigger link clicked (emitted by TriggerLinksService). Backs the
  // `link.clicked` workflow trigger; filter on trigger.triggerLinkId.
  LinkClicked: "marketing.link.clicked.v1",

  // Inbound webhook received (emitted by InboundWebhooksService). Backs the
  // `webhook.received` workflow trigger; the posted JSON is carried under
  // payload.body, filter on trigger.body.<field> / trigger.webhookId.
  WebhookReceived: "marketing.webhook.received.v1",

  // Memberships (Epic 10b) — emitted by CertificateService when a
  // course-completion certificate is issued. Backs the `certificate.issued`
  // workflow trigger; filter on trigger.courseId.
  CertificateIssued: "marketing.certificate.issued.v1",

  // NetGSM blacklist sync (Phase 1 Task 10) — emitted whenever a lead's SMS
  // opt-out flag flips, so NetgsmBlacklistSyncService can mirror the
  // transition onto NetGSM's account-level SMS blacklist (defense-in-depth;
  // İYS + the app-side smsOptOut checks remain the primary enforcement).
  // Producers: ComplianceService (MARKETING_SMS consent writes) and
  // CampaignTrackingService (public campaign-unsubscribe route).
  SmsOptedOut: "marketing.sms.optout.v1",
  SmsOptedIn: "marketing.sms.optin.v1",

  // İYS push-back webhook (NetGSM Phase 2 Task 4) — one event per NEW
  // consent-change element the unified public receiver
  // (NetgsmEventsController's `iys` route, hub-owned) archives from İYS's
  // (unsigned, array-shaped) push. IysWebhookConsumer subscribes and applies
  // the ONAY/RET to the matching lead's MARKETING_SMS consent via
  // ComplianceService.recordConsent, tagging the source
  // `IYS_<originalSource>` so ComplianceService/IysSyncService can
  // recognize — and never re-enqueue — an İYS-ORIGINATED change (would
  // otherwise be a feedback loop back to İYS).
  IysConsentReceived: "marketing.iys.consent.v1",

  // Santral live call event (NetGSM Phase 3 Task 1) — one event per NEW
  // call-event element the unified public receiver (NetgsmEventsController's
  // `events` route, hub-owned) normalizes from a santral scenario push
  // (Inbound_call/Answer/Hangup/cdr). An element whose scenario doesn't
  // normalize is archived for audit but never published, same fail-closed
  // treatment as IysConsentReceived above. The telephony consumer (Phase 3
  // Task 2) subscribes to write INBOUND/missed SalesCall rows + screen-pop.
  CallEvent: "marketing.telephony.call_event.v1",

  // A missed inbound call (NetGSM Phase 3 Task 2) — emitted by
  // TelephonyEventConsumer the first time an INBOUND SalesCall resolves to
  // NO_ANSWER. Forward-compatible trigger source for workflow automation (a
  // 'missed call' trigger — not yet wired into WorkflowTriggerService's
  // TRIGGER_EVENT_MAP, see that file); usable today by anything that
  // subscribes directly via DomainEventBus.
  CallMissed: "marketing.call.missed.v1",

  // Voice-campaign report push (NetGSM Phase 5 Task 3) — one event per NEW
  // (relationid, state) pair the unified public receiver
  // (NetgsmEventsController's `voice-report` route) archives from NetGSM's
  // voicesms report push. Voice PUSHES call outcomes (unlike SMS, which is
  // DLR-polled); a single call can receive multiple distinct-state pushes,
  // each archived + published independently (mirrors the `events` route's
  // one-call/many-scenarios shape). Consumed by VoiceReportConsumer
  // (marketing/campaigns), which correlates purely by `relationid` (=
  // CampaignRecipient.id) — never netgsmJobId/referansId, the SMS DLR-poll
  // reconciler's own unscoped signal.
  VoiceReport: "marketing.voice.report.v1",

  // Press-1 → workflow trigger (NetGSM Phase 5 Task 3) — emitted by
  // VoiceReportConsumer when a voice-report's pushButton matches one of the
  // campaign's configured voiceConfig.keys. Backs the `voice_keypress`
  // workflow trigger (WorkflowTriggerService's EVENT_FOR_TRIGGER); filter on
  // trigger.key to react to a specific digit (e.g. "pressed 1 -> create task").
  VoiceKeypress: "marketing.voice.keypress.v1",

  // Auto-dialer per-attempt report push (NetGSM Phase 5 Task 5) — one event
  // per NEW (JobID, unique_id) element the unified public receiver
  // (NetgsmEventsController's `autocall-report` route) archives from
  // NetGSM's `/autocallservice` attempt webhook. A number can be retried
  // several times; each attempt gets its own unique_id and its own event
  // (unlike VoiceReport, no extra state-token scoping is needed). Consumed
  // by AutocallReportConsumer (marketing/campaigns), which correlates by
  // `jobId` == AutocallSession.netgsmListId, then matches `called` to the
  // session's own AutocallSessionItem rows by phone.
  AutocallReport: "marketing.autocall.report.v1",
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

/**
 * Booking lifecycle payload (cancelled / updated / rescheduled). Minimal +
 * self-contained; consumers re-read the booking for fresh state. `workspaceId`
 * is the scope anchor.
 */
export interface MarketingBookingLifecyclePayload {
  workspaceId: string;
  bookingId: string;
  calendarId?: string;
  occurredAt: string;
}

/**
 * SMS opt-out/opt-in transition payload (marketing.sms.optout.v1 /
 * marketing.sms.optin.v1). Self-contained: NetgsmBlacklistSyncService never
 * reads the Lead row, so `phone` is carried directly. `phone` is the raw
 * value stored on Lead.phone — the client normalizes it to NetGSM's local
 * MSISDN format on the wire.
 */
export interface MarketingSmsOptStatusPayload {
  workspaceId: string;
  leadId: string;
  phone: string;
}

/**
 * İYS push-back consent change (marketing.iys.consent.v1). Emitted once per
 * NEW array element the unified NetGSM webhook receiver archives. The
 * producer (NetgsmEventsController, hub-owned so it stays business-logic
 * free — it never resolves a lead itself) uses the literal event-type
 * string rather than importing this file, so the hub never takes a
 * compile-time dependency on the marketing bounded context; this interface
 * is the canonical contract IysWebhookConsumer types its handler against.
 */
export interface MarketingIysConsentPayload {
  workspaceId: string;
  /** Raw recipient as reported by İYS (phone for MESAJ/ARAMA, email for EPOSTA). */
  recipient: string;
  /** İYS consent type: MESAJ (SMS) | ARAMA (call) | EPOSTA (email). Only
   *  MESAJ is applied this phase — ARAMA lands with Phase 5 voice campaigns,
   *  EPOSTA is out of scope for this program (see IysWebhookConsumer). */
  type: string;
  status: 'ONAY' | 'RET';
  /** İYS source code as reported by the push (e.g. HS_WEB, HS_MESAJ). */
  source: string;
  transactionId: string;
}

export type SantralCallEventKind = 'inbound_call' | 'answer' | 'hangup' | 'cdr';

/**
 * Santral live call event (marketing.telephony.call_event.v1). Emitted once
 * per NEW call-event element the unified NetGSM webhook receiver (the hub's
 * `events` route) normalizes from a santral scenario push. Mirrors
 * `SantralEvent` from
 * `netgsm/webhooks/santral-event-normalizer.ts` — kept as an independent
 * interface (not imported) so marketing's event registry never takes a
 * compile-time dependency on the netgsm hub module, the same reasoning as
 * MarketingIysConsentPayload above.
 */
export interface MarketingCallEventPayload {
  workspaceId: string;
  kind: SantralCallEventKind;
  uniqueId: string | null;
  crmId: string | null;
  customerNum: string | null;
  internalNum: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  status: string | null;
  recording: string | null;
  durationSec: number | null;
  raw: object;
}

/**
 * A missed inbound call (marketing.call.missed.v1) — emitted by
 * TelephonyEventConsumer the first time an INBOUND SalesCall resolves to
 * NO_ANSWER (never re-emitted for the same call; the consumer's monotonic
 * status guard only lets that transition happen once). `leadId`/`customerNum`
 * let a future workflow trigger react without a re-read.
 */
export interface MarketingCallMissedPayload {
  workspaceId: string;
  salesCallId: string;
  leadId: string | null;
  customerNum: string | null;
}

/**
 * Voice-campaign report push (marketing.voice.report.v1). Emitted once per
 * NEW (relationid, state) element the unified NetGSM webhook receiver
 * archives (NetgsmEventsController's `voice-report` route, hub-owned so it
 * stays business-logic free). The producer uses the literal event-type
 * string rather than importing this file, same reasoning as
 * MarketingIysConsentPayload/MarketingCallEventPayload above; this interface
 * is the canonical contract VoiceReportConsumer types its handler against.
 */
export interface MarketingVoiceReportPayload {
  workspaceId: string;
  /** = CampaignRecipient.id, stamped as `relationid` at send time (see
   *  campaign-sender.service.ts's `sendVoice`). */
  relationid: string;
  /** Raw durum/state as reported by NetGSM. The exact vocabulary isn't
   *  live-verified (see VoiceReportConsumer.mapVoiceState's own caveat). */
  state: string | null;
  /** Talk seconds (bilsec), when the call carries one. */
  bilsec: number | null;
  /** DTMF digit the callee pressed (push_button), when present. */
  pushButton: string | null;
  /** Call-recording URL (record_link), when present. CampaignRecipient has
   *  no dedicated column for this yet — see VoiceReportConsumer. */
  recordLink: string | null;
}

/**
 * Press-1 → workflow trigger (marketing.voice.keypress.v1). Emitted by
 * VoiceReportConsumer when a voice-report's pushButton matches one of the
 * campaign's configured `voiceConfig.keys`. `leadId`/`campaignId`/
 * `recipientId` let a workflow react (and a future action look up either
 * row) without a re-read; filter on trigger.key for a specific digit.
 */
export interface MarketingVoiceKeypressPayload {
  workspaceId: string;
  leadId: string;
  campaignId: string;
  recipientId: string;
  key: string;
}

/**
 * Auto-dialer per-attempt report push (marketing.autocall.report.v1).
 * Emitted once per NEW (JobID, unique_id) element the unified NetGSM webhook
 * receiver archives (NetgsmEventsController's `autocall-report` route,
 * hub-owned so it stays business-logic free). The producer uses the literal
 * event-type string rather than importing this file, same reasoning as
 * MarketingIysConsentPayload/MarketingCallEventPayload above; this interface
 * is the canonical contract AutocallReportConsumer types its handler against.
 */
export interface MarketingAutocallReportPayload {
  workspaceId: string;
  /** = AutocallClient.addAutocall's returned jobId/listId (best-effort
   *  assumed to be the SAME identifier echoed back here — see
   *  AutocallClient's docstring for the "not live-verified" caveat). */
  jobId: string;
  /** The dialed number, as NetGSM echoes it — matched against
   *  AutocallSessionItem.phone (normalized) to resolve the lead. */
  called: string | null;
  /** This ONE attempt's identifier — a retried number gets a new one per try. */
  uniqueId: string | null;
  /** Raw status as reported by NetGSM. Vocabulary NOT researched/pinned down
   *  (unlike voice-report's durum 1/2/3/7) — kept verbatim; see
   *  AutocallReportConsumer for how it's stored. */
  status: string | null;
}
