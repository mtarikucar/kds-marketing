import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  kind: string;
  payload: any;
  attempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

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
      await this.reapStuck();
      const claimed = await this.claimBatch();
      for (const job of claimed) {
        await this.run(job);
      }
    }, this.logger);
  }

  private async reapStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    await this.prisma.scheduledJob.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
      data: { status: 'PENDING', lockedAt: null },
    });
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
      await handler(job);
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
