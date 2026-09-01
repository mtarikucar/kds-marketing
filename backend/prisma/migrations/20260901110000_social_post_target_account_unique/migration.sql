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
-- since `prisma migrate deploy` runs on boot, ahead of `node dist/main` in the
-- same `&&` chain, a failure anywhere in this file does not just skip a
-- migration: the API never starts. Every statement below is written with that
-- in mind. There may be legitimate historical duplicates: before this
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
--   3. a PENDING row over any other row that never reached the network.
--      This rule read the other way round first ("any non-PENDING row over a
--      bare PENDING one, because a FAILED one carries the error an operator
--      needs"), and that is backwards exactly where it decides anything.
--      `publishDuePost` fans out over PENDING targets and no others, so keeping
--      the FAILED half of a (FAILED, PENDING) pair silently drops that network
--      from a post that is still queued to go out — and attachTargets now
--      refuses to re-attach an account the post already holds a row for, so the
--      composer cannot put it back either. The post publishes to three networks
--      instead of four and nothing anywhere says why. A stale error string is
--      worth less than a queued publish, and it is not even lost: the loser is
--      archived below, error column and all.
--      Rules 1 and 2 still run first, so a FAILED row that DID reach the
--      network (externalPostId set) still wins; this rule only ever chooses
--      between two rows that both have nothing on the network.
--   4. the lowest id. The table has no timestamp column at all, so there is no
--      "oldest" to prefer; id is arbitrary but STABLE, which is what matters —
--      a re-run of this migration on a restored dump picks the same winner.
--
-- Losers are deleted rather than neutered (the channels_type_externalId
-- precedent NULLs the identity instead, but a target row with no account is not
-- a row, it is garbage): everything a target means is the pair. What they
-- carried is preserved first — metrics onto the keeper where they fit, the row
-- itself into an archive table.

-- One writer at a time, for the whole file.
--
-- A deploy leaves the old container serving while the new one boots and runs
-- this, so "nobody is writing during a migration" is false here. A save landing
-- between the DELETE and the CREATE UNIQUE INDEX below can insert the very
-- duplicate this migration just removed and take the index build — and the boot
-- — down with it. SHARE ROW EXCLUSIVE blocks writers and still lets readers
-- through, and the CREATE UNIQUE INDEX at the end blocks writers anyway (its
-- SHARE lock conflicts with the ROW EXCLUSIVE every INSERT takes), so this adds
-- no stall that was not already coming — it just starts it at the top of the
-- file, where the state it protects is decided rather than assumed.
--
-- This also requires the file to run inside a transaction, and it does:
-- `prisma migrate deploy` wraps each migration in one, which is verifiable from
-- the outside — LOCK TABLE outside a transaction block is an ERROR in Postgres,
-- and this migration applies cleanly.
LOCK TABLE "social_post_targets" IN SHARE ROW EXCLUSIVE MODE;

-- The ranking is computed ONCE, here, and every statement below reads it.
--
-- It began as the same window function copy-pasted into each statement's CTE,
-- which is two problems. The small one is drift: several copies of an eight-line
-- ORDER BY that MUST agree, or the row that gets archived is not the row that
-- gets deleted and the archive lies about which one won. The larger one is that
-- each statement takes its own snapshot under READ COMMITTED, so even the
-- identical expression can rank differently in two of them if anything changed
-- in between. The LOCK above closes that window; one materialised plan closes it
-- from the other side, and makes "the keeper we recorded is the keeper we kept"
-- true by construction instead of by inspection.
--
-- DROP first: a temp table lives for the whole session, not the statement, so a
-- hand replay of this file in an already-open psql session would otherwise trip
-- over the plan left behind by the previous pass.
DROP TABLE IF EXISTS "social_post_target_dedup_plan";
CREATE TEMP TABLE "social_post_target_dedup_plan" AS
SELECT
  "id",
  first_value("id") OVER w AS keeper,
  row_number() OVER w AS rn
FROM "social_post_targets"
WINDOW w AS (
  PARTITION BY "postId", "socialAccountId"
  ORDER BY
    ("status" = 'PUBLISHED') DESC,
    ("externalPostId" IS NOT NULL) DESC,
    ("status" = 'PENDING') DESC,
    "id" ASC
);

-- The losers' metrics are not garbage, so move what can be moved first.
-- social_post_metrics is UNIQUE (targetId, date), so a day the winner already
-- has a reading for cannot take the loser's — the winner's own reading wins
-- there, because the winner is the row whose externalPostId the puller will
-- keep refreshing. Whatever is left cascades away with the loser (the FK is
-- ON DELETE CASCADE).
--
-- That "the winner already has one" guard is necessary and was not sufficient,
-- and the difference is a failed boot. A pair can hold more than two rows, and
-- two DIFFERENT losers can each carry a reading for the same date the keeper
-- has nothing for: both rows pass the guard, both move onto (keeper, date), and
-- the second one violates a unique constraint that is not deferrable. Postgres
-- raises inside the UPDATE, `migrate deploy` exits non-zero, and the API does
-- not come up.
--
-- So the movable set is collapsed to one row per (keeper, date) before anything
-- is written. DISTINCT ON keeps the reading from the best-ranked loser — the
-- row that lost by the narrowest margin is the closest thing to the keeper's own
-- history — and the losers behind it cascade away with their target row, which
-- is exactly what happened to every one of them before this statement existed.
WITH movable AS (
  SELECT
    m."id"      AS metric_id,
    p."keeper"  AS keeper,
    m."date"    AS metric_date,
    p."rn"      AS rn
  FROM "social_post_metrics" m
  JOIN "social_post_target_dedup_plan" p ON p."id" = m."targetId"
  WHERE p."rn" > 1
    AND NOT EXISTS (
      SELECT 1 FROM "social_post_metrics" k
      WHERE k."targetId" = p."keeper" AND k."date" = m."date"
    )
),
chosen AS (
  SELECT DISTINCT ON (keeper, metric_date) metric_id, keeper
  FROM movable
  -- rn first: prefer the best-ranked loser. metric_id only to make the choice
  -- total, so a re-run on a restored dump moves the same row.
  ORDER BY keeper, metric_date, rn ASC, metric_id ASC
)
UPDATE "social_post_metrics" m
SET "targetId" = c.keeper
FROM chosen c
WHERE m."id" = c.metric_id;

-- Archive the losers before destroying them.
--
-- A second PUBLISHED row is not noise; it is the evidence that a double-post
-- reached a real customer's feed. It holds the externalPostId of the copy still
-- sitting on that network, which is the one thing an operator needs to go find
-- and delete it, and its SocialPostMetric rows go with it
-- (SocialPostTarget.metrics is ON DELETE CASCADE). The file's own comment above
-- admits these rows exist and "some of them published" — deleting them with no
-- count, no copy and no line in the log meant the migration would erase the only
-- proof of the incident it exists to prevent, silently, at 3am, at boot.
--
-- The cascaded metrics are not copied here: a metric row is re-derivable from
-- the network by the externalPostId this archive keeps, and a post's readings
-- are not what an operator is looking for at this point anyway. The rows are.
--
-- This table is a forensic record, not schema anyone builds on. It is modeled in
-- schema.prisma (as SocialPostTargetDedupArchive) only because the CI parity
-- gate diffs the migrations against the datamodel and an unmodeled table reads
-- as drift; nothing in the application reads it. On almost every database it
-- will be empty, and an operator who has looked may drop it.
CREATE TABLE IF NOT EXISTS "social_post_targets_dedup_archive" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalPostId" TEXT,
    "error" TEXT,
    "keeperId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_post_targets_dedup_archive_pkey" PRIMARY KEY ("id")
);

-- Its own surrogate id, not the archived row's: a restored dump replayed through
-- this file a second time is a second, real archiving event, and a primary key
-- collision there would abort a boot to protect a duplicate forensic row. The
-- destroyed row's id is kept as data, in "targetId".
INSERT INTO "social_post_targets_dedup_archive" (
  "id", "targetId", "workspaceId", "postId", "socialAccountId",
  "network", "status", "externalPostId", "error", "keeperId"
)
SELECT
  gen_random_uuid()::text,
  t."id",
  t."workspaceId",
  t."postId",
  t."socialAccountId",
  t."network",
  t."status",
  t."externalPostId",
  t."error",
  p."keeper"
FROM "social_post_targets" t
JOIN "social_post_target_dedup_plan" p ON p."id" = t."id"
WHERE p."rn" > 1;

DELETE FROM "social_post_targets" t
USING "social_post_target_dedup_plan" p
WHERE t."id" = p."id"
  AND p."rn" > 1;

-- Say it out loud — but to the right reader, because it is NOT the boot log.
--
-- A container that comes up having quietly deleted published targets looks
-- exactly like one that had nothing to delete, and those are very different
-- mornings. This block used to claim it closed that gap. It does not:
-- `prisma migrate deploy` is what runs this file at boot, and it does not
-- surface server messages at all. Verified directly against this Postgres with
-- a probe migration raising both a NOTICE and a WARNING — the migration
-- applied, the DO block ran, and `migrate deploy` printed nothing but "The
-- following migration(s) have been applied". The one signal an operator had
-- been promised about a destructive step did not exist.
--
-- The NOTICE is kept because it still reaches the OTHER reader of this file:
-- the operator replaying it by hand through psql, which does print it — the
-- restored-dump case the IF NOT EXISTS at the bottom is written for.
--
-- WHAT AN OPERATOR SHOULD ACTUALLY RUN after a deploy that applied this
-- migration, since the archive table is the signal that survives a boot:
--
--   SELECT count(*) FROM "social_post_targets_dedup_archive";
--   SELECT * FROM "social_post_targets_dedup_archive" WHERE "status" = 'PUBLISHED';
--
-- Zero is the ordinary morning. A non-zero PUBLISHED count is a post that
-- reached a real feed twice, and the row carries the externalPostId needed to go
-- and delete the copy.
DO $$
DECLARE
  archived bigint;
BEGIN
  SELECT count(*) INTO archived
  FROM "social_post_target_dedup_plan" WHERE "rn" > 1;
  IF archived > 0 THEN
    RAISE NOTICE
      'social_post_targets: archived and deleted % duplicate target row(s) into social_post_targets_dedup_archive (SELECT * FROM "social_post_targets_dedup_archive" to review; rows with status = ''PUBLISHED'' reached a real feed twice)',
      archived;
  END IF;
END $$;

DROP TABLE "social_post_target_dedup_plan";

-- The name Prisma derives for @@unique([postId, socialAccountId]) on a model
-- mapped to "social_post_targets" — keep it in sync with the schema or every
-- later `migrate diff` reports drift.
--
-- IF NOT EXISTS so the whole file stays re-runnable against a database that has
-- already had it applied. `migrate deploy` will not re-run an applied migration,
-- but the case this is for is the one where its bookkeeping is gone: a dump
-- restored without _prisma_migrations, or an operator replaying the file by hand
-- to dedup a database that drifted. Every other statement here is already
-- idempotent; without this one the replay dies on its last line.
CREATE UNIQUE INDEX IF NOT EXISTS "social_post_targets_postId_socialAccountId_key"
    ON "social_post_targets" ("postId", "socialAccountId");
