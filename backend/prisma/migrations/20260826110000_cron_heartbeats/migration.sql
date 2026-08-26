-- Heartbeat for every scheduled job.
--
-- 20+ crons run through withAdvisoryLock and none of them recorded that they
-- had run, so a job that silently stopped firing was indistinguishable from a
-- job with nothing to do.
--
-- One row per job, upserted: the question is "is this still running and did it
-- work last time", not "show me a year of ticks". The table stays tiny and
-- needs no retention job of its own.
CREATE TABLE "cron_heartbeats" (
    "jobName"   TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastOkAt"  TIMESTAMP(3),
    "lastError" TEXT,
    "runs"      INTEGER NOT NULL DEFAULT 0,
    "failures"  INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_heartbeats_pkey" PRIMARY KEY ("jobName")
);
