-- Epic 13 review-sync (inert until Google Business / FB page token). Additive.
ALTER TABLE "review_sources" ADD COLUMN "placeId" TEXT;
ALTER TABLE "review_sources" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "review_sources" ADD COLUMN "externalRef" TEXT;
ALTER TABLE "review_sources" ADD COLUMN "syncStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "review_sources" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN "lastError" TEXT;

ALTER TABLE "reviews" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'GATE';
ALTER TABLE "reviews" ADD COLUMN "externalReviewId" TEXT;
ALTER TABLE "reviews" ADD COLUMN "authoredAt" TIMESTAMP(3);
-- Idempotency for the sync: one row per (source, provider review id). NULLs are
-- distinct in Postgres, so existing gate reviews (sourceId/externalReviewId null)
-- are unaffected.
CREATE UNIQUE INDEX "reviews_sourceId_externalReviewId_key" ON "reviews"("sourceId", "externalReviewId");
