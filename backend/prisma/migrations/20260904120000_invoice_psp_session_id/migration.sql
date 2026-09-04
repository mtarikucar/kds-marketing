-- The Stripe checkout session an invoice's buyer was sent to.
--
-- Stripe confirms a payment by sending the BUYER back to a return URL. A buyer
-- who pays and then closes the tab never makes that request: the money is taken
-- and the invoice stays SENT forever. PayTR and iyzico post server-to-server
-- and have no such hole, which is why this is a Stripe-shaped column.
--
-- Nullable, no backfill: rows written before this existed have no session to
-- record, and the reconcile sweep filters on `pspSessionId IS NOT NULL` — so an
-- old row is skipped rather than probed with nothing.
ALTER TABLE "Invoice" ADD COLUMN "pspSessionId" TEXT;

-- The sweep's own predicate. Partial, because it only ever asks about invoices
-- that are still waiting and actually have a session to ask about — which on a
-- healthy workspace is a handful of rows out of every invoice ever issued.
CREATE INDEX IF NOT EXISTS "Invoice_pending_stripe_session_idx"
  ON "Invoice" ("workspaceId", "createdAt")
  WHERE "status" = 'SENT' AND "pspSessionId" IS NOT NULL;
