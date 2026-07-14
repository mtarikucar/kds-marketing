-- Invoice numbers are 4 random bytes (8 hex chars) and carried NO uniqueness
-- constraint, so two invoices in a workspace could silently share a number.
-- First re-suffix any pre-existing duplicates (all but the earliest keep their
-- number plus a short id-derived suffix), then enforce uniqueness. Idempotent:
-- after the first pass no duplicates remain, so the UPDATE matches 0 rows and
-- the index CREATE is IF NOT EXISTS.
UPDATE "invoices" i
SET "number" = i."number" || '-' || UPPER(SUBSTRING(i."id", 1, 4))
WHERE EXISTS (
  SELECT 1 FROM "invoices" d
  WHERE d."workspaceId" = i."workspaceId"
    AND d."number" = i."number"
    AND (d."createdAt" < i."createdAt" OR (d."createdAt" = i."createdAt" AND d."id" < i."id"))
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_workspaceId_number_key"
  ON "invoices" ("workspaceId", "number");
