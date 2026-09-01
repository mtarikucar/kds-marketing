-- The database backstop for the double-publish `attachTargets` could not stop.
--
-- `social_post_targets` has carried two plain indexes and no unique constraint
-- since it was created, which meant the `skipDuplicates: true` on
-- SocialPlannerService.attachTargets' createMany was decoration: skipDuplicates
-- skips rows that would violate a UNIQUE constraint, and there was none to
-- violate. Nothing in the database stopped one post from holding two target
-- rows for the same account.
--
-- That stayed theoretical only while a post holding a PUBLISHED target could
-- not be edited. `unschedulePost` now resets a publish run that died mid-fan-out
-- back to DRAFT, so a draft CAN hold a live target; the composer prefills its
-- account picker from every target, the caller's deleteMany clears only the
-- PENDING rows, and the next save inserted a second PENDING row beside the
-- PUBLISHED one. `publishDuePost` fans out over every PENDING target it finds,
-- so the customer's own feed got the post twice.
--
-- attachTargets now excludes already-attached accounts in application code as
-- well; this is the half that also holds against a concurrent second writer and
-- against any future caller that forgets.

-- Pre-existing duplicates have to go first, or CREATE UNIQUE INDEX fails — and
-- since `prisma migrate deploy` runs on boot, a failure here would stop the
-- container from starting. There may be legitimate historical ones: before this
-- constraint, two rows for the same (post, account) were simply what a
-- re-attach produced, and some of them published.
--
-- Which row keeps the pair, in order:
--   1. a PUBLISHED row — it is the one the network actually received, it holds
--      the externalPostId the metrics puller queries, and deleting it would
--      both lose that history and free attachTargets to queue the account
--      again, which is the exact bug this migration exists to prevent
--   2. a row carrying an externalPostId — the same evidence one status write
--      short, e.g. a run that died between the vendor call and the update
--   3. any non-PENDING row (a FAILED one carries the error an operator needs)
--      over a bare PENDING one
--   4. the lowest id. The table has no timestamp column at all, so there is no
--      "oldest" to prefer; id is arbitrary but STABLE, which is what matters —
--      a re-run of this migration on a restored dump picks the same winner.
--
-- Losers are deleted rather than neutered (the channels_type_externalId
-- precedent NULLs the identity instead, but a target row with no account is not
-- a row, it is garbage): everything a target means is the pair.

-- Their metrics are not garbage, though, so move what can be moved first.
-- social_post_metrics is UNIQUE (targetId, date), so a day the winner already
-- has a reading for cannot take the loser's — the winner's own reading wins
-- there, because the winner is the row whose externalPostId the puller will
-- keep refreshing. Whatever is left cascades away with the loser (the FK is
-- ON DELETE CASCADE).
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER w AS keeper,
    row_number() OVER w AS rn
  FROM "social_post_targets"
  WINDOW w AS (
    PARTITION BY "postId", "socialAccountId"
    ORDER BY
      ("status" = 'PUBLISHED') DESC,
      ("externalPostId" IS NOT NULL) DESC,
      ("status" <> 'PENDING') DESC,
      "id" ASC
  )
)
UPDATE "social_post_metrics" m
SET "targetId" = r.keeper
FROM ranked r
WHERE m."targetId" = r.id
  AND r.rn > 1
  AND NOT EXISTS (
    SELECT 1 FROM "social_post_metrics" k
    WHERE k."targetId" = r.keeper AND k."date" = m."date"
  );

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "postId", "socialAccountId"
      ORDER BY
        ("status" = 'PUBLISHED') DESC,
        ("externalPostId" IS NOT NULL) DESC,
        ("status" <> 'PENDING') DESC,
        "id" ASC
    ) AS rn
  FROM "social_post_targets"
)
DELETE FROM "social_post_targets" t
USING ranked r
WHERE t.id = r.id
  AND r.rn > 1;

-- The name Prisma derives for @@unique([postId, socialAccountId]) on a model
-- mapped to "social_post_targets" — keep it in sync with the schema or every
-- later `migrate diff` reports drift.
CREATE UNIQUE INDEX "social_post_targets_postId_socialAccountId_key"
    ON "social_post_targets" ("postId", "socialAccountId");
