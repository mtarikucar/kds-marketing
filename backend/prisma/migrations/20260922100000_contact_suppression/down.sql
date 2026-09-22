-- Reverts 20260922100000_contact_suppression exactly: the one table it created,
-- with its two indexes. Idempotent, and a safe no-op if already reverted.
-- The denormalised Lead flags (emailOptOut, emailBouncedAt, emailVerifiedStatus)
-- are the fast read and are written alongside every suppression, so a rollback
-- loses the audit trail and never the suppression itself.
DROP TABLE IF EXISTS "contact_suppressions";
