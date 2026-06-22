import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  kind: string;
  payload: any;
  attempts: number;
}

/**
 * A handler may return a reschedule directive to advance a self-rescheduling
 * chain (e.g. a bulk-enroll fan-out) by re-running THIS SAME row at a later
 * time, instead of creating a new child PENDING row. Keeping a chain as exactly
 * one row means it can never collide with itself on the (kind, dedupKey)
 * partial-unique index — which a create-child-then-mark-DONE pattern can, if a
 * crash strands the parent in RUNNING until the reaper revives it.
 */
export interface JobRescheduleDirective {
  reschedule: { runAt: Date; payload?: Prisma.InputJsonValue };
}
export type JobHandlerResult = void | JobRescheduleDirective;
export type JobHandler = (job: ClaimedJob) => Promise<JobHandlerResult>;

const BATCH = 100;
const STUCK_AFTER_MS = 15 * 60 * 1000;

/**
 * Claims due ScheduledJob rows once a minute (single-replica via advisory
 * lock) and routes each to its registered per-kind handler — same claim SQL
 * as OutboxWorker (UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)).
 *
 * Feature modules register handlers in onModuleInit (mirrors the
 * DomainEventBus subscribe pattern). An unknown kind FAILs the job
 * immediately (it's a code regression, not a transient error). Transient
 * failures back off (30s·2^attempts, capped 1h) until maxAttempts → FAILED
 * + a `DLQ:` log line for ops grep. RUNNING rows older than 15 min are
 * reaped back to PENDING (crash recovery).
 */
@Injectable()
export class ScheduledJobRunnerService {
  private readonly logger = new Logger(ScheduledJobRunnerService.name);
  private readonly handlers = new Map<string, JobHandler>();

  constructor(private readonly prisma: PrismaService) {}

  registerHandler(kind: string, fn: JobHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`ScheduledJob handler for kind "${kind}" already registered`);
    }
    this.handlers.set(kind, fn);
  }

  /** Exposed for the tripwire spec: which kinds have a handler. */
  registeredKinds(): string[] {
    return [...this.handlers.keys()];
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'scheduled-job-runner' })
  async tick(): Promise<void> {
    await withAdvisoryLock(this.prisma, 'scheduled-job-runner', async () => {
      // Each phase is isolated. The reaper MUST NOT be able to block dispatch:
      // it runs first, and a single thrown error here (e.g. a unique-violation)
      // would otherwise starve every kind/tenant for the whole runner. Likewise a
      // single job's bookkeeping failure must not abort the rest of the batch.
      try {
        await this.reapStuck();
      } catch (e: any) {
        this.logger.error(`scheduled-job reapStuck failed: ${e?.message ?? e}`);
      }
      let claimed: ClaimedJob[];
      try {
        claimed = await this.claimBatch();
      } catch (e: any) {
        this.logger.error(`scheduled-job claimBatch failed: ${e?.message ?? e}`);
        return;
      }
      for (const job of claimed) {
        try {
          await this.run(job);
        } catch (e: any) {
          this.logger.error(`scheduled-job dispatch ${job.id} crashed: ${e?.message ?? e}`);
        }
      }
    }, this.logger);
  }

  /**
   * Crash recovery: revive RUNNING rows whose lock has gone stale, while
   * guaranteeing the post-condition "at most one PENDING row per (kind,
   * dedupKey)" so REVIVE can never violate the partial-unique index. Three
   * passes, atomic:
   *   1. RETIRE stuck rows whose dedup chain already advanced (a PENDING
   *      successor exists) — their work is carried by that successor.
   *   2. RETIRE all-but-the-newest stuck row in a no-successor dedup group —
   *      a chain can transiently strand >1 RUNNING row of the same key (legacy
   *      create-child handlers), and reviving both would duplicate the key.
   *   3. REVIVE the survivors: unconstrained (null-dedupKey) rows and the single
   *      remaining stuck row per no-successor dedup group.
   * The NOT EXISTS re-checks make each pass safe against a PENDING created
   * concurrently by a request-path schedule().
   */
  private async reapStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE "scheduled_jobs" s
           SET "status" = 'DONE', "completedAt" = now(), "lockedAt" = null
         WHERE s."status" = 'RUNNING' AND s."lockedAt" < ${cutoff}
           AND s."dedupKey" IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM "scheduled_jobs" p
              WHERE p."status" = 'PENDING' AND p."kind" = s."kind" AND p."dedupKey" = s."dedupKey"
           );
      `,
      this.prisma.$executeRaw`
        UPDATE "scheduled_jobs" s
           SET "status" = 'DONE', "completedAt" = now(), "lockedAt" = null
         WHERE s."status" = 'RUNNING' AND s."lockedAt" < ${cutoff}
           AND s."dedupKey" IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM "scheduled_jobs" p
              WHERE p."status" = 'PENDING' AND p."kind" = s."kind" AND p."dedupKey" = s."dedupKey"
           )
           AND s."id" <> (
             SELECT x."id" FROM "scheduled_jobs" x
              WHERE x."status" = 'RUNNING' AND x."lockedAt" < ${cutoff}
                AND x."kind" = s."kind" AND x."dedupKey" = s."dedupKey"
              ORDER BY x."lockedAt" DESC, x."id" DESC
              LIMIT 1
           );
      `,
      this.prisma.$executeRaw`
        UPDATE "scheduled_jobs" s
           SET "status" = 'PENDING', "lockedAt" = null
         WHERE s."status" = 'RUNNING' AND s."lockedAt" < ${cutoff}
           AND (
             s."dedupKey" IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM "scheduled_jobs" p
                WHERE p."status" = 'PENDING' AND p."kind" = s."kind" AND p."dedupKey" = s."dedupKey"
             )
           );
      `,
    ]);
  }

  private async claimBatch(): Promise<ClaimedJob[]> {
    const now = new Date();
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; workspaceId: string; kind: string; payload: any; attempts: number }>
    >`
      UPDATE "scheduled_jobs"
         SET "status" = 'RUNNING', "lockedAt" = ${now}
       WHERE "id" IN (
         SELECT "id" FROM "scheduled_jobs"
          WHERE "status" = 'PENDING' AND "runAt" <= ${now}
          ORDER BY "runAt"
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH}
       )
       RETURNING "id", "workspaceId", "kind", "payload", "attempts";
    `;
    return rows;
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          lastError: `no handler registered for kind "${job.kind}"`,
          completedAt: new Date(),
        },
      });
      this.logger.error(`scheduled-job DLQ: ${job.id} kind=${job.kind} — no handler`);
      return;
    }
    try {
      const result = await handler(job);
      if (result && typeof result === 'object' && 'reschedule' in result && result.reschedule) {
        // Self-rescheduling chain: advance THIS row in place rather than creating
        // a child PENDING, so the chain is always exactly one row. attempts resets
        // (a successful continuation, not a retry).
        const r = result.reschedule;
        await this.prisma.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            runAt: r.runAt,
            ...(r.payload !== undefined ? { payload: r.payload } : {}),
            lockedAt: null,
            attempts: 0,
            lastError: null,
          },
        });
        return;
      }
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: { status: 'DONE', completedAt: new Date(), lastError: null },
      });
    } catch (e: any) {
      const attempts = job.attempts + 1;
      const fresh = await this.prisma.scheduledJob.findUnique({
        where: { id: job.id },
        select: { maxAttempts: true },
      });
      const maxAttempts = fresh?.maxAttempts ?? 5;
      const msg = (e?.message ?? String(e)).slice(0, 500);
      if (attempts >= maxAttempts) {
        await this.prisma.scheduledJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', attempts, lastError: msg, completedAt: new Date() },
        });
        this.logger.error(`scheduled-job DLQ: ${job.id} kind=${job.kind} attempts=${attempts}: ${msg}`);
      } else {
        const backoffMs = Math.min(30_000 * 2 ** attempts, 60 * 60 * 1000);
        await this.prisma.scheduledJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            attempts,
            lastError: msg,
            runAt: new Date(Date.now() + backoffMs),
            lockedAt: null,
          },
        });
        this.logger.warn(`scheduled-job retry ${job.id} kind=${job.kind} attempt=${attempts}: ${msg}`);
      }
    }
  }
}
