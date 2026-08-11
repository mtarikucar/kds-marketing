-- Manual rollback for 20260810120000_backfill_memberships_research_activated_modules
-- (forward-only Prisma migrate, matching this repo's manual-down convention).
--
-- Removes exactly the 'memberships' and 'research' elements from any
-- activatedModules array that contains them, preserving the order and contents
-- of every other entry. NULL rows and rows containing neither key are left
-- untouched by the WHERE clause, so this is a safe no-op if already reverted.
--
-- CAVEAT, stated plainly: this cannot distinguish a key this migration added
-- from one a workspace had deliberately switched on beforehand. Rolling back
-- therefore also hides Courses/Research for any tenant who had enabled them by
-- hand. That is the same trade-off the earlier voiceCampaigns/fax rollbacks
-- make, and it is why the forward migration is the intended state.
UPDATE "workspaces" w
SET "activatedModules" = sub.filtered
FROM (
  SELECT
    w2."id",
    COALESCE(
      jsonb_agg(elem.value ORDER BY elem.ord) FILTER (
        WHERE elem.value <> '"memberships"'::jsonb
          AND elem.value <> '"research"'::jsonb
      ),
      '[]'::jsonb
    ) AS filtered
  FROM "workspaces" w2
  CROSS JOIN LATERAL jsonb_array_elements(w2."activatedModules") WITH ORDINALITY AS elem(value, ord)
  WHERE w2."activatedModules" IS NOT NULL
    AND jsonb_typeof(w2."activatedModules") = 'array'
    AND (
      w2."activatedModules" @> '["memberships"]'::jsonb
      OR w2."activatedModules" @> '["research"]'::jsonb
    )
  GROUP BY w2."id"
) sub
WHERE w."id" = sub."id";
