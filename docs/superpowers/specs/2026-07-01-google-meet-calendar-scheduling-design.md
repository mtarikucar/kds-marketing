# Design — Google Meet + Calendar Scheduling (Appointments, Availability & Conferencing)

- **Date:** 2026-07-01
- **Status:** Approved (user granted full autonomy: most comprehensive + most professional-engineering option at every decision point)
- **Implementation progress:** Phase 1 (conferencing links — Google Meet + Teams) ✅ implemented & unit/e2e-tested on `feat/google-meet-calendar-scheduling`. Phases 2–4 pending. Plan: `docs/superpowers/plans/2026-07-01-phase1-conferencing-links.md`.
- **Scope owner:** marketing module (NestJS 11 + Prisma 6 + Postgres backend; React + TanStack Query frontend)
- **Branch base:** `chore/code-review-fixes` (synced to `origin/main`)

---

## 0. Executive summary

The system already ships ~80% of a GoHighLevel-style booking/availability engine and a full Google Calendar (real) + Outlook/Graph (scaffolded, inert) 2-way sync. This project **extends** that foundation rather than rebuilding it, to deliver:

1. **Conferencing links** — Google Meet **and** Microsoft Teams links attached to bookings, hosted by the assigned staff member (per-host model).
2. **Rich availability + appointment lifecycle** — blackout/PTO, per-staff working hours, min-notice/max-advance/before-after buffers, reschedule, `NO_SHOW`/`COMPLETED`/`PENDING`/`RESCHEDULED` states, multi-channel (email + SMS) + host reminders, attendee timezone.
3. **In-app + public self-service UI** — React slot-picker, appointments list/detail, typed service layer, public self-service booking page with token-based self-cancel/reschedule.
4. **Advanced Meet** — Meet REST v2 spaces (recording/transcript/co-host), env-gated and inert until the Google Cloud app is verified with the extra scope.

Delivered in **4 independently shippable phases**, each with reversible up/down migrations, colocated unit specs + e2e, 5-locale i18n, and the existing degrade-gracefully (`isConfigured()`) gating.

---

## 1. What already exists (verified against source)

### Backend booking engine — `backend/src/modules/marketing/sites/booking.service.ts`
- `availability(workspaceId, calId, fromISO, toISO)` — enumerates bookable slot starts. Caps range to `MAX_RANGE_DAYS=21`, computes `effectiveCapacity` (SINGLE/COLLECTIVE→1, CLASS→capacity, ROUND_ROBIN→member count), counts our `CONFIRMED` bookings against capacity, treats any workspace-wide `EXTERNAL_BUSY` overlap as a hard block, slices wall-clock windows into `slotMinutes` stepping by `slotMinutes + bufferMinutes`.
- `book(...)` — reserves inside a `$transaction` guarded by `pg_advisory_xact_lock(hashtext('booking:<workspaceId>'))`; race-free capacity + cross-calendar "one human can't be double-booked" assignee invariant; `isAlignedSlot()` re-validates the grid so a direct API call can't book an off-grid time.
- `cancel(...)`, `remind(job)` (hard-coded **T-1h** email-only), round-robin assignee picking, mints/links a `Lead`, emits `BookingCreated`, best-effort `googleSync.pushBooking` + `outlookSync.pushBooking`.
- DST-safe timezone math in `backend/src/modules/marketing/sites/timezone-slots.ts` (`zonedParts`, `zonedWallTimeToUtcMs`, `parseHm`). **Note:** the class docstring claiming "interpreted in UTC for v1" is **stale** — the code is timezone-aware. We will fix that docstring as part of Phase 2.

### Data model — `backend/prisma/schema.prisma`
- `Booking` (`bookings`): `startAt/endAt`, `name/email/phone/notes`, `status String @default("CONFIRMED")` **(a plain String, not an enum — new statuses need no enum migration)**, `assigneeUserId`, `leadId`, unique `token`, `googleEventId`, `outlookEventId`. Indexes: `(calendarId, startAt)`, `(workspaceId)`, `(workspaceId, googleEventId)`, `(workspaceId, outlookEventId)`.
- `BookingCalendar` (`booking_calendars`): `type`, `capacity`, `availability Json`, `slotMinutes`, `bufferMinutes`, `timezone` (default `Europe/Istanbul`), `active`; `@@unique([workspaceId, slug])`.
- `BookingCalendarMember` (`booking_calendar_members`): `marketingUserId` soft-ref, `priority`; cascade-deleted with calendar; `@@unique([calendarId, marketingUserId])`.
- `GoogleCalendarConnection` (`google_calendar_connections`): sealed `accessToken/refreshToken`, `tokenExpiresAt`, `syncToken`, watch channel fields, `enabled`. `@@index([workspaceId, marketingUserId])`, `@@unique([channelId])`. **Already per-(workspace, marketingUser, googleCalendarId).**
- `OutlookCalendarConnection` (`outlook_calendar_connections`): mirror for MS Graph (`deltaToken`, `subscriptionId`, `clientState`).

### Integrations — `backend/src/modules/marketing/integrations/`
- `google-calendar.service.ts` — env-gated OAuth (`isConfigured()` = client id + secret + `isSecretBoxConfigured()`), `getAuthUrl` (scope `https://www.googleapis.com/auth/calendar`, `access_type=offline`, `prompt=consent`), `handleCallback` (stateless AES-GCM sealed `state`), `getFreshAccessToken` (refresh + 60s skew, re-seals rotated tokens). Raw REST via `safeFetch` — **no googleapis SDK**.
- `google-calendar-sync.service.ts` — `pushBooking()` builds the event body at **~L146** (`summary/description/start/end/attendees/extendedProperties` only — **no `conferenceData`**), idempotent event id `bk<uuid-no-hyphens>`, 409-adopt; `cancelBooking()`; `pullEvents()` incremental `syncToken` (external → `EXTERNAL_BUSY`); `ensureWatch/startWatch/stopWatch`; `@Cron(EVERY_6_HOURS, 'gcal-watch-renew')` under `withAdvisoryLock`. Subscribes to `BookingCreated` on the `DomainEventBus`.
- `outlook-calendar-sync.service.ts` — mirror over MS Graph, `eventBody(booking)` at **~L747** (`subject/body/start/end` — **no `onlineMeeting`/`isOnlineMeeting`**).
- Cross-cutting: `secret-box.helper.ts` (AES-256-GCM, `MARKETING_SECRET_KEY`), `google-oauth-env.ts` (accepts `GOOGLE_OAUTH_CLIENT_ID/_SECRET` or `GOOGLE_CLIENT_ID/_SECRET`), `safe-fetch.ts` (SSRF-safe), `advisory-lock.ts`, `ScheduledJob` + `ScheduledJobRunnerService` (durable jobs; **no BullMQ**).

### Endpoints & DTOs
- Admin: `controllers/marketing-booking.controller.ts` — `@Controller('marketing/calendars')`, guards `MarketingGuard + MarketingRolesGuard('MANAGER') + FeatureGuard('funnels') + PermissionsGuard('settings.manage')`.
- Public: `controllers/public-site.controller.ts` — `GET book/:ws/:cal/slots`, `POST book/:ws/:cal/reserve` (throttled), `GET book/:ws/:cal` (server-rendered HTML).
- DTOs: `dto/site.dto.ts` — `CreateCalendarDto`/`UpdateCalendarDto` (`slotMinutes` 5–480, `bufferMinutes` 0–240, `timezone` ≤64, `availability` Record), `SetCalendarMembersDto`.

### Events — `events/marketing-event-types.ts`
- Only `BookingCreated = 'marketing.booking.created.v1'` exists. **No `BookingCancelled`/`BookingUpdated`/`BookingRescheduled`.** Workflow trigger `booking.created` mapped in `workflows/workflow-trigger.service.ts`.

### Frontend — `frontend/src/`
- `pages/marketing/BookingSettingsPage.tsx` (`/booking`, manager-gated) configures calendars/availability/members. `pages/marketing/calendar/CalendarPage.tsx` renders **tasks**, not bookings. All calendar views are **hand-rolled CSS grid** (no FullCalendar). Date picking = `react-day-picker` via `components/ui/DatePicker.tsx`; time = native `<input type="time">`. `pages/marketing/settings/connections/GoogleCalendarTab.tsx` + `OutlookCalendarTab.tsx` + `hooks.ts`. i18n = 5 locales (`en/tr/ru/uz/ar`) in `i18n/locales/*/marketing.json`. Timezone-safe helpers in `features/marketing/utils/datetime.ts`. **No typed `booking.service.ts` yet** — pages call `marketingApi` inline (violates the ADR at `docs/superpowers/adr/2026-06-15-frontend-api-service-layer.md`).

---

## 2. Architecture decisions

### 2.1 Chosen approach: extend-in-place + a thin `ConferenceProvider` abstraction
Everything stays in the marketing module. We do **not** clone a new provider table for Meet, and we do **not** extract booking into a new module. We add a small provider interface so Meet and Teams share one call site.

```
backend/src/modules/marketing/integrations/conferencing/
  conference-provider.interface.ts   // ConferenceProvider + ConferenceResult types
  google-meet.provider.ts            // Calendar events.insert conferenceData → hangoutLink
  teams.provider.ts                  // Graph event onlineMeeting → joinUrl
  conferencing.service.ts            // resolves the host connection + provider, orchestrates create/cancel, handles pending
```

```ts
interface ConferenceResult {
  provider: 'GOOGLE_MEET' | 'TEAMS';
  joinUrl: string | null;          // null while Google reports conferenceData pending
  conferenceId: string | null;     // hangout id / onlineMeeting id (for teardown + follow-up get)
  requestId: string;               // stable per booking (idempotency)
  status: 'created' | 'pending';
}
interface ConferenceProvider {
  readonly kind: 'GOOGLE_MEET' | 'TEAMS';
  create(host: HostConnection, booking: BookingRow): Promise<ConferenceResult>;
  cancel(host: HostConnection, conferenceId: string): Promise<void>;   // best-effort
  resolvePending?(host: HostConnection, booking: BookingRow): Promise<ConferenceResult>; // follow-up get
}
```

Meet is created by adding `conferenceData: { createRequest: { requestId: 'bk<bookingId>', conferenceSolutionKey: { type: 'hangoutsMeet' } } }` to the event body **and** appending `?conferenceDataVersion=1` to the `events.insert`/`patch` call in `google-calendar-sync.service.ts` — no new OAuth scope required (the existing `calendar` scope already permits it). Teams is created by setting `isOnlineMeeting: true` + `onlineMeetingProvider: 'teamsForBusiness'` on the Graph event and reading back `onlineMeeting.joinUrl`.

**`requestId = bk<bookingId>`** is stable so retries never spawn duplicate conferences (aligns with the existing `bk<uuid>` event-id scheme).

### 2.2 Host identity: per-host connection model (chosen)
The Meet/Teams organizer is whoever's OAuth token pushes the event. For ROUND_ROBIN the meeting must be hosted by the **assigned** member, so we map calendar/member → the host's own connection:
- `BookingCalendar.conferencing` — `NONE | GOOGLE_MEET | TEAMS` (which provider, if any, to attach).
- Host resolution order for a booking: (1) the booking's `assigneeUserId`'s own enabled connection of the calendar's provider; (2) the calendar `ownerUserId`'s connection; (3) the workspace's active connection (back-compat). If none → **linkless booking + a structured warning surfaced on the booking**, never a crash (matches the best-effort pattern).
- No new connection table — `GoogleCalendarConnection` / `OutlookCalendarConnection` are already per-(workspace, marketingUser); we resolve by `marketingUserId`.

### 2.3 Reversible migrations (user global rule)
Every migration ships an `up` (`migration.sql`) **and** a hand-authored `down.sql` that drops exactly what the up added, idempotent and tightly scoped, verified round-trip (up → down → up). Recent migrations already follow this (`20260630130000_social_campaign_engine/down.sql`), so it matches house style.

### 2.4 Degrade-gracefully gating preserved
Google/Teams/advanced-Meet features stay **inert** unless their operator creds + secret-box are configured. New env names are documented in `backend/.env.example` and NOT added to `main.ts` `validateEnv()` required list (they are soft-gated).

---

## 3. Data model changes (all reversible)

### Phase 1 migration `<UTC>_booking_conferencing`
`Booking` add:
- `meetingUrl String?` — the join URL (Meet `hangoutLink` / Teams `joinUrl`).
- `conferenceProvider String?` — `GOOGLE_MEET | TEAMS`.
- `conferenceId String?` — hangout/onlineMeeting id (teardown + pending follow-up).
- `conferenceStatus String?` — `created | pending | failed | none` (drives the pending-resolve job + UI).

`BookingCalendar` add:
- `conferencing String @default("NONE")` — `NONE | GOOGLE_MEET | TEAMS`.
- `conferenceConfig Json?` — advanced-Meet config (recording/transcript/co-host), read only by Phase 4 when the advanced scope is present; added here (nullable) to avoid a second `booking_calendars`-touching migration later.

`down.sql`: `ALTER TABLE bookings DROP COLUMN IF EXISTS ...` (×4); `ALTER TABLE booking_calendars DROP COLUMN IF EXISTS conferencing; ALTER TABLE booking_calendars DROP COLUMN IF EXISTS "conferenceConfig";`.

### Phase 2 migration `<UTC>_booking_availability_policy`
`BookingCalendar` add: `minNoticeMinutes Int @default(0)`, `maxAdvanceDays Int @default(60)`, `bufferBeforeMinutes Int @default(0)`, `bufferAfterMinutes Int @default(0)`, `reminderConfig Json?` (array of `{ offsetMinutes, channels: ['EMAIL'|'SMS'], audience: 'CUSTOMER'|'HOST'|'BOTH' }`).
`Booking` add: `attendeeTimezone String?`, `rescheduledFromId String?` (self soft-ref for reschedule chains). `status` gains `NO_SHOW | COMPLETED | PENDING | RESCHEDULED` (comment-only widening; no enum).

New model `BookingBlackout` (`booking_blackouts`): `id`, `workspaceId`, `calendarId String?` (null = workspace-wide / all calendars), `marketingUserId String?` (null = calendar-wide; set = per-staff time-off), `startAt`, `endAt`, `reason String?`, `createdAt`; `@@index([workspaceId, calendarId])`, `@@index([workspaceId, marketingUserId])`. Applied as a hard block in `availability()` + `isAlignedSlot()`.

New model `MemberAvailability` (`member_availability`): per-`(calendarId, marketingUserId)` `availability Json` + `timezone String?`. When present for a ROUND_ROBIN member, that member is only offered inside the intersection of calendar windows ∩ member windows. Optional — absent members fall back to the calendar's availability.

`down.sql`: drop new columns + `DROP TABLE IF EXISTS booking_blackouts; DROP TABLE IF EXISTS member_availability;`.

### Phase 4 (no schema change beyond config)
Meet-space config (recording/transcript/co-host) lives in `reminderConfig`-sibling JSON `conferenceConfig Json?` on `BookingCalendar` (added in Phase 1's migration as a nullable column to avoid a second `Booking`-touching migration), read only when the advanced scope is present.

---

## 4. Phase breakdown

### Phase 1 — Conferencing links (Google Meet + Teams)
**Backend**
1. Add the `conferencing/` provider abstraction (§2.1).
2. Extend `google-calendar-sync.service.ts::pushBooking` to include `conferenceData` + `?conferenceDataVersion=1` when the calendar's `conferencing === 'GOOGLE_MEET'`; read back `hangoutLink`/`conferenceData.entryPoints`; persist `meetingUrl/conferenceProvider/conferenceId/conferenceStatus` on the booking. Handle the async `pending` state (`conferenceData.createRequest.status.statusCode === 'pending'`) by scheduling a `booking.conference.resolve` `ScheduledJob` that does a follow-up `events.get`.
3. Mirror the same in `outlook-calendar-sync.service.ts::eventBody` for Teams (`isOnlineMeeting`), reading `onlineMeeting.joinUrl`.
4. **Per-host resolution** in a shared helper used by both sync services (§2.2).
5. **Domain events**: add `BookingCancelled`, `BookingUpdated`, `BookingRescheduled` to `marketing-event-types.ts`; emit via the outbox in `book()`/`cancel()`/reschedule; conferencing teardown + calendar-mirror delete subscribe to `BookingCancelled` (replaces today's best-effort direct calls, which stay as a self-healing fallback).
6. Surface the join URL in the confirmation email + a proper **ICS invite** (with `LOCATION`/`URL`/`X-GOOGLE-CONFERENCE`) and in reminders.
7. Migration `<UTC>_booking_conferencing` (up + down). DTO: add `conferencing` to `Create/UpdateCalendarDto`.

**Tests**: extend `booking.service.spec.ts`, `google-calendar-sync.service.spec.ts`, add `conferencing.service.spec.ts` + a `google-meet.provider.spec.ts`/`teams.provider.spec.ts`; e2e `booking-conferencing.e2e-spec.ts`. Verify migration round-trip.

### Phase 2 — Rich availability + appointment lifecycle
**Backend**
1. `BookingBlackout` + `MemberAvailability` models + policy fields (§3).
2. Extend `availability()` + `isAlignedSlot()`: apply blackout hard-blocks, `minNoticeMinutes` (earliest bookable = now + notice), `maxAdvanceDays` (replaces the fixed 21-day cap where configured), `bufferBeforeMinutes`/`bufferAfterMinutes` (separate pre/post padding), and per-member availability intersection for ROUND_ROBIN.
3. Reschedule endpoint (admin + public-by-token): cancels-in-place → creates a linked new booking (`rescheduledFromId`), re-pushes the conference (patch), emits `BookingRescheduled`.
4. Lifecycle statuses `NO_SHOW`/`COMPLETED`/`PENDING`/`RESCHEDULED` with admin transitions; approval flow (`PENDING` → `CONFIRMED`) when the calendar opts in.
5. Multi-channel reminders: replace the single T-1h job with `reminderConfig`-driven scheduling (email via `EmailService`, SMS via the existing NetGSM channel adapter), including host reminders. Capture `attendeeTimezone` on the public reserve and use it in all customer-facing times (fix the `toUTCString()` usage).
6. Fix the stale `booking.service.ts` docstring.

**Tests**: blackout/notice/advance/buffer/member-intersection slot math, reschedule, lifecycle transitions, reminder scheduling, tz rendering; migration round-trip.

### Phase 3 — In-app + public self-service UI
**Frontend**
1. Typed `features/marketing/api/booking.service.ts` + TanStack Query hooks (stable keys); refactor `BookingSettingsPage`/appointments to use it (ADR compliance).
2. New **slot-grid** component (available times) — none exists today.
3. **Appointments list/detail** page (in-app) showing bookings, status, assignee, Meet/Teams join link, with cancel/reschedule/no-show/complete actions; manager-gated route in `App.tsx` + `navigation.ts` (`funnels` feature).
4. **Public self-service booking page** in React (replaces reliance on the backend HTML route): pick calendar → pick slot (attendee tz) → reserve → confirmation with join link; token-based self-cancel/reschedule page.
5. Conferencing toggle (`NONE/GOOGLE_MEET/TEAMS`) + policy fields in the calendar config UI.
6. 5-locale i18n keys (`en/tr/ru/uz/ar`); all datetime via `datetime.ts` (never `toISOString()`).

**Tests**: component/integration tests (Vitest/RTL) for slot-grid, appointments actions, public booking flow, i18n key coverage (mirrors existing `*.test.tsx` + `marketing-parity.test.ts`).

### Phase 4 — Advanced Meet (spaces API)
1. Add optional scope `https://www.googleapis.com/auth/meetings.space.created`; a re-consent path that upgrades an existing `GoogleCalendarConnection` (record granted scopes; gate advanced features on their presence).
2. Meet REST v2 spaces provisioning (`meet.googleapis.com/v2/spaces`) for recording/transcript/co-host config, wired behind `BookingCalendar.conferenceConfig`.
3. **Env-gated + inert** until the operator configures the scope AND the Google Cloud app is verified for it; a status endpoint reports capability. Documented as an operational dependency.

**Tests**: provider unit tests with the advanced path mocked; capability-gating tests.

---

## 5. Cross-cutting conventions (all phases)
- **RBAC**: admin routes keep `MANAGER` floor + `@RequirePermission('settings.manage')` + `FeatureGuard('funnels')`; never co-list OWNER (OWNER-floor is automatic). Public routes `@MarketingPublic()` + `@Throttle`.
- **Secrets**: seal any token with `secret-box.helper`; mask in responses; gate on `isConfigured()`.
- **Jobs**: `ScheduledJob` + runner for reminders/pending-resolve; `@Cron + withAdvisoryLock` for renewals. No BullMQ.
- **HTTP**: all outbound via `safeFetch`.
- **Multi-tenancy**: every query `workspaceId`-scoped; soft refs; respects `workspace-scoping.arch.spec.ts`.
- **Tests**: colocated `*.spec.ts` + `backend/test/e2e/*.e2e-spec.ts` via `test/utils/test-app.ts`. Run: `cd backend && npm test` / `npm run test:e2e`.
- **Migrations**: `npx prisma migrate dev --name <snake>` + hand-authored `down.sql`; verify up→down→up.
- **i18n**: keys in all 5 locales; TR first-class.

---

## 6. Operational dependencies & risks
- **Teams parity** inert until `MS_OAUTH_CLIENT_ID/_SECRET` set (already the case).
- **Advanced Meet (Phase 4)** inert until `meetings.space.created` scope granted + **Google Cloud app verification** — outside code; ops-owned.
- **`conferenceData` is async** — `hangoutLink` may be absent on insert (`pending`); handled by the follow-up `events.get` job.
- **Idempotency** — `requestId = bk<bookingId>` stable; retries never duplicate conferences.
- **Free-busy fidelity** — today `EXTERNAL_BUSY` is pulled workspace-wide; per-host calendar mapping (Phase 2) tightens it per host.
- **Reversible-migration constraint** — hand-author each `down.sql`; verify round-trip.
- **Timezone/DST** — `timezone-slots.ts` handles calendar-tz math; Phase 2 adds attendee-tz for customer-facing display.
- **Google consent screen** — creating conferences needs the OAuth app's Calendar scope through verification for external users; confirm the production Google app status before enabling Meet for external tenants.

---

## 7. Rollout / sequencing
Phases are independently shippable and gated, so each can go out under the tag-driven release once green. Order: 1 → 2 → 3 → 4 (2/3/4 depend on Phase 1's conferencing columns + events). Every phase: build → colocated + e2e tests green → migration round-trip verified → ship.
