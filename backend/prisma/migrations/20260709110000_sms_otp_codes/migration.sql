-- NetGSM SMS v2 (Phase 1, Task 12): SMS OTP codes — 2FA-SMS enroll/login
-- challenge + lead phone verification. New table only; no changes to
-- existing tables.
--
-- `codeHash` is the SHA-256 of the 6-digit code — the raw code is NEVER
-- persisted. `purpose`/`targetType`/`targetId` scope a code to exactly one
-- flow + entity (TWO_FACTOR/USER or LEAD_PHONE_VERIFY/LEAD) so a code issued
-- for one can never verify another. `attempts`/`maxAttempts` cap brute force;
-- `consumedAt` makes a code single-use; `expiresAt` is the 3-minute TTL.
CREATE TABLE IF NOT EXISTS "sms_otp_codes" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "purpose"     TEXT NOT NULL,
  "targetType"  TEXT NOT NULL,
  "targetId"    TEXT NOT NULL,
  "phone"       TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "consumedAt"  TIMESTAMP(3),
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sms_otp_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "sms_otp_codes_target_idx"
  ON "sms_otp_codes"("workspaceId", "purpose", "targetType", "targetId", "createdAt");
