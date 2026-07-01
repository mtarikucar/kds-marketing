-- Manual rollback for 20260701120000_booking_conferencing (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up added,
-- idempotent (IF EXISTS) and scoped to the conferencing columns only.
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "meetingUrl";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceProvider";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceId";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceStatus";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "conferencing";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "conferenceConfig";
