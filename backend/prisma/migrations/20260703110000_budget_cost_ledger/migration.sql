-- Budget Autopilot cost plumbing (Faz 7 cheap unblock, independent of Faz 5):
-- ChannelTariff (unit prices) + SpendLedger (append-only money ledger) +
-- per-message / per-call cost columns so conversation & content spend can be
-- priced into currency and paced against a single growth budget.

-- AlterTable
ALTER TABLE "sales_calls" ADD COLUMN     "billableSeconds" INTEGER,
ADD COLUMN     "costAmount" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "costAmount" DECIMAL(14,4),
ADD COLUMN     "smsSegments" INTEGER;

-- AlterTable
ALTER TABLE "voice_calls" ADD COLUMN     "billableSeconds" INTEGER,
ADD COLUMN     "costAmount" DECIMAL(14,4);

-- CreateTable
CREATE TABLE "channel_tariffs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "channel" TEXT NOT NULL,
    "provider" TEXT,
    "unitType" TEXT NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "country" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spend_ledgers" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT,
    "channel" TEXT NOT NULL,
    "delta" DECIMAL(14,2) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "quantity" DECIMAL(14,4),
    "reason" TEXT NOT NULL,
    "ref" TEXT,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_tariffs_channel_unitType_active_effectiveFrom_idx" ON "channel_tariffs"("channel", "unitType", "active", "effectiveFrom");

-- CreateIndex
CREATE INDEX "channel_tariffs_workspaceId_channel_unitType_idx" ON "channel_tariffs"("workspaceId", "channel", "unitType");

-- CreateIndex
CREATE INDEX "spend_ledgers_workspaceId_createdAt_idx" ON "spend_ledgers"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "spend_ledgers_workspaceId_budgetId_channel_idx" ON "spend_ledgers"("workspaceId", "budgetId", "channel");

-- CreateIndex
CREATE INDEX "spend_ledgers_ref_idx" ON "spend_ledgers"("ref");

