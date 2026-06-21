-- Migration: Public payment-enabled Order Forms (GoHighLevel parity, increment 1)
--
-- A manager-authored config (template): a public page where a buyer submits
-- name/email/phone → the server creates-or-dedupes a lead, creates an invoice
-- for the configured product/items, and redirects to the existing invoice pay
-- page. Pricing is server-resolved (productId XOR items); the buyer never sets
-- the amount. publicToken minted at create (the form is shared). New table only
-- — purely additive, safe online migration.

-- CreateTable
CREATE TABLE "order_forms" (
    "id"            TEXT NOT NULL,
    "workspaceId"   TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "productId"     TEXT,
    "items"         JSONB,
    "currency"      TEXT NOT NULL DEFAULT 'TRY',
    "collectPhone"  BOOLEAN NOT NULL DEFAULT true,
    "phoneRequired" BOOLEAN NOT NULL DEFAULT false,
    "notes"         TEXT,
    "publicToken"   TEXT NOT NULL,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_forms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_forms_publicToken_key" ON "order_forms"("publicToken");
CREATE INDEX "order_forms_workspaceId_active_idx" ON "order_forms"("workspaceId", "active");
CREATE INDEX "order_forms_workspaceId_createdAt_idx" ON "order_forms"("workspaceId", "createdAt");
