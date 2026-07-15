-- Reverse of migration.sql — drop exactly the index + column it added.
DROP INDEX IF EXISTS "workflow_runs_trigger_event";
ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "triggerEventId";
