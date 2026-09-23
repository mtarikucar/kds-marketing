import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { EmailFrom, EmailService } from '../../../../common/services/email.service';
import { normalizeAddress } from '../../../../common/util/email-address';
import { MailCopyKey, escapeHtml, mailReasonKey, t, tHtml } from '../../../../common/i18n/mail-copy';
import { SuppressionService } from '../../compliance/suppression.service';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { MailboxHealthService } from '../mailbox-health.service';
import { newMessageId, normalizeMessageId } from '../email-message-id';
import { GATE_MATRIX, gateApplies } from './mail-class';
import { MailGuardService, GateRefusal, LeadDeliverability, WorkspaceGateState } from './mail-guard.service';
import { MailLogRef, MailLogService } from './mail-log.service';
import { MailTraceService } from './mail-trace.service';
import { SenderIdentity, SenderIdentityService } from './sender-identity.service';
import { classifySmtpError } from './smtp-error';
import { MailOutcome, MailReason, MailReceipt, MailTransport, OutboundMail } from './outbound-mail.types';

/**
 * The seam: one place a mail goes through, and one receipt that says what
 * happened to it.
 *
 * Today the same bare `false` means "this person unsubscribed", "the relay was
 * down for a minute", "SMTP is not configured at all" and "we sent it fine" —
 * so a campaign reports SENT when nothing left the building
 * (`campaign-failures-terminal`), a workflow step is DONE when the mail was
 * dropped (`failed-automation-done`), and a distribution draft stays SENT on a
 * failure (`distribution-sent-on-fail`). Nobody can answer "why did this
 * customer never get the invoice", because nothing wrote it down
 * (`automated-email-not-recorded`).
 *
 * This is **not** a universal funnel. The class decides which gates run (§A1);
 * `send()` is the shared pipeline, and it is what each class's caller uses. An
 * invoice still reaches a customer who unticked marketing mail, a booking
 * confirmation still never acquires a `List-Unsubscribe`, and a password reset
 * is still stopped by nothing a tenant can set.
 *
 * ## The order is the contract
 *
 *  1. validate the recipient, load the lead once
 *  2. the idempotency claim — a key that already sent is `DEDUPED`
 *  3. the sender identity
 *  4. the ordered gate; a refusal writes its own ledger row and RETURNS
 *  5. the ledger row opens **before** the dispatch, never after
 *  6. compose (footer, headers, our own deterministic Message-ID)
 *  7. dispatch
 *  8. classify, settle, refund
 *  9. the lead-timeline trace, best-effort, outside everything
 *
 * Step 5 before step 7 is the whole `pending-row` defect: a row written after
 * the send is missing precisely for the mails where the process died mid-send.
 *
 * Nothing here throws (PLAN G2). `MESSAGES_EXHAUSTED` is caught by the guard
 * and mapped; a ledger or trace failure is a `warn`.
 */

/** What the pre-launch card asks before anybody presses send. */
export interface MailPreflight {
  ok: boolean;
  reason?: MailReason;
  userMessage?: { key: string; vars?: Record<string, string> };
  transport: MailTransport;
  from: { email: string; name: string; replyTo?: string };
  degraded?: SenderIdentity['degraded'];
}

/** The workspace facts one send needs — read once, or not at all. */
interface WorkspaceContext extends WorkspaceGateState {
  name?: string | null;
  defaultLanguage?: string | null;
}

/** What the transport answered, before it is classified. */
interface Dispatch {
  ok: boolean;
  messageId: string | null;
  error?: string;
  /** The transport's own verdict, when it had one to give. */
  retriable?: boolean;
  smtpCode?: number;
  smtpEnhanced?: string;
}

@Injectable()
export class OutboundMailService {
  private readonly logger = new Logger(OutboundMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: SenderIdentityService,
    private readonly guard: MailGuardService,
    private readonly mailLog: MailLogService,
    private readonly trace: MailTraceService,
    private readonly suppression: SuppressionService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly email: EmailService,
    private readonly health: MailboxHealthService,
  ) {}

  async send(mail: OutboundMail): Promise<MailReceipt> {
    const to = (mail.to ?? '').trim();
    const toNorm = normalizeAddress(to) ?? to.toLowerCase();

    // 1. The lead, once. Workspace-scoped, so a leadId from another tenant
    //    resolves to nothing rather than to somebody else's customer.
    const lead = await this.loadLead(mail);

    // 2. The dedupe claim. Only ever with a key the CALLER owns: a
    //    content-derived one would swallow a rep typing "tamam" twice.
    if (mail.idempotencyKey) {
      const already = await this.mailLog.claim(mail.workspaceId, mail.idempotencyKey);
      if (already) return this.dedupedReceipt(already);
    }
    const ws = await this.loadWorkspace(mail);

    // 3. Who it is from.
    const identity = await this.identity.resolve(mail.workspaceId, mail.mailClass, { html: !!mail.html });

    // 4. The gate. A refusal is visible: it gets a ledger row and a timeline
    //    entry, because "we did not send this, and here is why" is the line
    //    that never existed.
    const refusal = await this.guard.check({ mail, lead, workspace: ws, transport: identity.transport });
    if (refusal) return this.refuse(mail, identity, refusal, { to, toNorm, lead });

    // 5. The ledger row, before anything is dispatched.
    const opened = await this.mailLog.pending({
      workspaceId: mail.workspaceId,
      mailClass: mail.mailClass,
      source: mail.source,
      idempotencyKey: mail.idempotencyKey ?? null,
      to,
      toNorm,
      leadId: lead?.id ?? null,
      fromAddress: identity.fromEmail,
      replyTo: identity.replyTo ?? null,
      transport: identity.transport,
      channelId: identity.config?.channelId ?? null,
      subject: mail.subject,
    });
    if (opened.deduped) {
      // The race the pre-check could not see: another send under the same key
      // won the insert. Give back what this one reserved.
      await this.guard.refundQuota(mail, identity.transport);
      return this.dedupedReceipt(opened.row);
    }
    const row = opened.row;

    // 6. Compose. The Message-ID is OURS and deterministic from the ledger row,
    //    so a bounce report and a Sent-folder copy point back at the same place.
    const messageId = newMessageId(row.id, identity.fromEmail) ?? null;
    const composed = this.compose(mail, identity, ws);

    // 7. Dispatch. A transport that THROWS rather than answering must not
    //    escape the gateway: G2 is the promise every migrated caller was
    //    rewritten against, and an escaped throw also strands the PENDING
    //    ledger row opened at step 5 with nothing to settle it.
    let result: Dispatch;
    try {
      result = await this.dispatch(mail, identity, composed, messageId);
    } catch (e: any) {
      const classified = classifySmtpError(e);
      result = {
        ok: false,
        messageId: null,
        error: String(e?.message ?? e).slice(0, 300),
        retriable: classified.retriable,
        ...(classified.code ? { smtpCode: classified.code } : {}),
      };
    }

    // 8. Settle.
    return this.settle(mail, identity, row, result, messageId, { to, lead });
  }

  /**
   * The same questions the send will ask, asked before anybody commits to it —
   * so the pre-launch card and the send can never disagree. It spends no quota
   * and writes no ledger row.
   */
  async preflight(mail: Omit<OutboundMail, 'text' | 'html'>): Promise<MailPreflight> {
    const full = { ...mail, text: '' } as OutboundMail;
    const lead = await this.loadLead(full);
    const ws = await this.loadWorkspace(full);
    const identity = await this.identity.resolve(mail.workspaceId, mail.mailClass);
    const from = {
      email: identity.fromEmail,
      name: identity.fromName,
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
    };

    const refusal = await this.guard.check({
      mail: full,
      lead,
      workspace: ws,
      transport: identity.transport,
      skipMetering: true,
    });
    if (refusal) {
      return {
        ok: false,
        reason: refusal.reason,
        userMessage: { key: mailReasonKey(refusal.reason) },
        transport: identity.transport,
        from,
        ...(identity.degraded ? { degraded: identity.degraded } : {}),
      };
    }

    const missing = this.transportMissing(identity);
    if (missing) {
      return {
        ok: false,
        reason: missing,
        userMessage: { key: mailReasonKey(missing) },
        transport: 'NONE',
        from,
        ...(identity.degraded ? { degraded: identity.degraded } : {}),
      };
    }

    return {
      ok: true,
      transport: identity.transport,
      from,
      ...(identity.degraded ? { degraded: identity.degraded } : {}),
    };
  }

  // ── the pipeline, step by step ─────────────────────────────────────────────

  private async loadLead(mail: OutboundMail): Promise<LeadDeliverability | null> {
    if (!mail.leadId) return null;
    try {
      return await this.prisma.lead.findFirst({
        where: { id: mail.leadId, workspaceId: mail.workspaceId },
        select: { id: true, emailNormalized: true },
      });
    } catch (e: any) {
      this.logger.warn(`lead read failed (lead=${mail.leadId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Read the workspace only for the classes that use it. AUTH and INTERNAL are
   * gated by nothing a tenant can set and carry no tenant copy, so account
   * recovery does not depend on a workspace read succeeding.
   */
  private async loadWorkspace(mail: OutboundMail): Promise<WorkspaceContext | null> {
    if (mail.mailClass === 'AUTH' || mail.mailClass === 'INTERNAL') return null;
    try {
      return await this.prisma.workspace.findUnique({
        where: { id: mail.workspaceId },
        // `timezone` is not decoration: the guard only falls back to its own
        // read when this value is `undefined`, which it never is on a real
        // send. Left out here, an hours-only send window has no zone to
        // resolve against and the quiet-hours clamp ships inert.
        select: { status: true, settings: true, name: true, defaultLanguage: true, timezone: true },
      });
    } catch (e: any) {
      this.logger.warn(`workspace read failed (workspace=${mail.workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  private async refuse(
    mail: OutboundMail,
    identity: SenderIdentity,
    refusal: GateRefusal,
    ctx: { to: string; toNorm: string; lead: LeadDeliverability | null },
  ): Promise<MailReceipt> {
    const { row } = await this.mailLog.pending({
      workspaceId: mail.workspaceId,
      mailClass: mail.mailClass,
      source: mail.source,
      idempotencyKey: mail.idempotencyKey ?? null,
      to: ctx.to,
      toNorm: ctx.toNorm,
      leadId: ctx.lead?.id ?? null,
      fromAddress: identity.fromEmail,
      replyTo: identity.replyTo ?? null,
      // Nothing carried it, so nothing is claimed to have.
      transport: 'NONE',
      channelId: identity.config?.channelId ?? null,
      subject: mail.subject,
      outcome: 'REFUSED',
      reason: refusal.reason,
      error: refusal.error,
    });

    const receipt: MailReceipt = {
      outcome: 'REFUSED',
      ok: false,
      mailLogId: row.id,
      messageId: null,
      transport: 'NONE',
      reason: refusal.reason,
      userMessage: { key: mailReasonKey(refusal.reason) },
      retriable: refusal.retriable,
      ...(refusal.retryAt ? { retryAt: refusal.retryAt } : {}),
      ...(refusal.error ? { error: refusal.error.slice(0, 300) } : {}),
    };
    await this.record(mail, receipt);
    return receipt;
  }

  /** The body and headers this class of mail is allowed to carry. */
  private compose(
    mail: OutboundMail,
    identity: SenderIdentity,
    ws: WorkspaceContext | null,
  ): { text: string; html?: string; listUnsubscribeUrl?: string } {
    const gates = GATE_MATRIX[mail.mailClass];
    if (!gateApplies(gates.unsubscribe, {}) || !mail.unsubscribe) {
      return { text: mail.text, ...(mail.html ? { html: mail.html } : {}) };
    }

    const url = mail.unsubscribe.url;
    const lang = mail.lang ?? ws?.defaultLanguage ?? null;
    const business = identity.fromName || ws?.name || '';
    // A caller that already rendered the link into its own body — the campaign
    // sender does — must not end up with two opt-out links.
    //
    // Only that LINE is dropped, never the rest of the block. The 6563
    // sender-identity lines (and who the mail is from, and which address it
    // reached) are the gateway's to attach on EVERY bulk send, and short-
    // circuiting the whole footer meant a campaign — the primary commercial
    // mail path, and the one that most needs the identification — shipped
    // without any of it while a workflow drip carried the lot.
    //
    // The html check compares both spellings: a compiled body escapes `&`
    // inside an href, so a link base that ever gains a query string would
    // otherwise read as "not carried" and earn a second footer.
    const carriesText = !!mail.text && mail.text.includes(url);
    const carriesHtml = !!mail.html && (mail.html.includes(url) || mail.html.includes(escapeHtml(url)));

    const text = `${mail.text}\n\n${this.footerText(lang, url, mail.to, business, ws, carriesText)}`;
    const html = mail.html ? this.withHtmlFooter(mail.html, this.footerHtml(lang, url, mail.to, business, ws, carriesHtml)) : undefined;

    return { text, ...(html ? { html } : {}), listUnsubscribeUrl: url };
  }

  private async dispatch(
    mail: OutboundMail,
    identity: SenderIdentity,
    composed: { text: string; html?: string; listUnsubscribeUrl?: string },
    messageId: string | null,
  ): Promise<Dispatch> {
    const missing = this.transportMissing(identity);
    if (missing) {
      // Never a silent mock success. `EmailService` deliberately reports true
      // with no transporter (dev, CI, an inert deploy); the gateway is where
      // "did this really leave the building" is decided.
      return { ok: false, messageId: null, error: 'email transport is not configured', retriable: false };
    }

    if (identity.transport !== 'PLATFORM' && identity.config) {
      const r = await this.registry.get('EMAIL').send({
        config: identity.config,
        to: mail.to.trim(),
        subject: mail.subject,
        text: composed.text,
        ...(composed.html ? { html: composed.html } : {}),
        ...(identity.fromName ? { fromName: identity.fromName } : {}),
        ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
        ...(messageId ? { messageId: `<${messageId}>` } : {}),
        ...this.threadingFor(mail),
        ...(composed.listUnsubscribeUrl ? { listUnsubscribeUrl: composed.listUnsubscribeUrl } : {}),
        // The invite goes wherever the mail goes. A tenant on its own mailbox
        // is exactly the tenant that most wants a branded booking mail, and
        // dropping the .ics here left the customer with a confirmation that
        // never reached their calendar — and a cancellation that never
        // withdrew the appointment.
        ...(mail.ics ? { ics: mail.ics } : {}),
      });
      return {
        ok: r.status === 'SENT',
        messageId: r.externalMessageId,
        error: r.error,
        ...(r.retriable === undefined ? {} : { retriable: r.retriable }),
        ...(r.smtpCode ? { smtpCode: r.smtpCode } : {}),
        ...(r.smtpEnhanced ? { smtpEnhanced: r.smtpEnhanced } : {}),
      };
    }

    const from: EmailFrom = {
      email: identity.fromEmail,
      name: identity.fromName,
      ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
      ...(identity.dkim ? { dkim: identity.dkim } : {}),
    };
    const to = mail.to.trim();
    // OUR id, not nodemailer's: it is already on the ledger row, and DSN
    // attribution and Sent-folder dedupe match on it.
    const wireId = messageId ? `<${messageId}>` : undefined;
    // An invite sent as a REQUEST re-adds an appointment the customer just
    // cancelled, so the method is threaded through rather than defaulted.
    const r = mail.ics
      ? await this.email.sendPlainEmailWithIcsResult(
          to,
          mail.subject,
          composed.text,
          mail.ics.content,
          from,
          {
            method: mail.ics.method,
            ...(mail.ics.filename ? { filename: mail.ics.filename } : {}),
          },
          wireId,
        )
      : composed.html
        ? await this.email.sendCampaignEmailResult(
            to,
            mail.subject,
            composed.text,
            composed.html,
            from,
            composed.listUnsubscribeUrl,
            wireId,
          )
        : await this.email.sendPlainEmailResult(
            to,
            mail.subject,
            composed.text,
            from,
            composed.listUnsubscribeUrl,
            wireId,
          );

    return {
      ok: r.ok,
      messageId: r.messageId ?? null,
      error: r.error,
      ...(r.smtpCode ? { smtpCode: r.smtpCode } : {}),
    };
  }

  private async settle(
    mail: OutboundMail,
    identity: SenderIdentity,
    row: MailLogRef,
    result: Dispatch,
    ourMessageId: string | null,
    ctx: { to: string; lead: LeadDeliverability | null },
  ): Promise<MailReceipt> {
    const transport: MailTransport = this.transportMissing(identity) ? 'NONE' : identity.transport;
    const messageId = normalizeMessageId(result.messageId) ?? ourMessageId;

    if (result.ok) {
      await this.mailLog.settle(row, { outcome: 'SENT', messageId, transport });
      await this.recordMailboxHealth(identity, true);
      const receipt: MailReceipt = {
        outcome: 'SENT',
        ok: true,
        mailLogId: row.id,
        messageId,
        transport,
        retriable: false,
      };
      await this.record(mail, receipt);
      return receipt;
    }

    const missing = this.transportMissing(identity);
    const verdict = missing
      ? { outcome: 'FAILED_PERMANENT' as MailOutcome, reason: 'NOT_CONFIGURED' as MailReason, retriable: false }
      : this.classify(result);

    await this.mailLog.settle(row, {
      outcome: verdict.outcome,
      reason: verdict.reason,
      error: result.error,
      messageId: null,
      transport,
    });
    // A refusal costs no quota, and neither does a failure: the message never
    // reached anybody, so the tenant is not charged for it.
    // `identity.transport`, not the settled `transport`: the guard reserved
    // against what the identity said, and a refund keyed off the "NONE" a
    // missing transport settles to would give nothing back.
    await this.guard.refundQuota(mail, identity.transport);
    await this.recordMailboxHealth(identity, false, result.error, verdict.reason);

    // Only the allow-listed "this mailbox does not exist" codes suppress, and
    // only inside THIS workspace. One tenant's misconfigured relay must never
    // hard-suppress an address for every other tenant (`sync-5xx-no-suppress`).
    if (verdict.suppress) await this.suppressRecipient(mail, ctx);

    const receipt: MailReceipt = {
      outcome: verdict.outcome,
      ok: false,
      mailLogId: row.id,
      messageId: null,
      transport,
      reason: verdict.reason,
      userMessage: { key: mailReasonKey(verdict.reason) },
      retriable: verdict.retriable,
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
      ...(result.smtpCode ? { smtpCode: result.smtpCode } : {}),
      ...(verdict.enhanced ? { smtpEnhanced: verdict.enhanced } : {}),
    };
    await this.record(mail, receipt);
    return receipt;
  }

  // ── the small decisions ────────────────────────────────────────────────────

  /**
   * What a failed send MEANS.
   *
   * `outcome` is what the QUEUE should do and `retriable` is whether this exact
   * attempt could succeed again — they differ for a systemic failure, where the
   * row belongs back in the queue but a second immediate attempt with the same
   * rejected password cannot work.
   */
  private classify(result: Dispatch): {
    outcome: MailOutcome;
    reason: MailReason;
    retriable: boolean;
    suppress?: boolean;
    enhanced?: string;
  } {
    const c = classifySmtpError({
      message: result.error ?? '',
      ...(result.smtpCode ? { responseCode: result.smtpCode } : {}),
      ...(result.smtpEnhanced ? { response: result.smtpEnhanced } : {}),
    });
    const enhanced = result.smtpEnhanced ?? c.enhanced;
    switch (c.kind) {
      case 'transient':
        return { outcome: 'FAILED_TRANSIENT', reason: 'TRANSIENT', retriable: true, enhanced };
      case 'systemic':
        return { outcome: 'FAILED_TRANSIENT', reason: 'SYSTEMIC', retriable: false, enhanced };
      case 'permanent-recipient':
        return { outcome: 'FAILED_PERMANENT', reason: 'PERMANENT', retriable: false, suppress: true, enhanced };
      default:
        // Everything else 5xx is honest-but-unknown: terminal for this attempt,
        // and NOT a reason to declare an address dead.
        return {
          outcome: 'FAILED_PERMANENT',
          reason: 'PERMANENT',
          retriable: result.retriable === true,
          enhanced,
        };
    }
  }

  /** Is there really a transport behind this identity? */
  private transportMissing(identity: SenderIdentity): MailReason | null {
    if (identity.transport === 'PLATFORM') {
      return this.email.isConfigured() && identity.fromEmail ? null : 'NOT_CONFIGURED';
    }
    return identity.config ? null : 'NOT_CONFIGURED';
  }

  private threadingFor(mail: OutboundMail): Record<string, unknown> {
    const gates = GATE_MATRIX[mail.mailClass];
    const out: Record<string, unknown> = {};
    if (gateApplies(gates.threading, {})) {
      const inReplyTo = normalizeMessageId(mail.thread?.inReplyTo);
      const references = (mail.thread?.references ?? [])
        .map((r) => normalizeMessageId(r))
        .filter((r): r is string => !!r);
      if (inReplyTo) out.inReplyTo = `<${inReplyTo}>`;
      if (references.length) out.references = references.map((r) => `<${r}>`);
    }
    // RFC 3834 on an AI-authored reply only. A human's own reply that claimed
    // to be auto-submitted would be filed as a robot by the receiver.
    if (gateApplies(gates.autoSubmitted, { aiAuthored: mail.aiAuthored })) {
      out.autoSubmitted = 'auto-replied';
    }
    return out;
  }

  private async suppressRecipient(
    mail: OutboundMail,
    ctx: { to: string; lead: LeadDeliverability | null },
  ): Promise<void> {
    try {
      await this.suppression.suppress(mail.workspaceId, ctx.to, 'EMAIL', 'HARD_BOUNCE', {
        source: `smtp:${mail.source}`,
        leadId: ctx.lead?.id ?? null,
      });
    } catch (e: any) {
      this.logger.warn(`hard-bounce suppression failed (workspace=${mail.workspaceId}): ${e?.message ?? e}`);
    }
  }

  /** The send lane of the mailbox card. Best-effort; health never fails a send. */
  private async recordMailboxHealth(
    identity: SenderIdentity,
    ok: boolean,
    error?: string,
    reason?: MailReason,
  ): Promise<void> {
    const config = identity.config;
    if (identity.transport === 'PLATFORM' || !config) return;
    const ref = { id: config.channelId, workspaceId: config.workspaceId };
    try {
      if (ok) await this.health.recordOk(ref, 'send');
      else await this.health.recordFailure(ref, 'send', { error, reason });
    } catch (e: any) {
      this.logger.warn(`mailbox health write failed (channel=${config.channelId}): ${e?.message ?? e}`);
    }
  }

  private async record(mail: OutboundMail, receipt: MailReceipt): Promise<void> {
    await this.trace.record({
      workspaceId: mail.workspaceId,
      leadId: mail.leadId ?? null,
      mailClass: mail.mailClass,
      subject: mail.subject,
      source: mail.source,
      receipt,
      proactive: mail.proactive,
      aiAuthored: mail.aiAuthored,
      ticari: mail.ticari,
    });
  }

  private dedupedReceipt(row: MailLogRef): MailReceipt {
    return {
      outcome: 'DEDUPED',
      ok: true,
      mailLogId: row.id,
      messageId: row.messageId,
      transport: (row.transport as MailTransport) ?? 'NONE',
      retriable: false,
    };
  }

  // ── the bulk footer ────────────────────────────────────────────────────────

  /**
   * `omitUnsubscribe` drops ONLY the opt-out line, for a body that already
   * rendered its own. Everything else ships either way.
   */
  private footerText(
    lang: string | null,
    url: string,
    to: string,
    business: string,
    ws: WorkspaceContext | null,
    omitUnsubscribe = false,
  ): string {
    const lines = [
      t(lang, 'footer.whySending', { business }),
      t(lang, 'footer.sentTo', { email: to }),
      omitUnsubscribe ? '' : t(lang, 'footer.unsubscribeText', { url }),
      ...this.identityLines(lang, business, ws).map((l) => l.text),
    ];
    return lines.filter(Boolean).join('\n');
  }

  private footerHtml(
    lang: string | null,
    url: string,
    to: string,
    business: string,
    ws: WorkspaceContext | null,
    omitUnsubscribe = false,
  ): string {
    const parts = [
      tHtml(lang, 'footer.whySending', { business }),
      tHtml(lang, 'footer.sentTo', { email: to }),
      omitUnsubscribe ? '' : `<a href="${escapeHtml(url)}">${tHtml(lang, 'footer.unsubscribe')}</a>`,
      ...this.identityLines(lang, business, ws).map((l) => l.html),
    ];
    return `<hr><div style="font-size:12px;color:#666">${parts.filter(Boolean).join('<br>')}</div>`;
  }

  /**
   * Put the footer INSIDE the document when there is one. A compiled campaign
   * body ends `</body></html>`, and markup appended after the closing tags is
   * at the mercy of whichever client decides to drop it — the one part of the
   * mail that has to survive is the part the law asks for.
   */
  private withHtmlFooter(html: string, footer: string): string {
    return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : `${html}${footer}`;
  }

  /**
   * The 6563 sender-identity block: Turkish law requires commercial mail to
   * name who sent it. It has no external dependency, so it ships with every
   * bulk send whether or not İYS is wired up. What is missing is simply left
   * out — a heading over three empty lines says less than nothing.
   */
  private identityLines(
    lang: string | null,
    business: string,
    ws: WorkspaceContext | null,
  ): { text: string; html: string }[] {
    const cfg = emailIdentity(ws?.settings);
    const rows: [MailCopyKey, string | undefined][] = [
      ['footer.identity.tradeName', cfg.tradeName ?? business ?? undefined],
      ['footer.identity.address', cfg.address],
      ['footer.identity.contact', cfg.contact],
    ];
    return rows
      .filter(([, value]) => !!value)
      .map(([key, value]) => ({
        text: t(lang, key, { value: value as string }),
        html: tHtml(lang, key, { value: value as string }),
      }));
  }
}

/** `settings.email.identity` — absent means the block carries the name alone. */
function emailIdentity(settings: unknown): { tradeName?: string; address?: string; contact?: string } {
  if (!settings || typeof settings !== 'object') return {};
  const email = (settings as Record<string, unknown>).email;
  if (!email || typeof email !== 'object') return {};
  const identity = (email as Record<string, unknown>).identity;
  if (!identity || typeof identity !== 'object') return {};
  const src = identity as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { tradeName: str(src.tradeName), address: str(src.address), contact: str(src.contact) };
}
