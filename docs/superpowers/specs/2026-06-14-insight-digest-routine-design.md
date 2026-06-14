# Insight-digest routine — design

**Date:** 2026-06-14
**Status:** approved-by-controller (autonomous goal) — decisions made here

## Goal

A weekly cloud routine that produces a short **insights digest** per active
workspace — a few computed KPIs plus an AI-written narrative + recommendations —
on the flat-fee routine surface. The **backend computes the KPIs** (it has DB
access); the routine only writes the prose from those numbers and POSTs it back.
Routine **#3 of 4**, reusing the shared `ROUTINE_TOKEN` + `RoutineTokenGuard`.

## Decisions (controller-made, per the autonomous goal)
- **No opt-in profile.** A digest is generated for every ACTIVE workspace that
  had activity in the period — simpler, net-new value, no profile editor needed.
- **Activity gate:** include a workspace only if, in the period, `leadsNew > 0`
  OR `reviewsNew > 0` OR `campaignsSent > 0` — no digests for dead workspaces.
- **Cadence:** weekly. Cron `0 5 * * 1` UTC (Mondays, 1h after content-pack).
- **Period:** trailing 7 days (`periodStart = now − 7d`, `periodEnd = now`).
- **Idempotency / weekly-due:** the GET excludes a workspace that already has an
  `InsightDigest` created in the last 6 days. POST inserts the digest → the next
  weekly run skips it. (Same weekly-due idea as content-pack, but keyed off the
  digest table instead of a profile.)
- **KPIs (computed by the backend):** a small, bounded set:
  `leadsNew` (Lead created in period), `leadsTotal` (pipeline size),
  `reviewsNew` (Review created in period), `avgRating` (avg rating of period
  reviews, null if none), `campaignsSent` (Campaign status=SENT, completedAt in
  period).
- **Output:** a new `InsightDigest` row (metrics snapshot + AI body). Draft/
  informational — nothing is sent.
- **No AI credits** (flat-fee routine); the activity gate + weekly-due bound volume.

### Non-goals
- No frontend (digest viewer is a follow-up; until then digests are read via
  API/DB).
- No opt-in/config UI, no per-workspace KPI customization.
- No sending/notifying — the digest is stored, not delivered.

## Shared foundation (already built)
Reuses `ROUTINE_TOKEN` + `RoutineTokenGuard` and the `internal/<feature>`
GET-jobs / POST-results shape. Nothing new.

## Data model (1 new Prisma model)
```prisma
/// A weekly AI-written insights digest for a workspace: a KPI snapshot plus a
/// narrative + recommendations. Produced by the insight-digest routine.
model InsightDigest {
  id          String   @id @default(uuid())
  workspaceId String
  periodStart DateTime
  periodEnd   DateTime
  /// KPI snapshot, e.g. { leadsNew, leadsTotal, reviewsNew, avgRating, campaignsSent }.
  metrics     Json
  body        String   @db.Text

  createdAt DateTime @default(now())

  @@index([workspaceId, createdAt])
  @@map("insight_digests")
}
```
Added via a new timestamped migration (hand-authored; DB-less env).

## Backend — `internal/insights` controller

`src/modules/internal/internal-insights.controller.ts`,
`@Controller('internal/insights')`, `@UseGuards(RoutineTokenGuard)`. Injects
`PrismaService` only.

### `GET /api/internal/insights/jobs`
For each ACTIVE workspace:
1. Skip if an `InsightDigest` exists with `createdAt >= now − 6d` (weekly-due).
2. Compute KPIs over `periodStart = now − 7d`:
   - `leadsNew` = `lead.count({ workspaceId, createdAt: { gte: periodStart } })`
   - `leadsTotal` = `lead.count({ workspaceId })`
   - `reviewsNew` = `review.count({ workspaceId, createdAt: { gte: periodStart } })`
   - `avgRating` = `review.aggregate(_avg.rating, { workspaceId, createdAt: { gte: periodStart }, rating: { not: null } })` → number or null
   - `campaignsSent` = `campaign.count({ workspaceId, status: 'SENT', completedAt: { gte: periodStart } })`
3. Include only if `leadsNew > 0 || reviewsNew > 0 || campaignsSent > 0`.

**Response:**
```jsonc
{
  "generatedAt": "<iso>",
  "periodStart": "<iso>",
  "periodEnd": "<iso>",
  "jobs": [
    {
      "workspaceId": "...",
      "workspaceSlug": "...",
      "productName": "...",
      "defaultLanguage": "tr",
      "metrics": { "leadsNew": 12, "leadsTotal": 240, "reviewsNew": 3, "avgRating": 4.3, "campaignsSent": 2 }
    }
  ]
}
```
Workspaces that are not-due or have no activity are omitted. Empty `jobs` →
routine writes a one-line summary and stops.

### `POST /api/internal/insights/:workspaceId/digest`
`@HttpCode(200)`. Body (class-validated DTO):
```jsonc
{ "periodStart": "<iso>", "periodEnd": "<iso>", "metrics": { ... }, "body": "<narrative>" }
```
- `periodStart`/`periodEnd` `@IsDateString()`; `metrics` `@IsObject()`; `body`
  `@IsString() @IsNotEmpty() @MaxLength(8000)`.
- Verify workspace exists + ACTIVE (404 otherwise).
- Insert one `InsightDigest` row (`workspaceId` from the path, `metrics` stored
  as-is, `periodStart/End` parsed to Date). Returns `{ id }`. No credit reserve.

## Routine prompt — `ops/insight-digest-routine-prompt.md`
Schedule `0 5 * * 1` UTC. No MCP. Flow: GET jobs → per job, write a concise
digest in the workspace's `defaultLanguage` grounded ONLY on the provided
`metrics` (a 2–4 sentence summary + 2–3 concrete recommendations; never invent
numbers not in `metrics`) → POST `{ periodStart, periodEnd, metrics, body }`
(echo the period + metrics from the job). One-line run summary.

## Testing
`internal-insights.controller.spec.ts`:
- GET computes metrics and includes a workspace with activity;
- GET omits a workspace with no activity (all-zero gate);
- GET omits a workspace already digested in the last 6 days (weekly-due skip);
- POST 404s unknown/inactive workspace;
- POST inserts an `InsightDigest` with the path `workspaceId` and returns `{ id }`.

## Operator handoff (manual, after deploy)
1. `ROUTINE_TOKEN` already exists — reused.
2. Apply migration on deploy (`prisma migrate deploy`).
3. Create the routine in claude.ai from `ops/insight-digest-routine-prompt.md`,
   schedule `0 5 * * 1` UTC, enable. (No seeding needed — no opt-in profile.)

## Routine #4 (future spec)
lead-scoring — its own spec/plan, reusing the foundation.
