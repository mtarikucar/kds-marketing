-- Prepaid AI-credit wallet + measured token usage. Additive; no changes to
-- existing tables.
--
-- WHY THE WALLET. `limits.aiCreditsMonthly` is an allowance that RESETS, and the
-- old ai_credit_boost_500 add-on raised that allowance for the current
-- subscription period only — so credits a customer PAID for evaporated at period
-- end. With the single plan shipping deliberately modest included credits and
-- top-up as the release valve, bought credits have to behave like money.
--
-- WHY THE USAGE LOG. Every price in ai-credit-costs.ts came from max_tokens
-- CEILINGS. AnthropicService has always returned real `usage` and every caller
-- discarded it, so nothing knew what a credit actually costs. These rows turn
-- the price table into arithmetic.

CREATE TABLE IF NOT EXISTS "ai_credit_wallets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    -- Whole credits. Never negative: debits use a conditional update.
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_credit_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_credit_wallets_workspaceId_key" ON "ai_credit_wallets"("workspaceId");

CREATE TABLE IF NOT EXISTS "ai_credit_ledger_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    -- signed: >0 credit, <0 debit
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    -- TOPUP | SPEND | REFUND | ADJUST | GRANT
    "kind" TEXT NOT NULL,
    -- Globally unique so a replayed settlement webhook credits exactly once.
    "ref" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_credit_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_credit_ledger_entries_ref_key" ON "ai_credit_ledger_entries"("ref");
CREATE INDEX IF NOT EXISTS "ai_credit_ledger_entries_workspaceId_createdAt_idx" ON "ai_credit_ledger_entries"("workspaceId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "ai_credit_ledger_entries"
    ADD CONSTRAINT "ai_credit_ledger_entries_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "ai_credit_wallets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    -- The AiAction key the call was charged under.
    "action" TEXT NOT NULL,
    -- Resolved model id, so a tier remap stays comparable after the fact.
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_usage_logs_workspaceId_createdAt_idx" ON "ai_usage_logs"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_usage_logs_action_createdAt_idx" ON "ai_usage_logs"("action", "createdAt");
