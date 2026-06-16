-- Migration: GDPR/KVKK consent log + data subject requests (Epic F compliance)

CREATE TABLE "consent_records" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "granted"     BOOLEAN NOT NULL,
  "source"      TEXT,
  "ipAddress"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_records_workspaceId_leadId_type_idx" ON "consent_records" ("workspaceId", "leadId", "type");

CREATE TABLE "data_requests" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "leadId"        TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "payload"       JSONB,
  "requestedById" TEXT,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"   TIMESTAMP(3),
  CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "data_requests_workspaceId_status_idx" ON "data_requests" ("workspaceId", "status");
