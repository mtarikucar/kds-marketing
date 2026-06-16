-- Migration: affiliate manager (workspace-scoped affiliates, referrals, commissions)
CREATE TABLE "affiliates" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "code"            TEXT NOT NULL,
  "commissionType"  TEXT NOT NULL,
  "commissionValue" DECIMAL(10,2) NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "affiliates_workspaceId_code_key" ON "affiliates" ("workspaceId", "code");
CREATE INDEX "affiliates_workspaceId_status_idx" ON "affiliates" ("workspaceId", "status");

CREATE TABLE "affiliate_referrals" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "affiliateId"    TEXT NOT NULL,
  "referredLeadId" TEXT,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "convertedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affiliate_referrals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_referrals_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "affiliate_referrals_workspaceId_affiliateId_idx" ON "affiliate_referrals" ("workspaceId", "affiliateId");
CREATE INDEX "affiliate_referrals_workspaceId_status_idx" ON "affiliate_referrals" ("workspaceId", "status");

CREATE TABLE "affiliate_commissions" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "referralId"  TEXT NOT NULL,
  "amount"      DECIMAL(10,2) NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'OWED',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "affiliate_commissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "affiliate_commissions_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "affiliate_commissions_referralId_fkey"
    FOREIGN KEY ("referralId") REFERENCES "affiliate_referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "affiliate_commissions_workspaceId_affiliateId_idx" ON "affiliate_commissions" ("workspaceId", "affiliateId");
CREATE INDEX "affiliate_commissions_workspaceId_status_idx" ON "affiliate_commissions" ("workspaceId", "status");
