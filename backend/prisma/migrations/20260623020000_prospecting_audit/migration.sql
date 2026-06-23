-- Epic 13 prospecting-audit. Additive: a brand-new table, no existing column
-- touched, so it is safe to apply ahead of the single-replica rollout.
CREATE TABLE "prospect_audits" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "businessName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "score" INTEGER,
    "sections" JSONB,
    "error" TEXT,
    "publicToken" TEXT NOT NULL,
    "convertedLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "prospect_audits_pkey" PRIMARY KEY ("id")
);

-- Unguessable capability token for the public report — must be unique.
CREATE UNIQUE INDEX "prospect_audits_publicToken_key" ON "prospect_audits"("publicToken");

CREATE INDEX "prospect_audits_workspaceId_status_idx" ON "prospect_audits"("workspaceId", "status");
