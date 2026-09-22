-- Reverts 20260922101000_mail_log exactly: the one table it created, with its
-- four indexes. Idempotent, and a safe no-op if already reverted.
-- Nothing else reads these rows — the tenant-visible trace is LeadActivity and
-- the Message thread, both untouched here — so a rollback costs the operator
-- view and the bounce-attribution hop, never a customer record.
DROP TABLE IF EXISTS "mail_log";
