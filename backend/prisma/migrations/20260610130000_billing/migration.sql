-- Phase F: packages, per-workspace subscriptions, purchasable add-on
-- boosts, and payment orders for the three payment paths (PayTR / Stripe /
-- manual bank transfer).

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dailyLeadQuota" INTEGER NOT NULL,
    "maxUsers" INTEGER NOT NULL,
    "maxResearchProfiles" INTEGER NOT NULL,
    "features" JSONB NOT NULL,
    "priceMonthlyTRY" DECIMAL(10,2) NOT NULL,
    "priceMonthlyUSD" DECIMAL(10,2) NOT NULL,
    "priceYearlyTRY" DECIMAL(10,2),
    "priceYearlyUSD" DECIMAL(10,2),
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_subscriptions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "trialEndsAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_addons" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "grants" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "packageId" TEXT,
    "addOnCode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "billingCycle" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "raw" JSONB,
    "approvedById" TEXT,
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "packages_code_key" ON "packages"("code");
CREATE UNIQUE INDEX "workspace_subscriptions_workspaceId_key" ON "workspace_subscriptions"("workspaceId");
CREATE INDEX "workspace_subscriptions_status_currentPeriodEnd_idx" ON "workspace_subscriptions"("status", "currentPeriodEnd");
CREATE INDEX "workspace_addons_workspaceId_status_idx" ON "workspace_addons"("workspaceId", "status");
CREATE UNIQUE INDEX "payment_orders_providerRef_key" ON "payment_orders"("providerRef");
CREATE UNIQUE INDEX "payment_orders_idempotencyKey_key" ON "payment_orders"("idempotencyKey");
CREATE INDEX "payment_orders_workspaceId_status_idx" ON "payment_orders"("workspaceId", "status");
CREATE INDEX "payment_orders_status_createdAt_idx" ON "payment_orders"("status", "createdAt");
