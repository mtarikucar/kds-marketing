# Phase 2 — Rich Availability + Appointment Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Checkbox steps track progress.

**Goal:** Turn the fixed weekly-window booking engine into a policy-rich one — blackout/time-off, per-staff working hours, min-notice / max-advance, before/after buffers, reschedule, a full appointment status lifecycle (PENDING/NO_SHOW/COMPLETED/RESCHEDULED), configurable multi-lead-time reminders, and attendee-timezone capture.

**Architecture:** Extend `booking.service.ts` (`availability()`/`isAlignedSlot()`/`book()`) and its DTOs/controller in place; add two Prisma models (`BookingBlackout`, `MemberAvailability`) and policy columns on `BookingCalendar`/`Booking`. Reminders move from a single hard-coded T-1h job to a `reminderConfig`-driven scheduler. Reversible migration.

**Tech Stack:** NestJS 11, Prisma 6, `timezone-slots.ts` (DST-safe), `ScheduledJob` runner, Jest.

## Global Constraints

- Reversible migration (up `migration.sql` + hand-authored `down.sql`, verified by inspection since no local DB; `npx prisma generate` to refresh the client).
- Booking `status` stays a plain String — widen the allowed set by comment only (`CONFIRMED|CANCELLED|EXTERNAL_BUSY|PENDING|NO_SHOW|COMPLETED|RESCHEDULED`).
- Back-compat: every new policy column has a safe default (`minNoticeMinutes 0`, `maxAdvanceDays 60`, buffers `0`), so existing calendars behave as today except `maxAdvanceDays` (60) replaces the hard-coded 21-day cap.
- All queries workspace-scoped; RBAC unchanged (MANAGER + `funnels` + `settings.manage`); public routes `@MarketingPublic()` + `@Throttle`.
- Commit per task, plain conventional messages (no AI trailer). Tests from `backend/`.

---

### Task 1: Migration — policy columns + BookingBlackout + MemberAvailability

**Files:** `prisma/schema.prisma`; `prisma/migrations/20260701130000_booking_availability_policy/{migration.sql,down.sql}`

**Interfaces (Produces):** `BookingCalendar.minNoticeMinutes/maxAdvanceDays/bufferBeforeMinutes/bufferAfterMinutes Int` + `reminderConfig Json?` + `requiresApproval Boolean`; `Booking.attendeeTimezone String?` + `rescheduledFromId String?`; models `BookingBlackout`, `MemberAvailability`.

- [ ] Edit schema (BookingCalendar): add `minNoticeMinutes Int @default(0)`, `maxAdvanceDays Int @default(60)`, `bufferBeforeMinutes Int @default(0)`, `bufferAfterMinutes Int @default(0)`, `requiresApproval Boolean @default(false)`, `reminderConfig Json?`.
- [ ] Edit schema (Booking): add `attendeeTimezone String?`, `rescheduledFromId String?`.
- [ ] Add models:
```prisma
model BookingBlackout {
  id              String   @id @default(uuid())
  workspaceId     String
  calendarId      String?  // null = all calendars in the workspace
  marketingUserId String?  // null = whole calendar; set = one staff member's time off
  startAt         DateTime
  endAt           DateTime
  reason          String?
  createdAt       DateTime @default(now())
  @@index([workspaceId, calendarId])
  @@index([workspaceId, marketingUserId])
  @@map("booking_blackouts")
}
model MemberAvailability {
  id              String   @id @default(uuid())
  workspaceId     String
  calendarId      String
  marketingUserId String
  availability    Json     // same weekday->[{start,end}] shape as BookingCalendar
  timezone        String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([calendarId, marketingUserId])
  @@index([workspaceId])
  @@map("member_availability")
}
```
- [ ] Write `migration.sql` (ALTER ADD COLUMN ×8 with defaults; CREATE TABLE ×2 + indexes) and `down.sql` (DROP TABLE IF EXISTS ×2; ALTER DROP COLUMN IF EXISTS ×8).
- [ ] `npx prisma validate && npx prisma generate`; verify every up statement has a down counterpart.
- [ ] Commit `feat(scheduling): add availability policy columns, blackout & member-availability models`.

### Task 2: Availability policy — min-notice, max-advance, before/after buffers

**Files:** `sites/booking.service.ts` (`availability()`, `isAlignedSlot()`); `sites/booking.service.spec.ts`

- [ ] Test: a calendar with `minNoticeMinutes: 120` hides slots < now+2h; `maxAdvanceDays: 3` caps the window at 3 days; `bufferBeforeMinutes/AfterMinutes` widen the step so offered starts are spaced `slot+before+after`.
- [ ] Implement: replace `MAX_RANGE_DAYS` cap with `cal.maxAdvanceDays` (fallback 60); `earliest = now + minNoticeMinutes*60000`, drop `s < earliest`; `step = slotMinutes + (bufferBeforeMinutes + bufferAfterMinutes || bufferMinutes)` (legacy `bufferMinutes` used when both are 0). Mirror in `isAlignedSlot()`. Fix the stale class docstring.
- [ ] Run tests; commit `feat(scheduling): enforce min-notice, max-advance and before/after buffers in availability`.

### Task 3: Blackout / time-off hard-blocks

**Files:** `sites/booking.service.ts` (`availability()`, `book()`), new `sites/blackout.util.ts` (pure overlap helper); specs

**Interfaces (Produces):** `overlapsBlackout(blackouts, startMs, endMs, assigneeUserId?): boolean`.

- [ ] Test (blackout.util.spec.ts): a workspace-wide blackout blocks any overlapping slot; a `marketingUserId`-scoped blackout blocks only that assignee's slots.
- [ ] Implement `blackout.util.ts`; in `availability()` load `bookingBlackout.findMany({ where: { workspaceId, OR: [{calendarId: null}, {calendarId}] , endAt: { gt: from }, startAt: { lt: to } } })` and hard-block overlapping slots (member-scoped ones only block that member — for SINGLE/CLASS treat member-scoped as ownerUserId); in `book()` re-check under the advisory lock.
- [ ] Run tests; commit `feat(scheduling): hard-block bookings during blackout / time-off windows`.

### Task 4: Reschedule (admin + public-by-token) + lifecycle statuses

**Files:** `sites/booking.service.ts` (new `reschedule()`, `setStatus()`); `controllers/marketing-booking.controller.ts` (+`PATCH bookings/:id/status`, `POST bookings/:id/reschedule`); `controllers/public-site.controller.ts` (+`POST book/:ws/:cal/reschedule/:token`); DTOs; specs

**Interfaces (Produces):** `reschedule(workspaceId, bookingId, newStartISO): Promise<{id;startAt}>` (validates the new slot like `book()`, patches the mirror, emits `BookingRescheduled`, sets old row `RESCHEDULED` + `rescheduledFromId` chain); `setStatus(workspaceId, bookingId, status)` for `NO_SHOW|COMPLETED|CONFIRMED` (approval) emitting `BookingUpdated`.

- [ ] Test: reschedule moves startAt, links `rescheduledFromId`, emits `BookingRescheduled`; setStatus rejects an invalid target; approval flips `PENDING`→`CONFIRMED`.
- [ ] Implement service methods + controller routes (MANAGER-gated admin; token-scoped public reschedule re-validates alignment + notice); emit events via outbox transactionally.
- [ ] Run tests; commit `feat(scheduling): reschedule and appointment status lifecycle (no-show/completed/approval)`.

### Task 5: reminderConfig-driven multi-lead-time reminders + attendee timezone

**Files:** `sites/booking.service.ts` (`book()` reminder scheduling, `remind()`); DTO (`reminderConfig`, capture `attendeeTimezone` on public reserve); `dto/site.dto.ts`, `public-site.controller.ts`; specs

**Interfaces (Consumes):** `BookingCalendar.reminderConfig` = `Array<{offsetMinutes:number; channels:('EMAIL'|'SMS')[]; audience:'CUSTOMER'|'HOST'|'BOTH'}>`.

- [ ] Test: with two reminder entries (T-24h + T-1h) `book()` schedules two `booking.reminder` jobs (deduped by offset); no config falls back to the single T-1h; customer-facing times render in `attendeeTimezone` when provided.
- [ ] Implement: parse `reminderConfig` (default `[{offsetMinutes:60,channels:['EMAIL'],audience:'CUSTOMER'}]`); schedule one job per entry (dedupKey `${bookingId}:${offsetMinutes}`); `remind()` reads the entry, sends EMAIL (and SMS best-effort via the NetGSM channel when `channels` includes SMS and a channel exists), to CUSTOMER and/or HOST; format the time in `attendeeTimezone || calendar.timezone`. Capture `attendeeTimezone` from the reserve DTO.
- [ ] Run tests; commit `feat(scheduling): configurable multi-lead-time + multi-channel reminders and attendee timezone`.

### Task 6: Blackout + member-availability admin CRUD

**Files:** `controllers/marketing-booking.controller.ts` (+blackout & member-availability routes); `sites/booking.service.ts` (CRUD); DTOs; specs; e2e

- [ ] Test: create/list/delete a blackout; set a member's availability; all workspace-scoped + MANAGER-gated.
- [ ] Implement CRUD + routes; per-member availability intersection in `availability()` for ROUND_ROBIN (offer a member's slot only inside calendar∩member windows).
- [ ] Run tests; commit `feat(scheduling): blackout & per-member availability admin CRUD + round-robin intersection`.

---

## Self-Review
Covers spec §4 Phase 2: blackout/PTO (T1,T3,T6), per-staff hours (T1,T6), min-notice/max-advance/buffers (T2), reschedule + lifecycle (T4), multi-channel reminders + attendee TZ (T5). Types (`reminderConfig` shape, `overlapsBlackout`, `reschedule`/`setStatus` signatures) are defined where introduced and consumed consistently. No placeholders.
