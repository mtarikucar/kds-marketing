-- A/B winner mode (audit A2). Additive: nullable columns only.
ALTER TABLE "campaigns" ADD COLUMN "abMode" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "abTestPercent" INTEGER;
ALTER TABLE "campaigns" ADD COLUMN "abWinnerMetric" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "abWinnerKey" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "abDecideAt" TIMESTAMP(3);
