-- RFC 6238 §5.2 TOTP replay guard: record the last time-step consumed at login
-- so a captured code can't be replayed within its validity window.
ALTER TABLE "marketing_users" ADD COLUMN IF NOT EXISTS "twoFactorLastStep" INTEGER;
