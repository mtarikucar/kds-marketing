-- Migration: Products catalog (GoHighLevel parity)
--
-- A reusable catalog of priced items a workspace sells. Foundation for invoices/
-- estimates/order-forms (later epics) and opportunity line items. New table only
-- — purely additive, no backfill, safe online migration. Soft workspace scoping
-- (no FK), matching the rest of the schema.

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "billingType" TEXT NOT NULL DEFAULT 'ONE_TIME',
    "interval" TEXT,
    "taxRate" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_workspaceId_idx" ON "products"("workspaceId");
CREATE INDEX "products_workspaceId_active_idx" ON "products"("workspaceId", "active");
