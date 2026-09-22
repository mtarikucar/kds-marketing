import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { hasHeaderInjection, isSingleAddress, normalizeAddress } from '../../../../common/util/email-address';
import { SuppressionService, SuppressionReason } from '../../compliance/suppression.service';
import { MessageQuotaService } from '../message-quota.service';
import { GATE_MATRIX, gateApplies } from './mail-class';
import { MailReason, OutboundMail } from './outbound-mail.types';

/**
 * The ordered gate: the one place that decides whether a mail may leave.
 *
 * Every step is driven by `GATE_MATRIX` (§A1) rather than by who is calling.
 * That is the whole point — each caller used to carry its own half-remembered
 * subset of these rules, so an invoice could be stopped by a marketing opt-out
 * while a drip campaign went out with no unsubscribe link at all.
 *
 * ## The order is a decision, not an accident
 *
 * Cheapest-refusal-first, and **suppression before metering**: a refusal must
 * cost no quota. A campaign that skips three thousand opted-out recipients
 * cannot be allowed to spend three thousand messages from the tenant's plan
 * saying nothing to nobody.
 *
 * ## It returns, it never throws
 *
 * `MessageQuotaService.reserve` throws `MESSAGES_EXHAUSTED`, and
 * `workflow-executor.service.ts` turns a thrown step into a whole-run FAILED.
 * So the throw is caught here and becomes a refusal the caller can read
 * (PLAN G2).
 */

/** What the guard decided. `null` means "nothing stopped this mail". */
export interface GateRefusal {
  reason: MailReason;
  /** A refusal is terminal unless the world is expected to change. */
  retriable: boolean;
  retryAt?: Date | null;
  error?: string;
}

/** The lead the mail is going to, when the caller resolved one. */
export interface LeadDeliverability {
  id: string;
  /** The stored address, which may no longer be the one being mailed. */
  emailNormalized?: string | null;
}

/** The kill-switch state, read once by the gateway and passed in. */
export interface WorkspaceGateState {
  status: string;
  settings?: unknown;
}

export interface GateContextInput {
  mail: OutboundMail;
  lead?: LeadDeliverability | null;
  /** Saves the guard a read when the gateway already loaded it. */
  workspace?: WorkspaceGateState | null;
  /**
   * Ask the gate without spending anything — the pre-launch card runs the same
   * checks the send will run, and a preview that consumed a message from the
   * tenant's plan would be a bug with a bill attached.
   */
  skipMetering?: boolean;
}

/** The cells a suppression row can be refused through, in matrix terms. */
const SUPPRESSION_GATES = ['erasure', 'hardBounce', 'optOut', 'complaint'] as const;

const SUPPRESSION_REASON_CODE: Record<SuppressionReason, MailReason> = {
  ERASURE: 'SUPPRESSED_ERASED',
  HARD_BOUNCE: 'SUPPRESSED_BOUNCE',
  INVALID: 'SUPPRESSED_INVALID',
  COMPLAINT: 'SUPPRESSED_COMPLAINT',
  OPT_OUT: 'SUPPRESSED_OPT_OUT',
  MANUAL: 'SUPPRESSED_OPT_OUT',
};

@Injectable()
export class MailGuardService {
  private readonly logger = new Logger(MailGuardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
    private readonly quota: MessageQuotaService,
  ) {}

  /**
   * Run the gate. A returned refusal has already undone nothing, because
   * nothing that costs anything has been spent when one is produced — the
   * quota reserve is the last step for exactly that reason.
   */
  async check(ctx: GateContextInput): Promise<GateRefusal | null> {
    const { mail } = ctx;
    const gates = GATE_MATRIX[mail.mailClass];
    if (!gates) return { reason: 'NOT_CONFIGURED', retriable: false, error: `unknown mail class ${mail.mailClass}` };

    // 1. One recipient, and one that cannot write a header. Unconditional for
    //    every class — a comma list mails two people under one unsubscribe
    //    token, and a CR/LF turns the recipient field into a header writer.
    const recipient = (mail.to ?? '').trim();
    if (!recipient) return { reason: 'NO_RECIPIENT', retriable: false };
    if (hasHeaderInjection(recipient) || !isSingleAddress(recipient)) {
      return { reason: 'BAD_RECIPIENT', retriable: false };
    }

    // 2. Bulk fails closed without a way off the list. This is the CRITICAL:
    //    a workflow `send_email` is commercial mail to a list by every
    //    definition that matters, and it went out with no opt-out at all.
    if (gateApplies(gates.unsubscribe, {}) && !this.usableUnsubscribe(mail)) {
      return { reason: 'NO_UNSUBSCRIBE', retriable: false };
    }

    // 3. The kill switches. A suspended workspace's OWN mail stops; ours
    //    (AUTH/INTERNAL) never does, or a suspension locks the owner out of the
    //    product they are trying to pay for.
    if (gateApplies(gates.workspaceActive, {}) || gateApplies(gates.sendingPaused, {})) {
      const ws = ctx.workspace !== undefined ? ctx.workspace : await this.loadWorkspace(mail.workspaceId);
      if (ws) {
        if (gateApplies(gates.workspaceActive, {}) && ws.status !== 'ACTIVE') {
          return { reason: 'WORKSPACE_INACTIVE', retriable: false };
        }
        // Default OFF for every existing row: an absent key is today's
        // behaviour, and only an explicit `true` pauses anything (PLAN G3).
        if (gateApplies(gates.sendingPaused, {}) && emailPaused(ws.settings)) {
          return { reason: 'SENDING_PAUSED', retriable: false };
        }
      }
    }

    // 4. Suppression — BEFORE anything that spends. The union read (the
    //    `ContactSuppression` table OR the denormalised Lead flags) lives in
    //    SuppressionService; the class semantics come from the same matrix.
    const suppressed = await this.suppressed(ctx, recipient);
    if (suppressed) {
      return { reason: SUPPRESSION_REASON_CODE[suppressed], retriable: false };
    }

    // 5. İYS `EPOSTA` (BULK + TİCARİ + configured) — `w2-iys-email`.
    // 6. Quiet-hours clamp, refused with a `retryAt` and never dropped —
    //    `w2-mail-policy-guards`.
    // 7. The per-workspace daily platform cap — `w2-mail-budget`.
    //    All three slot in here, in this order, and each one refuses before the
    //    quota below is spent.

    // 8. Metering, last. The campaign sender reserves its own quota before the
    //    recipient loop, so it says so and is not charged twice.
    if (gateApplies(gates.messageQuota, {}) && !mail.alreadyMetered && !ctx.skipMetering) {
      const refusal = await this.reserveQuota(mail.workspaceId);
      if (refusal) return refusal;
    }

    return null;
  }

  /** Give back what a refused-but-already-reserved send took. */
  async refundQuota(mail: OutboundMail): Promise<void> {
    if (!gateApplies(GATE_MATRIX[mail.mailClass]?.messageQuota ?? 'never', {})) return;
    if (mail.alreadyMetered) return;
    try {
      await this.quota.refund(mail.workspaceId, 'EMAIL');
    } catch (e: any) {
      this.logger.warn(`quota refund failed (workspace=${mail.workspaceId}): ${e?.message ?? e}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A link the recipient's client can actually act on.
   *
   * `listUnsubscribeHeaders` silently drops anything that is not absolute
   * http(s) — which would produce a mail that passes the gate and still carries
   * no unsubscribe header. A URL nobody can follow is not an unsubscribe.
   */
  private usableUnsubscribe(mail: OutboundMail): boolean {
    const url = (mail.unsubscribe?.url ?? '').trim();
    return !!mail.unsubscribe?.token && /^https?:\/\//i.test(url);
  }

  private async loadWorkspace(workspaceId: string): Promise<WorkspaceGateState | null> {
    try {
      return await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { status: true, settings: true },
      });
    } catch (e: any) {
      // A kill switch we cannot read is not a reason to stop a tenant's mail;
      // it is a reason to say so and carry on as before.
      this.logger.warn(`workspace gate read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Ask about the address being mailed — and, when the lead's stored address
   * has since been edited, about that one too. The write side already treats
   * the two as the same person (`SuppressionService.suppress` widens its
   * projection by `leadId`); the read side has to agree, or an opt-out
   * disappears the moment a rep corrects a typo.
   */
  private async suppressed(ctx: GateContextInput, recipient: string): Promise<SuppressionReason | null> {
    const { mail } = ctx;
    const gates = GATE_MATRIX[mail.mailClass];
    // INTERNAL is gated by none of them — a digest to our own user is stopped
    // by nothing a tenant's contact list says. Asking anyway would cost two
    // queries per mail to learn that.
    const gated = SUPPRESSION_GATES.some((cell) => gates[cell] !== 'never');
    if (!gated) return null;

    const opts = {
      proactive: mail.proactive,
      conversationId: mail.thread?.conversationId ?? null,
    };
    const first = await this.suppression.check(mail.workspaceId, recipient, mail.mailClass, opts);
    if (first.suppressed && first.reason) return first.reason;

    const stored = normalizeAddress(ctx.lead?.emailNormalized ?? null);
    if (!stored || stored === normalizeAddress(recipient)) return null;
    const second = await this.suppression.check(mail.workspaceId, stored, mail.mailClass, opts);
    return second.suppressed && second.reason ? second.reason : null;
  }

  /**
   * `reserve` throws a Nest `ForbiddenException` at the cap. Caught here and
   * turned into a refusal: a quota-capped mail skips ONE step, it does not
   * abort a whole automation run.
   */
  private async reserveQuota(workspaceId: string): Promise<GateRefusal | null> {
    try {
      await this.quota.reserve(workspaceId, 'EMAIL');
      return null;
    } catch (e: any) {
      const code = e?.response?.code ?? e?.code;
      if (code === 'MESSAGES_EXHAUSTED') {
        return { reason: 'QUOTA_EXHAUSTED', retriable: false, error: e?.response?.message ?? e?.message };
      }
      // Anything else from the meter is infrastructure, not policy: the mail is
      // worth retrying, and the quota was never spent.
      this.logger.warn(`quota reserve failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return { reason: 'TRANSIENT', retriable: true, error: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

/** `settings.email.paused` — absent means "not paused", for every existing row. */
function emailPaused(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const email = (settings as Record<string, unknown>).email;
  if (!email || typeof email !== 'object') return false;
  return (email as Record<string, unknown>).paused === true;
}
