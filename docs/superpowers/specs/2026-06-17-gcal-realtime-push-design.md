# Real-time Google Calendar push sync — design

**Date:** 2026-06-17
**Status:** Implemented (ships in the next `v*.*.*` tag)

## Problem

Two-way Google Calendar sync existed but the **pull** direction (Google → our
availability) only ran on the manual "Sync now" button — there was no automatic
or real-time path. Push (our bookings → Google) was already automatic via the
`BookingCreated` domain event. For GoHighLevel parity the pull side must be
real-time and hands-off.

## Approach (chosen: Option 2 — `events.watch` push channels)

Use Google Calendar **push notifications**: register a watch channel per
connection so Google POSTs a change notification to our public webhook the
moment anything changes; the webhook triggers an incremental pull. No polling.

### Lifecycle

1. **Register** (`startWatch`) — on a successful connect (and on renewal) we
   `POST events.watch` with `{id, type:web_hook, address, token, params.ttl}`.
   `address` = `${MARKETING_PUBLIC_URL}/api/marketing/integrations/google-calendar/notifications`.
   We persist Google's `resourceId` + `expiration`, our channel `id`, and a
   random per-channel `token`. Any prior channel is stopped first (no orphans).
2. **Receive** (`notifications` webhook, already existed) — validates the
   `X-Goog-Channel-Id` + `X-Goog-Resource-Id` + `X-Goog-Channel-Token` against
   the stored row (forged/stale notifications no-op), then runs `pullEvents`.
   The initial `resourceState: sync` ping is ignored.
3. **Renew** (`renewWatches`, `@Cron` every 6h) — channels expire (Google caps
   the TTL, ~7 days); we re-register any channel within 24h of expiry so the
   feed never lapses. Only connections that already have a channel are renewed.
4. **Stop** (`stopWatch`) — on disconnect (and before re-registering) we
   `POST channels/stop` and clear the channel fields.

### Data model

Additive, nullable columns on `GoogleCalendarConnection` (migration
`20260617120000_gcal_watch_renewal`, safe online change):
- `channelToken String?` — per-channel verification nonce.
- `channelExpiration DateTime?` — drives the renewal cron.
(`channelId` / `resourceId` already existed.)

### Resilience / security

- **Best-effort**: every watch op is try/caught and degrades to manual-sync mode
  on failure — connecting/syncing never breaks. A `401` (typically an unverified
  webhook domain) is logged with a clear hint.
- **Webhook auth**: the per-channel `token` + `resourceId` are both checked, so
  the public notifications endpoint can't be driven by a forged request.
- **Single-replica** assumption for the renewal `@Cron` (mirrors the other
  marketing cron jobs); a multi-replica deploy would fire it per instance.

## Operator prerequisite (REQUIRED for push to activate)

Google rejects `events.watch` unless the **webhook receiving domain is verified**
for the Cloud project:
1. Verify `hummytummy.com` in **Google Search Console**.
2. Add it under **Google Cloud Console → APIs & Services → Domain verification**.

Until then the feature stays in manual "Sync now" mode (no crash, no data loss).

## Out of scope

- Per-user (vs per-workspace) calendar selection — still the active connection.
- Multi-replica cron de-duplication (leader election) — deferred with the other
  marketing crons.
