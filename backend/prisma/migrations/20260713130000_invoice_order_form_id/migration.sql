-- Add a stable OrderForm reference to invoices so the order-form submit()
-- idempotency window keys off the form id, not the editable, non-unique note.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "orderFormId" TEXT;

-- Supports the submit() reuse lookup: recent open invoice for (workspace, lead, form).
CREATE INDEX IF NOT EXISTS "invoices_workspaceId_leadId_orderFormId_idx"
  ON "invoices" ("workspaceId", "leadId", "orderFormId");
