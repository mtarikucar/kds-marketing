-- CreateTable
CREATE TABLE "ad_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "level" TEXT NOT NULL DEFAULT 'CAMPAIGN',
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DECIMAL(14,2) NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 3,
    "action" TEXT NOT NULL,
    "actionValue" DECIMAL(10,2),
    "maxBudget" DECIMAL(14,2),
    "minBudget" DECIMAL(14,2),
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "lastRunAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_rule_logs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_rule_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_rules_workspaceId_adAccountId_idx" ON "ad_rules"("workspaceId", "adAccountId");

-- CreateIndex
CREATE INDEX "ad_rules_enabled_idx" ON "ad_rules"("enabled");

-- CreateIndex
CREATE INDEX "ad_rule_logs_workspaceId_ruleId_idx" ON "ad_rule_logs"("workspaceId", "ruleId");

-- CreateIndex
CREATE INDEX "ad_rule_logs_ruleId_entityId_action_createdAt_idx" ON "ad_rule_logs"("ruleId", "entityId", "action", "createdAt");

-- AddForeignKey
ALTER TABLE "ad_rules" ADD CONSTRAINT "ad_rules_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_rule_logs" ADD CONSTRAINT "ad_rule_logs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ad_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

