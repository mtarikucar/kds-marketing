# Phase 1 — Conferencing Links (Google Meet + Teams) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a Google Meet or Microsoft Teams join link to every booking, hosted by the assigned staff member, surfaced in the confirmation email/ICS/reminders, with reliable teardown on cancel.

**Architecture:** Extend the existing Google/Outlook 2-way sync in `backend/src/modules/marketing/integrations/` with a thin `ConferenceProvider` abstraction. The push flow adds `conferenceData` (Google, `conferenceDataVersion=1`) / `onlineMeeting` (Teams) to the mirrored event, reads back the join URL, and persists it on the `Booking`. New `BookingCancelled/Updated/Rescheduled` domain events drive teardown via the outbox. Async Google `conferenceData` (`pending`) is resolved by a `ScheduledJob` follow-up.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres), `safeFetch` (SSRF-safe REST — no vendor SDK), `secret-box` sealed tokens, `ScheduledJob` runner (no BullMQ), Jest (colocated `*.spec.ts` + `backend/test/e2e/*.e2e-spec.ts`).

## Global Constraints

- ORM is **Prisma** (`backend/prisma/schema.prisma`); migrations in `backend/prisma/migrations/<UTCstamp>_<snake>/migration.sql`. **Every migration ships an up (`migration.sql`) AND a hand-authored `down.sql`** that drops exactly what the up added, idempotent (`IF EXISTS`), verified up→down→up.
- No new OAuth scope for Phase 1 — the existing `https://www.googleapis.com/auth/calendar` scope already permits `conferenceData`.
- All outbound HTTP via `safeFetch` (`backend/src/common/util/safe-fetch.ts`), `timeoutMs` set.
- Feature stays **inert** when unconfigured (`GoogleCalendarService.isConfigured()` / Outlook equivalent) — never throw into the booking flow; push is best-effort (logged, swallowed).
- Booking `status` is a plain `String` (not an enum) — no enum migration needed.
- Idempotency: Google `conferenceData.createRequest.requestId = "bk<bookingId-no-hyphens>"` (aligns with the existing `bk<uuid>` event-id scheme).
- Domain events use the `marketing.` prefix (already allowlisted in `outbox/event-types.ts` + dedup-required in `outbox.service.ts`); producers pass a deterministic `idempotencyKey`.
- RBAC/i18n/secret-box conventions per the design doc §5. Commit messages: plain conventional commits, **no AI/Claude trailer**.
- Run tests from `backend/`: `npx jest <path>` (unit), `npm run test:e2e` (e2e). Author migration: `npx prisma migrate dev --name <snake>`.

---

### Task 1: Migration — conferencing columns (reversible)

**Files:**
- Modify: `backend/prisma/schema.prisma` (models `Booking`, `BookingCalendar`)
- Create: `backend/prisma/migrations/<UTCstamp>_booking_conferencing/migration.sql`
- Create: `backend/prisma/migrations/<UTCstamp>_booking_conferencing/down.sql`

**Interfaces:**
- Produces: `Booking.meetingUrl/conferenceProvider/conferenceId/conferenceStatus` (all `String?`); `BookingCalendar.conferencing String @default("NONE")`, `BookingCalendar.conferenceConfig Json?`.

- [ ] **Step 1: Edit `schema.prisma` — add columns to `Booking`** (after `outlookEventId`):

```prisma
  // Conferencing (Phase 1): the video-meeting join link mirrored onto the
  // booking. provider = GOOGLE_MEET | TEAMS; conferenceId = hangout/onlineMeeting
  // id (teardown + pending follow-up); status = created | pending | failed | none.
  meetingUrl         String?
  conferenceProvider String?
  conferenceId       String?
  conferenceStatus   String?
```

- [ ] **Step 2: Edit `schema.prisma` — add fields to `BookingCalendar`** (after `active`):

```prisma
  // Which conferencing provider to attach to this calendar's bookings.
  conferencing     String  @default("NONE") // NONE | GOOGLE_MEET | TEAMS
  // Advanced-Meet config (recording/transcript/co-host), read only by Phase 4.
  conferenceConfig Json?
```

- [ ] **Step 3: Generate the migration**

Run: `cd backend && npx prisma migrate dev --name booking_conferencing`
Expected: creates `prisma/migrations/<stamp>_booking_conferencing/migration.sql` and regenerates the client. Note the exact `<stamp>` dir.

- [ ] **Step 4: Hand-author `down.sql`** in the same migration dir:

```sql
-- Down migration for booking_conferencing (reverses migration.sql exactly).
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "meetingUrl";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceProvider";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceId";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "conferenceStatus";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "conferencing";
ALTER TABLE "booking_calendars" DROP COLUMN IF EXISTS "conferenceConfig";
```

- [ ] **Step 5: Verify round-trip**

Run: `cd backend && psql "$DATABASE_URL" -f prisma/migrations/<stamp>_booking_conferencing/down.sql && npx prisma migrate deploy && npx prisma migrate status`
Expected: down runs clean; deploy re-applies; status shows up-to-date. (If no local DB, verify SQL by inspection: every `ADD COLUMN` in `migration.sql` has a matching `DROP COLUMN IF EXISTS` in `down.sql`.)

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(scheduling): add conferencing columns to bookings and calendars"
```

---

### Task 2: DTO + calendar CRUD — accept `conferencing`

**Files:**
- Modify: `backend/src/modules/marketing/dto/site.dto.ts` (`CreateCalendarDto`)
- Modify: `backend/src/modules/marketing/sites/booking.service.ts:61-106` (`create`/`update`)
- Test: `backend/src/modules/marketing/sites/booking.service.spec.ts`

**Interfaces:**
- Produces: `CreateCalendarDto.conferencing?: string`; `BookingService.create/update` persist `conferencing` when a valid enum value.

- [ ] **Step 1: Write the failing test** — append to `booking.service.spec.ts` (inside the existing describe, reuse its Prisma mock):

```ts
it('persists a valid conferencing value on create, defaulting invalid to NONE', async () => {
  const createSpy = jest.spyOn(prisma.bookingCalendar, 'create').mockResolvedValue({ id: 'c1' } as any);
  await service.create('ws1', { name: 'Sales', conferencing: 'GOOGLE_MEET' });
  expect(createSpy.mock.calls[0][0].data.conferencing).toBe('GOOGLE_MEET');
  await service.create('ws1', { name: 'X', conferencing: 'BOGUS' });
  expect(createSpy.mock.calls[1][0].data.conferencing).toBe('NONE');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/sites/booking.service.spec.ts -t conferencing`
Expected: FAIL (`data.conferencing` is `undefined`).

- [ ] **Step 3: Implement** — add to `site.dto.ts` `CreateCalendarDto`:

```ts
  @IsOptional() @IsString() @IsIn(['NONE', 'GOOGLE_MEET', 'TEAMS']) conferencing?: string;
```

Add a module-level const near `CALENDAR_TYPES` in `booking.service.ts`:

```ts
const CONFERENCING = ['NONE', 'GOOGLE_MEET', 'TEAMS'];
```

In `create(...)` data object add:

```ts
          conferencing: CONFERENCING.includes(dto.conferencing) ? dto.conferencing : 'NONE',
```

In `update(...)` after the `type` guard add:

```ts
    if (dto.conferencing !== undefined && CONFERENCING.includes(dto.conferencing)) data.conferencing = dto.conferencing;
```

(Ensure `IsIn` is imported in `site.dto.ts`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/sites/booking.service.spec.ts -t conferencing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/dto/site.dto.ts backend/src/modules/marketing/sites/booking.service.ts backend/src/modules/marketing/sites/booking.service.spec.ts
git commit -m "feat(scheduling): accept per-calendar conferencing provider in calendar CRUD"
```

---

### Task 3: Domain events — BookingCancelled / Updated / Rescheduled

**Files:**
- Modify: `backend/src/modules/marketing/events/marketing-event-types.ts`
- Test: `backend/src/modules/marketing/events/marketing-event-types.spec.ts` (create)

**Interfaces:**
- Produces: `MarketingEventTypes.BookingCancelled = 'marketing.booking.cancelled.v1'`, `BookingUpdated = 'marketing.booking.updated.v1'`, `BookingRescheduled = 'marketing.booking.rescheduled.v1'`; `interface MarketingBookingLifecyclePayload { workspaceId; bookingId; calendarId?; occurredAt }`.

- [ ] **Step 1: Write the failing test** — create `marketing-event-types.spec.ts`:

```ts
import { MarketingEventTypes } from './marketing-event-types';
it('defines booking lifecycle event names under the marketing prefix', () => {
  expect(MarketingEventTypes.BookingCancelled).toBe('marketing.booking.cancelled.v1');
  expect(MarketingEventTypes.BookingUpdated).toBe('marketing.booking.updated.v1');
  expect(MarketingEventTypes.BookingRescheduled).toBe('marketing.booking.rescheduled.v1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/events/marketing-event-types.spec.ts`
Expected: FAIL (undefined keys).

- [ ] **Step 3: Implement** — add to `MarketingEventTypes` (after `BookingCreated`):

```ts
  BookingCancelled: "marketing.booking.cancelled.v1",
  BookingUpdated: "marketing.booking.updated.v1",
  BookingRescheduled: "marketing.booking.rescheduled.v1",
```

Add the payload interface at the bottom of the file:

```ts
export interface MarketingBookingLifecyclePayload {
  workspaceId: string;
  bookingId: string;
  calendarId?: string;
  occurredAt: string;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/events/marketing-event-types.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/events/marketing-event-types.ts backend/src/modules/marketing/events/marketing-event-types.spec.ts
git commit -m "feat(scheduling): add booking cancelled/updated/rescheduled domain events"
```

---

### Task 4: Conferencing provider abstraction + host resolution

**Files:**
- Create: `backend/src/modules/marketing/integrations/conferencing/conference-provider.interface.ts`
- Create: `backend/src/modules/marketing/integrations/conferencing/host-resolver.service.ts`
- Test: `backend/src/modules/marketing/integrations/conferencing/host-resolver.service.spec.ts`

**Interfaces:**
- Produces:
  - `type ConferenceProviderKind = 'GOOGLE_MEET' | 'TEAMS';`
  - `interface ConferenceResult { provider: ConferenceProviderKind; joinUrl: string | null; conferenceId: string | null; requestId: string; status: 'created' | 'pending' | 'failed'; }`
  - `interface HostConnection { kind: ConferenceProviderKind; connectionId: string; marketingUserId: string; }`
  - `HostResolverService.resolve(workspaceId, booking, kind): Promise<HostConnection | null>` — resolution order: booking.assigneeUserId's enabled connection → calendar.ownerUserId's → workspace's first enabled → null.

- [ ] **Step 1: Write the failing test** — `host-resolver.service.spec.ts`:

```ts
import { HostResolverService } from './host-resolver.service';

function svc(rows: any[]) {
  const prisma: any = {
    googleCalendarConnection: { findFirst: jest.fn(async ({ where }: any) =>
      rows.find(r => r.marketingUserId === where.marketingUserId && r.enabled) ?? null) },
    bookingCalendar: { findFirst: jest.fn(async () => ({ ownerUserId: 'owner1' })) },
  };
  // second findFirst (no marketingUserId) returns the workspace's first enabled
  prisma.googleCalendarConnection.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.marketingUserId) return rows.find(r => r.marketingUserId === where.marketingUserId && r.enabled) ?? null;
    return rows.find(r => r.enabled) ?? null;
  });
  return new HostResolverService(prisma);
}

it('prefers the assignee connection', async () => {
  const s = svc([{ id: 'gA', marketingUserId: 'assignee1', enabled: true }]);
  const host = await s.resolve('ws1', { calendarId: 'c1', assigneeUserId: 'assignee1' } as any, 'GOOGLE_MEET');
  expect(host).toEqual({ kind: 'GOOGLE_MEET', connectionId: 'gA', marketingUserId: 'assignee1' });
});

it('returns null when no connection exists', async () => {
  const s = svc([]);
  const host = await s.resolve('ws1', { calendarId: 'c1', assigneeUserId: 'x' } as any, 'GOOGLE_MEET');
  expect(host).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/integrations/conferencing/host-resolver.service.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `conference-provider.interface.ts`:

```ts
export type ConferenceProviderKind = 'GOOGLE_MEET' | 'TEAMS';

export interface ConferenceResult {
  provider: ConferenceProviderKind;
  joinUrl: string | null;
  conferenceId: string | null;
  requestId: string;
  status: 'created' | 'pending' | 'failed';
}

export interface HostConnection {
  kind: ConferenceProviderKind;
  connectionId: string;
  marketingUserId: string;
}
```

`host-resolver.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ConferenceProviderKind, HostConnection } from './conference-provider.interface';

/**
 * Resolve WHICH connected calendar account hosts a booking's video conference.
 * Order: the assigned member's own enabled connection → the calendar owner's →
 * the workspace's first enabled connection → null (linkless booking). Google
 * and Teams use their respective connection tables based on `kind`.
 */
@Injectable()
export class HostResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    workspaceId: string,
    booking: { calendarId: string; assigneeUserId?: string | null },
    kind: ConferenceProviderKind,
  ): Promise<HostConnection | null> {
    const table: any =
      kind === 'GOOGLE_MEET'
        ? this.prisma.googleCalendarConnection
        : this.prisma.outlookCalendarConnection;

    const byUser = async (marketingUserId: string) =>
      (await table.findFirst({ where: { workspaceId, marketingUserId, enabled: true }, orderBy: { createdAt: 'asc' } })) ?? null;

    let row = booking.assigneeUserId ? await byUser(booking.assigneeUserId) : null;
    if (!row) {
      const cal = await this.prisma.bookingCalendar.findFirst({ where: { id: booking.calendarId, workspaceId }, select: { ownerUserId: true } });
      if (cal?.ownerUserId) row = await byUser(cal.ownerUserId);
    }
    if (!row) row = await table.findFirst({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    if (!row) return null;
    return { kind, connectionId: row.id, marketingUserId: row.marketingUserId };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/integrations/conferencing/host-resolver.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Register + commit** — add `HostResolverService` to `marketing.module.ts` providers (near the calendar sync services, ~L738), then:

```bash
git add backend/src/modules/marketing/integrations/conferencing backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(scheduling): add conferencing provider interface and host resolver"
```

---

### Task 5: Google Meet — attach conferenceData on push + persist join URL

**Files:**
- Modify: `backend/src/modules/marketing/integrations/google-calendar-sync.service.ts` (`pushBooking` body ~L146; POST/PATCH URLs; response handling)
- Test: `backend/src/modules/marketing/integrations/google-calendar-sync.service.spec.ts`

**Interfaces:**
- Consumes: `HostResolverService.resolve`, `BookingCalendar.conferencing`, `Booking.meetingUrl/conferenceProvider/conferenceId/conferenceStatus`.
- Produces: `pushBooking` persists the Meet join URL when the calendar's `conferencing === 'GOOGLE_MEET'`; returns the same event id contract as today.

- [ ] **Step 1: Write the failing test** — add to `google-calendar-sync.service.spec.ts` (reuse its Google/Prisma mocks; mock the calendar as `conferencing: 'GOOGLE_MEET'`, host resolvable, and the events POST returning `{ id, hangoutLink: 'https://meet.google.com/abc', conferenceData: { conferenceId: 'abc' } }`):

```ts
it('adds conferenceData and persists the Meet link when calendar opts in', async () => {
  // arrange: booking with no googleEventId, calendar.conferencing = GOOGLE_MEET,
  // host resolves, apiJson POST returns a hangoutLink.
  const updateSpy = jest.spyOn(prisma.booking, 'updateMany');
  await service.pushBooking('ws1', 'bk1');
  const postBody = JSON.parse(apiJson.mock.calls.find(c => c[2]?.method === 'POST')[1] ?? apiJson.mock.calls[0][0]);
  // conferenceData present + versioned url
  expect(apiJson.mock.calls.some(c => String(c[0]).includes('conferenceDataVersion=1'))).toBe(true);
  expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ meetingUrl: 'https://meet.google.com/abc', conferenceProvider: 'GOOGLE_MEET', conferenceStatus: 'created' }),
  }));
});
```

> Note for implementer: the exact mock wiring mirrors the existing `pushBooking` tests in this spec file — copy their `apiJson`/`getFreshAccessToken` stubs and extend the calendar/host stubs. If the spec has no `apiJson` spy yet, spy on `service['apiJson']`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/integrations/google-calendar-sync.service.spec.ts -t conferenceData`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `pushBooking`, after loading `booking` and before building `body`, resolve conferencing:

```ts
    const cal = await this.prisma.bookingCalendar.findFirst({
      where: { id: booking.calendarId, workspaceId }, select: { conferencing: true },
    });
    const wantsMeet = cal?.conferencing === 'GOOGLE_MEET';
    const host = wantsMeet ? await this.hostResolver.resolve(workspaceId, booking, 'GOOGLE_MEET') : null;
```

Extend `body` with (only when `wantsMeet && host`):

```ts
      ...(wantsMeet && host
        ? { conferenceData: { createRequest: { requestId: `bk${booking.id.replace(/-/g, '')}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
        : {}),
```

Append `?conferenceDataVersion=1` to the POST and PATCH URLs when `wantsMeet && host` (build the URL with a helper `withConfVersion(url)` that appends the query param). After a successful create/patch, extract + persist the link:

```ts
      const link = (event as any).hangoutLink
        ?? (event as any).conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri
        ?? null;
      const confId = (event as any).conferenceData?.conferenceId ?? null;
      const pending = (event as any).conferenceData?.createRequest?.status?.statusCode === 'pending';
      if (wantsMeet && host) {
        await this.prisma.booking.updateMany({
          where: { id: booking.id, workspaceId },
          data: {
            meetingUrl: link, conferenceProvider: 'GOOGLE_MEET', conferenceId: confId,
            conferenceStatus: link ? 'created' : pending ? 'pending' : 'failed',
          },
        });
        if (!link && pending) {
          await this.scheduledJobs.schedule({
            workspaceId, kind: 'booking.conference.resolve', runAt: new Date(Date.now() + 30_000),
            dedupKey: `conf:${booking.id}`, payload: { workspaceId, bookingId: booking.id },
          });
        }
      }
```

Inject `HostResolverService` and `ScheduledJobService` into the constructor; register the `'booking.conference.resolve'` handler in `onModuleInit` (does a follow-up `events.get` and persists the link if now available).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/integrations/google-calendar-sync.service.spec.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/integrations/google-calendar-sync.service.ts backend/src/modules/marketing/integrations/google-calendar-sync.service.spec.ts backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(scheduling): create Google Meet link on booking push and persist it"
```

---

### Task 6: Teams — attach onlineMeeting on Outlook push + persist join URL

**Files:**
- Modify: `backend/src/modules/marketing/integrations/outlook-calendar-sync.service.ts` (`eventBody` ~L747; response handling)
- Test: `backend/src/modules/marketing/integrations/outlook-calendar-sync.service.spec.ts`

**Interfaces:**
- Consumes: `HostResolverService.resolve(..., 'TEAMS')`, `BookingCalendar.conferencing`.
- Produces: `pushBooking` sets `isOnlineMeeting: true` + `onlineMeetingProvider: 'teamsForBusiness'` and persists `onlineMeeting.joinUrl` when `conferencing === 'TEAMS'`.

- [ ] **Step 1: Write the failing test** — mirror Task 5's test in the Outlook spec: calendar `conferencing: 'TEAMS'`, host resolves, POST returns `{ id, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/xyz' } }`; assert `booking.updateMany` persists `meetingUrl: 'https://teams.microsoft.com/l/xyz'`, `conferenceProvider: 'TEAMS'`, `conferenceStatus: 'created'`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/integrations/outlook-calendar-sync.service.spec.ts -t Teams`
Expected: FAIL.

- [ ] **Step 3: Implement** — make `eventBody` conferencing-aware (pass a `wantsTeams` flag), adding when true:

```ts
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
```

After create/patch, read back `resp.onlineMeeting?.joinUrl` and `resp.onlineMeeting?.joinUrl` id, and `booking.updateMany` with `meetingUrl/conferenceProvider:'TEAMS'/conferenceStatus`. Inject `HostResolverService`; gate on `cal.conferencing === 'TEAMS'` and a resolvable host. (Graph returns `onlineMeeting` synchronously — no pending path needed.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/integrations/outlook-calendar-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/integrations/outlook-calendar-sync.service.ts backend/src/modules/marketing/integrations/outlook-calendar-sync.service.spec.ts backend/src/modules/marketing/marketing.module.ts
git commit -m "feat(scheduling): create Teams online meeting on Outlook push and persist it"
```

---

### Task 7: Emit BookingCancelled + conference teardown

**Files:**
- Modify: `backend/src/modules/marketing/sites/booking.service.ts` (`cancel` ~L464; `book` outbox append ~L425)
- Modify: `backend/src/modules/marketing/integrations/google-calendar-sync.service.ts` (subscribe to `BookingCancelled`)
- Modify: `backend/src/modules/marketing/integrations/outlook-calendar-sync.service.ts` (subscribe to `BookingCancelled`)
- Test: `backend/src/modules/marketing/sites/booking.service.spec.ts`

**Interfaces:**
- Consumes: `MarketingEventTypes.BookingCancelled`, `MarketingBookingLifecyclePayload`.
- Produces: `cancel()` emits `BookingCancelled` via `outbox.append`; deleting the Google/Outlook event (which removes the Meet/Teams conference) now also runs off the event, with the direct calls kept as a self-healing fallback.

- [ ] **Step 1: Write the failing test** — assert `cancel()` calls `outbox.append` with `type: MarketingEventTypes.BookingCancelled` and `idempotencyKey: 'booking-cancelled:<id>'`.

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement** — in `cancel()`, wrap the status update + emit in a `$transaction` so the event is transactional with the state change:

```ts
    if (existing.status !== 'CANCELLED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.booking.updateMany({ where: { id: existing.id, workspaceId }, data: { status: 'CANCELLED' } });
        await this.outbox.append({
          type: MarketingEventTypes.BookingCancelled,
          idempotencyKey: `booking-cancelled:${existing.id}`,
          payload: { workspaceId, bookingId: existing.id, occurredAt: new Date().toISOString() },
        }, tx as any);
      });
      this.googleSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
      this.outlookSync.cancelBooking(workspaceId, existing.id).catch(() => undefined);
    }
```

In each sync service `onModuleInit`, add `this.bus.on(MarketingEventTypes.BookingCancelled, handler)` where the handler calls `cancelBooking(payload.workspaceId, payload.bookingId)`; `onModuleDestroy` removes it. (`cancelBooking` already deletes the Google/Outlook event, which tears down the attached Meet/Teams conference.)

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/sites/booking.service.ts backend/src/modules/marketing/integrations/google-calendar-sync.service.ts backend/src/modules/marketing/integrations/outlook-calendar-sync.service.ts backend/src/modules/marketing/sites/booking.service.spec.ts
git commit -m "feat(scheduling): emit BookingCancelled and tear down conference on cancel"
```

---

### Task 8: Surface the join link in confirmation email + ICS + reminder

**Files:**
- Create: `backend/src/modules/marketing/sites/ics.util.ts`
- Modify: `backend/src/modules/marketing/sites/booking.service.ts` (`book` confirmation ~L437; `remind` ~L486)
- Test: `backend/src/modules/marketing/sites/ics.util.spec.ts`

**Interfaces:**
- Produces: `buildIcs({ uid, start, end, summary, description, joinUrl?, organizerEmail? }): string` — RFC-5545 VEVENT with `URL`/`LOCATION`/`X-GOOGLE-CONFERENCE` when `joinUrl` set.

- [ ] **Step 1: Write the failing test** — `ics.util.spec.ts`: assert output contains `BEGIN:VEVENT`, `UID:`, `DTSTART:`, and when `joinUrl` given, a `URL:` and `LOCATION:` line with the link; CRLF line endings.

- [ ] **Step 2: Run to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement** `ics.util.ts` (pure function, no deps; format times as UTC `YYYYMMDDTHHMMSSZ`, escape `,;\\n`), then in `book()` fetch the just-written `meetingUrl` (re-read the booking or pass it through) and include it in the email body + attach the ICS via `EmailService.sendEmail` (which supports attachments) instead of `sendPlainEmail`; include the join URL line in `remind()`.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/sites/ics.util.ts backend/src/modules/marketing/sites/ics.util.spec.ts backend/src/modules/marketing/sites/booking.service.ts
git commit -m "feat(scheduling): include Meet/Teams join link in confirmation email, ICS and reminder"
```

---

### Task 9: E2E — book a Meet-enabled calendar end to end

**Files:**
- Create: `backend/test/e2e/booking-conferencing.e2e-spec.ts`

**Interfaces:**
- Consumes: the shared `test/utils/test-app.ts` harness (real AppModule + deep-mocked Prisma).

- [ ] **Step 1: Write the test** — with Google configured (mock `isConfigured` true) and a `GOOGLE_MEET` calendar + resolvable connection, POST a public reserve and assert the created booking is stored with `conferenceProvider: 'GOOGLE_MEET'` and a `meetingUrl`; then cancel and assert `BookingCancelled` was appended to the outbox and `cancelBooking` invoked. Mirror an existing calendar e2e for setup.

- [ ] **Step 2: Run**

Run: `cd backend && npm run test:e2e -- booking-conferencing`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/e2e/booking-conferencing.e2e-spec.ts
git commit -m "test(scheduling): e2e for Meet-enabled booking and conference teardown"
```

---

### Task 10: `.env.example` + docs

**Files:**
- Modify: `backend/.env.example`
- Modify: `docs/superpowers/specs/2026-07-01-google-meet-calendar-scheduling-design.md` (mark Phase 1 done)

- [ ] **Step 1:** Add a commented note under the Google/MS OAuth section of `.env.example` that Meet needs no extra scope and Teams needs `MS_OAUTH_CLIENT_ID/_SECRET`; document `conferencing` per-calendar.
- [ ] **Step 2: Commit**

```bash
git add backend/.env.example docs/superpowers/specs/2026-07-01-google-meet-calendar-scheduling-design.md
git commit -m "docs(scheduling): document conferencing configuration for Phase 1"
```

---

## Self-Review

**Spec coverage (design §4 Phase 1):** provider abstraction (Task 4) ✓; Meet conferenceData + pending resolve (Task 5) ✓; Teams onlineMeeting (Task 6) ✓; per-host resolution (Task 4) ✓; BookingCancelled/Updated/Rescheduled events (Task 3) + teardown (Task 7) ✓; email/ICS/reminder join link (Task 8) ✓; migration up/down (Task 1) ✓; DTO conferencing (Task 2) ✓; e2e (Task 9) ✓; env/docs (Task 10) ✓. `BookingUpdated`/`BookingRescheduled` names are defined in Task 3 and consumed in Phase 2 (reschedule) — defined-before-use holds within the program.

**Placeholder scan:** Task 5/6/9 reference "mirror the existing spec's mocks" rather than reproducing the whole mock harness — this is a deliberate pointer to a concrete existing file, not a TODO; the new assertions are shown in full.

**Type consistency:** `ConferenceResult`/`HostConnection`/`ConferenceProviderKind` names match across Tasks 4–6; `conferenceStatus` values (`created|pending|failed`) consistent with the migration comment (`created|pending|failed|none`); `requestId = bk<bookingId-no-hyphens>` consistent with the existing event-id scheme.
