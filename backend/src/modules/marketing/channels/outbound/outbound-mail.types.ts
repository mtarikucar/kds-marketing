import { MailClass } from './mail-class';

/**
 * What one outbound mail is, and what came back.
 *
 * The receipt is the point. Today an honest refusal ("this person
 * unsubscribed"), an honest failure ("the relay was down for a minute") and a
 * real bug all come back as the same bare `false`, so the campaign console says
 * SENT when nothing was sent (`campaign-failures-terminal`), a workflow step is
 * DONE when the mail was dropped (`failed-automation-done`), a distribution
 * draft stays SENT on a failure (`distribution-sent-on-fail`) and a
 * misconfigured mailer counts as delivered (`mailer-misconfig-silent`).
 *
 * `REFUSED` is not a failure: policy said no, it is terminal, it is visible,
 * and it is never retried.
 */
export interface OutboundMail {
  workspaceId: string;
  mailClass: MailClass;
  /** EXACTLY one address — enforced, not assumed. */
  to: string;
  /** Never invented by the adapter (`fake-re-subject`). */
  subject: string;
  text: string;
  html?: string;
  /** Drives suppression, the trace and the unsubscribe token. */
  leadId?: string | null;
  /** BULK: absent ⇒ REFUSED (fail closed). */
  unsubscribe?: { token: string; url: string };
  thread?: { inReplyTo?: string | null; references?: string[]; conversationId?: string };
  ics?: { method: 'REQUEST' | 'CANCEL'; content: string; filename?: string };
  /** CONVERSATIONAL only: "we reach out" vs "we answer them". */
  proactive?: boolean;
  /** The body was written by the AI (drives `Auto-Submitted`). */
  aiAuthored?: boolean;
  /** BULK: commercial (TİCARİ) rather than BİLGİLENDİRME, for the İYS gate. */
  ticari?: boolean;
  /** Defaults to `Workspace.defaultLanguage` — NOT a new column. */
  lang?: string;
  /** `'campaign:<id>' | 'workflow:<id>' | 'invoice:<id>' | …` */
  source: string;
  /**
   * OPTIONAL. Only for callers with a real domain key: booking / invoice /
   * workflow-step. NEVER content-derived and NEVER required — `sendTakeoverReply`
   * and the workflow handler legitimately send identical text twice (a rep
   * typing "tamam" twice).
   */
  idempotencyKey?: string;
  /** The campaign sender reserves its own quota today. */
  alreadyMetered?: boolean;
}

export type MailOutcome =
  | 'SENT'
  /** Policy said no — terminal, NOT a failure, never retried. */
  | 'REFUSED'
  /** The provider said no forever — terminal. */
  | 'FAILED_PERMANENT'
  /** Retry is the right answer. */
  | 'FAILED_TRANSIENT'
  /** A MailLog row with this idempotencyKey already SENT. */
  | 'DEDUPED';

export type MailReason =
  | 'SUPPRESSED_OPT_OUT'
  | 'SUPPRESSED_BOUNCE'
  | 'SUPPRESSED_INVALID'
  | 'SUPPRESSED_COMPLAINT'
  | 'SUPPRESSED_ERASED'
  | 'IYS_RET'
  | 'CONSENT_REQUIRED'
  | 'QUOTA_EXHAUSTED'
  | 'DAILY_CAP'
  | 'QUIET_HOURS'
  | 'WORKSPACE_INACTIVE'
  | 'SENDING_PAUSED'
  | 'NO_RECIPIENT'
  | 'BAD_RECIPIENT'
  | 'NO_UNSUBSCRIBE'
  | 'MISSING_PUBLIC_BASE_URL'
  | 'NOT_CONFIGURED'
  | 'TRANSIENT'
  | 'SYSTEMIC'
  | 'PERMANENT';

export type MailTransport = 'MAILBOX_SMTP' | 'MAILBOX_OAUTH' | 'PLATFORM' | 'NONE';

export interface MailReceipt {
  outcome: MailOutcome;
  /** `outcome === 'SENT' || outcome === 'DEDUPED'`. */
  ok: boolean;
  /** Always written, even for REFUSED — a refusal has to be visible. */
  mailLogId: string;
  /** Normalized, no angle brackets. */
  messageId: string | null;
  transport: MailTransport;
  /** Machine code, localisable. Never printed raw at a user. */
  reason?: MailReason;
  /** The provider's own words, ≤300 chars, never a paraphrase — this is the
   *  string an operator pastes into a support thread. */
  error?: string;
  /** i18n contract: the key the UI renders, with its variables. */
  userMessage?: { key: string; vars?: Record<string, string> };
  retriable: boolean;
  retryAt?: Date | null;
  smtpCode?: number;
  smtpEnhanced?: string;
}
