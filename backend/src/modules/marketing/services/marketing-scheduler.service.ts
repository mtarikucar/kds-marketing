import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
// v2.8.95 — every cron in this file mutates shared rows or creates
// new ones. Without per-replica coordination the followup-reminder
// loop in particular fires the duplicate-check + create pair on
// every replica, producing one notification per replica per lead.
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { MarketingLeadsService } from './marketing-leads.service';
import { GoogleCalendarSyncService } from '../integrations/google-calendar-sync.service';
import { OutlookCalendarSyncService } from '../integrations/outlook-calendar-sync.service';

/**
 * Background jobs that keep marketing data tidy:
 *
 *   - Cron #1 (offer-expire): every 30 minutes, flip SENT offers
 *     whose `validUntil` is past to EXPIRED. Without this the
 *     accept-button stays live on stale offers indefinitely.
 *
 *   - Cron #2 (notification-cleanup): once a day, drop
 *     MarketingNotification rows older than 30 days. The table has
 *     no TTL otherwise and grows without bound.
 *
 *   - Cron #3 (follow-up-reminder): once a day at 09:00 local,
 *     surface `nextFollowUp` dates in the next 24h as
 *     FOLLOW_UP_REMINDER notifications on the lead's owner. Quietly
 *     skipped for converted/lost leads.
 *
 * All jobs are safe to re-run — they use `updateMany` with status
 * filters that are idempotent after the first run.
 *
 * Two of them DESTROY data rather than tidy it: `purgeExpiredData` (the
 * time-based KVKK retention sweep) and `scrubErasedCalendarCopies` (which
 * carries a fulfilled erasure onto the mirrored Google / Outlook events).
 * Both do nothing at all until someone asks for it — the first needs a
 * per-workspace retention period, the second a fulfilled erasure request.
 *
 * Multi-tenancy: crons have no user context, so each one fans out over
 * ACTIVE workspaces and runs its queries scoped per workspace; rows are
 * never touched across workspaces in a single statement, and any
 * notification created inside carries the workspace id of the row that
 * triggered it.
 */
const NOTIFICATION_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

/** The same literal ComplianceService stamps on an erased lead / booking. */
const ERASED_MARKER = '[Silinmiş]';

/**
 * How far back the calendar sweep looks for erasures it has to mirror. The
 * sweep is daily, so every erasure gets one pass plus one retry — enough to
 * survive a provider outage or a token that was being re-authorised when the
 * erasure ran, without re-patching the same event for weeks (each patch bumps
 * the event's `updated` stamp, which our own delta pull then has to read).
 */
const ERASURE_CALENDAR_LOOKBACK_DAYS = 2;

/** WorkflowRun states whose `cursor`/`context` are finished, not live. */
const TERMINAL_WORKFLOW_STATES = ['DONE', 'FAILED', 'STOPPED'];
/** EmailInboundItem states nobody will act on again (NEW/FAILED are retryable,
 *  QUARANTINED is what the channel card's "Tekrar dene" button acts on). */
const TERMINAL_INBOUND_STATES = ['DONE', 'SKIPPED'];
/** One pass deletes at most this many workflow runs, so a workspace with years
 *  of history can't hold the advisory lock for a whole tick. The next night
 *  takes the next slice. */
const RETENTION_RUN_BATCH = 500;

type RetentionKey =
  | 'triggerClickDays'
  | 'toolCallDays'
  | 'workflowRunDays'
  | 'mailLogDays'
  | 'inboundItemDays'
  | 'messageBodyDays'
  | 'webhookEventDays';

/**
 * The shortest period each category accepts. A floor is not paternalism: an
 * operator typing `1` into a settings field would otherwise delete the mail
 * ledger a bounce report is still arriving for, or the inbound rows the IMAP
 * poller's 24h re-scan window relies on. Below the floor the knob is ignored
 * and the category keeps everything — the same answer as "unset".
 */
const RETENTION_FLOOR_DAYS: Record<RetentionKey, number> = {
  triggerClickDays: 30,
  toolCallDays: 7,
  workflowRunDays: 7,
  // A DSN or a complaint can arrive days after the send, and the ops snapshot
  // reads MailLog for its default range.
  mailLogDays: 30,
  // Comfortably above email-imap-poll's FIRST_RUN_LOOKBACK_MS re-scan.
  inboundItemDays: 30,
  messageBodyDays: 30,
  // The archived provider push IS the replay protection for a redelivery.
  webhookEventDays: 30,
};

type RetentionPolicy = Partial<Record<RetentionKey, number>>;

export interface RetentionOutcome {
  dryRun: boolean;
  /** Workspaces that actually had a policy — not workspaces scanned. */
  workspaces: number;
  triggerClicksAnonymised: number;
  toolCallLogsDeleted: number;
  workflowRunsDeleted: number;
  mailLogsDeleted: number;
  inboundItemsDeleted: number;
  messageBodiesScrubbed: number;
  webhookEventsDeleted: number;
}

/**
 * Read `settings.retention` off a Workspace.settings jsonb blob.
 *
 * ABSENT means keep everything, which is what every existing row says and
 * therefore what every existing tenant keeps doing (G3). A value that is not a
 * positive integer at or above its floor is treated as absent rather than
 * clamped: silently destroying more than the operator asked for is the one
 * mistake this job must never make.
 */
function parseRetentionPolicy(settings: unknown): RetentionPolicy | null {
  if (!settings || typeof settings !== 'object') return null;
  const raw = (settings as Record<string, unknown>).retention;
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const policy: RetentionPolicy = {};
  for (const key of Object.keys(RETENTION_FLOOR_DAYS) as RetentionKey[]) {
    const value = src[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const days = Math.floor(value);
    if (days < RETENTION_FLOOR_DAYS[key]) continue;
    policy[key] = days;
  }
  return Object.keys(policy).length ? policy : null;
}

@Injectable()
export class MarketingSchedulerService {
  private readonly logger = new Logger(MarketingSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: MarketingLeadsService,
    private readonly googleSync: GoogleCalendarSyncService,
    private readonly outlookSync: OutlookCalendarSyncService,
  ) {}

  // Step D saga safety net: finalize conversions that provisioned a tenant
  // (via the core port) but failed to commit their marketing-side state and
  // were never retried. Advisory-locked so only one replica sweeps.
  @Cron(CronExpression.EVERY_HOUR, { name: 'marketing-orphan-reconcile' })
  async reconcileOrphanConversions(): Promise<{ reconciled: number }> {
    let outcome = { reconciled: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-orphan-reconcile',
      async () => {
        outcome = await this.leads.reconcileOrphanProvisionedConversions();
        if (outcome.reconciled > 0) {
          this.logger.warn(
            `orphan-reconcile: finalized ${outcome.reconciled} provisioned conversion(s)`,
          );
        }
      },
      this.logger,
    );
    return outcome;
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'marketing-offer-expire' })
  async expireOffers(): Promise<{ expired: number }> {
    let outcome = { expired: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-offer-expire',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        const now = new Date();
        let expired = 0;
        for (const ws of workspaces) {
          const result = await this.prisma.leadOffer.updateMany({
            where: {
              workspaceId: ws.id,
              status: 'SENT',
              validUntil: { lt: now, not: null },
            },
            data: { status: 'EXPIRED' },
          });
          expired += result.count;
        }
        if (expired > 0) {
          this.logger.log(`offer-expire: marked ${expired} offer(s) EXPIRED`);
        }
        outcome = { expired };
      },
      this.logger,
    );
    return outcome;
  }

  /**
   * Retire approval requests whose window has closed.
   *
   * PENDING -> EXPIRED happened in exactly one place: inside decide(), when a
   * human clicked approve or reject on a card that had already lapsed. So an
   * expired request NOBODY touched stayed PENDING for good — the approval
   * queue offered it as actionable, the morning brief counted it in
   * "N onay bekliyor" every day, and clicking it only ever answered
   * "request has expired".
   *
   * A count that can never reach zero is worse than no count: it is the line
   * that teaches the owner to skip the section, and the section it sits in is
   * the one carrying "a customer is waiting for a reply".
   *
   * Hourly rather than daily. A stale card is misleading from the moment it
   * lapses, and the MCP lane's TTL is 24h, so a daily sweep would leave a full
   * day of them. Guarded on status PENDING, so a decision made in the same
   * tick is never clobbered — the same condition decide() writes under.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'marketing-approval-expiry' })
  async expireStaleApprovals(): Promise<{ expired: number }> {
    let outcome = { expired: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-approval-expiry',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        let expired = 0;
        for (const ws of workspaces) {
          const res = await this.prisma.approvalRequest.updateMany({
            where: { workspaceId: ws.id, status: 'PENDING', expiresAt: { lt: new Date() } },
            data: { status: 'EXPIRED' },
          });
          expired += res.count;
        }
        if (expired > 0) {
          this.logger.log(`approval-expiry: retired ${expired} lapsed request(s)`);
        }
        outcome = { expired };
      },
      this.logger,
    );
    return outcome;
  }

  /**
   * Delete OAuth hand-offs nobody came back for.
   *
   * A PendingSocialConnection holds a SEALED provider access token between the
   * OAuth callback and the moment the user picks which assets to connect. The
   * happy path deletes it, and each read rejects-and-deletes an expired row —
   * but a flow the user abandons (closes the tab after the callback) is never
   * read again, so nothing ever removed it. The row, and the token inside it,
   * stayed for good.
   *
   * The delete is deliberately NOT scoped per workspace. Every other sweep in
   * this file loops over ACTIVE workspaces, which is right for their data — but
   * a secret left behind by a suspended or deleted workspace is exactly the one
   * that should not be kept, and a per-workspace loop would skip it. `expiresAt`
   * is the whole predicate: the row is already useless to every caller.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'marketing-pending-connection-sweep' })
  async sweepExpiredPendingConnections(): Promise<{ deleted: number }> {
    let outcome = { deleted: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-pending-connection-sweep',
      async () => {
        const result = await this.prisma.pendingSocialConnection.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        if (result.count > 0) {
          this.logger.log(
            `pending-connection-sweep: deleted ${result.count} abandoned OAuth hand-off(s)`,
          );
        }
        outcome = { deleted: result.count };
      },
      this.logger,
    );
    return outcome;
  }

  /**
   * Calls abandoned in INITIATED.
   *
   * SalesCallService already auto-cancels a stale INITIATED row — but only
   * inside `dial()`, as a side effect of someone placing the NEXT call. If
   * nobody dials again, nothing ever runs, and the row simply stays. On the live
   * workspace one call has been sitting in INITIATED since 15 August: not
   * because the cleanup is wrong, but because the only thing that triggers it
   * never happened again.
   *
   * A row like that is a lie to every reader — the call list, the activity feed
   * and any report that treats INITIATED as "in progress".
   *
   * The cutoff here is SIX HOURS, deliberately far longer than dial()'s 30
   * minutes. That path runs while a rep is actively dialling, so it can afford
   * a tight window; this one runs unattended against every workspace, where the
   * only real risk is cancelling something still live or racing a CDR that is
   * still on its way. Six hours makes both impossible in practice, and an
   * abandoned row costs nothing by surviving a few extra hours.
   *
   * Scoped per ACTIVE workspace like the other sweeps in this file, rather
   * than run globally: a suspended workspace's abandoned call row harms
   * nobody, so there is no reason to widen the workspace-scoping exemption
   * for it.
   *
   * `status: 'INITIATED'` in the where is REQUIRED, not decorative: it is what
   * stops this write from regressing a row the CDR reconciler has already
   * moved to CONNECTED, which would lose that call's duration and recording
   * permanently. Same guard the dial path uses, for the same reason.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'marketing-stale-call-sweep' })
  async cancelAbandonedCalls(): Promise<{ cancelled: number }> {
    let outcome = { cancelled: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-stale-call-sweep',
      async () => {
        const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        let cancelled = 0;
        for (const ws of workspaces) {
          const result = await this.prisma.salesCall.updateMany({
            where: { workspaceId: ws.id, status: 'INITIATED', startedAt: { lt: cutoff } },
            data: {
              status: 'CANCELLED',
              endedAt: new Date(),
              notes: 'Auto-cancelled (stale — never logged)',
            },
          });
          cancelled += result.count;
        }
        if (cancelled > 0) {
          this.logger.log(`stale-call-sweep: cancelled ${cancelled} abandoned call(s)`);
        }
        outcome = { cancelled };
      },
      this.logger,
    );
    return outcome;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'marketing-notification-cleanup' })
  async cleanupOldNotifications(): Promise<{ deleted: number }> {
    let outcome = { deleted: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-notification-cleanup',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - NOTIFICATION_TTL_DAYS);
        let deleted = 0;
        for (const ws of workspaces) {
          const result = await this.prisma.marketingNotification.deleteMany({
            where: { workspaceId: ws.id, createdAt: { lt: cutoff } },
          });
          deleted += result.count;
        }
        if (deleted > 0) {
          this.logger.log(
            `notification-cleanup: deleted ${deleted} notification(s) older than ${NOTIFICATION_TTL_DAYS}d`,
          );
        }
        outcome = { deleted };
      },
      this.logger,
    );
    return outcome;
  }

  /**
   * The PERIODIC destruction job (`no-retention`).
   *
   * Per-subject erasure already works (ComplianceService) and call recordings
   * already age out; what did not exist anywhere in the backend was a
   * TIME-based sweep. Only marketing notifications, dispatched outbox rows,
   * unattached media and (opt-in) recordings ever aged out, so email bodies,
   * the inbound ledger, tracked clicks, AI tool logs and finished workflow
   * contexts were kept forever against a privacy notice that promises
   * destruction.
   *
   * Two categories are deliberately NOT deleted, because the naive purge
   * breaks a reader the finding's author would never see fail:
   *
   *  - `CampaignRecipient` is excluded outright. `recomputeStats` derives
   *    sent/failed/opened/clicked FROM those rows and is re-triggered long
   *    after a send (a late open pixel, a DLR poll, a resumed batch), so
   *    purging them silently zeroes a historic campaign report. Freezing
   *    stats first would need a `Campaign.statsFrozenAt` column.
   *  - `Message` is SCRUBBED in place, never deleted. Its `externalMessageId`
   *    is the IMAP poller's dedupe token ("the UID cursor is a mere
   *    optimisation"), so deleting the row makes the same mail re-ingest as a
   *    duplicate inbox item on the next re-scan — and keeping the row also
   *    keeps the conversation readable, which is what ComplianceService does
   *    for the same class of reason.
   *
   * Tracked clicks are anonymised rather than deleted for the same shape of
   * reason: the click COUNT is a number the tenant reads off the trigger-link
   * page, while the `ip`/`userAgent`/`leadId` are the personal data. Dropping
   * those three turns the row into a pure tally.
   *
   * `dryRun` answers "what would this delete" without writing — the only
   * honest way for an operator to choose a period.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'marketing-retention-purge' })
  async purgeExpiredData(
    opts: { dryRun?: boolean } = {},
  ): Promise<RetentionOutcome> {
    const dryRun = opts.dryRun === true;
    const outcome: RetentionOutcome = {
      dryRun,
      workspaces: 0,
      triggerClicksAnonymised: 0,
      toolCallLogsDeleted: 0,
      workflowRunsDeleted: 0,
      mailLogsDeleted: 0,
      inboundItemsDeleted: 0,
      messageBodiesScrubbed: 0,
      webhookEventsDeleted: 0,
    };
    await withAdvisoryLock(
      this.prisma,
      'marketing-retention-purge',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, settings: true },
        });
        for (const ws of workspaces) {
          const policy = parseRetentionPolicy(ws.settings);
          // No period chosen ⇒ nothing ages out, exactly as before.
          if (!policy) continue;
          outcome.workspaces += 1;
          try {
            await this.purgeWorkspaceData(ws.id, policy, dryRun, outcome);
          } catch (e) {
            // One tenant's deadlocked delete must not cancel everyone else's
            // destruction obligation; the next night retries this workspace.
            this.logger.warn(
              `retention-purge: ws=${ws.id} failed: ${(e as Error).message}`,
            );
          }
        }
        const touched =
          outcome.triggerClicksAnonymised +
          outcome.toolCallLogsDeleted +
          outcome.workflowRunsDeleted +
          outcome.mailLogsDeleted +
          outcome.inboundItemsDeleted +
          outcome.messageBodiesScrubbed +
          outcome.webhookEventsDeleted;
        if (touched > 0) {
          this.logger.log(
            `retention-purge${dryRun ? ' (dry run)' : ''}: ${touched} row(s) across ${outcome.workspaces} workspace(s)`,
          );
        }
      },
      this.logger,
    );
    return outcome;
  }

  /** One workspace's slice of the retention sweep. Every write below is
   *  scoped by `workspaceId` AND by that category's own cutoff. */
  private async purgeWorkspaceData(
    workspaceId: string,
    policy: RetentionPolicy,
    dryRun: boolean,
    outcome: RetentionOutcome,
  ): Promise<void> {
    // Each block spreads its filter into a where that names `workspaceId` at
    // the call site — the scope has to be readable where the write happens,
    // which is also what the workspace-scoping fitness spec checks.
    if (policy.triggerClickDays) {
      const stale = {
        clickedAt: { lt: daysAgo(policy.triggerClickDays) },
        // Skip rows already anonymised, so a long tail isn't rewritten nightly.
        OR: [
          { ip: { not: null } },
          { userAgent: { not: null } },
          { leadId: { not: null } },
        ],
      };
      outcome.triggerClicksAnonymised += dryRun
        ? await this.prisma.triggerLinkClick.count({ where: { workspaceId, ...stale } })
        : (
            await this.prisma.triggerLinkClick.updateMany({
              where: { workspaceId, ...stale },
              data: { ip: null, userAgent: null, leadId: null },
            })
          ).count;
    }

    if (policy.toolCallDays) {
      // args/result carry whatever the agent was handed about a person; the
      // AgentRun they hang off keeps the audit of WHICH tool ran.
      const stale = { createdAt: { lt: daysAgo(policy.toolCallDays) } };
      outcome.toolCallLogsDeleted += dryRun
        ? await this.prisma.toolCallLog.count({ where: { workspaceId, ...stale } })
        : (await this.prisma.toolCallLog.deleteMany({ where: { workspaceId, ...stale } })).count;
    }

    if (policy.workflowRunDays) {
      const runs = await this.prisma.workflowRun.findMany({
        where: {
          workspaceId,
          status: { in: TERMINAL_WORKFLOW_STATES },
          updatedAt: { lt: daysAgo(policy.workflowRunDays) },
        },
        select: { id: true },
        take: RETENTION_RUN_BATCH,
      });
      // `take` caps the pass, so a dry run over a long backlog reports one
      // night's slice rather than the whole tail.
      const runIds = runs.map((r) => r.id);
      if (runIds.length && !dryRun) {
        // WorkflowStepRun has no FK to its run, so the children go first or
        // they are orphaned rows nothing can ever reach again.
        await this.prisma.workflowStepRun.deleteMany({
          where: { workspaceId, runId: { in: runIds } },
        });
        outcome.workflowRunsDeleted += (
          await this.prisma.workflowRun.deleteMany({
            where: { workspaceId, id: { in: runIds } },
          })
        ).count;
      } else {
        outcome.workflowRunsDeleted += runIds.length;
      }
    }

    if (policy.mailLogDays) {
      const stale = { createdAt: { lt: daysAgo(policy.mailLogDays) } };
      outcome.mailLogsDeleted += dryRun
        ? await this.prisma.mailLog.count({ where: { workspaceId, ...stale } })
        : (await this.prisma.mailLog.deleteMany({ where: { workspaceId, ...stale } })).count;
    }

    if (policy.inboundItemDays) {
      const stale = {
        state: { in: TERMINAL_INBOUND_STATES },
        createdAt: { lt: daysAgo(policy.inboundItemDays) },
      };
      outcome.inboundItemsDeleted += dryRun
        ? await this.prisma.emailInboundItem.count({ where: { workspaceId, ...stale } })
        : (
            await this.prisma.emailInboundItem.deleteMany({
              where: { workspaceId, ...stale },
            })
          ).count;
    }

    if (policy.messageBodyDays) {
      const stale = {
        createdAt: { lt: daysAgo(policy.messageBodyDays) },
        body: { not: ERASED_MARKER },
      };
      outcome.messageBodiesScrubbed += dryRun
        ? await this.prisma.message.count({ where: { workspaceId, ...stale } })
        : (
            await this.prisma.message.updateMany({
              where: { workspaceId, ...stale },
              data: { body: ERASED_MARKER },
            })
          ).count;
    }

    if (policy.webhookEventDays) {
      // The raw provider push (an SMS DLR, an Iys consent element, a call
      // event) is archived verbatim, so it holds phone numbers and call
      // metadata long after anything reads it. Only a PROCESSED row goes: an
      // unprocessed one is still work in hand, and deleting it would also drop
      // the (workspace, purpose, externalId) key that makes a redelivery a
      // no-op instead of a second run.
      const stale = {
        processedAt: { not: null },
        receivedAt: { lt: daysAgo(policy.webhookEventDays) },
      };
      outcome.webhookEventsDeleted += dryRun
        ? await this.prisma.netgsmWebhookEvent.count({ where: { workspaceId, ...stale } })
        : (
            await this.prisma.netgsmWebhookEvent.deleteMany({
              where: { workspaceId, ...stale },
            })
          ).count;
    }
  }

  /**
   * Carry a fulfilled erasure onto the mirrored Google / Outlook events
   * (`erasure-calendar`).
   *
   * `fulfillErasure` scrubs the Booking row inside one transaction and emits
   * nothing, and both sync services subscribe to BookingCreated /
   * BookingCancelled only — so the host's calendar kept the erased person's
   * name, notes and address, which is the copy their colleagues actually look
   * at every morning.
   *
   * The sweep reads what the erasure already wrote (the marker on the lead
   * plus `deletedAt`) instead of needing a new event type, which also makes it
   * self-healing: a workspace whose Google token was being re-authorised when
   * the erasure ran is scrubbed on the next pass. The providers' own
   * `scrubBooking` decides how — explicit clearing values, no attendee
   * notification, patch rather than delete.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'marketing-erasure-calendar-scrub' })
  async scrubErasedCalendarCopies(): Promise<{ scanned: number; scrubbed: number }> {
    const outcome = { scanned: 0, scrubbed: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-erasure-calendar-scrub',
      async () => {
        const cutoff = daysAgo(ERASURE_CALENDAR_LOOKBACK_DAYS);
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        for (const ws of workspaces) {
          // The marker is what distinguishes an ERASED lead from one that was
          // merely soft-deleted or merged away — those keep their PII on
          // purpose and must not have their appointments rewritten.
          const erased = await this.prisma.lead.findMany({
            where: {
              workspaceId: ws.id,
              contactPerson: ERASED_MARKER,
              deletedAt: { gte: cutoff },
            },
            select: { id: true },
          });
          if (!erased.length) continue;

          const bookings = await this.prisma.booking.findMany({
            where: {
              workspaceId: ws.id,
              leadId: { in: erased.map((l) => l.id) },
              // A pulled busy-block is somebody else's event; we never write it.
              status: { not: 'EXTERNAL_BUSY' },
              OR: [
                { googleEventId: { not: null } },
                { outlookEventId: { not: null } },
              ],
            },
            select: { id: true, googleEventId: true, outlookEventId: true },
          });

          for (const booking of bookings) {
            outcome.scanned += 1;
            if (booking.googleEventId) {
              if (await this.scrubOne(() => this.googleSync.scrubBooking(ws.id, booking.id))) {
                outcome.scrubbed += 1;
              }
            }
            if (booking.outlookEventId) {
              if (await this.scrubOne(() => this.outlookSync.scrubBooking(ws.id, booking.id))) {
                outcome.scrubbed += 1;
              }
            }
          }
        }
        if (outcome.scrubbed > 0) {
          this.logger.log(
            `erasure-calendar-scrub: cleared ${outcome.scrubbed} mirrored event(s)`,
          );
        }
      },
      this.logger,
    );
    return outcome;
  }

  /** One provider call, isolated: a revoked token on one mailbox must not stop
   *  the sweep reaching the next person's appointments. */
  private async scrubOne(call: () => Promise<boolean>): Promise<boolean> {
    try {
      return await call();
    } catch (e) {
      this.logger.warn(`erasure-calendar-scrub: ${(e as Error).message}`);
      return false;
    }
  }

  @Cron('0 9 * * *', { name: 'marketing-followup-reminder' })
  async fireFollowUpReminders(): Promise<{ reminded: number }> {
    let outcome = { reminded: 0 };
    await withAdvisoryLock(
      this.prisma,
      'marketing-followup-reminder',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        let reminded = 0;
        for (const ws of workspaces) {
          const wsOutcome = await this.fireFollowUpRemindersInner(ws.id);
          reminded += wsOutcome.reminded;
        }
        outcome = { reminded };
      },
      this.logger,
    );
    return outcome;
  }

  private async fireFollowUpRemindersInner(
    workspaceId: string,
  ): Promise<{ reminded: number }> {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);

    const dueLeads = await this.prisma.lead.findMany({
      where: {
        workspaceId,
        // A bulk-deleted (deletedAt) or merged-away (mergedIntoId) lead keeps its
        // nextFollowUp/status/assignedToId, so without this it would fire a
        // FOLLOW_UP_REMINDER for a lead that's gone from the rep's list (a phantom
        // reminder linking to a deleted/merged tombstone). Match the dedup/count/
        // deferred-action reads that already exclude hidden leads.
        mergedIntoId: null,
        deletedAt: null,
        nextFollowUp: { gte: now, lte: tomorrow },
        status: { notIn: ['WON', 'LOST'] },
        assignedToId: { not: null },
      },
      select: {
        id: true,
        businessName: true,
        contactPerson: true,
        assignedToId: true,
        nextFollowUp: true,
      },
    });

    let reminded = 0;
    for (const lead of dueLeads) {
      if (!lead.assignedToId) continue;
      // Idempotency: don't duplicate today's reminder for the same
      // lead. The check is cheap and the table has an index on
      // (userId, isRead).
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dup = await this.prisma.marketingNotification.findFirst({
        where: {
          workspaceId,
          userId: lead.assignedToId,
          type: 'FOLLOW_UP_REMINDER',
          createdAt: { gte: today },
          // metadata is JSON; Prisma supports `path` equality for the leadId field.
          metadata: { path: ['leadId'], equals: lead.id } as any,
        },
        select: { id: true },
      });
      if (dup) continue;

      await this.prisma.marketingNotification.create({
        data: {
          // The triggering lead was resolved via the workspace-scoped
          // findMany above, so this is the lead's own workspace.
          workspaceId,
          userId: lead.assignedToId,
          type: 'FOLLOW_UP_REMINDER',
          title: 'Follow-up due',
          message: `${lead.businessName} — ${lead.contactPerson}`,
          metadata: { leadId: lead.id, dueAt: lead.nextFollowUp?.toISOString() },
        },
      });
      reminded += 1;
    }

    if (reminded > 0) {
      this.logger.log(`followup-reminder: fired ${reminded} reminder(s)`);
    }
    return { reminded };
  }
}
