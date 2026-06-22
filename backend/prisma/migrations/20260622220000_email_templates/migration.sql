-- Epic 8: email block builder + EmailTemplate (GoHighLevel parity).
-- New table + two additive nullable Campaign columns — safe on one replica.
CREATE TABLE "email_templates" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "blocks"       JSONB NOT NULL,
  "theme"        JSONB,
  "compiledHtml" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_templates_workspaceId_idx" ON "email_templates"("workspaceId");

ALTER TABLE "campaigns" ADD COLUMN "bodyHtml" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "emailTemplateId" TEXT;
