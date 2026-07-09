-- Manual rollback for 20260709190000_autocall_dialer (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up added —
-- child table first (its FK references the parent).
DROP TABLE IF EXISTS "autocall_session_items";
DROP TABLE IF EXISTS "autocall_sessions";
