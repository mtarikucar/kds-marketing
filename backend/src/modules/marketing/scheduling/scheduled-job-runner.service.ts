import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { RESEARCH_RUN_KIND } from '../research/research-kinds';
import {
  MCP_ACTIVITY_AGENT,
  mcpActivityCutoff,
  researchGraceCutoff,
} from '../research/research-execution';

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
/** Invoked once when a job of this kind exhausts maxAttempts and is DLQ'd —
 *  lets the owning feature flip ITS domain record terminal (e.g. an ImportJob
 *  stuck RUNNING would otherwise poll "running…" forever). Best-effort. */
export type JobExhaustedHook = (job: ClaimedJob, error: string) => Promise<void>;

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
  private readonly exhaustedHooks = new Map<string, JobExhaustedHook>();

  constructor(private readonly prisma: PrismaService) {}

  registerHandler(kind: string, fn: JobHandler, onExhausted?: JobExhaustedHook): void {
    if (this.handlers.has(kind)) {
      throw new Error(`ScheduledJob handler for kind "${kind}" already registered`);
    }
    this.handlers.set(kind, fn);
    if (onExhausted) this.exhaustedHooks.set(kind, onExhausted);
  }

  /** Exposed for the tripwire spec: which kinds have a handler. */
  registeredKinds(): string[] {
    return [...this.handlers.keys()];
  }

  /** In-process overlap guard — see tick(). */
  private ticking = false;

  @Cron(CronExpression.EVERY_MINUTE, { name: 'scheduled-job-runner' })
  async tick(): Promise<void> {
    // A minute tick can legitimately outlast its interval (a 100-job batch
    // behind slow AI/media handlers). Postgres session advisory locks are
    // RE-ENTRANT per connection, so an overlapping tick in THIS process could
    // re-acquire the lock on the same pooled connection and run CONCURRENTLY —
    // its reaper would then revive rows the first tick still holds in memory
    // and double-run them (duplicate sends). One boolean kills that whole
    // class for the in-process case; the advisory lock keeps covering the
    // cross-replica case.
    if (this.ticking) {
      this.logger.debug('tick skipped: previous tick still running');
      return;
    }
    this.ticking = true;
    try {
      await this.tickBody();
    } finally {
      this.ticking = false;
    }
  }

  private async tickBody(): Promise<void> {
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

  /**
   * Claim the due batch — minus the one kind this runner is not always
   * entitled to.
   *
   * A workspace on `researchExecution = 'MCP'` has said its nightly research
   * is drained by its OWN Claude over MCP, billed to its own Anthropic
   * subscription. That is the whole feature: research is 86% of the platform's
   * measured model bill, and moving the EXECUTION is what moves the money. The
   * cron still enqueues those jobs unchanged — the queue is the handover point
   * — so if this claim took them anyway, they would be executed in-process on
   * the platform's key within sixty seconds of being written, the owner's
   * drainer would never find anything to lease, and the mode would silently do
   * nothing while looking like it worked.
   *
   * Two properties of the predicate are load-bearing, and each is a different
   * outage if it slips:
   *
   *  - It is a CONJUNCTION of kind and mode. Excluding the kind alone would
   *    strand research for every SERVER workspace (the default, i.e. almost
   *    all of them); excluding the workspace alone would strand its campaigns,
   *    follow-ups, imports and reminders too.
   *  - The mode is read LIVE off `workspaces`, not stamped onto the row at
   *    enqueue time. Stamping is tidier layering — this is the one place the
   *    generic runner knows a feature's kind — but it leaves a real bug:
   *    rows stamped MCP are orphaned forever the moment an owner switches back
   *    to SERVER, drained by nobody, noticed by nothing.
   *
   *    Reading live means flipping the switch releases every PENDING row in the
   *    very next tick, in either direction. It does NOT release a row that is
   *    already CLAIMED: this predicate only ever sees PENDING, so a job an MCP
   *    client holds is untouched by the flip and stays that way until
   *    `ResearchLeaseService.releaseExpired` returns it to the queue. That is
   *    precisely why the sweep runs from `queueStatus()` — mode-independent, no
   *    client needed — and not only from `claim()` behind the mode check;
   *    without that second caller the stamped-row bug described above simply
   *    reappeared one status later, and just as invisibly.
   *
   *    Cost: the planner does NOT do a PK lookup per candidate row. `EXPLAIN`
   *    on this predicate shows `(kind <> 'research.run') OR (NOT (hashed
   *    SubPlan))` — one pass over the MCP workspaces, hashed once, then probed
   *    per row. `workspaces` is read once per tick, not once per job. The
   *    honest version is cheaper than it was described as.
   *
   * ## The exclusion EXPIRES, and that is what makes it safe to default on
   *
   * The mode no longer means "who drains", it means "who is asked FIRST"
   * (`research-execution.ts`). Left as a hard switch it had a fatal edge: a
   * connection is not evidence that anyone will drain the queue at 3AM, so a
   * customer who connected Claude once and never scheduled a task had their
   * research stop dead while the panel showed an empty review queue — a broken
   * thing wearing the costume of an empty result, which is the failure this
   * repo keeps paying for.
   *
   * So the exclusion is bounded by `createdAt > now - RESEARCH_MCP_GRACE_MS`.
   * Inside the window the row is the owner's Claude's to lease; outside it, the
   * platform drains it like any other job and `ResearchRunnerService.handle`
   * records that it had to (which the home timeline then says by name — a
   * fallback that quietly keeps the cost on the platform is the same trap from
   * the other direction).
   *
   * `createdAt` and NOT `runAt` is deliberate. `runAt` is rewritten by the retry
   * backoff, so a takeover run that fails once would push its own row back
   * inside the window and hand first refusal to a client that already declined
   * it — the job would then ping-pong instead of retrying. `createdAt` is
   * immutable, so the clock runs from the moment the cron enqueued the night.
   * It is also the same column `queueStatus()` ages the queue by, so the panel
   * and this predicate cannot disagree about how old a job is.
   *
   * A job whose MCP lease EXPIRED comes back to PENDING with its original
   * `createdAt`, so it is claimable immediately — correct, since an abandoned
   * lease is precisely the case the fallback exists for.
   *
   * ## AUTO, and what actually counts as "a Claude is connected"
   *
   * The default mode is `AUTO`, resolved live here: MCP while this workspace
   * has MCP TRAFFIC inside `MCP_CONNECTION_STALE_MS`, SERVER otherwise.
   *
   * The signal is an `agent_runs` row with `agent = 'mcp'`. `McpInvokerService`
   * opens exactly one per tool call and a tool call cannot happen any other
   * way, so the row IS a Claude that reached this workspace. Deliberately NOT
   * `ApiKey.lastUsedAt`: `ApiKeysService.authenticate()` is shared by the MCP
   * verifier and the public REST `ApiKeyGuard` and stamps `lastUsedAt` for
   * both, so a workspace whose Zapier integration polls the REST API would be
   * auto-switched to a lane no Claude is on. The agent-run signal is also the
   * only one that sees the OAuth connectors (Claude.ai / Desktop), which never
   * touch `ApiKey` at all.
   *
   * The whole three-way decision is duplicated in TypeScript by
   * `effectiveResearchExecution()`, because `ResearchLeaseService` has to
   * answer the same question for a client. Two implementations of one rule
   * drift; `research-mcp-fallback.realdb.e2e-spec.ts` pins them against each
   * other over the full matrix on real Postgres.
   *
   * `RESEARCH_RUN_KIND` and the two windows are imported from the import-free
   * `research-kinds.ts` / `research-execution.ts` rather than from the research
   * runner, which imports this file.
   */
  private async claimBatch(): Promise<ClaimedJob[]> {
    const now = new Date();
    const graceCutoff = researchGraceCutoff(now);
    const mcpSeenSince = mcpActivityCutoff(now);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; workspaceId: string; kind: string; payload: any; attempts: number }>
    >`
      UPDATE "scheduled_jobs"
         SET "status" = 'RUNNING', "lockedAt" = ${now}
       WHERE "id" IN (
         SELECT s."id" FROM "scheduled_jobs" s
          WHERE s."status" = 'PENDING' AND s."runAt" <= ${now}
            AND NOT (
              s."kind" = ${RESEARCH_RUN_KIND}
              AND s."createdAt" > ${graceCutoff}
              AND EXISTS (
                SELECT 1 FROM "workspaces" w
                 WHERE w."id" = s."workspaceId"
                   AND (
                     w."researchExecution" = 'MCP'
                     OR (
                       w."researchExecution" = 'AUTO'
                       AND EXISTS (
                         SELECT 1 FROM "agent_runs" r
                          WHERE r."workspaceId" = w."id"
                            AND r."agent" = ${MCP_ACTIVITY_AGENT}
                            AND r."startedAt" > ${mcpSeenSince}
                       )
                     )
                   )
              )
            )
          ORDER BY s."runAt"
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
      // Heartbeat: claimBatch stamps lockedAt ONCE for up to 100 rows, but a
      // row can wait many minutes in this in-memory queue behind slow
      // handlers. Without a re-stamp it would look stale (>15 min) to another
      // replica's reaper while still queued here — revived, re-claimed and
      // DOUBLE-RUN. Re-stamp immediately before execution so only genuinely
      // dead claims ever age out.
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: { lockedAt: new Date() },
      });
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
        // Let the owning feature mark ITS domain record terminal too —
        // best-effort: a hook failure must never disturb the DLQ bookkeeping.
        const onExhausted = this.exhaustedHooks.get(job.kind);
        if (onExhausted) {
          await onExhausted(job, msg).catch((hookErr) =>
            this.logger.error(
              `scheduled-job DLQ hook failed for ${job.id} kind=${job.kind}: ${(hookErr as Error)?.message}`,
            ),
          );
        }
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
