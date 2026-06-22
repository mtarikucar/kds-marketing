-- Epic 11a: affiliate self-serve portal. Additive nullable columns.
ALTER TABLE "affiliates" ADD COLUMN "portalTokenHash" TEXT;
ALTER TABLE "affiliates" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "affiliates_portalTokenHash_key" ON "affiliates"("portalTokenHash");
