# Epic F — 2FA/MFA (TOTP) — design

**Date:** 2026-06-16 · autonomous (no-ask) · independent off main

## Goal
TOTP-based two-factor auth for marketing users (flagship enterprise security).
- **TOTP util** (`util/totp.ts`) — dependency-free RFC 6238 (SHA-1, 6 digits, 30s,
  ±1 window), base32 secrets, backup codes (SHA-256 single-use).
- **Management** — `TwoFactorService` + `/marketing/auth/2fa/{enroll,enable,disable,status}`
  (signed-in user). `enable` verifies a code before flipping the flag + issues 10 backup codes once.
- **Login enforcement** (additive) — `MarketingAuthService.login` issues a 5-min
  `2fa-challenge` JWT (not a session) when `twoFactorEnabled`; the client completes
  it at public `POST /auth/2fa/verify` (TOTP or single-use backup code) → tokens.
  Users without 2FA are unaffected.

`MarketingUser` gains `twoFactorEnabled/Secret/BackupCodes`.

## Testing
Unit: totp round-trip/verify/skew/reject; service enroll/enable/disable/status.
E2E: enroll+enable, full login→challenge→verify, bad-code 401. Existing auth
suite unaffected (631 unit + 58 e2e green).
