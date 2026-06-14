# Lead-scoring routine — design

**Date:** 2026-06-14
**Status:** approved-by-controller (autonomous goal) — decisions made here

## Goal

A nightly cloud routine that assigns an AI fit/value **score (0–100)** + a short
reason to unscored, still-active leads, so reps can prioritise. Runs on the
flat-fee routine surface. The routine reads each lead's data + the workspace's
product context and writes the score; the backend serves jobs and persists
scores. Routine **#4 of 4** (the last), reusing the shared `ROUTINE_TOKEN` +
`RoutineTokenGuard`.

## Decisions (controller-made, per the autonomous goal)
- **Target leads:** `scoredAt IS NULL` AND `status NOT IN ('WON','LOST')` — score
  every active, not-yet-scored lead. Oldest first.
- **Cadence:** nightly (this is cheap classification). Cron `0 6 * * *` UTC.
- **Per-workspace daily cap:** `ROUTINE_LEADSCORE_DAILY_CAP` (default 100,
  env-tunable) — bounds work per workspace per night.
- **Idempotency / no-clobber:** GET returns only `scoredAt IS NULL` leads; POST
  writes only when `scoredAt` is still null (guarded `updateMany` scoped by
  `{ id, workspaceId, scoredAt: null }`) and stamps `scoredAt` — so re-runs never
  re-score or clobber, and cross-tenant writes are impossible.
- **Output:** three new nullable columns on `Lead` — `aiScore Int?`,
  `aiScoreReason String?`, `scoredAt DateTime?` — plus `@@index([workspaceId, scoredAt])`.
- **No AI credits** (flat-fee routine); the daily cap + `scoredAt` guard bound volume.
- **Does not change rep-set `priority`/`status`** — the AI score is a separate,
  advisory field reps see alongside.

### Non-goals
- No frontend (surfacing `aiScore` in the leads UI is a follow-up; until then the
  score is readable via API/DB).
- No auto-routing/assignment based on the score.
- No change to the interactive in-process classification path.

## Shared foundation (already built)
Reuses `ROUTINE_TOKEN` + `RoutineTokenGuard` and the GET-jobs / POST-results shape.

## Data model (additive columns on `Lead`)
Add to the existing `Lead` model:
```prisma
  /// AI fit/value score (0-100) + reason from the lead-scoring routine. Advisory;
  /// separate from rep-set priority/status. scoredAt null = not yet scored.
  aiScore       Int?
  aiScoreReason String?   @db.Text
  scoredAt      DateTime?
```
And add an index: `@@index([workspaceId, scoredAt])`.
Migration is additive (nullable ADD COLUMNs + one CREATE INDEX) — no data
migration, no rewrite. Hand-authored (DB-less env); applied at deploy.

## Backend — `internal/lead-scoring` controller

`src/modules/internal/internal-lead-scoring.controller.ts`,
`@Controller('internal/lead-scoring')`, `@UseGuards(RoutineTokenGuard)`. Injects
`PrismaService` + `ConfigService`.

### `GET /api/internal/lead-scoring/jobs`
One job per ACTIVE workspace that has unscored active leads.
- Per workspace: `lead.findMany` where `{ workspaceId, scoredAt: null, status: { notIn: ['WON','LOST'] } }`, `orderBy: { createdAt: 'asc' }`, `take: cap`, selecting the scoring-relevant fields: `id, businessName, businessType, source, city, region, tableCount, branchCount, currentSystem, notes`.
- `cap` from `ROUTINE_LEADSCORE_DAILY_CAP` (default 100; reject non-numeric/≤0).
- Omit workspaces with zero unscored leads.

**Response:**
```jsonc
{
  "generatedAt": "<iso>",
  "jobs": [
    {
      "workspaceId": "...",
      "workspaceSlug": "...",
      "productName": "...",
      "productDescription": "...",
      "leads": [
        { "leadId": "...", "businessName": "...", "businessType": "CAFE", "source": "INSTAGRAM",
          "city": "...", "region": "...", "tableCount": 12, "branchCount": 1,
          "currentSystem": "...", "notes": "..." }
      ]
    }
  ]
}
```

### `POST /api/internal/lead-scoring/:workspaceId/scores`
`@HttpCode(200)`. Body (class-validated DTO):
```jsonc
{ "scores": [ { "leadId": "...", "score": 0-100, "reason": "..." } ] }
```
- `score` `@IsInt() @Min(0) @Max(100)`; `reason` `@IsString() @MaxLength(500)`; `leadId` `@IsUUID()`; `scores` `@ArrayMinSize(1) @ArrayMaxSize(100)`.
- Verify workspace exists + ACTIVE (404 otherwise).
- Per score: `lead.updateMany` WHERE `{ id, workspaceId, scoredAt: null }`, data `{ aiScore: score, aiScoreReason: reason, scoredAt: new Date() }`. Sum `res.count` into `scored`.
- Returns `{ scored, skipped }`. No credit reserve.

## Routine prompt — `ops/lead-scoring-routine-prompt.md`
Schedule `0 6 * * *` UTC. No MCP. Flow: GET jobs → per lead, assign a 0–100
fit/value score (how well it matches the workspace's product/ICP and how likely
to convert) + a one-line reason, grounded ONLY on the provided lead fields +
product context → POST `{ scores: [...] }`. One-line summary.

## Env documentation
Add `ROUTINE_LEADSCORE_DAILY_CAP=100` to `backend/.env.example` and a README row.
(`ROUTINE_TOKEN` already documented.)

## Testing
`internal-lead-scoring.controller.spec.ts`:
- GET selects only `scoredAt:null` + `status notIn [WON,LOST]`; clips to the cap (default 100 + env override); omits empty workspaces;
- POST 404s unknown/inactive workspace;
- POST guarded `updateMany` (WHERE `{id, workspaceId, scoredAt:null}`); counts scored/skipped; never cross-workspace.

## Operator handoff (manual)
1. `ROUTINE_TOKEN` reused; optionally set `ROUTINE_LEADSCORE_DAILY_CAP`.
2. Apply migration on deploy (`prisma migrate deploy`).
3. Create the routine in claude.ai from `ops/lead-scoring-routine-prompt.md`,
   schedule `0 6 * * *` UTC, enable.

## Series complete
This is routine #4 of 4. Frontend surfacing (review drafts, content drafts,
content-profile editor, insight viewer, lead aiScore column) remains as
follow-up frontend work across the four routines.
