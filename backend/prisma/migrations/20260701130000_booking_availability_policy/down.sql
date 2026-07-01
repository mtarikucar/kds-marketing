-- Manual rollback for 20260701130000_booking_availability_policy (Prisma migrate
-- is forward-only; run by hand to revert). Drops exactly what the up added,
-- idempotent (IF EXISTS) and scoped to the Phase-2 policy additions only.
DROP TABLE IF EXISTS "member_availability";
DROP TABLE IF EXISTS "booking_blackouts";

ALTER TABLE "bookings" DROP COLUMN IF EXISTS "rescheduledFromId";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "attendeeTimezone";

ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "reminderConfig";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "requiresApproval";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "bufferAfterMinutes";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "bufferBeforeMinutes";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "maxAdvanceDays";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "minNoticeMinutes";
