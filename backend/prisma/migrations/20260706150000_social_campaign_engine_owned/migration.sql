-- Content arm: mark engine-provisioned social campaigns so one-click
-- quick-start is idempotent (skip an account already backed by an active
-- engine-owned campaign for the budget's period). Null = user-authored.
ALTER TABLE "social_campaigns" ADD COLUMN "engineBudgetId" TEXT;

CREATE INDEX "social_campaigns_workspaceId_engineBudgetId_idx"
  ON "social_campaigns"("workspaceId", "engineBudgetId");
