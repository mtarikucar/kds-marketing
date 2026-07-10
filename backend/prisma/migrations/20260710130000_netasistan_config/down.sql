-- Manual rollback for 20260710130000_netasistan_config (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly the columns the up
-- added; touches no operator/user data.
ALTER TABLE "marketing_users" DROP COLUMN IF EXISTS "netasistanOptIn";
ALTER TABLE "telephony_configs" DROP COLUMN IF EXISTS "netasistanConfigSealed";
