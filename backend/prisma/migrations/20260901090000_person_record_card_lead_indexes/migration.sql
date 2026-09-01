-- The person record card's two per-contact reads get an index that matches them.
--
-- Both new sections ask the same shape: WHERE "workspaceId" = ? AND "leadId" = ?.
-- `estimates` had only ("workspaceId","status") and `bookings` had no leadId
-- index at all, so Postgres narrowed on the workspace and filtered the heap —
-- a whole-workspace scan every time somebody opened one of the two disclosures.
--
-- Low urgency today because both sections are lazy: they cost nothing until a
-- rep opens them. Stage 2 makes these reads routine, which is the point of
-- doing it now rather than after.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs each migration inside a
-- transaction and CREATE INDEX CONCURRENTLY cannot run in one. Both tables are
-- small enough that the brief write lock is not worth a manual out-of-band step.
CREATE INDEX IF NOT EXISTS "estimates_workspaceId_leadId_idx"
  ON "estimates" ("workspaceId", "leadId");

CREATE INDEX IF NOT EXISTS "bookings_workspaceId_leadId_idx"
  ON "bookings" ("workspaceId", "leadId");
