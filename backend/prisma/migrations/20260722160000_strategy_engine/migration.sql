-- Strategy Engine: the living, archetype-adaptive marketing strategy (one live
-- strategy per workspace), its hybrid-onboarding intake sessions, and the typed
-- ActionPlan items. Additive; no changes to existing tables.
CREATE TABLE IF NOT EXISTS "marketing_strategies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "archetype" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "autonomyLevel" TEXT NOT NULL DEFAULT 'ASSISTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "marketing_strategies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_strategies_workspaceId_key" ON "marketing_strategies"("workspaceId");

CREATE TABLE IF NOT EXISTS "strategy_intake_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "transcript" JSONB NOT NULL,
    "autoAnalysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "strategy_intake_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "strategy_intake_sessions_workspaceId_status_idx" ON "strategy_intake_sessions"("workspaceId", "status");

CREATE TABLE IF NOT EXISTS "strategy_actions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "strategy_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "strategy_actions_workspaceId_strategyId_status_idx" ON "strategy_actions"("workspaceId", "strategyId", "status");
