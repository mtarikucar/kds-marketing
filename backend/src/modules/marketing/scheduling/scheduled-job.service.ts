import { SchedulerRegistry } from '@nestjs/schedule';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ScheduleOpts {
  workspaceId: string;
  kind: string;
  runAt: Date;
  payload: Prisma.InputJsonValue;
  /** When set, rescheduling collapses onto the existing PENDING row. */
  dedupKey?: string;
  maxAttempts?: number;
}

type Tx = Prisma.TransactionClient | PrismaService;

/**
 * Enqueue/cancel side of the delayed-work primitive. The runner
 * (scheduled-job-runner.service) claims + dispatches. See the model comment
 * for why this is separate from OutboxEvent.
 */
@Injectable()
export class ScheduledJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  /**
   * Schedule a job. With a dedupKey, an existing PENDING job of the same
   * (kind, dedupKey) is updated in place (runAt/payload) rather than
   * duplicated — so "reschedule the follow-up" is one row, not a pile-up.
   * The partial-unique index is the backstop against a concurrent racer.
   */
  async schedule(opts: ScheduleOpts, tx: Tx = this.prisma): Promise<string> {
    const db = tx as PrismaService;
    if (opts.dedupKey) {
      const existing = await db.scheduledJob.findFirst({
        where: { kind: opts.kind, dedupKey: opts.dedupKey, status: 'PENDING' },
        select: { id: true },
      });
      if (existing) {
        // ATOMIC conditional reschedule: the runner can claim this row
        // (PENDING→RUNNING) between the findFirst and this write. An
        // unconditional update would then rewrite runAt/payload on a row that
        // is ALREADY EXECUTING with the old payload (or is DONE) and report
        // success — the reschedule silently lost (a campaign the user moved
        // to next week still launches now, and nothing exists for the new
        // time). Guard on status and, when the claim won the race, fall
        // through to CREATE a fresh PENDING row instead (the P2002 catch
        // below still collapses a concurrent-create race).
        const claimed = await db.scheduledJob.updateMany({
          where: { id: existing.id, status: 'PENDING' },
          data: {
            runAt: opts.runAt,
            payload: opts.payload,
            workspaceId: opts.workspaceId,
            ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
          },
        });
        if (claimed.count > 0) return existing.id;
      }
    }
    try {
      const job = await db.scheduledJob.create({
        data: {
          workspaceId: opts.workspaceId,
          kind: opts.kind,
          runAt: opts.runAt,
          payload: opts.payload,
          dedupKey: opts.dedupKey ?? null,
          maxAttempts: opts.maxAttempts ?? 5,
        },
        select: { id: true },
      });
      return job.id;
    } catch (e) {
      // Lost a race with a concurrent scheduler for the same (kind, dedupKey):
      // the partial-unique index rejected this create. Collapse onto the winner's
      // PENDING row (same semantic as the findFirst path above) rather than
      // surfacing the raw P2002 as a 500.
      if (
        opts.dedupKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await db.scheduledJob.findFirst({
          where: { kind: opts.kind, dedupKey: opts.dedupKey, status: 'PENDING' },
          select: { id: true },
        });
        if (winner) return winner.id;
      }
      throw e;
    }
  }

  /** Cancel the PENDING job for (kind, dedupKey). Returns true if one was cancelled. */
  async cancel(kind: string, dedupKey: string, tx: Tx = this.prisma): Promise<boolean> {
    const db = tx as PrismaService;
    const res = await db.scheduledJob.updateMany({
      where: { kind, dedupKey, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    return res.count > 0;
  }

  /**
   * Read the queue.
   *
   * Everything deferred in this product runs through `scheduled_jobs` —
   * AI replies, follow-ups, campaign batches, imports, booking reminders — and
   * each row carries the `lastError` of its most recent attempt. Until this
   * method there was no way to read any of that: no API route, no MCP tool, no
   * panel screen. A job could fail its five attempts and land in FAILED and the
   * only trace was a log line on the box.
   *
   * That is how a silent AI stays silent. The reply path deliberately schedules
   * a retry job when a live reply throws, so the exception that stopped it was
   * being captured correctly the whole time — into a column nobody could read.
   *
   * Workspace-scoped, newest first, and it returns `lastError` verbatim because
   * a redacted error answers nothing.
   */
  async list(
    workspaceId: string,
    opts: { kind?: string; status?: string; limit?: number } = {},
  ) {
    return this.prisma.scheduledJob.findMany({
      where: {
        workspaceId,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 20, 1), 100),
      select: {
        id: true,
        kind: true,
        status: true,
        runAt: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        dedupKey: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }

  /**
   * The recurring side of the same question.
   *
   * `list()` above reads one-off jobs. This reads the SCHEDULES: 20+ crons run
   * through `withAdvisoryLock` — the morning brief, this queue's own runner, ad
   * pulls, review sync, calendar sync, every NetGSM poller, the sweeps — and
   * each now records when it last ran and whether it worked.
   *
   * Not workspace-scoped, and cannot be: a cron is platform-level and its rows
   * carry no workspace. Nothing here is customer data — job names, timestamps
   * and the last error string.
   *
   * The pair of timestamps is the whole point. `lastRunAt` well ahead of
   * `lastOkAt` means the job is firing and failing; both stale means it is not
   * firing at all. Those look identical from the outside and need opposite
   * fixes.
   */
  async listCronHeartbeats() {
    const [registered, recorded] = await Promise.all([
      Promise.resolve(this.listRegisteredCrons()),
      this.prisma.cronHeartbeat.findMany({ orderBy: { lastRunAt: 'desc' } }),
    ]);
    return { registered, recorded };
  }

  /**
   * Every cron Nest actually has registered, straight from its own registry.
   *
   * The heartbeats alone are a surface that lies by omission. They are written
   * from `withAdvisoryLock`, so a job that does not use the lock — or that
   * returns early before reaching it, as the call-analysis sweep does when STT
   * is unconfigured — simply never appears. A reader seeing 9 rows cannot tell
   * "not instrumented" from "not firing", and those are opposite problems.
   *
   * Names deliberately are NOT joined against the heartbeats. A cron's @Cron
   * name and its lock name are different strings by convention in this codebase
   * (`call-cdr-sync` locks as `telephony:cdr-sync`), and a fuzzy match would
   * silently pair the wrong two rows — a confident wrong answer where two
   * honest lists will do.
   *
   * `lastFiredAt` is per-process and resets on restart: it says the schedule is
   * alive right now. The heartbeat says the work completed and survives a
   * deploy. Neither replaces the other.
   */
  private listRegisteredCrons() {
    const out: Array<{ name: string; lastFiredAt: Date | null; nextAt: Date | null }> = [];
    let jobs: Map<string, unknown>;
    try {
      jobs = this.scheduler.getCronJobs();
    } catch {
      return out;
    }
    for (const [name, job] of jobs) {
      const j = job as { lastDate?: () => Date | null; nextDate?: () => unknown };
      let lastFiredAt: Date | null = null;
      let nextAt: Date | null = null;
      try {
        lastFiredAt = j.lastDate?.() ?? null;
      } catch {
        lastFiredAt = null;
      }
      try {
        const n = j.nextDate?.();
        // cron's nextDate() returns a Luxon DateTime on v3+, a Date on older
        // builds. Take whichever without assuming, and never let it throw.
        nextAt = n instanceof Date ? n : ((n as { toJSDate?: () => Date })?.toJSDate?.() ?? null);
      } catch {
        nextAt = null;
      }
      out.push({ name, lastFiredAt, nextAt });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async cancelById(id: string): Promise<boolean> {
    const res = await this.prisma.scheduledJob.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    return res.count > 0;
  }
}
