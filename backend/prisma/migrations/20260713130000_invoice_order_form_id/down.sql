-- Reverse of migration.sql — drop exactly what it added.
DROP INDEX IF EXISTS "invoices_workspaceId_leadId_orderFormId_idx";
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "orderFormId";
