-- Epic 4a: workflow goals (GoHighLevel parity).
-- Additive, nullable column — safe to deploy ahead of the code on a single replica.
ALTER TABLE "workflows" ADD COLUMN "goal" JSONB;
