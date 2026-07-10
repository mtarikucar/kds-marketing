-- Manual rollback for 20260710120000_backfill_fax_activated_modules
-- (forward-only Prisma migrate, matching this repo's manual-down convention).
--
-- Removes exactly the 'fax' element from any activatedModules array that
-- contains it, preserving the order/contents of every other entry. NULL rows
-- and rows that don't contain 'fax' are left completely untouched by the
-- WHERE clause, so this is a safe no-op if already reverted (idempotent) and
-- never touches operator-authored allow-lists that never had 'fax'
-- backfilled into them in the first place (e.g. one manually added post-hoc,
-- then already removed by a prior run of this rollback).
UPDATE "workspaces" w
SET "activatedModules" = sub.filtered
FROM (
  SELECT
    w2."id",
    COALESCE(
      jsonb_agg(elem.value ORDER BY elem.ord) FILTER (WHERE elem.value <> '"fax"'::jsonb),
      '[]'::jsonb
    ) AS filtered
  FROM "workspaces" w2
  CROSS JOIN LATERAL jsonb_array_elements(w2."activatedModules") WITH ORDINALITY AS elem(value, ord)
  WHERE w2."activatedModules" IS NOT NULL
    AND jsonb_typeof(w2."activatedModules") = 'array'
    AND w2."activatedModules" @> '["fax"]'::jsonb
  GROUP BY w2."id"
) sub
WHERE w."id" = sub."id";
