-- AI Social Content Studio — Social Campaign engine (Milestone 3).
-- Additive only: new enums + two tables, two nullable columns on social_posts,
-- and the FK wiring the pre-existing generated_assets.socialCampaignId column to
-- the new social_campaigns table. Safe on populated tables; no backfill needed.

CREATE TYPE "SocialCampaignStatus" AS ENUM ('DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED');
CREATE TYPE "SocialCampaignAutomationMode" AS ENUM ('APPROVAL','SEMI_AUTO','FULL_AUTO');
CREATE TYPE "SocialCampaignPlanningMode" AS ENUM ('AI_PROPOSE','AI_FULL','USER_TOPICS');
CREATE TYPE "SocialCampaignItemStatus" AS ENUM ('PLANNED','GENERATING','NEEDS_APPROVAL','APPROVED','SCHEDULED','PUBLISHED','FAILED','SKIPPED');

CREATE TABLE "social_campaigns" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "goal" TEXT,
  "theme" TEXT,
  "brief" JSONB NOT NULL,
  "status" "SocialCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "automationMode" "SocialCampaignAutomationMode" NOT NULL,
  "planningMode" "SocialCampaignPlanningMode" NOT NULL,
  "cadence" JSONB NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3),
  "targetAccountIds" TEXT[],
  "mediaKinds" TEXT[],
  "defaultImageModel" TEXT,
  "defaultVideoModel" TEXT,
  "dailyPublishCap" INTEGER NOT NULL DEFAULT 2,
  "linkedCampaignId" TEXT,
  "linkedAdCampaignId" TEXT,
  "stats" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_campaigns_workspaceId_status_idx" ON "social_campaigns"("workspaceId","status");

CREATE TABLE "social_campaign_items" (
  "id" TEXT NOT NULL,
  "socialCampaignId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sequenceIndex" INTEGER NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" "SocialCampaignItemStatus" NOT NULL DEFAULT 'PLANNED',
  "topic" TEXT,
  "socialPostId" TEXT,
  "generatedAssetIds" TEXT[],
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_campaign_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_campaign_items_socialCampaignId_status_idx" ON "social_campaign_items"("socialCampaignId","status");
CREATE INDEX "social_campaign_items_workspaceId_status_idx" ON "social_campaign_items"("workspaceId","status");

ALTER TABLE "social_posts" ADD COLUMN "socialCampaignId" TEXT;
ALTER TABLE "social_posts" ADD COLUMN "campaignItemId" TEXT;
CREATE INDEX "social_posts_socialCampaignId_idx" ON "social_posts"("socialCampaignId");

ALTER TABLE "social_campaign_items"
  ADD CONSTRAINT "social_campaign_items_socialCampaignId_fkey"
  FOREIGN KEY ("socialCampaignId") REFERENCES "social_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_assets"
  ADD CONSTRAINT "generated_assets_socialCampaignId_fkey"
  FOREIGN KEY ("socialCampaignId") REFERENCES "social_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
