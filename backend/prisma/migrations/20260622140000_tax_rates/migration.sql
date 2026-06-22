-- Migration: Tax rates + invoice/estimate tax breakdown (GoHighLevel parity)
--
-- A reusable per-workspace TaxRate (e.g. KDV %20), applied exclusively (added on
-- top). Invoices and estimates gain subtotal + taxTotal columns; existing rows
-- default both to 0 (their `total` stays correct — read paths treat subtotal=total
-- when the breakdown is 0). Additive + defaulted only — safe online migration.

-- CreateTable
CREATE TABLE "tax_rates" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "rate"        DECIMAL(5,2) NOT NULL,
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    "archived"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_rates_workspaceId_archived_idx" ON "tax_rates"("workspaceId", "archived");

-- AlterTable
ALTER TABLE "invoices"  ADD COLUMN "subtotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices"  ADD COLUMN "taxTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "estimates" ADD COLUMN "subtotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "estimates" ADD COLUMN "taxTotal" INTEGER NOT NULL DEFAULT 0;
