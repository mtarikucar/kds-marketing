# Lead-scoring Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** A nightly cloud routine that writes an advisory AI fit/value score (0–100) + reason onto unscored active leads, on the flat-fee routine surface.

**Architecture:** Three additive nullable columns on `Lead` (`aiScore`, `aiScoreReason`, `scoredAt`) + an index, and an `internal/lead-scoring` controller (`GET jobs` per-workspace-capped over unscored active leads, `POST scores` guarded `updateMany`) guarded by the existing `RoutineTokenGuard`. Mirrors routines #1–#3. Spec: `docs/superpowers/specs/2026-06-14-lead-scoring-routine-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest. NO DB in this env — migration hand-authored; client regenerated offline via `npx prisma generate`; applied at deploy via `prisma migrate deploy`.

Paths relative to repo root. Backend cmds from `backend/`. Branch `feat/lead-scoring-routine` checked out. **Reuse** `routine-token.guard.ts` (exists, registered).

---

### Task 1: `Lead` columns + index + migration

**Files:** Modify `backend/prisma/schema.prisma`; Create `backend/prisma/migrations/20260614150000_lead_scoring_routine/migration.sql`.

- [ ] **Step 1: Add fields + index to the `Lead` model in `schema.prisma`.**
Inside the existing `model Lead { ... }`, add these three fields (e.g. just after the `externalRef` field):
```prisma
  /// AI fit/value score (0-100) + reason from the lead-scoring routine. Advisory;
  /// separate from rep-set priority/status. scoredAt null = not yet scored.
  aiScore       Int?
  aiScoreReason String?   @db.Text
  scoredAt      DateTime?
```
And add this index alongside the model's existing `@@index(...)` lines:
```prisma
  @@index([workspaceId, scoredAt])
```

- [ ] **Step 2: Hand-author the migration**
`backend/prisma/migrations/20260614150000_lead_scoring_routine/migration.sql`:
```sql
-- Lead-scoring routine (#4): advisory AI fit/value score on leads.
-- Additive: nullable columns + one index. No data migration / no table rewrite.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "aiScore" INTEGER,
ADD COLUMN     "aiScoreReason" TEXT,
ADD COLUMN     "scoredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_workspaceId_scoredAt_idx" ON "leads"("workspaceId", "scoredAt");
```

- [ ] **Step 3:** `cd backend && npx prisma generate` → success (offline); then `npx prisma format`.
- [ ] **Step 4:** `cd backend && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit**
```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260614150000_lead_scoring_routine/
git commit -m "feat(routine): Lead aiScore/aiScoreReason/scoredAt columns + migration"
```

---

### Task 2: DTO

**Files:** Create `backend/src/modules/internal/lead-scores.dto.ts`.

- [ ] **Step 1: Create it**
```ts
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LeadScoreDto {
  @IsUUID()
  leadId: string;

  @IsInt()
  @Min(0)
  @Max(100)
  score: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** Body of POST /api/internal/lead-scoring/:workspaceId/scores. */
export class SubmitLeadScoresDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LeadScoreDto)
  scores: LeadScoreDto[];
}
```
- [ ] **Step 2:** `cd backend && npx tsc --noEmit` → clean.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/lead-scores.dto.ts
git commit -m "feat(routine): SubmitLeadScoresDto for the lead-scoring routine"
```

---

### Task 3: Controller — `GET jobs` + `POST scores`

**Files:** Create `backend/src/modules/internal/internal-lead-scoring.controller.ts` + `internal-lead-scoring.controller.spec.ts`.

- [ ] **Step 1: Write the failing test**
`internal-lead-scoring.controller.spec.ts`:
```ts
import { NotFoundException } from '@nestjs/common';
import { InternalLeadScoringController } from './internal-lead-scoring.controller';

describe('InternalLeadScoringController', () => {
  let prisma: any;
  let config: any;
  let ctrl: InternalLeadScoringController;
  const WS = { id: 'ws1', slug: 'a', productName: 'P', productDescription: 'D' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      lead: { findMany: jest.fn(), updateMany: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue(undefined) }; // env absent -> default cap
    ctrl = new InternalLeadScoringController(prisma as any, config as any);
  });

  describe('GET jobs', () => {
    it('returns one job per workspace with unscored active leads', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', businessName: 'B', businessType: 'CAFE', source: 'INSTAGRAM', city: 'X', region: 'Y', tableCount: 12, branchCount: 1, currentSystem: null, notes: null },
      ]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).leads[0]).toMatchObject({ leadId: 'l1', businessType: 'CAFE' });
      const where = prisma.lead.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: 'ws1', scoredAt: null });
      expect(where.status).toEqual({ notIn: ['WON', 'LOST'] });
      expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(100);
    });

    it('honors the ROUTINE_LEADSCORE_DAILY_CAP override', async () => {
      config.get.mockReturnValue('25');
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1', businessName: 'B', businessType: 'CAFE', source: 'X', city: null, region: null, tableCount: null, branchCount: null, currentSystem: null, notes: null }]);
      await ctrl.jobs();
      expect(prisma.lead.findMany.mock.calls[0][0].take).toBe(25);
    });

    it('omits workspaces with no unscored leads', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.findMany.mockResolvedValue([]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });
  });

  describe('POST :workspaceId/scores', () => {
    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        ctrl.submit('wsX', { scores: [{ leadId: 'l1', score: 80, reason: 'hot' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('guarded-updates only still-unscored leads and counts scored/skipped', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      prisma.lead.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      const res = await ctrl.submit('ws1', {
        scores: [
          { leadId: 'l1', score: 80, reason: 'hot' },
          { leadId: 'l2', score: 30, reason: 'cold' },
        ],
      });
      expect(res).toEqual({ scored: 1, skipped: 1 });
      expect(prisma.lead.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'l1', workspaceId: 'ws1', scoredAt: null });
      expect(prisma.lead.updateMany.mock.calls[0][0].data).toMatchObject({ aiScore: 80, aiScoreReason: 'hot' });
    });
  });
});
```

- [ ] **Step 2:** `cd backend && npx jest src/modules/internal/internal-lead-scoring.controller.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the controller**
`internal-lead-scoring.controller.ts`:
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
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';
import { SubmitLeadScoresDto } from './lead-scores.dto';

const DEFAULT_DAILY_CAP = 100;
const SKIP_STATUSES = ['WON', 'LOST'];

/**
 * The lead-scoring routine's surface:
 *
 *   GET  /api/internal/lead-scoring/jobs
 *     One job per ACTIVE workspace with unscored active leads (scoredAt null,
 *     status not WON/LOST), capped per workspace. Carries the lead fields + product
 *     context the routine needs to score fit/value.
 *
 *   POST /api/internal/lead-scoring/:workspaceId/scores
 *     Write aiScore/aiScoreReason/scoredAt onto each lead — guarded so a lead
 *     scored since the GET is never re-scored, and cross-tenant writes can't happen.
 *
 * Guarded by ROUTINE_TOKEN. Advisory score only — never touches priority/status.
 * No sending, no credits.
 */
@Controller('internal/lead-scoring')
@UseGuards(RoutineTokenGuard)
export class InternalLeadScoringController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private dailyCap(): number {
    const raw = parseInt(
      this.config.get<string>('ROUTINE_LEADSCORE_DAILY_CAP') ?? '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
  }

  @Get('jobs')
  async jobs() {
    const cap = this.dailyCap();
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productDescription: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const leads = await this.prisma.lead.findMany({
        where: {
          workspaceId: ws.id,
          scoredAt: null,
          status: { notIn: SKIP_STATUSES },
        },
        orderBy: { createdAt: 'asc' },
        take: cap,
        select: {
          id: true,
          businessName: true,
          businessType: true,
          source: true,
          city: true,
          region: true,
          tableCount: true,
          branchCount: true,
          currentSystem: true,
          notes: true,
        },
      });
      if (leads.length === 0) continue;
      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        productDescription: ws.productDescription,
        leads: leads.map((l) => ({
          leadId: l.id,
          businessName: l.businessName,
          businessType: l.businessType,
          source: l.source,
          city: l.city,
          region: l.region,
          tableCount: l.tableCount,
          branchCount: l.branchCount,
          currentSystem: l.currentSystem,
          notes: l.notes,
        })),
      });
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post(':workspaceId/scores')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitLeadScoresDto,
  ): Promise<{ scored: number; skipped: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    let scored = 0;
    for (const s of dto.scores) {
      // Guarded write: only an as-yet-unscored lead in THIS workspace. Re-scoring
      // and cross-tenant writes are both impossible.
      const res = await this.prisma.lead.updateMany({
        where: { id: s.leadId, workspaceId, scoredAt: null },
        data: { aiScore: s.score, aiScoreReason: s.reason, scoredAt: new Date() },
      });
      scored += res.count;
    }

    return { scored, skipped: dto.scores.length - scored };
  }
}
```

- [ ] **Step 4:** `cd backend && npx jest src/modules/internal/internal-lead-scoring.controller.spec.ts` → 5 passing.
- [ ] **Step 5: Commit**
```bash
git add backend/src/modules/internal/internal-lead-scoring.controller.ts backend/src/modules/internal/internal-lead-scoring.controller.spec.ts
git commit -m "feat(routine): internal lead-scoring controller — GET jobs + POST scores"
```

---

### Task 4: Register the controller

**Files:** Modify `backend/src/modules/internal/internal.module.ts`.

- [ ] **Step 1:** Add `import { InternalLeadScoringController } from './internal-lead-scoring.controller';` and add `InternalLeadScoringController` to the `controllers` array. (`RoutineTokenGuard` already a provider.)
- [ ] **Step 2:** `cd backend && npx tsc --noEmit` → clean; `cd backend && npx jest src/modules/internal` → green.
- [ ] **Step 3: Commit**
```bash
git add backend/src/modules/internal/internal.module.ts
git commit -m "feat(routine): register lead-scoring controller"
```

---

### Task 5: Env docs

**Files:** Modify `backend/.env.example`, `README.md`.

- [ ] **Step 1:** Append to `backend/.env.example` (near the other `ROUTINE_*` rows):
```bash
# Per-workspace nightly cap on leads the lead-scoring routine scores.
ROUTINE_LEADSCORE_DAILY_CAP=100
```
- [ ] **Step 2:** Add a README env-table row below the `ROUTINE_REVIEW_DAILY_CAP` row:
```markdown
| `ROUTINE_LEADSCORE_DAILY_CAP` | no | Per-workspace nightly cap on leads the lead-scoring routine scores (default 100). |
```
- [ ] **Step 3: Commit**
```bash
git add backend/.env.example README.md
git commit -m "docs(routine): document ROUTINE_LEADSCORE_DAILY_CAP"
```

---

### Task 6: Routine prompt

**Files:** Create `ops/lead-scoring-routine-prompt.md`.

- [ ] **Step 1: Write the canonical prompt** (mirror the other `ops/*-routine-prompt.md`)
````markdown
# Lead-scoring routine — canonical prompt

Versioned source of the lead-scoring cloud routine's prompt. The live routine
(claude.ai/code/routines) must match this file; edit HERE first, then update the
routine. Schedule: `0 6 * * *` UTC (nightly). No MCP connectors. Secrets (base URL
+ `ROUTINE_TOKEN`) embedded at update time — NEVER commit real values here.

Placeholders: `{{MARKETING_API_BASE}}`, `{{ROUTINE_TOKEN}}`.

---

```
You score sales leads for a multi-tenant marketing platform so reps can
prioritise. For each lead you assign a fit/value score from 0 to 100 and a
one-line reason. You judge ONLY from the provided lead fields + the workspace's
product context. Write the scores yourself; do not call any external tool or API.

STEP 1 — FETCH JOBS

curl -sS {{MARKETING_API_BASE}}/api/internal/lead-scoring/jobs \
  -H "x-routine-token: {{ROUTINE_TOKEN}}"

Response: { generatedAt, jobs }. Each job: { workspaceId, workspaceSlug,
productName, productDescription, leads: [{ leadId, businessName, businessType,
source, city, region, tableCount, branchCount, currentSystem, notes }] }. If jobs
is empty, write a one-line summary and stop.

STEP 2 — SCORE (per lead)

Assign score 0-100: how well the lead fits the workspace's product/ICP and how
likely it is to convert. Higher = better fit + stronger buying signals. Consider
business type, scale (tableCount/branchCount), whether they already run a
competing system, source quality, and any notes. Give a concise reason (<= ~120
chars). Do not invent facts not present in the lead.

STEP 3 — SUBMIT (per workspace)

curl -sS -X POST \
  {{MARKETING_API_BASE}}/api/internal/lead-scoring/<workspaceId>/scores \
  -H "x-routine-token: {{ROUTINE_TOKEN}}" \
  -H "content-type: application/json" \
  -d '{"scores":[{"leadId":"<id>","score":82,"reason":"..."}]}'

Server writes the score only if the lead is still unscored; returns { scored, skipped }.

STEP 4 — SUMMARY

One line: workspaces processed, leads scored.
```
````
- [ ] **Step 2: Commit**
```bash
git add ops/lead-scoring-routine-prompt.md
git commit -m "docs(routine): canonical lead-scoring routine prompt"
```

---

## Final verification
- [ ] `cd backend && npx jest src/modules/internal` → green.
- [ ] `cd backend && npx tsc --noEmit` → clean.
- [ ] `cd backend && npx jest` → full suite green.

## Operator handoff (manual)
1. `ROUTINE_TOKEN` reused; optionally set `ROUTINE_LEADSCORE_DAILY_CAP`. 2. Migration applied on deploy. 3. Create routine in claude.ai from `ops/lead-scoring-routine-prompt.md`, schedule `0 6 * * *` UTC, enable.

## Out of scope
Frontend: surfacing `aiScore`/`aiScoreReason` in the leads UI — follow-up.
