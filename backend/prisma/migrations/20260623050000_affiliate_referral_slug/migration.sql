-- Affiliate referral loop: a globally-unique public referral slug for /r/:slug.
-- Additive: nullable column + unique index (NULLs don't collide in Postgres).
ALTER TABLE "affiliates" ADD COLUMN "referralSlug" TEXT;
CREATE UNIQUE INDEX "affiliates_referralSlug_key" ON "affiliates"("referralSlug");
