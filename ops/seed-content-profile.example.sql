-- Seed one opt-in profile for the content-pack routine (#2).
-- The content-pack routine ONLY processes workspaces that have an ACTIVE
-- content_profiles row, so seed at least one before enabling that routine.
-- (The other three routines need no seeding.)
--
-- Runs AFTER the content_pack migration is applied (prisma migrate deploy).
-- Edit <WORKSPACE_ID> + the brief fields, then run against the prod DB:
--   psql "$DATABASE_URL" -f ops/seed-content-profile.example.sql
--   # or: npx prisma db execute --file ops/seed-content-profile.example.sql --schema prisma/schema.prisma  (from backend/)

INSERT INTO "content_profiles"
  ("id", "workspaceId", "name", "status", "themes", "voice", "counts", "language", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),                                  -- PG13+ (or replace with an explicit uuid)
  '<WORKSPACE_ID>',                                   -- ← the workspace to generate content for
  'Default weekly pack',
  'ACTIVE',
  'Ürün avantajları, müşteri başarı hikayeleri, sezonluk kampanyalar, sektör ipuçları',  -- themes (edit)
  'Sıcak, profesyonel, kısa ve net',                  -- voice/tone (nullable; edit or set NULL)
  '{"social": 5, "email": 2, "sms": 1}'::jsonb,       -- per-channel counts (server clamps: social≤10, email≤5, sms≤5)
  'tr',                                               -- output language (ISO 639-1)
  NOW(), NOW()
);
