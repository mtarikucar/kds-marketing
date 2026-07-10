-- Phase 3 Task 2 MEDIUM follow-up — DB-atomic guard against duplicate INBOUND
-- SalesCall rows. handleInboundCall/handleTerminal's findFirst-then-create on
-- externalCallId (20260709140000) is a classic TOCTOU race: two DIFFERENT
-- events for the same brand-new call (an `inbound_call` and an out-of-order
-- hangup/cdr) can both see no existing row and both insert — each spawning
-- its own missed-call follow-up task + marketing.call.missed.v1. A plain
-- index only sped up the read; it never stopped the double-insert.
--
-- Postgres excludes any row with a NULL in the tuple from a standard UNIQUE
-- index (NULLS DISTINCT is the default — deliberately NOT overridden to
-- NULLS NOT DISTINCT here), so OUTBOUND rows are unaffected: externalCallId
-- stays null until the CDR/event backfill runs, and may never get one at all
-- for click-to-dial (netgsm-lite). Only two rows in the same workspace
-- sharing the same NON-NULL externalCallId collide, which is exactly the
-- duplicate this guards against.
--
-- Existing-data assumption: a santral `uniqueId` identifies one physical call
-- leg, and OUTBOUND vs. INBOUND legs never share one (OUTBOUND's
-- externalCallId is either the netsantral originate response's own call id,
-- later reconciled via crm_id correlation onto the SAME row, or backfilled
-- from a santral event that correlates by crm_id first — never by a second
-- insert). If this assumption is ever wrong for some pre-existing dataset,
-- this ADD fails loudly (Postgres reports the exact duplicated key) rather
-- than silently dropping/merging rows — deliberately no dedupe step here.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_calls_workspaceId_externalCallId_key"
  ON "sales_calls"("workspaceId", "externalCallId");

DROP INDEX IF EXISTS "sales_calls_externalCallId_idx";
