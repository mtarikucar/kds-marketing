# Insight-digest Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** A weekly cloud routine producing a KPI-snapshot + AI narrative digest per active workspace; backend computes KPIs, routine writes prose.

**Architecture:** One new Prisma model `InsightDigest` + an `internal/insights` controller (`GET jobs` computes KPIs + weekly-due/activity gates, `POST digest` inserts) guarded by the existing `RoutineTokenGuard`. Mirrors routines #1/#2. Spec: `docs/superpowers/specs/2026-06-14-insight-digest-routine-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest. NO DB in this env — migration is hand-authored; client regenerated offline via `npx prisma generate`; applied at deploy via `prisma migrate deploy`.

Paths relative to repo root. Backend cmds from `backend/`. Branch `feat/insight-digest-routine` checked out. **Reuse** `routine-token.guard.ts` (exists, already registered).

---

### Task 1: `InsightDigest` model + migration

**Files:** Modify `backend/prisma/schema.prisma`; Create `backend/prisma/migrations/20260614140000_insight_digest_routine/migration.sql`.

- [ ] **Step 1: Add the model to `schema.prisma`** (after the `ContentDraft` model)
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

- [ ] **Step 2: Hand-author the migration**
`backend/prisma/migrations/20260614140000_insight_digest_routine/migration.sql`:
```sql
-- Insight-digest routine (#3): weekly AI insights digest per workspace.
-- Additive only; no changes to existing tables.

-- CreateTable
CREATE TABLE "insight_digests" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insight_digests_workspaceId_createdAt_idx" ON "insight_digests"("workspaceId", "createdAt");
```

- [ ] **Step 3:** `cd backend && npx prisma generate` → success (offline). Then `npx prisma format` to keep alignment clean.
- [ ] **Step 4:** `cd backend && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit**
```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260614140000_insight_digest_routine/
git commit -m "feat(routine): InsightDigest model + migration"
```

---

### Task 2: DTO

**Files:** Create `backend/src/modules/internal/insight-digest.dto.ts`.

- [ ] **Step 1: Create it**
```ts
import { IsDateString, IsObject, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** Body of POST /api/internal/insights/:workspaceId/digest. */
export class SubmitInsightDigestDto {
  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsObject()
  metrics: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  body: string;
}
```
- [ ] **Step 2:** `cd backend && npx tsc --noEmit` → clean.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/insight-digest.dto.ts
git commit -m "feat(routine): SubmitInsightDigestDto for the insight-digest routine"
```

---

### Task 3: Controller — `GET jobs` + `POST digest`

**Files:** Create `backend/src/modules/internal/internal-insights.controller.ts` + `internal-insights.controller.spec.ts`.

- [ ] **Step 1: Write the failing test**
`internal-insights.controller.spec.ts`:
```ts
import { NotFoundException } from '@nestjs/common';
import { InternalInsightsController } from './internal-insights.controller';

describe('InternalInsightsController', () => {
  let prisma: any;
  let ctrl: InternalInsightsController;
  const WS = { id: 'ws1', slug: 'a', productName: 'P', defaultLanguage: 'tr' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      insightDigest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'dg1' }),
      },
      lead: { count: jest.fn().mockResolvedValue(0) },
      review: { count: jest.fn().mockResolvedValue(0), aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null } }) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
    };
    ctrl = new InternalInsightsController(prisma as any);
  });

  describe('GET jobs', () => {
    it('includes a workspace with activity and computes rounded metrics', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.count.mockResolvedValueOnce(12).mockResolvedValueOnce(240); // leadsNew, leadsTotal
      prisma.review.count.mockResolvedValue(3);
      prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 4.33 } });
      prisma.campaign.count.mockResolvedValue(2);

      const res = await ctrl.jobs();

      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).metrics).toEqual({
        leadsNew: 12, leadsTotal: 240, reviewsNew: 3, avgRating: 4.3, campaignsSent: 2,
      });
      expect(res.periodStart).toEqual(expect.any(String));
      expect(res.periodEnd).toEqual(expect.any(String));
    });

    it('omits a workspace with no activity (all-zero gate)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });

    it('omits a workspace already digested within the weekly-due window (and skips KPI work)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.insightDigest.findFirst.mockResolvedValue({ id: 'recent' });
      prisma.lead.count.mockResolvedValue(99);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
      expect(prisma.lead.count).not.toHaveBeenCalled();
    });
  });

  describe('POST :workspaceId/digest', () => {
    const validBody = {
      periodStart: '2026-06-07T00:00:00Z',
      periodEnd: '2026-06-14T00:00:00Z',
      metrics: { leadsNew: 5 },
      body: 'great week',
    };

    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(ctrl.submit('wsX', validBody)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates an InsightDigest scoped to the path workspace and returns its id', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      const res = await ctrl.submit('ws1', validBody);
      expect(res).toEqual({ id: 'dg1' });
      expect(prisma.insightDigest.create.mock.calls[0][0].data).toMatchObject({
        workspaceId: 'ws1', body: 'great week',
      });
    });
  });
});
```

- [ ] **Step 2:** `cd backend && npx jest src/modules/internal/internal-insights.controller.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the controller**
`internal-insights.controller.ts`:
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
import { SubmitInsightDigestDto } from './insight-digest.dto';

const PERIOD_DAYS = 7;
const DUE_AFTER_DAYS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The insight-digest routine's surface:
 *
 *   GET  /api/internal/insights/jobs
 *     One job per ACTIVE workspace that (a) has NOT been digested in the last
 *     DUE_AFTER_DAYS (weekly-due) and (b) had activity in the trailing
 *     PERIOD_DAYS. The backend computes the KPI snapshot; the routine writes the
 *     narrative from it.
 *
 *   POST /api/internal/insights/:workspaceId/digest
 *     Persist the AI digest (metrics snapshot + body). The new row is what drops
 *     the workspace out of "weekly-due" next run.
 *
 * Guarded by ROUTINE_TOKEN. No sending, no credits.
 */
@Controller('internal/insights')
@UseGuards(RoutineTokenGuard)
export class InternalInsightsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('jobs')
  async jobs() {
    const now = Date.now();
    const periodStart = new Date(now - PERIOD_DAYS * DAY_MS);
    const periodEnd = new Date(now);
    const dueCutoff = new Date(now - DUE_AFTER_DAYS * DAY_MS);

    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, defaultLanguage: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const recent = await this.prisma.insightDigest.findFirst({
        where: { workspaceId: ws.id, createdAt: { gte: dueCutoff } },
        select: { id: true },
      });
      if (recent) continue; // weekly-due: already digested this week

      const [leadsNew, leadsTotal, reviewsNew, ratingAgg, campaignsSent] =
        await Promise.all([
          this.prisma.lead.count({ where: { workspaceId: ws.id, createdAt: { gte: periodStart } } }),
          this.prisma.lead.count({ where: { workspaceId: ws.id } }),
          this.prisma.review.count({ where: { workspaceId: ws.id, createdAt: { gte: periodStart } } }),
          this.prisma.review.aggregate({
            _avg: { rating: true },
            where: { workspaceId: ws.id, createdAt: { gte: periodStart }, rating: { not: null } },
          }),
          this.prisma.campaign.count({ where: { workspaceId: ws.id, status: 'SENT', completedAt: { gte: periodStart } } }),
        ]);

      if (leadsNew === 0 && reviewsNew === 0 && campaignsSent === 0) continue; // activity gate

      const rawAvg = ratingAgg._avg.rating;
      const avgRating =
        rawAvg === null || rawAvg === undefined ? null : Math.round(rawAvg * 10) / 10;

      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        defaultLanguage: ws.defaultLanguage,
        metrics: { leadsNew, leadsTotal, reviewsNew, avgRating, campaignsSent },
      });
    }

    return {
      generatedAt: periodEnd.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      jobs,
    };
  }

  @Post(':workspaceId/digest')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitInsightDigestDto,
  ): Promise<{ id: string }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    const digest = await this.prisma.insightDigest.create({
      data: {
        workspaceId,
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
        metrics: dto.metrics as Prisma.InputJsonValue,
        body: dto.body,
      },
      select: { id: true },
    });

    return { id: digest.id };
  }
}
```

- [ ] **Step 4:** `cd backend && npx jest src/modules/internal/internal-insights.controller.spec.ts` → 5 passing.
- [ ] **Step 5: Commit**
```bash
git add backend/src/modules/internal/internal-insights.controller.ts backend/src/modules/internal/internal-insights.controller.spec.ts
git commit -m "feat(routine): internal insights controller — GET jobs + POST digest"
```

---

### Task 4: Register the controller

**Files:** Modify `backend/src/modules/internal/internal.module.ts`.

- [ ] **Step 1:** Add `import { InternalInsightsController } from './internal-insights.controller';` and add `InternalInsightsController` to the `controllers` array. (`RoutineTokenGuard` already in `providers` — do not re-add.)
- [ ] **Step 2:** `cd backend && npx tsc --noEmit` → clean; `cd backend && npx jest src/modules/internal` → all green.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/internal.module.ts
git commit -m "feat(routine): register insights controller"
```

---

### Task 5: Routine prompt

**Files:** Create `ops/insight-digest-routine-prompt.md`.

- [ ] **Step 1: Write the canonical prompt** (mirror `ops/content-pack-routine-prompt.md` header convention)
````markdown
# Insight-digest routine — canonical prompt

Versioned source of the insight-digest cloud routine's prompt. The live routine
(claude.ai/code/routines) must match this file; edit HERE first, then update the
routine. Schedule: `0 5 * * 1` UTC (Mondays). No MCP connectors. Secrets (base URL
+ `ROUTINE_TOKEN`) embedded at update time — NEVER commit real values here.

Placeholders: `{{MARKETING_API_BASE}}`, `{{ROUTINE_TOKEN}}`.

---

```
You write a weekly insights digest for each business on a marketing platform.
The backend gives you the numbers; you write a short narrative + recommendations.
You invent NOTHING — use only the metrics provided. Write the digest yourself; do
not call any external tool or API.

STEP 1 — FETCH JOBS

curl -sS {{MARKETING_API_BASE}}/api/internal/insights/jobs \
  -H "x-routine-token: {{ROUTINE_TOKEN}}"

Response: { generatedAt, periodStart, periodEnd, jobs }. Each job: { workspaceId,
workspaceSlug, productName, defaultLanguage, metrics: { leadsNew, leadsTotal,
reviewsNew, avgRating, campaignsSent } }. If jobs is empty, write a one-line
summary and stop.

STEP 2 — WRITE (per job)

In the workspace's `defaultLanguage`, write a digest grounded ONLY on `metrics`:
- 2-4 sentence summary of the week (cite the actual numbers).
- 2-3 concrete, specific recommendations tied to the numbers (e.g. low avgRating
  -> follow up on unhappy customers; high leadsNew but few campaignsSent -> launch
  a nurture campaign).
Never state a number that is not in `metrics`. Keep it under ~8000 chars.

STEP 3 — SUBMIT (per workspace)

curl -sS -X POST \
  {{MARKETING_API_BASE}}/api/internal/insights/<workspaceId>/digest \
  -H "x-routine-token: {{ROUTINE_TOKEN}}" \
  -H "content-type: application/json" \
  -d '{"periodStart":"<from job>","periodEnd":"<from job>","metrics":<the job metrics object>,"body":"<your digest>"}'

Echo periodStart/periodEnd and the metrics object from the job. Server returns { id }.

STEP 4 — SUMMARY

One line: workspaces digested.
```
````
- [ ] **Step 2: Commit**
```bash
git add ops/insight-digest-routine-prompt.md
git commit -m "docs(routine): canonical insight-digest routine prompt"
```

---

## Final verification
- [ ] `cd backend && npx jest src/modules/internal` → green.
- [ ] `cd backend && npx tsc --noEmit` → clean.
- [ ] `cd backend && npx jest` → full suite green.

## Operator handoff (manual)
1. `ROUTINE_TOKEN` reused. 2. Migration applied on deploy. 3. Create routine in claude.ai from `ops/insight-digest-routine-prompt.md`, schedule `0 5 * * 1` UTC, enable. No seeding (no opt-in profile).

## Out of scope
Frontend digest viewer — separate follow-up.
