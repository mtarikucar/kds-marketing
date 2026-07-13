-- Reverse of migration.sql — drop exactly what it added.
ALTER TABLE "marketing_users" DROP COLUMN IF EXISTS "twoFactorLastStep";
