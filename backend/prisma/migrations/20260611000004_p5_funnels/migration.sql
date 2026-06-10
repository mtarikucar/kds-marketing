-- P5: funnels/sites + forms + booking. Additive (four new tables).

CREATE TABLE "site_pages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "seo" JSONB,
    "theme" JSONB,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_pages_workspaceId_slug_key" ON "site_pages"("workspaceId", "slug");
CREATE INDEX "site_pages_workspaceId_idx" ON "site_pages"("workspaceId");

CREATE TABLE "form_defs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "redirectUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "form_defs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "form_defs_workspaceId_idx" ON "form_defs"("workspaceId");

CREATE TABLE "booking_calendars" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "availability" JSONB NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "booking_calendars_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_calendars_workspaceId_slug_key" ON "booking_calendars"("workspaceId", "slug");
CREATE INDEX "booking_calendars_workspaceId_idx" ON "booking_calendars"("workspaceId");

CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "leadId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bookings_token_key" ON "bookings"("token");
CREATE INDEX "bookings_calendarId_startAt_idx" ON "bookings"("calendarId", "startAt");
CREATE INDEX "bookings_workspaceId_idx" ON "bookings"("workspaceId");
