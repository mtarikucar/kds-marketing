-- Epic 9b: A/B split testing for campaigns (GoHighLevel parity).
-- New table + two additive columns — safe on one replica.
ALTER TABLE "campaigns" ADD COLUMN "abEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaign_recipients" ADD COLUMN "variantKey" TEXT;

CREATE TABLE "campaign_variants" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "campaignId"      TEXT NOT NULL,
  "key"             TEXT NOT NULL,
  "weight"          INTEGER NOT NULL DEFAULT 1,
  "subject"         TEXT,
  "body"            TEXT NOT NULL,
  "bodyHtml"        TEXT,
  "emailTemplateId" TEXT,
  "stats"           JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_variants_campaignId_key_key" ON "campaign_variants"("campaignId", "key");
CREATE INDEX "campaign_variants_workspaceId_idx" ON "campaign_variants"("workspaceId");
CREATE INDEX "campaign_variants_campaignId_idx" ON "campaign_variants"("campaignId");
