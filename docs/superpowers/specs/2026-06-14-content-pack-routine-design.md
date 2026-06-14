# Content-pack routine — design

**Date:** 2026-06-14
**Status:** approved (brainstorming) — pending spec review

## Goal

A weekly cloud routine (`claude.ai/code/routines`) that pre-generates a "content
pack" — social posts plus email/SMS copy drafts — for each opted-in workspace,
on the flat-fee routine surface instead of the metered API. The routine writes
the copy itself and POSTs it back as **drafts only**; nothing is auto-sent. This
is **routine #2 of 4**, reusing the shared `ROUTINE_TOKEN` + `RoutineTokenGuard`
foundation built for routine #1 (review-draft).

## Decisions (from brainstorming)
- **Channels:** both social and email/SMS.
- **Landing:** one uniform `ContentDraft` table, all pieces land as `DRAFT`. The
  routine NEVER creates campaigns or sends anything. For email/SMS the human
  later promotes a draft into a campaign through existing UI (a separate action,
  not part of this routine).
- **Cadence:** weekly pack. Cron `0 4 * * 1` (Monday 04:00 UTC). A per-profile
  "weekly-due" guard (`lastRunAt` null or > 6 days) makes the run idempotent and
  robust to manual re-runs / missed weeks.
- **Volume:** per-channel counts live on the profile (`counts` = `{social, email,
  sms}`), server-clamped to sane maxes (social ≤ 10, email ≤ 5, sms ≤ 5).
- **Scope = A (backend + routine only).** Frontend (profile editor + draft inbox)
  is an explicit follow-up — see Scope boundary. Until it ships, profiles are
  seeded by an operator (SQL/admin) and drafts are read via API/DB.

### Non-goals
- No campaign creation, no sending, no scheduling of sends.
- No frontend in this spec (separate follow-up).
- No AI credit consumption (flat-fee routine); a weekly-due guard + per-profile
  counts bound the volume instead of credits.

## Shared foundation (already built in routine #1)
Reuses `ROUTINE_TOKEN` + `RoutineTokenGuard` (`x-routine-token`) and the
`internal/<feature>` GET-jobs / POST-results shape. Nothing new here.

## Data model (2 new Prisma models)

Follows the house convention: bare `workspaceId String` (no relation field),
`@@index([workspaceId, status])`, `@@map` snake_case table name. Added via a new
timestamped migration.

### `ContentProfile` (opt-in, mirrors `ResearchProfile`)
```
model ContentProfile {
  id          String  @id @default(uuid())
  workspaceId String
  name        String
  status      String  @default("ACTIVE") // ACTIVE | PAUSED

  /// Customer-authored: themes/topics to write about.
  themes      String  @db.Text
  /// Optional voice/tone guidance.
  voice       String? @db.Text
  /// Per-channel piece counts, e.g. { "social": 5, "email": 2, "sms": 1 }.
  counts      Json
  /// Output language (ISO 639-1).
  language    String  @default("en")

  lastRunAt   DateTime?
  /// { social, email, sms, at } from the latest routine run.
  lastRunStats Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status])
  @@map("content_profiles")
}
```

### `ContentDraft` (output)
```
model ContentDraft {
  id               String  @id @default(uuid())
  workspaceId      String
  contentProfileId String?
  channel          String  // social | email | sms
  subject          String? // email only
  body             String  @db.Text
  status           String  @default("DRAFT") // DRAFT | USED | DISCARDED

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status])
  @@map("content_drafts")
}
```

## Backend — `internal/content` controller

`src/modules/internal/internal-content.controller.ts`,
`@Controller('internal/content')`, `@UseGuards(RoutineTokenGuard)`. Injects
`PrismaService` only (the routine writes the copy; we serve jobs + persist drafts).

### `GET /api/internal/content/jobs`
One job per ACTIVE workspace that has at least one ACTIVE, weekly-due
`ContentProfile`.

- **Weekly-due:** `lastRunAt` is null OR `lastRunAt < now - 6 days`. Computed in
  code (fetch profiles, filter by the cutoff) — keeps the nightly-safe idempotency.
- **counts clamp:** clamp each channel from `profile.counts` to `{ social: ≤10,
  email: ≤5, sms: ≤5 }` (default 0 for a missing/invalid channel) before emitting,
  so a bad profile can't request 1000 pieces.

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
      "defaultLanguage": "tr",
      "profile": {
        "id": "...",
        "name": "...",
        "themes": "...",
        "voice": "...",
        "language": "tr",
        "counts": { "social": 5, "email": 2, "sms": 1 }   // already clamped
      }
    }
  ]
}
```
Workspaces with no due profile are omitted. Empty `jobs` → routine writes a
one-line summary and stops.

### `POST /api/internal/content/jobs/:workspaceId/drafts`
`@HttpCode(200)`. Body (class-validated DTO):
```jsonc
{ "profileId": "...", "drafts": [ { "channel": "social|email|sms", "subject": "?", "body": "..." } ] }
```
- `@ArrayMinSize(1)`, `@ArrayMaxSize(50)` on `drafts`; `channel` `@IsIn(['social','email','sms'])`; `subject` optional `@MaxLength(200)`; `body` `@IsNotEmpty() @MaxLength(4000)`; `profileId` `@IsUUID()`.
- Verifies workspace exists + ACTIVE (404 otherwise).
- `createMany` the drafts (`workspaceId`, `contentProfileId: profileId`, channel/subject/body, status defaults DRAFT).
- Best-effort stamp the profile's `lastRunAt = now` + `lastRunStats = { counts by channel, at }` (scoped `updateMany` by `{ id: profileId, workspaceId }`; never fail the submission over it). This stamp is what flips the profile out of "weekly-due", giving idempotency.
- Returns `{ created: number }`. No credit reserve.

## Routine prompt — `ops/content-pack-routine-prompt.md`
Versioned canonical prompt, same header convention as the others. Schedule
`0 4 * * 1` UTC. No MCP connectors. Flow:
1. `GET {{MARKETING_API_BASE}}/api/internal/content/jobs` with `x-routine-token`.
2. Per job/profile: produce exactly `counts.social` social posts, `counts.email`
   emails, `counts.sms` SMS — grounded on `productName`/`productDescription` +
   `themes` + `voice`, in the profile's `language`. Email uses the existing
   `SUBJECT:` / `BODY:` convention. Punchy/hook for social; concise for SMS.
   No tools — Claude writes the copy itself.
3. `POST .../jobs/<workspaceId>/drafts` with `{ profileId, drafts: [...] }`.
4. One-line run summary.

## Testing
`internal-content.controller.spec.ts`, mirroring routine #1's controller spec:
- guard rejects (covered by the shared guard spec — no new guard);
- GET emits only ACTIVE + weekly-due profiles; omits not-due (recent `lastRunAt`) and paused;
- GET clamps `counts` to the per-channel maxes (and zeros invalid channels);
- POST 404s unknown/inactive workspace;
- POST `createMany`s the right rows and stamps `lastRunAt`/`lastRunStats`;
- POST never writes across workspaces (profile stamp scoped by `{id, workspaceId}`).

## Scope boundary — frontend follow-up (NOT in this spec)
Routine #1 reused the panel's existing `replyDraft` display. Content-pack has no
existing UI. This spec delivers backend + routine only. A **separate follow-up**
must add: (1) a ContentProfile editor (mirror the research-profile settings UI),
(2) a ContentDraft inbox (list / mark USED / DISCARDED, and for email/SMS a "use
in a campaign" action). Until then: operators seed `content_profiles` rows
directly, and drafts are read via API/DB. The routine produces value the moment
the backend ships; it's just not visible in the panel yet.

## Operator handoff (after deploy)
1. `ROUTINE_TOKEN` already exists from routine #1 — reused, nothing new.
2. Seed at least one `content_profiles` row (until the editor ships).
3. In `claude.ai/code/routines`, create a routine from
   `ops/content-pack-routine-prompt.md` (fill `{{MARKETING_API_BASE}}` /
   `{{ROUTINE_TOKEN}}`), schedule `0 4 * * 1` UTC, enable.

## Routines #3–#4 (future specs)
insight-digest → lead-scoring, each its own spec/plan reusing the foundation.
