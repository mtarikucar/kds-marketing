/**
 * What kind of mail is this, and which gates does that kind pass through?
 *
 * There is no single `send()` that every mail funnels into. There is one
 * function per mail class sharing one ordered gate, and THIS TABLE IS THE
 * CONTRACT: the guard reads it as data instead of each caller remembering its
 * own rules. A universal funnel breaks working siblings — an invoice must reach
 * a customer who unticked marketing mail (`document-email-bare`,
 * `no-payment-receipt`), a booking confirmation must never acquire a
 * `List-Unsubscribe` header, and a password reset must never be stopped by a
 * stale bounce row or carry a tenant's Reply-To (`no-password-recovery`).
 *
 * Every `'never'` below is a verifier's explicit warning, annotated with the
 * finding that demanded it. They are not defaults; they are the reason the mail
 * is typed at all.
 */

export type MailClass =
  /** Account/security: login, verification, password reset, 2FA, temp password.
   *  Platform identity ONLY. Never a tenant Reply-To (that is a phishing
   *  shape), never an unsubscribe header, never blocked by a marketing opt-out
   *  or a stale bounce. */
  | 'AUTH'
  /** Mail to OUR OWN users about the product: daily digest, booking HOST
   *  reminder, team invite. No lead, no tenant Reply-To, NOT metered against
   *  messagesMonthly. */
  | 'INTERNAL'
  /** The tenant's business mail to one named customer: quote, invoice, receipt,
   *  booking confirm/cancel/reminder, e-sign. Tenant identity + Reply-To.
   *  No unsubscribe. */
  | 'TRANSACTIONAL'
  /** Thread-bound 1:1: inbox reply, AI reply, AI follow-up, distribution
   *  outreach, MCP send_message. Goes out through MessageSenderService.
   *  Threading headers. */
  | 'CONVERSATIONAL'
  /** Marketing to a list: campaign batch, workflow/drip send_email, nurture.
   *  Full consent + suppression gate, RFC 8058 headers + footer, metering,
   *  caps, pacing. */
  | 'BULK';

export const MAIL_CLASSES: readonly MailClass[] = [
  'AUTH',
  'INTERNAL',
  'TRANSACTIONAL',
  'CONVERSATIONAL',
  'BULK',
] as const;

/**
 * One vocabulary for every cell, so no cell is ever read as merely truthy.
 * `'message'` and `'n/a'` are the two that would be misread as "yes" by a
 * boolean-shaped matrix — and both mean "not on this path".
 */
export type Gate =
  /** Applies to every mail of this class. */
  | 'always'
  /** Never applies — each one carries the finding that demanded it. */
  | 'never'
  /** Applies only when WE reach out first (`OutboundMail.proactive`). */
  | 'proactive'
  /** BULK only: applies to commercial (TİCARİ) mail under İYS. */
  | 'ticari'
  /** Applies only when the author is the AI, never a human's own reply. */
  | 'ai'
  /** Covered by the conversation's own `Message` row — no second trace. */
  | 'message'
  /** Unreachable for this class (it never uses the platform transport). */
  | 'n/a';

export interface GateSet {
  /** Exactly one recipient, CR/LF refused. Unconditional, every class. */
  singleRecipient: Gate;
  /** KVKK erasure tombstone — the one thing that stops even AUTH mail. */
  erasure: Gate;
  /** Hard bounce / INVALID address. */
  hardBounce: Gate;
  /** Marketing opt-out (`emailOptOut`). */
  optOut: Gate;
  /** Spam complaint. */
  complaint: Gate;
  /** İYS `EPOSTA` RET, when the workspace has İYS configured. */
  iysEposta: Gate;
  /** `List-Unsubscribe` + `-Post` + footer. On BULK it is fail-closed. */
  unsubscribe: Gate;
  /** Tenant Reply-To on the platform transport. */
  replyTo: Gate;
  /** `"<Marka> via Jeeta"` display name (platform transport only). */
  viaDisplayName: Gate;
  /** `In-Reply-To` / `References`. */
  threading: Gate;
  /** `Auto-Submitted` (RFC 3834). */
  autoSubmitted: Gate;
  /** `MessageQuotaService` metering against the tenant plan. */
  messageQuota: Gate;
  /** Workspace-not-ACTIVE kill switch. */
  workspaceActive: Gate;
  /** `settings.email.paused` operator switch. */
  sendingPaused: Gate;
  /** Per-workspace daily platform-transport cap. */
  dailyCap: Gate;
  /** Quiet-hours / send-window clamp. */
  quietHours: Gate;
  /** `LeadActivity` trace. */
  leadActivity: Gate;
  /** `MailLog` ledger row. */
  mailLog: Gate;
}

export const GATE_MATRIX: Record<MailClass, GateSet> = {
  AUTH: {
    singleRecipient: 'always',
    erasure: 'always',
    // A stale bounce or an opt-out that silences a password reset locks the
    // owner out of the product for good (no-password-recovery). Security mail
    // is not marketing and is gated by nothing the tenant can set.
    hardBounce: 'never',
    optOut: 'never',
    complaint: 'never',
    iysEposta: 'never',
    // An unsubscribe link on a login code invites the recipient to switch off
    // their own account security.
    unsubscribe: 'never',
    // A tenant Reply-To on a password reset is the phishing shape itself, and
    // "<Marka> via Jeeta" on one relabels platform mail as the tenant's
    // (platform-fallback-no-reply-to, tenant-content-platform).
    replyTo: 'never',
    viaDisplayName: 'never',
    threading: 'never',
    autoSubmitted: 'never',
    // Never metered, never paused, never capped: a suspended or over-quota
    // workspace must still be able to log in and recover (suspension-doesnt-stop
    // deliberately stops the tenant's OWN mail, not ours).
    messageQuota: 'never',
    workspaceActive: 'never',
    sendingPaused: 'never',
    dailyCap: 'never',
    quietHours: 'never',
    // `LeadActivity.leadId` is NOT NULL and this mail has no lead; the MailLog
    // row is the whole trace (automated-email-not-recorded).
    leadActivity: 'never',
    mailLog: 'always',
  },

  INTERNAL: {
    singleRecipient: 'always',
    // The recipient is one of our own users, not a data subject on a tenant's
    // list, so a tenant-scoped tombstone does not speak about them.
    erasure: 'never',
    hardBounce: 'never',
    optOut: 'never',
    complaint: 'never',
    iysEposta: 'never',
    unsubscribe: 'never',
    // A team invite with the tenant brand's Reply-To would send replies about
    // OUR product to the tenant's sales inbox (invites-not-sent,
    // digest-relative-link, host-reminder-multiws).
    replyTo: 'never',
    viaDisplayName: 'never',
    threading: 'never',
    autoSubmitted: 'never',
    // Metering a daily digest against messagesMonthly spends a paying
    // customer's quota on mail we send to ourselves.
    messageQuota: 'never',
    workspaceActive: 'never',
    sendingPaused: 'never',
    dailyCap: 'never',
    quietHours: 'never',
    leadActivity: 'never',
    mailLog: 'always',
  },

  TRANSACTIONAL: {
    singleRecipient: 'always',
    erasure: 'always',
    hardBounce: 'always',
    // The invoice still has to arrive. Unticking marketing mail is not a
    // refusal of the receipt for something the customer bought.
    optOut: 'never',
    complaint: 'never',
    iysEposta: 'never',
    // 6563 does not ask for an opt-out on a mail the customer's own order
    // produced, and a `List-Unsubscribe` on one tells Gmail this is a list.
    unsubscribe: 'never',
    replyTo: 'always',
    viaDisplayName: 'always',
    threading: 'never',
    autoSubmitted: 'never',
    messageQuota: 'always',
    workspaceActive: 'always',
    sendingPaused: 'always',
    dailyCap: 'always',
    // A quote the customer is waiting for does not get held until 09:00
    // (no-send-window is about automation, not about answering an order).
    quietHours: 'never',
    leadActivity: 'always',
    mailLog: 'always',
  },

  CONVERSATIONAL: {
    singleRecipient: 'always',
    erasure: 'always',
    // Proactive only. An address that just sent us a message is demonstrably
    // live and demonstrably talking to us; refusing to ANSWER it because of an
    // old opt-out or a verification false positive is the regression
    // (replies-skip-consent).
    hardBounce: 'proactive',
    optOut: 'proactive',
    complaint: 'proactive',
    iysEposta: 'never',
    unsubscribe: 'never',
    // This class goes out through the mailbox transport, which already sends as
    // the tenant — there is no platform From to re-label (no-display-name).
    replyTo: 'n/a',
    viaDisplayName: 'n/a',
    threading: 'always',
    // RFC 3834 on an AI-authored reply only. A human's reply that claims to be
    // auto-submitted gets filed as a robot by the receiver
    // (ai-email-style, human-start-recorded-ai).
    autoSubmitted: 'ai',
    messageQuota: 'always',
    workspaceActive: 'always',
    sendingPaused: 'always',
    dailyCap: 'always',
    // An answer goes out when it is written; only a follow-up we initiate
    // waits for the window.
    quietHours: 'proactive',
    // The `Message` row IS the trace here, and it is what the inbox renders —
    // a second LeadActivity would double every thread in the stream.
    leadActivity: 'message',
    mailLog: 'always',
  },

  BULK: {
    singleRecipient: 'always',
    erasure: 'always',
    hardBounce: 'always',
    optOut: 'always',
    complaint: 'always',
    // Only commercial mail needs an İYS RET check; BİLGİLENDİRME does not
    // (tr-commercial-compliance).
    iysEposta: 'ticari',
    // Fail closed: no token, no send (workflow-email-noncompliant).
    unsubscribe: 'always',
    replyTo: 'always',
    viaDisplayName: 'always',
    // A campaign is not a reply to anything; threading headers on one would
    // graft it into a customer's existing thread.
    threading: 'never',
    autoSubmitted: 'never',
    messageQuota: 'always',
    workspaceActive: 'always',
    sendingPaused: 'always',
    dailyCap: 'always',
    quietHours: 'always',
    leadActivity: 'always',
    mailLog: 'always',
  },
};

/** What the guard knows about the mail in front of it when it reads a cell. */
export interface GateContext {
  /** We reached out first (as opposed to answering an inbound message). */
  proactive?: boolean;
  /** Commercial (TİCARİ) rather than BİLGİLENDİRME, for İYS. */
  ticari?: boolean;
  /** The body was written by the AI, not by a human. */
  aiAuthored?: boolean;
}

/**
 * Does this cell apply to the mail in hand?
 *
 * One reader for the whole table so the conditional cells are interpreted
 * identically everywhere. `'message'` and `'n/a'` answer false on purpose: both
 * mean "this gate is not on this path", and a caller that treated the string as
 * truthy would write a duplicate trace or a header the class must not carry.
 */
export function gateApplies(gate: Gate, ctx: GateContext = {}): boolean {
  switch (gate) {
    case 'always':
      return true;
    case 'proactive':
      return !!ctx.proactive;
    case 'ticari':
      return !!ctx.ticari;
    case 'ai':
      return !!ctx.aiAuthored;
    default:
      return false;
  }
}
