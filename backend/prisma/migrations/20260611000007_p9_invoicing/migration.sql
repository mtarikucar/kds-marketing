-- P9: end-customer invoicing. Additive (two new tables).

CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT,
    "number" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publicToken" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidVia" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoices_publicToken_key" ON "invoices"("publicToken");
CREATE INDEX "invoices_workspaceId_status_idx" ON "invoices"("workspaceId", "status");

CREATE TABLE "workspace_psp_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MANUAL',
    "configSealed" TEXT,
    "configPublic" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_psp_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_psp_configs_workspaceId_key" ON "workspace_psp_configs"("workspaceId");
