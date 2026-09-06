-- Reverts the platform RUNWARE_CENT seed only. Workspace overrides (workspaceId
-- NOT NULL) are operator data and are left alone. Safe no-op if already gone.

DELETE FROM "channel_tariffs"
WHERE "workspaceId" IS NULL
  AND "channel" = 'CONTENT'
  AND "unitType" = 'RUNWARE_CENT'
  AND "provider" = 'runware';
