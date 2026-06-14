# Routine trigger + schedule layer — design

**Date:** 2026-06-14
**Status:** approved-direction (user) — decisions controller-made

## Goal

The 4 cloud routines (review-draft, content-pack, insight-digest, lead-scoring)
stay on claude.ai but use the **"Call via API"** trigger instead of claude.ai's
built-in cron Schedule. **Our backend owns when they run** and fires them by
calling each routine's trigger URL. Triggers come from three sources:
1. **Manual** — a button in the platform (superadmin) panel.
2. **Schedule** — a cron the operator configures in the panel, run by a backend
   scheduler (multi-replica-safe).
3. **Event** — reactive: a new private-feedback review fires review-draft; a lead
   ingest fires lead-scoring (debounced).

This layer is **purely additive** — the existing routine→backend data API
(`internal/{reviews,content,insights,lead-scoring}` + `RoutineTokenGuard` +
`ROUTINE_TOKEN`) is unchanged; it's what the routine calls DURING its run. This
new layer is what STARTS the run.

## Distinction (the earlier confusion)
- **Claude API** (Messages API, credit-metered) — NOT used here.
- **Routine trigger API** (claude.ai "Call via API") — what this layer calls.

## Decisions (controller-made)
- Trigger URL + token live in the DB (`RoutineConfig`), token sealed via
  `secret-box` — so the operator pastes claude.ai's Call-via-API URL+token into
  the panel (no redeploy). **Requires `MARKETING_SECRET_KEY`.**
- Manual trigger ignores `enabled` (explicit admin action); schedule + event
  triggers respect `enabled`.
- Event triggers are debounced by `eventCooldownSec` (default 300s) to batch
  bursts (a workspace getting 50 reviews shouldn't fire 50 triggers).
- Scheduler uses `@nestjs/schedule` `SchedulerRegistry` dynamic `CronJob`s, each
  firing inside `withAdvisoryLock` (the established multi-replica pattern).
- Routine config is **global/platform-level** (routines process all workspaces),
  so management lives in the platform (superadmin) realm.

### Non-goals
- No change to the 4 internal data-API controllers / `RoutineTokenGuard` / prompts.
- No per-workspace routine config (it's global).
- The actual claude.ai trigger-API request shape is assumed `POST <triggerUrl>`
  with `Authorization: Bearer <token>` + JSON `{ source }`. If claude.ai's real
  contract differs, only `RoutineTriggerService.fire()` changes (one method).

## Data model (1 new Prisma model)
```prisma
model RoutineConfig {
  id                 String  @id @default(uuid())
  key                String  @unique // review-draft | content-pack | insight-digest | lead-scoring
  enabled            Boolean @default(false)
  /// Cron for the backend scheduler (null = no schedule; manual/event only).
  cron               String?
  /// React to domain events (review-draft: new private feedback; lead-scoring: lead ingest).
  onEvent            Boolean @default(false)
  /// claude.ai "Call via API" trigger endpoint + sealed token.
  triggerUrl         String?
  triggerTokenSealed String? @db.Text
  /// Min seconds between event-driven triggers (debounce bursts).
  eventCooldownSec   Int     @default(300)
  lastTriggeredAt    DateTime?
  lastTriggerStatus  String?  // ok | error
  lastTriggerError   String?  @db.Text
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@map("routine_configs")
}
```
Migration hand-authored (DB-less env). On boot, `RoutineConfigService` upserts
the 4 keys (`review-draft`, `content-pack`, `insight-digest`, `lead-scoring`)
with `enabled: false` so the rows always exist.

## Backend — new `RoutinesModule` (`src/modules/routines/`)

Imports `PrismaModule` (global), the outbox module (for `DomainEventBus`), and is
imported by `AppModule`. Uses `ConfigService`, `SchedulerRegistry`, `secret-box`.

### `RoutineConfigService`
- `ensureSeeded()` (onModuleInit): upsert the 4 keys.
- `list()`: all 4 configs (token NEVER returned — return `hasToken: boolean`).
- `get(key)`: one config.
- `update(key, dto)`: set cron/enabled/onEvent/triggerUrl; if `triggerToken`
  provided, seal it via `secret-box.sealSecret` (503 if `MARKETING_SECRET_KEY`
  unset) and store in `triggerTokenSealed`. After update, call
  `scheduleRunner.reload(key)`.
- `recordTrigger(key, status, error?)`: stamp `lastTriggeredAt/Status/Error`.
- `resolveToken(config)`: `openSecret(triggerTokenSealed)` or null.

### `RoutineTriggerService`
- `trigger(key, source: 'manual'|'schedule'|'event'): Promise<{ ok, error? }>`:
  1. Load config. If `source !== 'manual'` and `!enabled` → skip (return ok:false, reason).
  2. If `source === 'event'` and `lastTriggeredAt` within `eventCooldownSec` → skip (cooldown).
  3. If no `triggerUrl` → record error "no trigger url", return.
  4. `fire(triggerUrl, token, source)` — `fetch` POST, `Authorization: Bearer <token>`,
     body `{ source }`, `AbortSignal.timeout(30_000)`, mirror the
     `http-core-provisioning.client.ts` error handling.
  5. `recordTrigger(key, 'ok'|'error', err?)`.
- `fire()` is the ONLY method coupled to claude.ai's exact contract.

### `RoutineScheduleRunner`
- onModuleInit: `reloadAll()` — for each enabled config with a cron, register a
  `CronJob(cron, () => withAdvisoryLock(prisma, 'routine-sched:'+key, () => trigger(key,'schedule'), logger))`
  via `SchedulerRegistry.addCronJob('routine:'+key, job)` + `job.start()`.
- `reload(key)`: remove the existing job if registered (`schedulerRegistry.deleteCronJob`),
  re-add if the config is enabled + has a cron. Called after every config update.
- Invalid cron strings are caught + logged (don't crash boot); the PATCH endpoint
  validates the cron before saving (see controller).

### `RoutineEventListener`
- onModuleInit: `domainEventBus.on('marketing.review.received.v1', handler)` and
  `domainEventBus.on('marketing.lead.created.v1', handler)`.
- review handler: if payload status === 'PRIVATE_FEEDBACK' → `trigger('review-draft','event')`.
- lead handler: → `trigger('lead-scoring','event')`.
- Both rely on the trigger's enabled + cooldown gating (handler just calls trigger).
- Handlers never throw (the bus isolates, but be safe — catch + log).

## Backend — platform controller

`src/modules/platform/controllers/routine-admin.controller.ts`,
`@Controller('platform/routines')`, `@UseGuards(PlatformGuard)`:
- `GET /platform/routines` → `routineConfigService.list()` (no tokens; `hasToken` flag, plus last-run fields, and a derived `triggers: {manual:true, schedule: !!cron && enabled, event: onEvent && enabled}`).
- `POST /platform/routines/:key/trigger` → `routineTriggerService.trigger(key,'manual')`; `@Audit`. Returns the trigger result.
- `PATCH /platform/routines/:key` → validate body (DTO below), validate cron if present (parse with `cron` package's `CronTime`/`CronJob` in a try/catch → 400 on invalid), `routineConfigService.update`; `@Audit`. Returns the updated config (no token).

DTO `UpdateRoutineConfigDto`: `enabled?` `@IsBoolean`, `cron?` `@IsString @MaxLength(120)` (nullable to clear), `onEvent?` `@IsBoolean`, `triggerUrl?` `@IsUrl`/`@IsString` (nullable), `triggerToken?` `@IsString @MaxLength(4000)` (write-only; never read back). Register the controller + providers in `PlatformModule` (import `RoutinesModule` to access its services, or co-locate — see wiring).

## Module wiring
- New `RoutinesModule` provides+exports `RoutineConfigService`, `RoutineTriggerService`, `RoutineScheduleRunner`, `RoutineEventListener`. Imports the outbox module (DomainEventBus) + ConfigModule (global). Imported by `AppModule`.
- `PlatformModule` imports `RoutinesModule` and registers `RoutineAdminController`.
- Respect `AI_DISABLED`? The trigger layer just calls claude.ai; it doesn't use the Anthropic key. So it is independent of `AI_DISABLED`. (It triggers a routine that itself runs on claude.ai.) No AI-gating needed.

## Frontend — platform admin page

`frontend/src/pages/platform/PlatformRoutinesPage.tsx` + route + nav entry,
mirroring `PlatformWorkspacesPage.tsx` and `platformApi.ts`:
- `useQuery(['platform','routines'])` → `platformApi.get('/routines')`.
- A card/row per routine: name, enabled toggle, cron input (with a hint + "leave blank = no schedule"), onEvent toggle, triggerUrl input, triggerToken input (password field, write-only — shows "configured" if `hasToken`), **Trigger now** button, last-run status + timestamp + error.
- `useMutation` for PATCH (save config) + POST (trigger now), `invalidateQueries(['platform','routines'])` on success; toast on error (esp. 400 invalid cron / 503 missing MARKETING_SECRET_KEY).
- Auth: platform store / redirect like the sibling page.

## Env
- `MARKETING_SECRET_KEY` becomes **required for this feature** (token sealing). Document in README + `.env.example`; the PATCH endpoint 503s with a clear message if unset when a token is provided. Not boot-gated (the rest of the app tolerates it absent).

## Testing
- `routine-trigger.service.spec.ts`: manual ignores enabled; schedule/event respect enabled; event cooldown skips within window; no-url → error recorded; fire success/failure → status stamped. (Mock fetch + config service.)
- `routine-config.service.spec.ts`: seed upserts 4 keys; update seals token; list never returns token (hasToken flag).
- `routine-schedule-runner.spec.ts`: reload registers/removes jobs per enabled+cron; invalid cron handled.
- `routine-admin.controller.spec.ts`: GET hides tokens; POST trigger delegates; PATCH validates cron (400) + missing-secret (503).
- `routine-event-listener.spec.ts`: review PRIVATE_FEEDBACK → trigger('review-draft','event'); lead.created → trigger('lead-scoring','event').

## Operator handoff
1. Set `MARKETING_SECRET_KEY` (base64 32-byte) in prod if not already.
2. In claude.ai, set each routine's trigger to **Call via API** (not Schedule); copy the generated URL + token.
3. In the platform panel → Routines: paste each routine's URL+token, set a cron (or leave blank), toggle enabled / onEvent, save. Use **Trigger now** to smoke-test.
