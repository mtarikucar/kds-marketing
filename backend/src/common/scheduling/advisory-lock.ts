import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Postgres advisory-lock wrapper, factored out of SubscriptionSchedulerService
 * so every new cron in the codebase uses the same coordination scheme.
 *
 * Under multi-replica deploy, every replica fires its @Cron decorators on
 * the same wall-clock tick — without coordination they all do duplicate
 * work (and in some cases double-charge / double-emit / double-update).
 * `pg_try_advisory_lock` is a per-session, transient, contention-free
 * primitive that returns true exactly once per id: the winning replica
 * proceeds, the losers silently skip.
 *
 * The id is derived from the job name with DJB2 (stable across runs), so
 * the same job string yields the same lock across replicas. Lock collisions
 * across different jobs are mathematically possible but harmless — the loser
 * just retries next tick. The 32-bit hash space gives ~4B distinct slots.
 */
/** Upper bound on a lock-holding cron body. A body that exceeds it has the
 *  transaction (and therefore the lock) forcibly released and the error
 *  surfaces to the cron's own logger — strictly better than the silent
 *  stall/duplicate the old session-lock semantics allowed. */
const LOCK_BODY_TIMEOUT_MS = 55 * 60 * 1000;

export async function withAdvisoryLock(
  prisma: PrismaService,
  jobName: string,
  run: () => Promise<void>,
  logger?: Logger,
): Promise<void> {
  const lockId = djb2(jobName);
  // CONNECTION-SAFE: the old implementation acquired pg_try_advisory_lock and
  // released pg_advisory_unlock via two bare $queryRaw calls, each on an
  // ARBITRARY pooled connection. Session advisory locks are per-connection and
  // RE-ENTRANT, which broke this in two ways: (a) a release landing on a
  // different connection was a silent no-op, leaking the lock to an idle
  // pooled session for hours — every subsequent tick on every replica skipped
  // and the whole cron silently stalled; (b) an overlapping tick whose acquire
  // happened to land on the ORIGINAL holding connection re-acquired the lock
  // re-entrantly and ran concurrently (duplicate job execution). Running the
  // try-xact-lock INSIDE one interactive transaction pins acquire+hold+release
  // to a single connection and releases at COMMIT/ROLLBACK — crash-safe, no
  // leak, no re-entrant double-entry. `run()` itself still executes its
  // queries on the normal pool; the transaction connection just holds the lock.
  // Whether THIS replica did the work. The losers skip silently and must not
  // write a heartbeat: three replicas ticking would otherwise report three runs
  // for one execution, and a job that only ever loses the race would look busy.
  let ranHere = false;
  let failure: string | null = null;

  try {
    await prisma.$transaction(
      async (tx) => {
        const acquired = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${lockId}) AS locked
        `;
        if (!acquired[0]?.locked) {
          logger?.debug(`skip ${jobName}: advisory lock held by another replica`);
          return;
        }
        ranHere = true;
        await run();
      },
      { maxWait: 5_000, timeout: LOCK_BODY_TIMEOUT_MS },
    );
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
    throw e;
  } finally {
    // OUTSIDE the transaction on purpose: written in there, the heartbeat would
    // roll back with the failure it exists to record, and the only tick worth
    // knowing about would be the one that never got written.
    if (ranHere) await recordHeartbeat(prisma, jobName, failure, logger);
  }
}

/**
 * Record that this job ran, and whether it worked.
 *
 * Every recurring thing this product does passes through withAdvisoryLock, and
 * until now not one of them wrote down that it had run. A cron that silently
 * stopped firing was indistinguishable from a cron with nothing to do — the
 * same shape as every other failure in this codebase, where the evidence
 * existed nowhere rather than somewhere unread.
 *
 * Never throws. A heartbeat is a note about the work, not the work; failing to
 * write it must not fail a job that succeeded, and must not replace the real
 * error of one that did not.
 */
async function recordHeartbeat(
  prisma: PrismaService,
  jobName: string,
  failure: string | null,
  logger?: Logger,
): Promise<void> {
  const now = new Date();
  try {
    await prisma.cronHeartbeat.upsert({
      where: { jobName },
      create: {
        jobName,
        lastRunAt: now,
        lastOkAt: failure ? null : now,
        lastError: failure ? failure.slice(0, 500) : null,
        runs: 1,
        failures: failure ? 1 : 0,
      },
      update: {
        lastRunAt: now,
        runs: { increment: 1 },
        ...(failure
          ? { lastError: failure.slice(0, 500), failures: { increment: 1 } }
          : // Clear the error on success: a stale message next to a fresh
            // lastOkAt reads as a live problem that has in fact been over for
            // weeks, and that is how a status surface stops being believed.
            { lastOkAt: now, lastError: null }),
      },
    });
  } catch (e) {
    logger?.warn(`heartbeat write failed for ${jobName}: ${(e as Error)?.message ?? e}`);
  }
}

/** Deterministic 32-bit hash. Stable for the same input across processes. */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Connection-safe advisory lock for SHORT-running work. Unlike withAdvisoryLock
 * (session lock acquired/released on possibly-different pooled connections — see
 * its caveat), this uses pg_try_advisory_xact_lock INSIDE an interactive
 * transaction, so the lock is tied to ONE connection and auto-released at COMMIT/
 * ROLLBACK. Non-blocking: a loser (lock held elsewhere) skips. Only for short run()
 * bodies (the tx is held for run()'s duration; default 45s timeout).
 *
 * The 45s default is chosen to be comfortably above the routine fire timeout
 * (FIRE_TIMEOUT_MS = 30s) plus the small recordTrigger write, so a slow HTTP
 * fire cannot abort the transaction mid-flight and lose the lastTriggeredAt stamp.
 */
export async function withAdvisoryXactLock(
  prisma: PrismaService,
  jobName: string,
  run: () => Promise<void>,
  opts?: { timeoutMs?: number; logger?: Logger },
): Promise<void> {
  const lockId = djb2(jobName);
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${lockId}) AS locked`;
      if (!rows[0]?.locked) {
        opts?.logger?.debug(`skip ${jobName}: advisory xact lock held elsewhere`);
        return;
      }
      await run();
    },
    { timeout: opts?.timeoutMs ?? 45_000 },
  );
}
