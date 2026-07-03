-- Default GLOBAL (workspaceId NULL) TR channel tariffs so the Budget Autopilot
-- can price conversation & content spend out of the box. Approximate defaults —
-- a workspace row overrides any of these. Idempotent (fixed ids + ON CONFLICT).
INSERT INTO "channel_tariffs"
  ("id","workspaceId","channel","provider","unitType","unitCost","currency","country","effectiveFrom","active","createdAt","updatedAt")
VALUES
  ('9e5f0000-0000-4000-8000-000000000001', NULL, 'SMS',      'netgsm', 'SMS_SEGMENT',  0.9000, 'TRY', 'TR', '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-000000000002', NULL, 'WHATSAPP', 'meta',   'WA_MARKETING', 0.3600, 'TRY', 'TR', '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-000000000003', NULL, 'WHATSAPP', 'meta',   'WA_UTILITY',   0.1800, 'TRY', 'TR', '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-000000000004', NULL, 'WHATSAPP', 'meta',   'WA_SERVICE',   0.0000, 'TRY', 'TR', '2026-01-01T00:00:00Z', true, now(), now()),
  ('9e5f0000-0000-4000-8000-000000000005', NULL, 'VOICE',    'netgsm', 'VOICE_MINUTE', 0.2000, 'TRY', 'TR', '2026-01-01T00:00:00Z', true, now(), now())
ON CONFLICT ("id") DO NOTHING;
