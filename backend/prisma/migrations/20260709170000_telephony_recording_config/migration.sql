-- NetGSM Phase 4 Task 1 — call-recording toggle + PBX record flags.
-- TelephonyConfig.recordCalls gates whether NetgsmApiAdapter passes
-- caller_record/called_record=1 to Netsantral's linkup/originate; OFF by
-- default (KVKK requires a caller announcement before recording, so this
-- must be an explicit opt-in). recordingRetentionDays (null = keep forever)
-- drives the Task 2 retention sweep. SalesCall.recordingStorageKey is the R2
-- object key once Task 2's ingest sweep has downloaded the provider
-- recording into stable storage. Additive only; no existing data touched.
ALTER TABLE "telephony_configs" ADD COLUMN IF NOT EXISTS "recordCalls" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telephony_configs" ADD COLUMN IF NOT EXISTS "recordingRetentionDays" INTEGER;
ALTER TABLE "sales_calls" ADD COLUMN IF NOT EXISTS "recordingStorageKey" TEXT;
