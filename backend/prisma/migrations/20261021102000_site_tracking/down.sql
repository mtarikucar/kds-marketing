-- Reverts 20261021102000_site_tracking exactly: the tables it created, dependants first. No
-- existing table is touched. Idempotent, and a safe no-op if already reverted.
DROP TABLE IF EXISTS "site_traffic_daily";
DROP TABLE IF EXISTS "site_tracking_keys";
