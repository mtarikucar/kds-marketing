-- Phase-3 final-review HIGH-2 fix — SalesCall.outcomeLoggedAt tracks whether a
-- REP has manually logged an outcome for this call, independent of `status`
-- (which TelephonyEventConsumer/CallCdrSyncService may already have
-- finalized before the rep gets to it). SalesCallService.logCall's atomic
-- claim moves from `where:{status:'INITIATED'}` to
-- `where:{outcomeLoggedAt:null}` so a webhook-finalized row can still be
-- merged onto (notes attached) instead of 409ing — this column is what makes
-- "already manually logged" a concept independent from "already
-- webhook-finalized". Additive only; no existing data touched or deleted.
ALTER TABLE "sales_calls" ADD COLUMN IF NOT EXISTS "outcomeLoggedAt" TIMESTAMP(3);
