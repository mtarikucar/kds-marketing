# Review-draft Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly-routine backend surface so review-reply drafting can run on the flat-fee `claude.ai/code/routines` instead of the metered Anthropic API.

**Architecture:** A shared `RoutineTokenGuard` (`x-routine-token` / `ROUTINE_TOKEN`) plus a thin `internal/reviews` controller with two endpoints — `GET pending-drafts` (lists reviews needing a reply, per-workspace daily-capped) and `POST :workspaceId/drafts` (writes drafts into the existing `review.replyDraft`, never clobbering). The cloud routine itself writes the draft text; the backend only serves jobs and stores results. Mirrors the existing `InternalResearchController` pattern.

**Tech Stack:** NestJS 11, Prisma, class-validator, Jest. Spec: `docs/superpowers/specs/2026-06-14-review-draft-routine-design.md`.

All paths are relative to the repo root. Backend tests run from `backend/`. Work happens on branch `feat/review-draft-routine` (already checked out).

---

### Task 1: `RoutineTokenGuard` (shared foundation)

**Files:**
- Create: `backend/src/modules/internal/routine-token.guard.ts`
- Test: `backend/src/modules/internal/routine-token.guard.spec.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/modules/internal/routine-token.guard.spec.ts`:
```ts
import { UnauthorizedException } from '@nestjs/common';
import { RoutineTokenGuard } from './routine-token.guard';

const ctxWith = (header?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-routine-token': header },
      }),
    }),
  }) as any;

const guard = (token?: string) =>
  new RoutineTokenGuard({ get: () => token } as any);

describe('RoutineTokenGuard', () => {
  it('rejects when ROUTINE_TOKEN is not configured', () => {
    expect(() => guard(undefined).canActivate(ctxWith('anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing header', () => {
    expect(() => guard('secret').canActivate(ctxWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong-length / wrong token', () => {
    expect(() => guard('secret').canActivate(ctxWith('nope'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the correct token', () => {
    expect(guard('secret').canActivate(ctxWith('secret'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/internal/routine-token.guard.spec.ts`
Expected: FAIL — `Cannot find module './routine-token.guard'`.

- [ ] **Step 3: Write minimal implementation**

`backend/src/modules/internal/routine-token.guard.ts`:
```ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Static token guard for the nightly-routine endpoints (/api/internal/reviews/*
 * and the later content/insights/lead-scoring routines). A SEPARATE secret from
 * RESEARCH_ROUTINE_TOKEN and INTERNAL_SERVICE_TOKEN: each cloud routine is its
 * own principal, its credential lives in the routine config, and a leak of one
 * must not grant another surface. Fails closed when ROUTINE_TOKEN is unset.
 */
@Injectable()
export class RoutineTokenGuard implements CanActivate {
  private readonly logger = new Logger(RoutineTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('ROUTINE_TOKEN');
    if (!expected) {
      this.logger.error(
        'ROUTINE_TOKEN not configured — rejecting routine call',
      );
      throw new UnauthorizedException('Routine API disabled');
    }

    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-routine-token'];
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing routine token');
    }

    const headerBuf = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (headerBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid routine token');
    }
    if (!timingSafeEqual(headerBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid routine token');
    }

    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/internal/routine-token.guard.spec.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/internal/routine-token.guard.ts backend/src/modules/internal/routine-token.guard.spec.ts
git commit -m "feat(routine): RoutineTokenGuard — shared x-routine-token guard"
```

---

### Task 2: Submit-drafts DTO

**Files:**
- Create: `backend/src/modules/internal/routine-reviews.dto.ts`

No unit test — it's a validation-decorated DTO exercised by the controller tests in Task 4. (Validation itself is integration-level; not worth an isolated unit test.)

- [ ] **Step 1: Create the DTO**

`backend/src/modules/internal/routine-reviews.dto.ts`:
```ts
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReviewDraftDto {
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @IsString()
  @IsNotEmpty()
  replyDraft: string;
}

/** Body of POST /api/internal/reviews/:workspaceId/drafts. */
export class SubmitReviewDraftsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReviewDraftDto)
  drafts: ReviewDraftDto[];
}
```

- [ ] **Step 2: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/internal/routine-reviews.dto.ts
git commit -m "feat(routine): SubmitReviewDraftsDto for the review-draft routine"
```

---

### Task 3: Controller — `GET pending-drafts`

**Files:**
- Create: `backend/src/modules/internal/internal-reviews.controller.ts`
- Test: `backend/src/modules/internal/internal-reviews.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/modules/internal/internal-reviews.controller.spec.ts`:
```ts
import { InternalReviewsController } from './internal-reviews.controller';

describe('InternalReviewsController', () => {
  let prisma: any;
  let config: any;
  let ctrl: InternalReviewsController;

  const WS = {
    id: 'ws1',
    slug: 'a',
    productName: 'P',
    productDescription: 'D',
    defaultLanguage: 'tr',
  };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      review: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue(undefined) }; // -> default cap
    ctrl = new InternalReviewsController(prisma as any, config as any);
  });

  describe('GET pending-drafts', () => {
    it('returns one job per active workspace with pending PRIVATE_FEEDBACK reviews', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 2, text: 'bad', authorName: 'X' },
      ]);

      const res = await ctrl.pendingDrafts();

      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).workspaceId).toBe('ws1');
      expect((res.jobs[0] as any).reviews[0]).toEqual({
        reviewId: 'rev1',
        rating: 2,
        text: 'bad',
        authorName: 'X',
      });
      expect(prisma.review.findMany.mock.calls[0][0].where).toMatchObject({
        workspaceId: 'ws1',
        status: 'PRIVATE_FEEDBACK',
        replyText: null,
        replyDraft: null,
      });
    });

    it('omits workspaces with nothing pending', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([]);
      const res = await ctrl.pendingDrafts();
      expect(res.jobs).toHaveLength(0);
    });

    it('clips to the default per-workspace daily cap (50)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 1, text: 't', authorName: null },
      ]);
      await ctrl.pendingDrafts();
      expect(prisma.review.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('honors the ROUTINE_REVIEW_DAILY_CAP override', async () => {
      config.get.mockReturnValue('10');
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.review.findMany.mockResolvedValue([
        { id: 'rev1', rating: 1, text: 't', authorName: null },
      ]);
      await ctrl.pendingDrafts();
      expect(prisma.review.findMany.mock.calls[0][0].take).toBe(10);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/internal/internal-reviews.controller.spec.ts`
Expected: FAIL — `Cannot find module './internal-reviews.controller'`.

- [ ] **Step 3: Write minimal implementation (GET only)**

`backend/src/modules/internal/internal-reviews.controller.ts`:
```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';

const DEFAULT_DAILY_CAP = 50;

/**
 * The review-draft routine's surface:
 *
 *   GET  /api/internal/reviews/pending-drafts
 *     One job per ACTIVE workspace that has private-feedback reviews still
 *     awaiting a reply — each with the workspace context the routine needs to
 *     write a good draft. Clipped to ROUTINE_REVIEW_DAILY_CAP per workspace.
 *
 *   POST /api/internal/reviews/:workspaceId/drafts   (added in Task 4)
 *
 * Guarded by ROUTINE_TOKEN (x-routine-token). The routine WRITES the draft text
 * itself (no Anthropic call here); we only serve jobs and persist results.
 */
@Controller('internal/reviews')
@UseGuards(RoutineTokenGuard)
export class InternalReviewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private dailyCap(): number {
    const raw = parseInt(
      this.config.get<string>('ROUTINE_REVIEW_DAILY_CAP') ?? '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
  }

  @Get('pending-drafts')
  async pendingDrafts() {
    const cap = this.dailyCap();
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        slug: true,
        productName: true,
        productDescription: true,
        defaultLanguage: true,
      },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const reviews = await this.prisma.review.findMany({
        where: {
          workspaceId: ws.id,
          status: 'PRIVATE_FEEDBACK',
          replyText: null,
          replyDraft: null,
          text: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        take: cap,
        select: { id: true, rating: true, text: true, authorName: true },
      });
      if (reviews.length === 0) continue;
      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        productDescription: ws.productDescription,
        defaultLanguage: ws.defaultLanguage,
        reviews: reviews.map((r) => ({
          reviewId: r.id,
          rating: r.rating,
          text: r.text,
          authorName: r.authorName,
        })),
      });
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/internal/internal-reviews.controller.spec.ts`
Expected: PASS (4 passing — the GET describe block).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/internal/internal-reviews.controller.ts backend/src/modules/internal/internal-reviews.controller.spec.ts
git commit -m "feat(routine): internal reviews controller — GET pending-drafts"
```

---

### Task 4: Controller — `POST :workspaceId/drafts`

**Files:**
- Modify: `backend/src/modules/internal/internal-reviews.controller.ts`
- Test: `backend/src/modules/internal/internal-reviews.controller.spec.ts` (add a describe block)

- [ ] **Step 1: Add the failing tests**

Append inside the top-level `describe('InternalReviewsController', ...)` in `internal-reviews.controller.spec.ts` (after the `GET pending-drafts` block), and add `NotFoundException` to the imports at the top of the file:

Add to imports (top of file):
```ts
import { NotFoundException } from '@nestjs/common';
```

Add this describe block:
```ts
  describe('POST :workspaceId/drafts', () => {
    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { drafts: [{ reviewId: 'r', replyDraft: 'hi' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes only still-empty drafts and counts written/skipped', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      prisma.review.updateMany
        .mockResolvedValueOnce({ count: 1 }) // rev1 written
        .mockResolvedValueOnce({ count: 0 }); // rev2 already filled -> skipped

      const res = await ctrl.submit('ws1', {
        drafts: [
          { reviewId: 'rev1', replyDraft: 'a' },
          { reviewId: 'rev2', replyDraft: 'b' },
        ],
      });

      expect(res).toEqual({ written: 1, skipped: 1 });
      // guarded WHERE prevents clobber + cross-workspace writes
      expect(prisma.review.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'rev1',
        workspaceId: 'ws1',
        replyDraft: null,
        replyText: null,
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd backend && npx jest src/modules/internal/internal-reviews.controller.spec.ts`
Expected: FAIL — `ctrl.submit is not a function`.

- [ ] **Step 3: Add the `submit` handler**

Update the imports line in `internal-reviews.controller.ts` to:
```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
```
Add the DTO import below the `RoutineTokenGuard` import:
```ts
import { SubmitReviewDraftsDto } from './routine-reviews.dto';
```
Add this method to the `InternalReviewsController` class (after `pendingDrafts`):
```ts
  @Post(':workspaceId/drafts')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitReviewDraftsDto,
  ): Promise<{ written: number; skipped: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    let written = 0;
    for (const d of dto.drafts) {
      // Guarded write: only fill a STILL-empty draft, scoped to this workspace.
      // Putting replyDraft/replyText/workspaceId in the WHERE means a draft a
      // human (or the interactive button) wrote since the GET is never
      // clobbered, and a cross-workspace write is impossible.
      const res = await this.prisma.review.updateMany({
        where: {
          id: d.reviewId,
          workspaceId,
          replyDraft: null,
          replyText: null,
        },
        data: { replyDraft: d.replyDraft },
      });
      written += res.count;
    }

    return { written, skipped: dto.drafts.length - written };
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd backend && npx jest src/modules/internal/internal-reviews.controller.spec.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/internal/internal-reviews.controller.ts backend/src/modules/internal/internal-reviews.controller.spec.ts
git commit -m "feat(routine): internal reviews controller — POST drafts (no-clobber)"
```

---

### Task 5: Register guard + controller in the internal module

**Files:**
- Modify: `backend/src/modules/internal/internal.module.ts`

- [ ] **Step 1: Add imports**

In `internal.module.ts`, after the existing `ResearchTokenGuard` import line add:
```ts
import { RoutineTokenGuard } from './routine-token.guard';
import { InternalReviewsController } from './internal-reviews.controller';
```

- [ ] **Step 2: Register in the @Module decorator**

In the `@Module({...})` object: add `InternalReviewsController` to the `controllers` array, and `RoutineTokenGuard` to the `providers` array. After the edit the arrays read:
```ts
  controllers: [
    InternalReferralController,
    InternalEventsController,
    InternalResearchController,
    InternalReviewsController,
  ],
  providers: [InternalTokenGuard, ResearchTokenGuard, RoutineTokenGuard],
```

- [ ] **Step 3: Build to verify wiring**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full internal-module test set**

Run: `cd backend && npx jest src/modules/internal`
Expected: PASS (guard spec + controller spec all green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/internal/internal.module.ts
git commit -m "feat(routine): register reviews controller + RoutineTokenGuard"
```

---

### Task 6: Env documentation (`.env.example` + README)

**Files:**
- Modify: `backend/.env.example`
- Modify: `README.md`

> `ROUTINE_TOKEN` is intentionally NOT added to `main.ts`'s boot-required list: the routine surface is additive and `RoutineTokenGuard` fails closed (401) when the token is unset, so a deploy without it must NOT crash. It only needs to be set before the routine is enabled in claude.ai.

- [ ] **Step 1: Add the env rows to `.env.example`**

Append to `backend/.env.example` (near the `RESEARCH_ROUTINE_TOKEN` entry if present, else at the end):
```bash
# Nightly cloud-routine surface (/api/internal/reviews/* and later content/
# insights/lead-scoring routines). Separate principal from RESEARCH_ROUTINE_TOKEN.
# RoutineTokenGuard fails closed when unset (routine endpoints 401).
ROUTINE_TOKEN=
# Per-workspace nightly cap on reviews the review-draft routine picks up.
ROUTINE_REVIEW_DAILY_CAP=50
```

- [ ] **Step 2: Add the README env-table row**

In `README.md`, in the environment-variable table (the one containing the `RESEARCH_ROUTINE_TOKEN` row near line 130), add directly below that row:
```markdown
| `ROUTINE_TOKEN` | no | Token for the nightly cloud-routine surface (`/api/internal/reviews/*`, `x-routine-token`) — separate principal from `RESEARCH_ROUTINE_TOKEN`. Guard fails closed when unset (routine endpoints 401). |
| `ROUTINE_REVIEW_DAILY_CAP` | no | Per-workspace nightly cap on reviews the review-draft routine drafts (default 50). |
```

- [ ] **Step 3: Commit**

```bash
git add backend/.env.example README.md
git commit -m "docs(routine): document ROUTINE_TOKEN + ROUTINE_REVIEW_DAILY_CAP"
```

---

### Task 7: Routine prompt (`ops/review-draft-routine-prompt.md`)

**Files:**
- Create: `ops/review-draft-routine-prompt.md`

- [ ] **Step 1: Write the canonical prompt**

`ops/review-draft-routine-prompt.md`:
````markdown
# Review-draft routine — canonical prompt

This is the versioned source of the review-draft cloud routine's prompt. The
live routine (claude.ai/code/routines) must match this file; edit HERE first,
then update the routine. Schedule: `0 3 * * *` UTC (1h after the research
routine, so the two don't contend). No MCP connectors needed. Secrets: the
service base URL and `ROUTINE_TOKEN` are embedded in the prompt at update time —
NEVER commit real values to this file.

Placeholders: `{{MARKETING_API_BASE}}` (e.g. https://marketing.example.com),
`{{ROUTINE_TOKEN}}`.

---

```
You draft replies to private customer feedback for a multi-tenant marketing
platform. Each workspace is a different business. Your nightly job: fetch the
reviews awaiting a reply, write one reply draft per review, and submit them.
You do NOT publish anything — a human reviews and sends each draft from the
panel. Write the drafts yourself; do not call any external tool or API.

STEP 1 — FETCH JOBS

curl -sS {{MARKETING_API_BASE}}/api/internal/reviews/pending-drafts \
  -H "x-routine-token: {{ROUTINE_TOKEN}}"

The response is { generatedAt, jobs }. Each job: { workspaceId, workspaceSlug,
productName, productDescription, defaultLanguage, reviews: [{ reviewId, rating,
text, authorName }] }. If jobs is empty, write a one-line summary and stop.

STEP 2 — DRAFT (per review)

Write a short, warm, professional reply IN THE REVIEW'S OWN LANGUAGE (fall back
to the job's defaultLanguage). Ground it in productName/productDescription so it
sounds like this business. Rules:
- Negative review (low rating / complaint): acknowledge the specific issue,
  apologize briefly, offer to make it right. NEVER argue or get defensive.
- Positive review: thank them warmly and specifically.
- 2-4 sentences. No placeholders like [name] unless authorName is present.
- Plain text only.

STEP 3 — SUBMIT (per workspace, batch its reviews)

curl -sS -X POST \
  {{MARKETING_API_BASE}}/api/internal/reviews/<workspaceId>/drafts \
  -H "x-routine-token: {{ROUTINE_TOKEN}}" \
  -H "content-type: application/json" \
  -d '{"drafts":[{"reviewId":"<id>","replyDraft":"<your reply>"}]}'

The server only stores a draft if the review is still un-drafted and unreplied
(it never overwrites a human's work), and returns { written, skipped }.

STEP 4 — SUMMARY

Write a one-line summary: workspaces processed, drafts written, skipped.
```
````

- [ ] **Step 2: Commit**

```bash
git add ops/review-draft-routine-prompt.md
git commit -m "docs(routine): canonical review-draft routine prompt"
```

---

## Final verification

- [ ] Run the whole internal suite: `cd backend && npx jest src/modules/internal` → all green.
- [ ] Type-check the backend: `cd backend && npx tsc --noEmit` → no errors.
- [ ] Lint touched files: `cd backend && npx eslint src/modules/internal` → clean.

## After implementation — operator handoff (manual, not code)

1. Generate a token: `openssl rand -hex 32` → set as `ROUTINE_TOKEN` in the prod env. Optionally set `ROUTINE_REVIEW_DAILY_CAP`. Deploy the backend.
2. In `claude.ai/code/routines`, create a new routine, paste `ops/review-draft-routine-prompt.md` with `{{MARKETING_API_BASE}}` and `{{ROUTINE_TOKEN}}` filled in, set schedule `0 3 * * *` UTC, enable it.
3. Smoke-test: trigger one manual run; confirm drafts appear in the panel's review list and `written`/`skipped` look right.

## Routines #2–#4

Each reuses `ROUTINE_TOKEN` + `RoutineTokenGuard` and the GET-jobs / POST-results shape with its own `internal/<feature>` controller and `ops/*-routine-prompt.md`. Build order: content-pack → insight-digest → lead-scoring (lead-scoring last — lowest $ benefit, already on Haiku). Each gets its own spec + plan.
