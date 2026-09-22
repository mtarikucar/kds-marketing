-- Reverts 20260922103000_email_inbound_items exactly: the one table it created,
-- with its two indexes. Idempotent, and a safe no-op if already reverted.
-- The mail itself lives in the tenant's mailbox and the ingested copies live in
-- "messages"; the IMAP cursor lives in channels.configPublic. Dropping this
-- table loses the retry ledger and the skip reasons — never a customer's mail,
-- and never the poller's position.
DROP TABLE IF EXISTS "email_inbound_items";
