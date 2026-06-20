-- Migration: Estimates / quotes (GoHighLevel parity)
--
-- A priced document of line items sent to a lead/customer who can accept or
-- decline; an accepted estimate converts to an invoice (convertedInvoiceId, a
-- soft no-FK link). Mirrors the invoices table shape. New table only — purely
-- additive, no backfill, safe online migration.

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT,
    "number" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "validUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publicToken" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "convertedInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estimates_publicToken_key" ON "estimates"("publicToken");
CREATE INDEX "estimates_workspaceId_status_idx" ON "estimates"("workspaceId", "status");
