import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { MailClass } from './mail-class';
import { MailOutcome, MailReason, MailTransport } from './outbound-mail.types';

/**
 * The outbound mail ledger — one row per mail the gateway was ASKED to send,
 * whatever happened to it.
 *
 * Three things have no other home. A refusal ("this person unsubscribed") today
 * leaves no row at all, so nobody can answer "why did this customer never get
 * the invoice". A mail with no lead — a digest, a host reminder, a team invite,
 * a password reset — cannot be traced through `LeadActivity`, whose `leadId` is
 * NOT NULL. And a bounce report arrives hours later carrying only a Message-ID,
 * which needs a row to point at.
 *
 * Write order is the point of the three methods. `pending()` lands BEFORE the
 * dispatch, never after: a row written afterwards is missing for exactly the
 * mails that mattered — the ones where the process died mid-send — and that is
 * the `pending-row` defect reproduced rather than fixed.
 *
 * Nothing here throws. A ledger that can break a send is worse than a ledger
 * with a gap in it (PLAN G2), so every failure is a `warn` and the caller gets
 * an id-less row back and carries on.
 */

/** Enough of the row to settle it later; `workspaceId` keeps every write scoped. */
export interface MailLogRef {
  id: string;
  workspaceId: string;
  status: string;
  messageId: string | null;
  /** Which transport the row was opened against — a DEDUPED receipt reports
   *  the transport that actually carried the mail, not the one this attempt
   *  would have used. */
  transport?: string;
  /** When the row was last written. OPTIONAL because most refs are built from
   *  a narrower read (or from `orphan()`, which has no row at all); only the
   *  P2002 path asks for it, to tell a send still in flight from a stranded
   *  claim. A ref without it is treated as stranded — see `inFlight()`. */
  updatedAt?: Date;
}

export interface MailLogOpen {
  workspaceId: string;
  mailClass: MailClass;
  source: string;
  /** OPTIONAL, never required and never content-derived. */
  idempotencyKey?: string | null;
  to: string;
  toNorm: string;
  leadId?: string | null;
  fromAddress: string;
  replyTo?: string | null;
  transport: MailTransport;
  channelId?: string | null;
  subject: string;
  messageId?: string | null;
  campaignRecipientId?: string | null;
  workflowRunId?: string | null;
  conversationMessageId?: string | null;
  meta?: Record<string, unknown> | null;
  /**
   * A gate refused before there was anything to dispatch. The row opens and
   * closes in one write — there is no PENDING moment to record, and a campaign
   * that skips three thousand suppressed recipients should not pay for six
   * thousand writes to say so.
   */
  outcome?: MailOutcome;
  reason?: MailReason;
  error?: string;
}

export interface MailLogSettle {
  outcome: MailOutcome;
  reason?: MailReason;
  error?: string;
  messageId?: string | null;
  transport?: MailTransport;
}

/** The provider's own words, kept short enough to sit in a support thread. */
const MAX_ERROR = 300;

/**
 * How long a PENDING row is assumed to belong to a send that is still running.
 *
 * The row opens BEFORE the dispatch and settles after it, so "PENDING" means
 * either "somebody is sending this right now" or "somebody died holding it".
 * The clock is the only thing that tells them apart. It is deliberately not
 * the transport's own socket timeout (15s SMTP / 20s Graph): that covers the
 * round-trip, not the compose, the attachments and the gate around it. Too
 * short re-admits the double send; too long only delays the retry of a row
 * nobody is coming back for.
 *
 * A minute is safe against the retry paths that exist: the job reaper revives
 * a crashed tick after 15 minutes (`STUCK_AFTER_MS`) and the outbox reclaims
 * after 5, so no automatic retry of a genuinely dead send can arrive inside
 * this window and be mistaken for a duplicate.
 */
const IN_FLIGHT_MS = 60_000;

function trim(v: string | null | undefined, max: number): string | null {
  const s = (v ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
}

@Injectable()
export class MailLogService {
  private readonly logger = new Logger(MailLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Has this idempotency key already produced a mail?
   *
   * The cheap pre-check, asked before the identity ladder and the gate run, so
   * an obvious duplicate costs one indexed read instead of a whole pipeline.
   * The race it cannot close is closed by `pending()`.
   */
  async claim(workspaceId: string, idempotencyKey: string): Promise<MailLogRef | null> {
    if (!workspaceId || !idempotencyKey) return null;
    try {
      const row = await this.prisma.mailLog.findFirst({
        where: { workspaceId, idempotencyKey },
        select: { id: true, workspaceId: true, status: true, messageId: true, transport: true },
      });
      return row && this.isDelivered(row.status) ? row : null;
    } catch (e: any) {
      this.logger.warn(`mail-log claim failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Open the row for this send.
   *
   * `deduped` is the answer to the race the pre-check cannot see: two sends
   * carrying the same key reach the insert together, one wins, and the loser
   * reads back what the winner wrote. A losing insert against a row that never
   * got out (a refusal, a transient failure) is a RETRY, not a duplicate — it
   * reuses that row rather than opening a second one the unique key would
   * refuse anyway.
   *
   * The winner's row is PENDING for the whole of its dispatch, so "not
   * delivered yet" is NOT the same question as "may I send it". A PENDING row
   * younger than `IN_FLIGHT_MS` belongs to a send that is still running and is
   * reported as a duplicate; only an older one is the stranded claim a retry
   * is entitled to reuse.
   *
   * The loser therefore answers DEDUPED on a prediction, and the trade is
   * deliberate: the winner owns the row's terminal state, so if the winner
   * fails only the winner's caller retries. A caller that retried the loser
   * too would be the duplicate delivery this branch exists to stop.
   */
  async pending(input: MailLogOpen): Promise<{ deduped: boolean; row: MailLogRef }> {
    const data = this.createData(input);
    try {
      const row = await this.prisma.mailLog.create({
        // `workspaceId` is spelled out at the call site, not only inside
        // `createData`: `workspace-scoping.arch.spec.ts` reads the argument
        // object itself, and a hoisted `data` variable hides the scope from it.
        data: { ...data, workspaceId: input.workspaceId },
        select: { id: true, workspaceId: true, status: true, messageId: true, transport: true },
      });
      return { deduped: false, row };
    } catch (e: any) {
      if (e?.code === 'P2002' && input.idempotencyKey) {
        const existing = await this.claimRow(input.workspaceId, input.idempotencyKey);
        if (existing) {
          if (this.isDelivered(existing.status) || this.inFlight(existing)) {
            return { deduped: true, row: existing };
          }
          await this.reopen(existing, data);
          return { deduped: false, row: { ...existing, status: data.status } };
        }
      }
      this.logger.warn(`mail-log pending failed (workspace=${input.workspaceId}): ${e?.message ?? e}`);
      return { deduped: false, row: this.orphan(input) };
    }
  }

  /** Close the row. Workspace-scoped as well as id-keyed, on purpose. */
  async settle(ref: MailLogRef | { id: string; workspaceId: string }, patch: MailLogSettle): Promise<void> {
    if (!ref?.id || !ref.workspaceId) return;
    try {
      await this.prisma.mailLog.updateMany({
        where: { id: ref.id, workspaceId: ref.workspaceId },
        data: {
          status: patch.outcome,
          reason: patch.reason ?? null,
          error: trim(patch.error, MAX_ERROR),
          ...(patch.transport ? { transport: patch.transport } : {}),
          ...(patch.messageId !== undefined ? { messageId: patch.messageId } : {}),
          ...(patch.outcome === 'SENT' ? { sentAt: new Date() } : {}),
        },
      });
    } catch (e: any) {
      this.logger.warn(`mail-log settle failed (id=${ref.id}): ${e?.message ?? e}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** SENT and DEDUPED both mean "the customer already has this mail". */
  private isDelivered(status: string): boolean {
    return status === 'SENT' || status === 'DEDUPED';
  }

  /**
   * "Another send owns this row and has not finished with it."
   *
   * A ref with no `updatedAt` — an older read shape, an orphan — is reported
   * as NOT in flight, so a missing timestamp degrades to the retry this branch
   * always did rather than to a mail silently dropped.
   */
  private inFlight(row: MailLogRef): boolean {
    if (row.status !== 'PENDING') return false;
    const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : NaN;
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < IN_FLIGHT_MS;
  }

  private createData(input: MailLogOpen): Prisma.MailLogUncheckedCreateInput {
    return {
      workspaceId: input.workspaceId,
      mailClass: input.mailClass,
      source: input.source,
      idempotencyKey: input.idempotencyKey ?? null,
      toAddress: input.to,
      toAddressNorm: input.toNorm,
      leadId: input.leadId ?? null,
      fromAddress: input.fromAddress,
      replyTo: input.replyTo ?? null,
      transport: input.transport,
      channelId: input.channelId ?? null,
      subject: input.subject,
      messageId: input.messageId ?? null,
      status: input.outcome ?? 'PENDING',
      reason: input.reason ?? null,
      error: trim(input.error, MAX_ERROR),
      attempts: 1,
      ...(input.outcome === 'SENT' ? { sentAt: new Date() } : {}),
      campaignRecipientId: input.campaignRecipientId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      conversationMessageId: input.conversationMessageId ?? null,
      meta: (input.meta ?? undefined) as any,
    };
  }

  private async claimRow(workspaceId: string, idempotencyKey: string): Promise<MailLogRef | null> {
    try {
      return await this.prisma.mailLog.findFirst({
        where: { workspaceId, idempotencyKey },
        // `updatedAt` only here: this is the one read that has to date a
        // PENDING row to tell an in-flight send from a stranded claim.
        select: {
          id: true,
          workspaceId: true,
          status: true,
          messageId: true,
          transport: true,
          updatedAt: true,
        },
      });
    } catch {
      return null;
    }
  }

  /** A retry under a key whose earlier attempt never reached anyone. */
  private async reopen(existing: MailLogRef, data: Prisma.MailLogUncheckedCreateInput): Promise<void> {
    try {
      await this.prisma.mailLog.updateMany({
        where: { id: existing.id, workspaceId: existing.workspaceId },
        data: {
          status: data.status,
          reason: data.reason,
          error: data.error,
          transport: data.transport,
          subject: data.subject,
          messageId: data.messageId,
          attempts: { increment: 1 },
        },
      });
    } catch (e: any) {
      this.logger.warn(`mail-log reopen failed (id=${existing.id}): ${e?.message ?? e}`);
    }
  }

  /**
   * The ledger is down and the mail still has to go out.
   *
   * An id-less ref settles into nothing (`settle` returns early), which is a
   * gap in the ledger — and a gap is the right trade against refusing to send
   * a customer's invoice because a bookkeeping table was unavailable.
   */
  private orphan(input: MailLogOpen): MailLogRef {
    return {
      id: '',
      workspaceId: input.workspaceId,
      status: input.outcome ?? 'PENDING',
      messageId: input.messageId ?? null,
      transport: input.transport,
    };
  }
}
