-- Promotion: an APPROVED concept becomes one campaign item, exactly once.
--
-- Two links, written in the same transaction, each doing a job the other
-- cannot.
--
-- 1) social_campaign_items.contentConceptId — UNIQUE. This is the whole
--    idempotency guarantee. Promotion is "read the concept, then create the
--    item", and a read-then-create guard cannot stop a double-create: two
--    concurrent transactions each read "no item yet" (neither can see the
--    other's uncommitted row) and both insert. The unique index makes Postgres
--    reject the second, and the loser reads the winner's item back instead.
--    Nullable because the overwhelming majority of items are still planned by
--    the campaign's own cadence tick and were never a concept.
--
--    It is also how the SHOT PLAN reaches production. The plan is NOT copied
--    onto the item: a copy would be a second source of truth for a document the
--    concept already owns, and the concept is immutable after review (a concept
--    is decided once), so the usual argument for snapshotting — the source can
--    change underneath you — does not apply here.
--
-- 2) content_concepts.promotedItemId — NOT unique, on purpose. A unique index
--    here would only forbid two concepts naming ONE item, which is not a race
--    that exists; the race is one concept producing two items, and (1) is what
--    refuses it. This column exists so the review queue can distinguish
--    "approved" from "approved and already in production" without a join, on a
--    table that has no foreign keys and therefore no Prisma relation to
--    traverse.
ALTER TABLE "social_campaign_items" ADD COLUMN IF NOT EXISTS "contentConceptId" TEXT;
ALTER TABLE "content_concepts" ADD COLUMN IF NOT EXISTS "promotedItemId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "social_campaign_items_contentConceptId_key"
    ON "social_campaign_items"("contentConceptId");
