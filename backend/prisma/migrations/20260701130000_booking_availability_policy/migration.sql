-- Phase 2: booking policy columns + blackout/time-off + per-member availability.
-- All calendar columns are additive with safe defaults (existing calendars keep
-- today's behaviour except maxAdvanceDays=60 replacing the old hard-coded 21-day
-- cap). New tables are empty until an admin populates them.

ALTER TABLE "booking_calendars" ADD COLUMN "minNoticeMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "booking_calendars" ADD COLUMN "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "booking_calendars" ADD COLUMN "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "booking_calendars" ADD COLUMN "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "booking_calendars" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "booking_calendars" ADD COLUMN "reminderConfig" JSONB;

ALTER TABLE "bookings" ADD COLUMN "attendeeTimezone" TEXT;
ALTER TABLE "bookings" ADD COLUMN "rescheduledFromId" TEXT;

CREATE TABLE "booking_blackouts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "calendarId" TEXT,
    "marketingUserId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_blackouts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "booking_blackouts_workspaceId_calendarId_idx" ON "booking_blackouts"("workspaceId", "calendarId");
CREATE INDEX "booking_blackouts_workspaceId_marketingUserId_idx" ON "booking_blackouts"("workspaceId", "marketingUserId");

CREATE TABLE "member_availability" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "marketingUserId" TEXT NOT NULL,
    "availability" JSONB NOT NULL,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "member_availability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "member_availability_calendarId_marketingUserId_key" ON "member_availability"("calendarId", "marketingUserId");
CREATE INDEX "member_availability_workspaceId_idx" ON "member_availability"("workspaceId");
