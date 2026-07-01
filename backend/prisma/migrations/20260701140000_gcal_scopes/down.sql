-- Manual rollback for 20260701140000_gcal_scopes (forward-only Prisma migrate).
ALTER TABLE "google_calendar_connections" DROP COLUMN IF EXISTS "scopes";
