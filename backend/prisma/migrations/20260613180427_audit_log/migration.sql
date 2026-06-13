-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "workspaceId" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_workspaceId_occurredAt_idx" ON "audit_log"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_resourceType_resourceId_idx" ON "audit_log"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_occurredAt_idx" ON "audit_log"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_action_occurredAt_idx" ON "audit_log"("action", "occurredAt");
