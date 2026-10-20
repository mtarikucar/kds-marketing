-- Reverts 20261021100000_commerce_ingest exactly: the three tables it created,
-- dependants first. No existing table is touched (the Lead -> ExternalOrder link
-- lives on external_orders.leadId), so no lead, invoice or attribution row is
-- lost. Idempotent, and a safe no-op if already reverted. Running this in
-- production is the owner's decision: it deletes every ingested store order.
DROP TABLE IF EXISTS "external_order_events";
DROP TABLE IF EXISTS "external_orders";
DROP TABLE IF EXISTS "commerce_sources";
