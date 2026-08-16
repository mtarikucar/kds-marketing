-- Aggregated page-open counters, so retiring a screen becomes arithmetic
-- instead of an opinion. Additive; no changes to existing tables.
--
-- One row per (workspace, route pattern, month) — NOT one row per visit. The
-- question this answers is "has anyone opened /order-forms this quarter?", and
-- a counter answers it at a fraction of the storage a per-event log would need.
--
-- No userId and no per-view timestamp on purpose: tracking which member of the
-- customer's staff looked at which screen is surveillance we have no reason to
-- perform. `route` is the router PATTERN, so it contains no record ids.

CREATE TABLE IF NOT EXISTS "page_view_stats" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    -- 'YYYY-MM', UTC.
    "period" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "page_view_stats_pkey" PRIMARY KEY ("id")
);

-- The upsert target: one counter per screen per workspace per month.
CREATE UNIQUE INDEX IF NOT EXISTS "page_view_stats_workspaceId_route_period_key"
    ON "page_view_stats"("workspaceId", "route", "period");

-- The read that matters: "across all workspaces, what was opened in period X".
CREATE INDEX IF NOT EXISTS "page_view_stats_period_route_idx"
    ON "page_view_stats"("period", "route");
