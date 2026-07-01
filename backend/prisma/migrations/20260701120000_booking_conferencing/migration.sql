-- Conferencing (Phase 1): attach a Google Meet / Teams join link to bookings.
-- All additive + nullable (the calendar flag defaults to 'NONE'), so this is
-- safe on populated tables and inert until a calendar opts a provider in.
ALTER TABLE "bookings" ADD COLUMN "meetingUrl" TEXT;
ALTER TABLE "bookings" ADD COLUMN "conferenceProvider" TEXT;
ALTER TABLE "bookings" ADD COLUMN "conferenceId" TEXT;
ALTER TABLE "bookings" ADD COLUMN "conferenceStatus" TEXT;

ALTER TABLE "booking_calendars" ADD COLUMN "conferencing" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "booking_calendars" ADD COLUMN "conferenceConfig" JSONB;
