-- Repair Meta accounts stored under the wrong network before the 2026-07-08 guard.
--
-- Meta's Login-for-Business returns BOTH Facebook Pages and linked Instagram
-- accounts, and the flow can be started as either. Until #130 the connected
-- asset was stored under the network of the FLOW, so starting an INSTAGRAM
-- connect and picking a Page wrote network = 'INSTAGRAM' with a Page id in
-- externalId. resolveSocialNetwork() fixed that at the source, but nothing ever
-- repaired the rows already written -- and the publisher routes by network
-- (FACEBOOK -> Page /feed, INSTAGRAM -> IG /media). A Page id sent to /media
-- cannot publish, so those accounts fail on every attempt while the panel shows
-- them connected and healthy. social-oauth.service.ts says exactly this in its
-- own comment: "a Page mis-tagged INSTAGRAM silently fails to publish".
--
-- Two shapes exist and they need different repairs, because
-- @@unique([workspaceId, network, externalId]) means a plain re-tag can collide
-- with a correct row that is already there.

-- 1) No conflicting Facebook row: the account is merely filed under the wrong
--    network. Re-tag it and it works -- the token and the asset are already
--    right, only the label was wrong.
UPDATE "social_accounts" a
SET "network" = 'FACEBOOK'
WHERE a."network" = 'INSTAGRAM'
  AND a."accountType" = 'PAGE'
  AND NOT EXISTS (
    SELECT 1
    FROM "social_accounts" b
    WHERE b."workspaceId" = a."workspaceId"
      AND b."network" = 'FACEBOOK'
      AND b."externalId" = a."externalId"
  );

-- 2) A correct Facebook row for the same Page already exists, so this row is a
--    redundant duplicate and re-tagging it would violate the unique constraint.
--    Disable it rather than delete it: social_post_targets references it with
--    onDelete: Restrict, and its publish history has to stay readable.
--
--    Matching on the duplicate externalId rather than on accountType is
--    deliberate -- it also catches rows written before accountType was
--    recorded. An Instagram business id is never equal to its Page id, so an
--    INSTAGRAM row sharing an externalId with a FACEBOOK row in the same
--    workspace is definitionally a mis-tagged Page.
UPDATE "social_accounts" a
SET "enabled" = false,
    "lastError" = 'mistagged_page_superseded'
WHERE a."network" = 'INSTAGRAM'
  AND a."enabled" = true
  AND EXISTS (
    SELECT 1
    FROM "social_accounts" b
    WHERE b."workspaceId" = a."workspaceId"
      AND b."network" = 'FACEBOOK'
      AND b."externalId" = a."externalId"
  );
