-- Reverse of migration.sql — drop exactly the index it added. The duplicate
-- re-suffix is intentionally left in place: reverting it would reintroduce
-- colliding invoice numbers (and the suffixed numbers are valid as-is).
DROP INDEX IF EXISTS "invoices_workspaceId_number_key";
