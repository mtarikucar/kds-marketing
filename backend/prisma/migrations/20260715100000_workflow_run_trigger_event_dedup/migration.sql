-- Durable idempotency for LEADLESS workflow enrollment. The existing
-- workflow_runs_active_per_lead index only dedupes runs whose leadId IS NOT
-- NULL, so a leadless trigger (webhook.received, an anonymous
-- conversation.message.received, a leadless link.clicked) double-enrolled on
-- the outbox's at-least-once redelivery — the same source event, redelivered
-- after a mid-dispatch pod restart, minted a second run (duplicate
-- emails/tasks/SMS). Key the dedup on the STABLE source event id (the outbox
-- row id, re-dispatched unchanged on redelivery) so a redelivered event trips
-- P2002 and start() returns a no-op. Idempotent (IF NOT EXISTS).
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "triggerEventId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_trigger_event"
  ON "workflow_runs" ("workflowId", "triggerEventId")
  WHERE "triggerEventId" IS NOT NULL;
