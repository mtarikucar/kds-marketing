-- The database backstop for v2.203.0.
--
-- A channel's (type, externalId) is the provider identity inbound webhooks route
-- by, and PublicChannelResolverService.byExternalId resolves it with a findFirst
-- and no ordering. Two ACTIVE rows sharing one identity therefore means a
-- customer's messages land in whichever tenant Postgres happens to scan first.
--
-- v2.203.0 closed the logic hole (the registration guard is now blind to
-- `status`, and re-activation re-checks). What it cannot close is the race:
-- create() reads then writes, so two concurrent requests in different
-- workspaces can both pass the check. Only a constraint fixes that.

-- Existing duplicates have to go first, or CREATE UNIQUE INDEX fails -- and
-- since `prisma migrate deploy` runs on boot, a failure here would stop the
-- container from starting.
--
-- Which row keeps the identity, in order:
--   1. the one holding credentials for it (configSealed) -- registering a
--      channel needs no secrets, so this is the closest thing to proof of
--      ownership the data has
--   2. an ACTIVE row over a disabled one
--   3. the oldest
--
-- The losers keep every row of their history and only give up the identity:
-- externalId is set NULL (Postgres treats NULLs as distinct, so they fall
-- outside the constraint) and the channel is disabled, because a channel that
-- can no longer receive anything should not claim to be live.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "type", "externalId"
      ORDER BY
        ("configSealed" IS NOT NULL) DESC,
        ("status" = 'ACTIVE') DESC,
        "createdAt" ASC
    ) AS rn
  FROM "channels"
  WHERE "externalId" IS NOT NULL
)
UPDATE "channels" c
SET "externalId" = NULL,
    "status" = 'DISABLED'
FROM ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- Replaces @@index([type, externalId]); a unique index serves the same lookups.
DROP INDEX IF EXISTS "channels_type_externalId_idx";

CREATE UNIQUE INDEX "channels_type_externalId_key" ON "channels" ("type", "externalId");
