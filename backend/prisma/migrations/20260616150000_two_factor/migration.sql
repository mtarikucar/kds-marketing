-- Migration: 2FA/MFA (TOTP) on marketing users (Epic F)

ALTER TABLE "marketing_users" ADD COLUMN "twoFactorEnabled"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "marketing_users" ADD COLUMN "twoFactorSecret"      TEXT;
ALTER TABLE "marketing_users" ADD COLUMN "twoFactorBackupCodes" JSONB;
