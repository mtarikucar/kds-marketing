-- Reverts 20260922104000_lead_iys_email exactly: the two nullable columns it
-- added to "leads". Idempotent, and a safe no-op if already reverted.
-- Both hold a CACHE of İYS's answer, never the tenant's own record: the consent
-- of record lives at İYS and in consent_records, so re-running the lookup
-- rebuilds these. No lead row is deleted and no opt-out column is touched.
ALTER TABLE "leads" DROP COLUMN IF EXISTS "iysEmailCheckedAt",
DROP COLUMN IF EXISTS "iysEmailStatus";
