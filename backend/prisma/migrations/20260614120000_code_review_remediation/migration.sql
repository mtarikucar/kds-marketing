-- Code-review remediation (branch harden/code-review-remediation).
--
-- Additive + integrity hardening:
--   * outbox_events.claimedAt + index — required by the new outbox reclaim sweep
--     that recovers rows orphaned in 'dispatching' by a crash mid-dispatch.
--   * onDelete RESTRICT on marketing_tasks.assignedTo and commissions.lead — a
--     rep/lead deletion must not silently cascade-delete work items / sever a
--     commission's money trail. (Reps are deactivated and leads soft-archived,
--     so these constrain only future hard-deletes; no existing row violates them.)
--   * Tenant-/access-pattern indexes (leads, lead_activities,
--     marketing_notifications, workspace_subscriptions).

-- DropForeignKey
ALTER TABLE "marketing_tasks" DROP CONSTRAINT "marketing_tasks_assignedToId_fkey";

-- DropForeignKey
ALTER TABLE "commissions" DROP CONSTRAINT "commissions_leadId_fkey";

-- DropIndex
DROP INDEX "lead_activities_leadId_idx";

-- DropIndex
DROP INDEX "marketing_notifications_workspaceId_idx";

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_workspaceId_assignedToId_idx" ON "leads"("workspaceId", "assignedToId");

-- CreateIndex
CREATE INDEX "lead_activities_leadId_createdAt_idx" ON "lead_activities"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_notifications_workspaceId_createdAt_idx" ON "marketing_notifications"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_subscriptions_packageId_idx" ON "workspace_subscriptions"("packageId");

-- CreateIndex
CREATE INDEX "outbox_events_status_claimedAt_idx" ON "outbox_events"("status", "claimedAt");

-- AddForeignKey
ALTER TABLE "marketing_tasks" ADD CONSTRAINT "marketing_tasks_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "marketing_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
