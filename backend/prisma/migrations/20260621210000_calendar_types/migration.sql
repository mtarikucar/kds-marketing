-- Migration: Calendar types (GoHighLevel parity)
--
-- Adds GHL calendar types to booking_calendars (SINGLE | ROUND_ROBIN |
-- COLLECTIVE | CLASS) with a per-slot capacity, a team-member join table for
-- round-robin/collective, and an assignee on each booking. Additive + defaulted
-- columns only — existing SINGLE calendars keep their exact behavior.

-- AlterTable
ALTER TABLE "booking_calendars" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "booking_calendars" ADD COLUMN "capacity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "assigneeUserId" TEXT;

-- CreateTable
CREATE TABLE "booking_calendar_members" (
    "id"              TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "calendarId"      TEXT NOT NULL,
    "marketingUserId" TEXT NOT NULL,
    "priority"        INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_calendar_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_calendar_members_calendarId_marketingUserId_key" ON "booking_calendar_members"("calendarId", "marketingUserId");
CREATE INDEX "booking_calendar_members_workspaceId_calendarId_idx" ON "booking_calendar_members"("workspaceId", "calendarId");

-- AddForeignKey
ALTER TABLE "booking_calendar_members" ADD CONSTRAINT "booking_calendar_members_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "booking_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
