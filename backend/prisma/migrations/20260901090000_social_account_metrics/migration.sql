-- The organic READ path: daily per-account snapshots, plus the bookkeeping the
-- hourly insights sweep needs to be well-behaved.
--
-- Until now the social integration could only push. SocialPostMetric existed
-- (and was never written by anything), but a post-level table cannot hold a
-- follower count: followers belong to the profile, not to any one post, and
-- there is no target row to hang them on. social_account_metrics is that
-- missing half — one row per (account, UTC day), upserted, so a re-pull a few
-- hours later overwrites the day rather than appending a second reading.
--
-- WHY (socialAccountId, date) IS UNIQUE AND NOT JUST INDEXED. The sweep runs
-- hourly and re-reads each account up to four times a day; without the unique
-- the same day would accumulate duplicate rows and every aggregate over the
-- table would silently multiply. The unique makes the writer's upsert the only
-- possible outcome, which is the same guarantee (targetId, date) gives
-- social_post_metrics and (adAccountId, date, campaignId) gives ad_metrics.
--
-- ON DELETE CASCADE mirrors social_post_metrics: metrics are derived data with
-- no independent meaning, so they die with the account. Note this is a
-- DIFFERENT choice from social_post_targets, which references social_accounts
-- with ON DELETE RESTRICT precisely because publish history must survive a
-- disconnect — and it is why disconnectAccount REVOKES an account with history
-- instead of deleting it. Cascade here does not weaken that: an account that
-- has ever published still cannot be deleted at all.
CREATE TABLE IF NOT EXISTS "social_account_metrics" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    -- UTC day. DATE (not TIMESTAMP) so the upsert key cannot be split by a
    -- time-of-day component the way a naive `new Date()` would split it.
    "date" DATE NOT NULL,
    -- A STOCK: a level at a point in time. Never sum this across days.
    "followers" INTEGER NOT NULL DEFAULT 0,
    "profileViews" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    -- No "posts" column, on purpose. How many times WE posted on a day is not
    -- the provider's number and does not need storing: social_post_targets
    -- answers it exactly, for every day, including the days no sweep ran. A
    -- column here could only ever be written for the current day and only on
    -- the ticks where the provider read succeeded, so it would freeze at
    -- whatever the last sweep of that day happened to see — a stale aggregate
    -- with no reader. The summary endpoint derives the figure from the targets.
    "raw" JSONB,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_account_metrics_pkey" PRIMARY KEY ("id"),
    -- Declared inline rather than as a trailing ALTER so that every statement
    -- in this file is guarded and the migration is safe to re-run as a whole.
    CONSTRAINT "social_account_metrics_socialAccountId_fkey"
        FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- The upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS "social_account_metrics_socialAccountId_date_key"
    ON "social_account_metrics"("socialAccountId", "date");

-- The read the summary endpoint performs: one workspace, one date window.
CREATE INDEX IF NOT EXISTS "social_account_metrics_workspaceId_date_idx"
    ON "social_account_metrics"("workspaceId", "date");

-- Sweep bookkeeping on the account itself.
--
-- insightsPulledAt records the last ATTEMPT, not the last success, and that
-- distinction is the whole point: an account whose insights permission was
-- never granted fails every single time, and if only successes stamped the
-- column it would stay NULL forever, sit permanently at the nulls-first front
-- of the due queue, and starve every healthy account behind it. This is the
-- same reason AdAccountService.markError stamps lastPulledAt on failure.
ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "insightsPulledAt" TIMESTAMP(3);

-- insightsError is a SEPARATE column from the existing "lastError", and merging
-- them would be a real bug rather than a tidy-up. `lastError` is folded into
-- needsReconnect (enabled !== true || expired || Boolean(lastError)), so any
-- string written there tells the owner to reconnect the account. A missing
-- read_insights scope or a rate limit says nothing whatsoever about the
-- publishing credential — the account works — and putting that message in
-- lastError would send the owner through an OAuth dance that cannot fix it.
-- Only a genuine auth failure is allowed to write 'reauth_required' to
-- lastError; everything else lands here, where it is reportable but inert.
ALTER TABLE "social_accounts" ADD COLUMN IF NOT EXISTS "insightsError" TEXT;

-- The sweep's cross-workspace due-row probe: enabled accounts whose
-- insightsPulledAt is NULL or older than the pull interval, oldest first.
CREATE INDEX IF NOT EXISTS "social_accounts_enabled_insightsPulledAt_idx"
    ON "social_accounts"("enabled", "insightsPulledAt");
