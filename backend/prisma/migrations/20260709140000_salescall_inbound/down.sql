-- Manual rollback for 20260709140000_salescall_inbound (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created and
-- touches no operator/user data.
DROP INDEX IF EXISTS "sales_calls_externalCallId_idx";
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "ringingAt";
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "answeredByUserId";

-- Re-add NOT NULL on marketingUserId ONLY if it's safe (no existing NULL
-- rows) — a real deployment may by now have genuine INBOUND/unassigned rows
-- (that's the entire point of this migration), and forcing NOT NULL back on
-- would either crash the rollback or silently corrupt/require deleting live
-- operator data. Guarded skip is a safe no-op; re-run this block by hand
-- after clearing/assigning those rows if the constraint must be restored.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "sales_calls" WHERE "marketingUserId" IS NULL) THEN
    ALTER TABLE "sales_calls" ALTER COLUMN "marketingUserId" SET NOT NULL;
  END IF;
END $$;
