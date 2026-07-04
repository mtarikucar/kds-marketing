-- Growth Autopilot foundations: prepaid growth wallet + autonomy lane.

-- CreateTable
CREATE TABLE "growth_wallets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_wallet_ledger_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "delta" DECIMAL(14,2) NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "growth_wallet_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "growth_wallets_workspaceId_key" ON "growth_wallets"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "growth_wallet_ledger_entries_ref_key" ON "growth_wallet_ledger_entries"("ref");

-- CreateIndex
CREATE INDEX "growth_wallet_ledger_entries_workspaceId_createdAt_idx" ON "growth_wallet_ledger_entries"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "growth_wallet_ledger_entries" ADD CONSTRAINT "growth_wallet_ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "growth_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (additive, default keeps existing rows on today's behavior)
ALTER TABLE "growth_budgets" ADD COLUMN "autonomyLevel" TEXT NOT NULL DEFAULT 'ASSISTED';
