-- Epic 6: Companies / B2B contact-company hierarchy (GoHighLevel parity).
-- New table + a nullable Lead.companyId — additive only, safe on one replica.
CREATE TABLE "companies" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "domain"       TEXT,
  "phone"        TEXT,
  "email"        TEXT,
  "address"      TEXT,
  "city"         TEXT,
  "notes"        TEXT,
  "customFields" JSONB,
  "archived"     BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "companies_workspaceId_archived_idx" ON "companies"("workspaceId", "archived");

ALTER TABLE "leads" ADD COLUMN "companyId" TEXT;
CREATE INDEX "leads_workspaceId_companyId_idx" ON "leads"("workspaceId", "companyId");
