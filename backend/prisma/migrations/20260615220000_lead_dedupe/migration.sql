-- Migration: lead duplicate-detection match keys + merge tombstone (Epic A4)

ALTER TABLE "leads" ADD COLUMN "phoneNormalized" TEXT;
ALTER TABLE "leads" ADD COLUMN "emailNormalized" TEXT;
ALTER TABLE "leads" ADD COLUMN "mergedIntoId"    TEXT;
ALTER TABLE "leads" ADD COLUMN "mergedAt"        TIMESTAMP(3);

-- Backfill the normalized keys from existing data (digits-only phone, lowercased
-- trimmed email). Going forward these are maintained by the leads service.
UPDATE "leads" SET "emailNormalized" = lower(trim("email")) WHERE "email" IS NOT NULL;
UPDATE "leads" SET "phoneNormalized" = regexp_replace("phone", '[^0-9]', '', 'g') WHERE "phone" IS NOT NULL;

CREATE INDEX "leads_workspaceId_phoneNormalized_idx" ON "leads" ("workspaceId", "phoneNormalized");
CREATE INDEX "leads_workspaceId_emailNormalized_idx" ON "leads" ("workspaceId", "emailNormalized");
CREATE INDEX "leads_mergedIntoId_idx" ON "leads" ("mergedIntoId");
