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
export async function withAdvisoryLock(
  prisma: PrismaService,
  jobName: string,
  run: () => Promise<void>,
  logger?: Logger,
): Promise<void> {
  const lockId = djb2(jobName);
  // Parameterized (no Unsafe): lockId is always an integer, but binding it keeps
  // the query off the raw-SQL surface and is defensive if the key derivation
  // ever changes. Session-level + non-blocking is intentional — losers skip this
  // tick rather than block, so do NOT swap this for pg_advisory_xact_lock.
  const acquired = await prisma.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${lockId}) AS locked
  `;
  if (!acquired[0]?.locked) {
    logger?.debug(`skip ${jobName}: advisory lock held by another replica`);
    return;
  }
  try {
    await run();
  } finally {
    // Release explicitly — Postgres also releases at session end, but
    // long-lived connection pools mean "session end" is hours away.
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockId})`;
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
