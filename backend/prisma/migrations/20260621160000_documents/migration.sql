-- Migration: E-signature Documents / Contracts (GoHighLevel parity, increment 1)
--
-- A manager authors a document and SENDS it (freezes a body snapshot + consent
-- statement, mints a public token); a signer reviews the frozen body, types
-- their full name, checks an explicit consent box and signs. Records a simple
-- electronic-signature audit trail (name/email/ip/user-agent/timestamp + frozen
-- consent + body snapshot). New table only — purely additive, safe online
-- migration. publicToken is null until SENT (Postgres permits many NULLs in a
-- unique index).

-- CreateTable
CREATE TABLE "documents" (
    "id"               TEXT NOT NULL,
    "workspaceId"      TEXT NOT NULL,
    "leadId"           TEXT,
    "type"             TEXT NOT NULL DEFAULT 'AGREEMENT',
    "title"            TEXT NOT NULL,
    "body"             TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'DRAFT',
    "publicToken"      TEXT,
    "bodySnapshot"     TEXT,
    "consentStatement" TEXT,
    "sentAt"           TIMESTAMP(3),
    "signerName"       TEXT,
    "signerEmail"      TEXT,
    "signedAt"         TIMESTAMP(3),
    "signerIp"         TEXT,
    "signerUserAgent"  TEXT,
    "declinedAt"       TIMESTAMP(3),
    "voidedAt"         TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_publicToken_key" ON "documents"("publicToken");
CREATE INDEX "documents_workspaceId_status_idx" ON "documents"("workspaceId", "status");
CREATE INDEX "documents_leadId_idx" ON "documents"("leadId");
