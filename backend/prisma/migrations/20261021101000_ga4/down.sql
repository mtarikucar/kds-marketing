-- Reverts 20261021101000_ga4 exactly: the tables it created, dependants first. No
-- existing table is touched. Idempotent, and a safe no-op if already reverted.
DROP TABLE IF EXISTS "ga4_daily_stats";
DROP TABLE IF EXISTS "ga4_connections";
