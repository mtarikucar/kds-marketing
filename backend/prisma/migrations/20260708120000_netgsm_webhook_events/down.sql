-- Manual rollback for 20260708120000_netgsm_webhook_events (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created and
-- touches no operator/user data.
DROP TABLE IF EXISTS "netgsm_webhook_events";
