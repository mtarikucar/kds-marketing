-- Default GLOBAL (workspaceId NULL) tariffs for the native AI Research engine so
-- firecrawl/apify/per-lead cost can settle into the workspace budget out of the
-- box. Approximate TRY defaults (with platform markup) — a workspace row
-- overrides any of these. Idempotent (fixed ids + ON CONFLICT).
INSERT INTO "channel_tariffs"
  ("id","workspaceId","channel","provider","unitType","unitCost","currency","country","effectiveFrom","active","createdAt","updatedAt")
VALUES
  ('9e5f0000-0000-4000-8000-0000000000a1', NULL, 'RESEARCH', 'firecrawl', 'FIRECRAWL_PAGE', 0.0500, 'TRY', NULL, '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-0000000000a2', NULL, 'RESEARCH', 'apify',     'APIFY_RUN',      0.5000, 'TRY', NULL, '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-0000000000a3', NULL, 'RESEARCH', 'jeeta',     'RESEARCH_LEAD',  2.0000, 'TRY', NULL, '2026-01-01T00:00:00Z', true, now(), now())
ON CONFLICT ("id") DO NOTHING;
