-- Manual rollback for 20260709110000_sms_otp_codes (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up added.
DROP INDEX IF EXISTS "sms_otp_codes_target_idx";
DROP TABLE IF EXISTS "sms_otp_codes";
