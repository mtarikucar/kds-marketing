-- Migration: Customer store-credit wallet (GoHighLevel parity)
--
-- One wallet per (workspace, lead) with an append-only ledger; `balance` is a
-- cached running total kept in sync inside each entry's transaction. New tables
-- only — additive.

-- CreateTable
CREATE TABLE "customer_wallets" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId"      TEXT NOT NULL,
    "balance"     INTEGER NOT NULL DEFAULT 0,
    "currency"    TEXT NOT NULL DEFAULT 'TRY',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger_entries" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "walletId"    TEXT NOT NULL,
    "delta"       INTEGER NOT NULL,
    "reason"      TEXT NOT NULL,
    "invoiceId"   TEXT,
    "note"        TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_wallets_workspaceId_leadId_key" ON "customer_wallets"("workspaceId", "leadId");
CREATE INDEX "customer_wallets_workspaceId_idx" ON "customer_wallets"("workspaceId");
CREATE INDEX "wallet_ledger_entries_walletId_createdAt_idx" ON "wallet_ledger_entries"("walletId", "createdAt");
CREATE INDEX "wallet_ledger_entries_workspaceId_idx" ON "wallet_ledger_entries"("workspaceId");

-- AddForeignKey
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "customer_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
