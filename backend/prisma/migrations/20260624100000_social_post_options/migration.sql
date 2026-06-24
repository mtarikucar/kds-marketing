-- Per-target publish formats + uploaded-media descriptors (R2 cleanup) live in
-- this additive JSON column. Nullable, no default — existing rows are unaffected.
ALTER TABLE "social_posts" ADD COLUMN "options" JSONB;
