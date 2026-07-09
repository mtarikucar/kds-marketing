-- Granular ad-level breakdown metrics (creative/adset × placement OR demographic)
-- in a SEPARATE table so the campaign-day AdMetric rollup stays untouched.
CREATE TABLE "ad_metric_breakdowns" (
  "id"               TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL,
  "adAccountId"      TEXT NOT NULL,
  "date"             DATE NOT NULL,
  "level"            TEXT NOT NULL DEFAULT 'ad',
  "campaignId"       TEXT NOT NULL DEFAULT '',
  "adSetId"          TEXT NOT NULL DEFAULT '',
  "adSetName"        TEXT,
  "adId"             TEXT NOT NULL DEFAULT '',
  "adName"           TEXT,
  "placement"        TEXT NOT NULL DEFAULT '',
  "breakdownType"    TEXT NOT NULL DEFAULT '',
  "breakdownValue"   TEXT NOT NULL DEFAULT '',
  "spend"            DECIMAL(14,2) NOT NULL DEFAULT 0,
  "impressions"      INTEGER NOT NULL DEFAULT 0,
  "clicks"           INTEGER NOT NULL DEFAULT 0,
  "leads"            INTEGER NOT NULL DEFAULT 0,
  "conversionValue"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "leads1dClick"     INTEGER NOT NULL DEFAULT 0,
  "leads7dClick"     INTEGER NOT NULL DEFAULT 0,
  "leads1dView"      INTEGER NOT NULL DEFAULT 0,
  "convValue1dClick" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "convValue7dClick" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "convValue1dView"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "pulledAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_metric_breakdowns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "adBreakdown_dim" ON "ad_metric_breakdowns"("adAccountId","date","campaignId","adSetId","adId","placement","breakdownType","breakdownValue");
CREATE INDEX "ad_metric_breakdowns_workspaceId_date_idx" ON "ad_metric_breakdowns"("workspaceId","date");
CREATE INDEX "ad_metric_breakdowns_adAccountId_campaignId_date_idx" ON "ad_metric_breakdowns"("adAccountId","campaignId","date");
