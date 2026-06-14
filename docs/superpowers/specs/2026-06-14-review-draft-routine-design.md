# Review-draft routine — design

**Date:** 2026-06-14
**Status:** approved (brainstorming) — pending spec review

## Goal

Move review-reply drafting off the metered Anthropic API and onto a flat-fee
`claude.ai/code/routines` nightly routine — the same surface the existing
research routine uses. The routine reads reviews that need a reply, writes the
draft itself (no tools, no API call back into Claude), and POSTs the drafts
back to the marketing backend, where they land in the existing
`review.replyDraft` field the panel already renders.

This is **routine #1 of 4** (review-draft, content-pack, insight-digest,
lead-scoring). It establishes the **shared routine foundation** (a single
`ROUTINE_TOKEN` + `RoutineTokenGuard`) that the other three reuse. Each of the
other three gets its own spec/plan cycle.

### Non-goals
- Not touching the existing interactive `ReviewsService.draftReply()` button
  flow (stays on the metered API, still reserves 1 credit).
- Not touching the live research routine or its `RESEARCH_ROUTINE_TOKEN`.
- No new Prisma columns — reuse `review.replyDraft`.

## Decisions (from brainstorming)
- **Approach B**: each routine is its own thin `internal/*` controller mirroring
  `InternalResearchController`; only the token + guard are shared. No generic
  routine framework (YAGNI).
- **Quota model**: drafts consume **no AI credits**, but a **per-workspace daily
  cap** (`ROUTINE_REVIEW_DAILY_CAP`, default 50) bounds how many reviews the
  routine picks up per workspace per run — prevents a high-volume workspace from
  swamping the routine / flat-fee surface.
- **Cron**: `0 3 * * *` UTC (1h after research's `0 2 * * *`, so the two routines
  don't contend).

## Shared foundation (built once, reused by routines #2–#4)

### `ROUTINE_TOKEN` + `RoutineTokenGuard`
- New env var `ROUTINE_TOKEN` (random 48+ hex). Separate principal from
  `RESEARCH_ROUTINE_TOKEN` and `INTERNAL_SERVICE_TOKEN`.
- `src/modules/internal/routine-token.guard.ts` — a near-verbatim copy of
  `research-token.guard.ts`: `ConfigService.get('ROUTINE_TOKEN')`, header
  `x-routine-token`, `timingSafeEqual`, rejects when unset. Logger name
  `RoutineTokenGuard`.
- Registered in `InternalApiModule` providers.
- README env table + `.env.example` get a `ROUTINE_TOKEN` row.

## Backend — `internal/reviews` controller

`src/modules/internal/internal-reviews.controller.ts`, `@Controller('internal/reviews')`,
`@UseGuards(RoutineTokenGuard)`. Constructor: `PrismaService` only (draft text is
written by the routine, not by us — no `AnthropicService` here).

### `GET /api/internal/reviews/pending-drafts`
One job per ACTIVE workspace that has reviews needing a draft.

**Selection** (a review needs a draft when):
- `status = 'PRIVATE_FEEDBACK'` (private negative feedback the team replies to —
  the same class the interactive button targets)
- `text` is non-null / non-empty (something to reply to)
- `replyText` is null (human hasn't already replied)
- `replyDraft` is null (not already drafted — by routine or interactive button)

Ordered `createdAt asc` (oldest first), **clipped to `ROUTINE_REVIEW_DAILY_CAP`
per workspace**.

**Response shape:**
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
      "reviews": [
        { "reviewId": "...", "rating": 2, "text": "...", "authorName": "..." }
      ]
    }
  ]
}
```
Workspaces with zero pending reviews are omitted. If `jobs` is empty the routine
writes a one-line summary and stops.

### `POST /api/internal/reviews/:workspaceId/drafts`
`@HttpCode(200)`. Body: `{ drafts: [{ reviewId: string, replyDraft: string }] }`
(class-validated DTO, mirrors `MintResearchLeadsDto` style).

- Verifies workspace exists and is ACTIVE (404 otherwise, like research).
- For each draft: **update only if `replyDraft` is still null AND `replyText` is
  still null AND `workspaceId` matches** — a guarded `updateMany` so a draft that
  was filled (human/interactive) between GET and POST is never clobbered, and
  cross-workspace writes are impossible.
- Returns `{ written: number, skipped: number }`.
- No credit reserve.

## Routine prompt — `ops/review-draft-routine-prompt.md`

Versioned canonical prompt, same header convention as
`ops/research-routine-prompt.md` (placeholders `{{MARKETING_API_BASE}}`,
`{{ROUTINE_TOKEN}}`; never commit real values). Flow:

1. `GET {{MARKETING_API_BASE}}/api/internal/reviews/pending-drafts`
   with `x-routine-token: {{ROUTINE_TOKEN}}`.
2. For each review: write a short, warm, professional reply in the review's
   language. If negative: acknowledge + offer to make it right, never argue.
   (Same intent as the interactive system prompt, written by Claude inline — no
   tool calls, no API call back into Claude.)
3. `POST .../api/internal/reviews/<workspaceId>/drafts` with the batch.
4. One-line run summary.

Schedule line documented as `0 3 * * *` UTC. No MCP connectors needed.

## Testing
`internal-reviews.controller.spec.ts`, mirroring the research controller's
coverage:
- guard rejects missing/wrong `x-routine-token`;
- GET selects only PRIVATE_FEEDBACK + text + no replyText + no replyDraft;
- GET clips per-workspace to the cap;
- GET omits workspaces with nothing pending and inactive workspaces;
- POST writes only when replyDraft/replyText still null (no clobber);
- POST 404s an unknown/inactive workspace;
- POST never writes across workspaces.

## Manual step (operator, after deploy)
1. Generate `ROUTINE_TOKEN` (48+ hex), set in prod env, deploy.
2. In `claude.ai/code/routines`, create a routine, paste
   `ops/review-draft-routine-prompt.md` with `{{MARKETING_API_BASE}}` and
   `{{ROUTINE_TOKEN}}` filled in, schedule `0 3 * * *` UTC, enable.

## Routines #2–#4 (future specs)
Each reuses `ROUTINE_TOKEN` + `RoutineTokenGuard` and the GET-jobs / POST-results
shape, with its own `internal/<feature>` controller and `ops/*-routine-prompt.md`.
- **content-pack** — `GET internal/content/jobs` (workspaces opted into scheduled
  content + briefs) / `POST .../pieces`; net-new feature.
- **insight-digest** — `GET internal/insights/jobs` (workspace KPIs) /
  `POST .../digest`; net-new.
- **lead-scoring** — batch `ai_classify`; low $ benefit (already Haiku), build last.
