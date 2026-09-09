-- Reverts 20260908090000_content_programme exactly: the six tables and the four
-- link columns. Idempotent; touches nothing else.
DROP TABLE IF EXISTS "content_programme_events";
DROP TABLE IF EXISTS "trend_signals";
DROP TABLE IF EXISTS "content_type_stats";
DROP TABLE IF EXISTS "content_slots";
DROP TABLE IF EXISTS "content_programmes";
DROP TABLE IF EXISTS "content_types";
DROP INDEX IF EXISTS "content_concepts_workspaceId_programmeId_idx";
ALTER TABLE "content_concepts" DROP COLUMN IF EXISTS "contentTypeKey",
DROP COLUMN IF EXISTS "programmeId",
DROP COLUMN IF EXISTS "slotId";
DROP INDEX IF EXISTS "social_campaigns_workspaceId_programmeId_idx";
ALTER TABLE "social_campaigns" DROP COLUMN IF EXISTS "programmeId";
