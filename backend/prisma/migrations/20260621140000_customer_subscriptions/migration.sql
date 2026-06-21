-- Migration: Recurring customer subscriptions (GoHighLevel parity)
--
-- An hourly sweep mints a DRAFT invoice per due billing period; it does NOT
-- auto-charge (the workspace collects via the existing invoice pay flow).
-- DISTINCT from "workspace_subscriptions" (the platform's SaaS billing). Fully
-- additive: 1 new table + 2 nullable columns + 1 partial-unique index. No
-- backfill, safe online migration.

-- CreateTable
CREATE TABLE "customer_subscriptions" (
    "id"                  TEXT NOT NULL,
    "workspaceId"         TEXT NOT NULL,
    "leadId"              TEXT,
    "name"                TEXT NOT NULL,
    "items"               JSONB NOT NULL,
    "currency"            TEXT NOT NULL DEFAULT 'TRY',
    "amount"              INTEGER NOT NULL DEFAULT 0,
    "notes"               TEXT,
    "dueDays"             INTEGER NOT NULL DEFAULT 14,
    "interval"            TEXT NOT NULL DEFAULT 'MONTH',
    "intervalCount"       INTEGER NOT NULL DEFAULT 1,
    "status"              TEXT NOT NULL DEFAULT 'ACTIVE',
    "anchorAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextBillingAt"       TIMESTAMP(3) NOT NULL,
    "lastBilledAt"        TIMESTAMP(3),
    "lastBilledPeriodKey" TEXT,
    "invoicesGenerated"   INTEGER NOT NULL DEFAULT 0,
    "failedAttempts"      INTEGER NOT NULL DEFAULT 0,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_subscriptions_status_nextBillingAt_idx" ON "customer_subscriptions"("status", "nextBillingAt");
CREATE INDEX "customer_subscriptions_workspaceId_status_idx" ON "customer_subscriptions"("workspaceId", "status");

-- AlterTable: link generated invoices back to their subscription + period.
ALTER TABLE "invoices" ADD COLUMN "subscriptionId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "subscriptionPeriodKey" TEXT;

-- CreateIndex
CREATE INDEX "invoices_subscriptionId_idx" ON "invoices"("subscriptionId");

-- THE no-double-bill invariant: at most one invoice per (subscription, period).
-- Prisma can't express partial-unique — raw SQL, same technique as
-- "scheduled_jobs_pending_dedup".
CREATE UNIQUE INDEX "invoices_subscription_period"
  ON "invoices"("subscriptionId", "subscriptionPeriodKey")
  WHERE "subscriptionId" IS NOT NULL;
