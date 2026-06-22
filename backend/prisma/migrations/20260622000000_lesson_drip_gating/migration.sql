-- Epic 10a: lesson drip / gating. Additive, defaulted/nullable columns.
ALTER TABLE "lessons" ADD COLUMN "gating" TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE "lessons" ADD COLUMN "dripDays" INTEGER;
ALTER TABLE "courses" ADD COLUMN "dripMode" TEXT;
