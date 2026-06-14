# Content-pack Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** A weekly cloud routine that pre-generates social + email/SMS copy drafts per opted-in workspace, draft-only, on the flat-fee routine surface.

**Architecture:** Two new Prisma models (`ContentProfile` opt-in + `ContentDraft` output) + an `internal/content` controller (`GET jobs` weekly-due/clamped, `POST drafts` createMany + stamp) guarded by the existing `RoutineTokenGuard`. Mirrors routine #1 (review-draft) and the research controller. Spec: `docs/superpowers/specs/2026-06-14-content-pack-routine-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest. DB is NOT reachable in this env, so the migration SQL is hand-authored and the client is regenerated offline with `prisma generate` (the migration is applied at deploy via `prisma migrate deploy`).

Paths relative to repo root. Backend cmds run from `backend/`. Branch `feat/content-pack-routine` is checked out. Reuse (do NOT recreate) `routine-token.guard.ts` — it already exists and is registered.

---

### Task 1: Prisma models + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260614130000_content_pack_routine/migration.sql`

- [ ] **Step 1: Add the two models to `schema.prisma`**

Add immediately after the `ResearchProfile` model block:
```prisma
/// Opt-in content-generation profile (one+ per workspace) driving the weekly
/// content-pack routine. Mirrors ResearchProfile.
model ContentProfile {
  id          String  @id @default(uuid())
  workspaceId String
  name        String
  status      String  @default("ACTIVE") // ACTIVE | PAUSED

  /// Customer-authored themes/topics to write about.
  themes      String  @db.Text
  /// Optional voice/tone guidance.
  voice       String? @db.Text
  /// Per-channel piece counts, e.g. { "social": 5, "email": 2, "sms": 1 }.
  counts      Json
  /// Output language (ISO 639-1).
  language    String  @default("en")

  lastRunAt    DateTime?
  /// { social, email, sms, at } from the latest routine run.
  lastRunStats Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status])
  @@map("content_profiles")
}

/// A single AI-generated copy draft (social/email/sms) produced by the
/// content-pack routine. Draft-only: never auto-sent. Humans review/use it.
model ContentDraft {
  id               String  @id @default(uuid())
  workspaceId      String
  contentProfileId String?
  channel          String  // social | email | sms
  subject          String? @db.Text
  body             String  @db.Text
  status           String  @default("DRAFT") // DRAFT | USED | DISCARDED

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status])
  @@map("content_drafts")
}
```

- [ ] **Step 2: Hand-author the migration SQL**

`backend/prisma/migrations/20260614130000_content_pack_routine/migration.sql`:
```sql
-- Content-pack routine (#2): opt-in content profiles + draft output.
-- Additive only; no changes to existing tables.

-- CreateTable
CREATE TABLE "content_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "themes" TEXT NOT NULL,
    "voice" TEXT,
    "counts" JSONB NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "lastRunAt" TIMESTAMP(3),
    "lastRunStats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_drafts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contentProfileId" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_profiles_workspaceId_status_idx" ON "content_profiles"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "content_drafts_workspaceId_status_idx" ON "content_drafts"("workspaceId", "status");
```

- [ ] **Step 3: Regenerate the Prisma client (offline, no DB)**

Run: `cd backend && npx prisma generate`
Expected: "Generated Prisma Client" success. This makes `prisma.contentProfile` / `prisma.contentDraft` available + typed.

- [ ] **Step 4: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: clean (the new models are now in the client).

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260614130000_content_pack_routine/
git commit -m "feat(routine): ContentProfile + ContentDraft models + migration"
```

---

### Task 2: Submit-drafts DTO

**Files:**
- Create: `backend/src/modules/internal/content-drafts.dto.ts`

- [ ] **Step 1: Create the DTO** (mirrors `routine-reviews.dto.ts` style)

```ts
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsIn,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ContentDraftDto {
  @IsIn(['social', 'email', 'sms'])
  channel: 'social' | 'email' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body: string;
}

/** Body of POST /api/internal/content/jobs/:workspaceId/drafts. */
export class SubmitContentDraftsDto {
  @IsUUID()
  profileId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ContentDraftDto)
  drafts: ContentDraftDto[];
}
```

- [ ] **Step 2: tsc** — `cd backend && npx tsc --noEmit` → clean.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/content-drafts.dto.ts
git commit -m "feat(routine): SubmitContentDraftsDto for the content-pack routine"
```

---

### Task 3: Controller — `GET jobs` + `POST drafts`

**Files:**
- Create: `backend/src/modules/internal/internal-content.controller.ts`
- Test: `backend/src/modules/internal/internal-content.controller.spec.ts`

- [ ] **Step 1: Write the failing test**

`internal-content.controller.spec.ts`:
```ts
import { NotFoundException } from '@nestjs/common';
import { InternalContentController } from './internal-content.controller';

describe('InternalContentController', () => {
  let prisma: any;
  let ctrl: InternalContentController;

  const WS = { id: 'ws1', slug: 'a', productName: 'P', productDescription: 'D', defaultLanguage: 'tr' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      contentProfile: { findMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      contentDraft: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    ctrl = new InternalContentController(prisma as any);
  });

  describe('GET jobs', () => {
    it('emits one job per ACTIVE due profile, with clamped counts', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([
        { id: 'cp1', name: 'n', themes: 't', voice: 'v', language: 'tr', counts: { social: 99, email: 2, sms: 1 } },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).profile.counts).toEqual({ social: 10, email: 2, sms: 1 }); // social clamped 99->10
      // due filter present (OR lastRunAt null / < cutoff)
      const where = prisma.contentProfile.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: 'ws1', status: 'ACTIVE' });
      expect(where.OR[0]).toEqual({ lastRunAt: null });
      expect(where.OR[1].lastRunAt.lt).toBeInstanceOf(Date);
    });

    it('skips a profile whose clamped counts are all zero', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([
        { id: 'cp1', name: 'n', themes: 't', voice: null, language: 'tr', counts: { social: 0, email: 0, sms: 0 } },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });

    it('omits workspaces with no due profile', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.contentProfile.findMany.mockResolvedValue([]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });
  });

  describe('POST jobs/:workspaceId/drafts', () => {
    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { profileId: 'cp1', drafts: [{ channel: 'social', body: 'x' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('createMany the drafts and stamps the profile lastRunAt', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      prisma.contentDraft.createMany.mockResolvedValue({ count: 2 });
      const res = await ctrl.submit('ws1', {
        profileId: 'cp1',
        drafts: [
          { channel: 'social', body: 'a' },
          { channel: 'email', subject: 's', body: 'b' },
        ],
      });
      expect(res).toEqual({ created: 2 });
      const rows = prisma.contentDraft.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ workspaceId: 'ws1', contentProfileId: 'cp1', channel: 'social', body: 'a' });
      // profile stamp scoped by {id, workspaceId}
      expect(prisma.contentProfile.updateMany.mock.calls[0][0].where).toEqual({ id: 'cp1', workspaceId: 'ws1' });
    });
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `cd backend && npx jest src/modules/internal/internal-content.controller.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the controller**

`internal-content.controller.ts`:
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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';
import { SubmitContentDraftsDto } from './content-drafts.dto';

const DUE_AFTER_DAYS = 6;
const COUNT_MAX = { social: 10, email: 5, sms: 5 } as const;

/**
 * The content-pack routine's surface:
 *
 *   GET  /api/internal/content/jobs
 *     One job per ACTIVE workspace × ACTIVE, weekly-DUE ContentProfile (lastRunAt
 *     null or older than DUE_AFTER_DAYS). counts are clamped to per-channel maxes.
 *
 *   POST /api/internal/content/jobs/:workspaceId/drafts
 *     Insert the generated drafts (DRAFT status) and stamp the profile's
 *     lastRunAt/lastRunStats — the stamp is what drops the profile out of
 *     "weekly-due", making the run idempotent.
 *
 * Guarded by ROUTINE_TOKEN (x-routine-token). The routine WRITES the copy; we
 * only serve jobs and persist drafts. No campaign creation, no sending, no credits.
 */
@Controller('internal/content')
@UseGuards(RoutineTokenGuard)
export class InternalContentController {
  constructor(private readonly prisma: PrismaService) {}

  private clampCounts(raw: unknown): { social: number; email: number; sms: number } {
    const c = (raw ?? {}) as Record<string, unknown>;
    const one = (v: unknown, max: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
    };
    return {
      social: one(c.social, COUNT_MAX.social),
      email: one(c.email, COUNT_MAX.email),
      sms: one(c.sms, COUNT_MAX.sms),
    };
  }

  @Get('jobs')
  async jobs() {
    const cutoff = new Date(Date.now() - DUE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productDescription: true, defaultLanguage: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const profiles = await this.prisma.contentProfile.findMany({
        where: {
          workspaceId: ws.id,
          status: 'ACTIVE',
          OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }],
        },
        select: { id: true, name: true, themes: true, voice: true, language: true, counts: true },
      });
      for (const p of profiles) {
        const counts = this.clampCounts(p.counts);
        if (counts.social + counts.email + counts.sms === 0) continue;
        jobs.push({
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          productName: ws.productName,
          productDescription: ws.productDescription,
          defaultLanguage: ws.defaultLanguage,
          profile: {
            id: p.id,
            name: p.name,
            themes: p.themes,
            voice: p.voice,
            language: p.language,
            counts,
          },
        });
      }
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post('jobs/:workspaceId/drafts')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitContentDraftsDto,
  ): Promise<{ created: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    const result = await this.prisma.contentDraft.createMany({
      data: dto.drafts.map((d) => ({
        workspaceId,
        contentProfileId: dto.profileId,
        channel: d.channel,
        subject: d.subject ?? null,
        body: d.body,
      })),
    });

    // Best-effort stamp; never fail the submission over it. Scoped by
    // {id, workspaceId} so a routine can never stamp another tenant's profile.
    const byChannel = dto.drafts.reduce<Record<string, number>>((acc, d) => {
      acc[d.channel] = (acc[d.channel] ?? 0) + 1;
      return acc;
    }, {});
    await this.prisma.contentProfile
      .updateMany({
        where: { id: dto.profileId, workspaceId },
        data: {
          lastRunAt: new Date(),
          lastRunStats: { ...byChannel, at: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return { created: result.count };
  }
}
```

- [ ] **Step 4: Run, verify pass** — `cd backend && npx jest src/modules/internal/internal-content.controller.spec.ts` → 5 passing.
- [ ] **Step 5: Commit**
```bash
git add backend/src/modules/internal/internal-content.controller.ts backend/src/modules/internal/internal-content.controller.spec.ts
git commit -m "feat(routine): internal content controller — GET jobs + POST drafts"
```

---

### Task 4: Register the controller

**Files:**
- Modify: `backend/src/modules/internal/internal.module.ts`

- [ ] **Step 1:** Add `import { InternalContentController } from './internal-content.controller';` and add `InternalContentController` to the `controllers` array. `RoutineTokenGuard` is ALREADY in `providers` (from routine #1) — do not re-add.
- [ ] **Step 2:** `cd backend && npx tsc --noEmit` → clean; `cd backend && npx jest src/modules/internal` → all green.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/internal.module.ts
git commit -m "feat(routine): register content controller"
```

---

### Task 5: Routine prompt

**Files:**
- Create: `ops/content-pack-routine-prompt.md`

- [ ] **Step 1: Write the canonical prompt** (mirror `ops/review-draft-routine-prompt.md` header convention)

````markdown
# Content-pack routine — canonical prompt

Versioned source of the content-pack cloud routine's prompt. The live routine
(claude.ai/code/routines) must match this file; edit HERE first, then update the
routine. Schedule: `0 4 * * 1` UTC (Mondays). No MCP connectors. Secrets (base URL
+ `ROUTINE_TOKEN`) are embedded at update time — NEVER commit real values here.

Placeholders: `{{MARKETING_API_BASE}}`, `{{ROUTINE_TOKEN}}`.

---

```
You generate a weekly content pack (social posts + email/SMS copy) for a
multi-tenant marketing platform. Each workspace is a different business. You
produce DRAFTS only — nothing is sent or published. Write the copy yourself; do
not call any external tool or API.

STEP 1 — FETCH JOBS

curl -sS {{MARKETING_API_BASE}}/api/internal/content/jobs \
  -H "x-routine-token: {{ROUTINE_TOKEN}}"

Response: { generatedAt, jobs }. Each job: { workspaceId, workspaceSlug,
productName, productDescription, defaultLanguage, profile: { id, name, themes,
voice, language, counts: { social, email, sms } } }. If jobs is empty, write a
one-line summary and stop.

STEP 2 — GENERATE (per job/profile)

Produce EXACTLY counts.social social posts, counts.email emails, counts.sms SMS.
Ground every piece in productName + productDescription + the profile's themes,
in the profile's `language` (fall back to defaultLanguage). Apply `voice` if set.
- social: punchy, a hook, platform-appropriate; no subject.
- email: format each as `SUBJECT: <subject>` then `BODY:` then the body.
- sms: short, concise, one clear CTA.
Keep each body well under 4000 chars.

STEP 3 — SUBMIT (per workspace)

curl -sS -X POST \
  {{MARKETING_API_BASE}}/api/internal/content/jobs/<workspaceId>/drafts \
  -H "x-routine-token: {{ROUTINE_TOKEN}}" \
  -H "content-type: application/json" \
  -d '{"profileId":"<profile.id>","drafts":[{"channel":"social","body":"..."},{"channel":"email","subject":"...","body":"..."}]}'

Server stores them as DRAFT and stamps the profile so it is not picked up again
this week; returns { created }.

STEP 4 — SUMMARY

One line: workspaces processed, drafts created by channel.
```
````

- [ ] **Step 2: Commit**
```bash
git add ops/content-pack-routine-prompt.md
git commit -m "docs(routine): canonical content-pack routine prompt"
```

---

## Final verification
- [ ] `cd backend && npx jest src/modules/internal` → all green.
- [ ] `cd backend && npx tsc --noEmit` → clean.
- [ ] `cd backend && npx jest` → full suite green (nothing else broke).

## Operator handoff (manual, not code)
1. `ROUTINE_TOKEN` already exists (routine #1) — reused.
2. Apply the migration on deploy (`prisma migrate deploy` runs it).
3. Seed ≥1 `content_profiles` row (until the editor UI ships).
4. Create the routine in claude.ai from `ops/content-pack-routine-prompt.md`, schedule `0 4 * * 1` UTC, enable.

## Out of scope (separate follow-up)
Frontend: ContentProfile editor + ContentDraft inbox. See the spec's Scope boundary.
