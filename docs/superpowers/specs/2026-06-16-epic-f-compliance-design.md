# Epic F (compliance subset) — GDPR/KVKK consent + data requests — design

**Date:** 2026-06-16
**Status:** autonomous (user no-ask) — controller-made
**Program:** GoHighLevel feature-parity, Epic F compliance slice (independent off main)

## Goal
The enterprise/compliance gap, delivered as the **safe, additive** slice:
- **Consent log** — append-only `ConsentRecord` per Lead (GDPR/KVKK); recording a
  marketing consent syncs the Lead's per-channel opt-out flag so the campaign
  engine honours it. Latest record per type is current.
- **Data subject requests** — `DataRequest`: EXPORT aggregates and returns a Lead's
  bundle (lead + activities + offers + tasks + consents) immediately; ERASURE is
  recorded PENDING for **reviewed** execution (never auto-deletes).

Workspace-scoped, OWNER/MANAGER-only. `/marketing/compliance/...`.

## Deferred to follow-ups (need live-auth changes or external credentials — flagged for the user)
- **2FA/MFA** — TOTP enroll/verify is buildable, but enforcing it modifies the live
  login flow → warrants review.
- **SSO (SAML/OIDC)** — needs an external IdP (config/credentials).
- **Custom roles & granular permissions** — invasive change to the auth guard model.

## Testing
Unit: consent record + opt-out sync, latest-per-type, export bundle, erasure
PENDING, workspace 404. E2E: consent/export/erasure + REP-forbidden. Full suite green.
