-- İçerik Programı: content types, the programme, its calendar slots, the
-- learning snapshots, trend signals and the "why" log — plus the links from the
-- publishing campaign and the concept back to the programme.
-- docs/superpowers/specs/2026-09-08-icerik-programi-otonom-dongu-design.md

-- AlterTable: the campaign a programme publishes through
ALTER TABLE "social_campaigns" ADD COLUMN "programmeId" TEXT;
CREATE INDEX "social_campaigns_workspaceId_programmeId_idx" ON "social_campaigns"("workspaceId", "programmeId");

-- AlterTable: a concept planned under a type, for a slot
ALTER TABLE "content_concepts" ADD COLUMN "contentTypeKey" TEXT,
ADD COLUMN "programmeId" TEXT,
ADD COLUMN "slotId" TEXT;
CREATE INDEX "content_concepts_workspaceId_programmeId_idx" ON "content_concepts"("workspaceId", "programmeId");

-- CreateTable
CREATE TABLE "content_types" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "structure" JSONB NOT NULL DEFAULT '[]',
    "defaultDurationSec" INTEGER NOT NULL DEFAULT 15,
    "networks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minShare" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "maxShare" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSeed" BOOLEAN NOT NULL DEFAULT true,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_programmes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "socialCampaignId" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT 'COMPOSITE',
    "brief" TEXT NOT NULL,
    "personaId" TEXT,
    "perWeek" INTEGER NOT NULL DEFAULT 5,
    "weeklyCreditCap" INTEGER NOT NULL DEFAULT 600,
    "explorationRate" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "maturityHours" INTEGER NOT NULL DEFAULT 72,
    "halfLifeDays" INTEGER NOT NULL DEFAULT 30,
    "editWindowHours" INTEGER NOT NULL DEFAULT 2,
    "lookaheadDays" INTEGER NOT NULL DEFAULT 14,
    "planLeadHours" INTEGER NOT NULL DEFAULT 36,
    "produceLeadHours" INTEGER NOT NULL DEFAULT 12,
    "seedWeeks" INTEGER NOT NULL DEFAULT 2,
    "phase" TEXT NOT NULL DEFAULT 'SEED',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "lastPlannedAt" TIMESTAMP(3),
    "lastMeasuredAt" TIMESTAMP(3),
    "lastReweightedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_slots" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "contentTypeId" TEXT NOT NULL,
    "contentTypeKey" TEXT NOT NULL,
    "selectionReason" TEXT NOT NULL,
    "trendSignalId" TEXT,
    "trendTitle" TEXT,
    "idea" TEXT NOT NULL,
    "conceptId" TEXT,
    "campaignItemId" TEXT,
    "socialPostId" TEXT,
    "quotedCredits" INTEGER,
    "spentCredits" INTEGER NOT NULL DEFAULT 0,
    "editableUntil" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "measuredAt" TIMESTAMP(3),
    "reward" DOUBLE PRECISION,
    "rewardBreakdown" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_type_stats" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "contentTypeId" TEXT NOT NULL,
    "contentTypeKey" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "alpha" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "beta" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "meanReward" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_type_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_signals" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'TR',
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ref" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "halfLifeHours" INTEGER NOT NULL DEFAULT 48,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trend_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_programme_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_programme_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_types_workspaceId_key_key" ON "content_types"("workspaceId", "key");
CREATE INDEX "content_types_workspaceId_active_idx" ON "content_types"("workspaceId", "active");
CREATE UNIQUE INDEX "content_programmes_socialCampaignId_key" ON "content_programmes"("socialCampaignId");
CREATE INDEX "content_programmes_workspaceId_status_idx" ON "content_programmes"("workspaceId", "status");
CREATE UNIQUE INDEX "content_slots_programmeId_scheduledFor_key" ON "content_slots"("programmeId", "scheduledFor");
CREATE INDEX "content_slots_workspaceId_programmeId_status_idx" ON "content_slots"("workspaceId", "programmeId", "status");
CREATE INDEX "content_slots_workspaceId_programmeId_scheduledFor_idx" ON "content_slots"("workspaceId", "programmeId", "scheduledFor");
CREATE INDEX "content_type_stats_programmeId_computedAt_idx" ON "content_type_stats"("programmeId", "computedAt");
CREATE INDEX "content_type_stats_type_network_time_idx" ON "content_type_stats"("programmeId", "contentTypeKey", "network", "computedAt");
CREATE UNIQUE INDEX "trend_signals_region_network_kind_title_key" ON "trend_signals"("region", "network", "kind", "title");
CREATE INDEX "trend_signals_region_observedAt_idx" ON "trend_signals"("region", "observedAt");
CREATE INDEX "content_programme_events_programmeId_createdAt_idx" ON "content_programme_events"("programmeId", "createdAt");
