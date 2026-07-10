-- Manual rollback for 20260709100000_lead_phone_verified (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up added.
ALTER TABLE "leads"
  DROP COLUMN IF EXISTS "phoneVerifiedAt";
