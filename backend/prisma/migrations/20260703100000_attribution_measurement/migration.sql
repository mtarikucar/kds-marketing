-- Faz 0 / Faz 5 foundation: first-touch Lead attribution, organic social-post
-- metrics (the organic mirror of ad_metrics), and ad revenue/ROAS columns —
-- the measurement plumbing the Performance Loop joins spend↔content↔revenue through.

-- AlterTable
ALTER TABLE "ad_metrics" ADD COLUMN     "conversionValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "roas" DECIMAL(10,4);

-- CreateTable
CREATE TABLE "lead_attributions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "clickId" TEXT,
    "clickIdType" TEXT,
    "ctwaClid" TEXT,
    "landingUrl" TEXT,
    "referrerUrl" TEXT,
    "sourceSocialPostId" TEXT,
    "sourceCampaignItemId" TEXT,
    "sourceSocialCampaignId" TEXT,
    "sourceAdCampaignId" TEXT,
    "sourceAdCreativeId" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_post_metrics" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "engagements" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "saves" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "videoViews" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "raw" JSONB,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_attributions_leadId_key" ON "lead_attributions"("leadId");

-- CreateIndex
CREATE INDEX "lead_attributions_workspaceId_sourceSocialPostId_idx" ON "lead_attributions"("workspaceId", "sourceSocialPostId");

-- CreateIndex
CREATE INDEX "lead_attributions_workspaceId_sourceAdCampaignId_idx" ON "lead_attributions"("workspaceId", "sourceAdCampaignId");

-- CreateIndex
CREATE INDEX "lead_attributions_workspaceId_ctwaClid_idx" ON "lead_attributions"("workspaceId", "ctwaClid");

-- CreateIndex
CREATE INDEX "lead_attributions_workspaceId_clickId_idx" ON "lead_attributions"("workspaceId", "clickId");

-- CreateIndex
CREATE INDEX "social_post_metrics_workspaceId_date_idx" ON "social_post_metrics"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "social_post_metrics_targetId_date_key" ON "social_post_metrics"("targetId", "date");

-- AddForeignKey
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_metrics" ADD CONSTRAINT "social_post_metrics_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "social_post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

