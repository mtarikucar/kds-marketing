# Brand Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a workspace one consolidated, AI-extracted brand/product profile that grounds every workspace AI (conversation, content, social, voice, research) and seeds the AI-researcher's lead targeting.

**Architecture:** Extend the existing `brand-brain` module. A new structured `BrandProfile` (one per workspace) is the always-on compact grounding block, injected into every AI system prompt via a cached `BrandContextService`. The full crawled/scraped materials live as ordinary `KnowledgeDoc`s (already FTS-grounded). An async, metered extraction pipeline (`BrandAnalysisRun` + a `brand-brain.analyze` ScheduledJob reusing the research Firecrawl/Apify providers) produces a draft the user reviews/applies; applying seeds `BrandKit`/`ResearchProfile`/`Workspace` fields without clobbering user edits.

**Tech Stack:** NestJS 11 / Express 5, Prisma + Postgres, `@nestjs/jwt`, Jest (backend). Frontend: Vite/React, `@tanstack/react-query`, axios, Vitest.

## Global Constraints

- **Reversible migrations (CLAUDE.md):** every schema migration ships as `prisma/migrations/<ts>_<name>/migration.sql` (up, idempotent `IF NOT EXISTS`) + a companion `down.sql` (drops exactly what up added, safe no-op if reverted). Verify round-trip up → down → up. Match the repo idiom: read `backend/prisma/migrations/20260708120000_netgsm_webhook_events/migration.sql` + `down.sql`.
- **No AI authorship trace (CLAUDE.md):** plain conventional commits; author is the user; no `Co-Authored-By`/"Generated with" trailer.
- **Workspace scoping fitness test:** `backend/src/modules/marketing/workspace-scoping.arch.spec.ts` fails any bulk/create Prisma call on a workspace-owned delegate lacking a literal `workspaceId`; cross-workspace reads must be justified-exempt in `ALLOWED_GLOBAL`.
- **AI credit costs are tripwire-pinned:** any new `creditCost('...')` key MUST be added to `backend/src/modules/marketing/ai/ai-credit-costs.ts` `AI_CREDIT_COSTS` (a spec pins the map — update it in the same task).
- **Provider-inert fallback:** `FirecrawlProvider`/`ApifyProvider` `isConfigured()` gate + throw-on-real-failure (never silently bill/report a caught throw as "no results"). `R2StorageService.upload` THROWS when unconfigured — callers must guard with `isConfigured()`.
- **Backend gates:** `cd backend && npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest <touched specs> && npx jest workspace-scoping.arch`. Frontend: `cd frontend && npx tsc && npx vitest run <touched>`. (`tsc -b` fails on a pre-existing missing `@types/node` — use `npx tsc`.)
- **Branch:** all work on `feat/brand-brain`. Commit per task.
- **Language:** synthesized/generated output follows `Workspace.defaultLanguage` (default `'tr'`).

---

## File structure

**Backend — created**
- `prisma/migrations/20260716120000_brand_profile/migration.sql` + `down.sql` — `brand_profiles` (Phase 1) + `brand_analysis_runs` (Phase 2, same or a second migration).
- `src/modules/marketing/brand-brain/brand-profile.service.ts` — `BrandProfile` CRUD + seed helpers. One responsibility: the structured brand header.
- `src/modules/marketing/brand-brain/brand-context.service.ts` — the cached always-on compact brand block for AI prompts.
- `src/modules/marketing/dto/brand-profile.dto.ts` — the editable payload.
- `src/modules/marketing/brand-brain/brand-analysis.service.ts` (Phase 2) — orchestrates the async extraction run.
- `src/modules/marketing/brand-brain/brand-analysis.runner.ts` (Phase 2) — the `brand-brain.analyze` ScheduledJob handler.
- `src/modules/marketing/brand-brain/sources/*.ts` (Phase 2) — website/social/gbp/upload source adapters.
- `*.spec.ts` alongside each.

**Backend — modified**
- `prisma/schema.prisma` — add `BrandProfile` (+ `BrandAnalysisRun` in Phase 2).
- `src/modules/marketing/marketing.module.ts` — provide the new services; register the analyze handler.
- `src/modules/marketing/controllers/marketing-brand-brain.controller.ts` — add GET/PUT `/brand-profile` (Phase 1) + analyze/review/apply routes (Phase 2/3).
- `src/modules/marketing/channels/conversation-ai-engine.service.ts` — inject the brand block into `buildSystem`.
- `src/modules/marketing/ai/content-ai.service.ts` — inject the brand block into `compose`.
- `src/modules/marketing/social-campaigns/social-campaigns.service.ts` — feed the brand block into generation.
- `src/modules/marketing/voice-ai/netgsm-ivr.service.ts` — inject the brand block into `generateInfo`.
- `src/modules/marketing/research/research-worker.service.ts` — enrich `buildBrief` with the brand block.
- `src/modules/marketing/research/providers/firecrawl.provider.ts` + `apify.provider.ts` (Phase 2) — add `crawl`/`mapSite` + `runActor`/social+GBP methods, same conventions.
- `src/modules/marketing/budget/research-spend.service.ts` (Phase 2) — new metered units if needed.
- `src/modules/marketing/ai/ai-credit-costs.ts` (Phase 2) — `brand.analyze` credit key.

**Frontend — created / modified**
- `frontend/src/pages/marketing/brandBrain/BrandProfileEditor.tsx` (Phase 1) — the editor form (a new sub-tab or a section on the Brain tab).
- `frontend/src/pages/marketing/brandBrain/BrandBrainWizard.tsx` (Phase 3) — the first-login wizard.
- `frontend/src/features/marketing/api/brandBrain.service.ts` — add `getBrandProfile`/`putBrandProfile` (Phase 1) + `startAnalysis`/`getRun`/`applyRun` (Phase 2/3).
- `frontend/src/pages/marketing/BrandingSettingsPage.tsx` — Brain tab hosts the editor (Phase 1) + a "Set up with AI" entry (Phase 3).
- `frontend/src/features/marketing/components/GettingStarted.tsx` — a "Build your Brand Brain" step.

---

# PHASE 1 — Foundation + AI wiring (ships value with zero extraction)

Even with no auto-extraction, this phase makes every AI brand-grounded and gives a manual brand editor. It is independently shippable.

## Task 1: `BrandProfile` schema + reversible migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260716120000_brand_profile/migration.sql`, `down.sql`

**Interfaces:**
- Produces: table `brand_profiles` + Prisma model `BrandProfile` (fields per the spec §1).

- [ ] **Step 1: Add the Prisma model.** In `schema.prisma`, after the `BrandKit` model (~line 3599), add:

```prisma
/// Brand Brain — the workspace's consolidated brand/product profile. The
/// structured "header" (always-on AI grounding block); deep materials live as
/// KnowledgeDoc/KnowledgeChunk. Seeds BrandKit/ResearchProfile/Workspace fields
/// but never silently overwrites user edits. See docs/superpowers/specs/2026-07-16-*.
model BrandProfile {
  id                 String    @id @default(uuid())
  workspaceId        String    @unique
  brandName          String
  tagline            String?
  description        String?   @db.Text
  valueProps         Json?     // string[]
  toneWords          Json?     // string[]
  voiceGuide         String?   @db.Text
  icpDescription     String?   @db.Text
  audienceObjections Json?     // string[]
  offerings          Json?     // [{ name, blurb, price? }]
  sources            Json?     // [{ type, url?, handle?, scrapedAt }]
  socialHandles      Json?     // [{ network, handle }]
  status             String    @default("DRAFT") // DRAFT | ACTIVE
  lastAnalyzedAt     DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  @@map("brand_profiles")
}
```

- [ ] **Step 2: Write the up migration** (`migration.sql`) — read `20260708120000_netgsm_webhook_events/migration.sql` first to match the idiom:

```sql
-- Brand Brain: the workspace's consolidated brand/product profile (structured
-- header). Additive; no changes to existing tables.
CREATE TABLE IF NOT EXISTS "brand_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT,
    "valueProps" JSONB,
    "toneWords" JSONB,
    "voiceGuide" TEXT,
    "icpDescription" TEXT,
    "audienceObjections" JSONB,
    "offerings" JSONB,
    "sources" JSONB,
    "socialHandles" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brand_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brand_profiles_workspaceId_key" ON "brand_profiles"("workspaceId");
```

- [ ] **Step 3: Write `down.sql`:**

```sql
-- Manual rollback for 20260716120000_brand_profile (Prisma migrate is
-- forward-only). Drops exactly what the up created; no operator data touched.
DROP TABLE IF EXISTS "brand_profiles";
```

- [ ] **Step 4: Generate + typecheck.** Run: `cd backend && npx prisma generate && npx tsc --noEmit -p tsconfig.json`. Expected: exit 0 (the `prisma.brandProfile` delegate now exists).

- [ ] **Step 5: Commit.**
```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260716120000_brand_profile
git commit -m "feat(brand-brain): BrandProfile model + reversible migration"
```

## Task 2: `BrandProfileService` + DTO + GET/PUT endpoint

**Files:**
- Create: `backend/src/modules/marketing/brand-brain/brand-profile.service.ts`, `.spec.ts`
- Create: `backend/src/modules/marketing/dto/brand-profile.dto.ts`
- Modify: `backend/src/modules/marketing/controllers/marketing-brand-brain.controller.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (provide + export `BrandProfileService`)

**Interfaces:**
- Produces:
  - `get(workspaceId: string): Promise<BrandProfile | null>`
  - `upsert(workspaceId: string, dto: BrandProfilePayload): Promise<BrandProfile>` — partial-safe (only touches sent fields), like `BrandKitService.upsert`; a create sets `brandName` (required) + `status: 'DRAFT'`.
  - `BrandProfilePayload` = `{ brandName?, tagline?, description?, valueProps?: string[], toneWords?: string[], voiceGuide?, icpDescription?, audienceObjections?: string[], offerings?: {name,blurb,price?}[], socialHandles?: {network,handle}[], status?: 'DRAFT'|'ACTIVE' }`.
- Consumes (Task 3+): `BrandContextService` reads `get()`.

- [ ] **Step 1: DTO.** `brand-profile.dto.ts` — `BrandProfilePayload` with class-validator (`@IsOptional`, `@IsString`, `@IsArray`, `@IsIn(['DRAFT','ACTIVE'])` for status, `@MaxLength` on strings). Model the nested `offerings`/`socialHandles` with `@ValidateNested`.

- [ ] **Step 2: Write the failing test** (`brand-profile.service.spec.ts`, mocked Prisma via `mockPrismaClient`):

```ts
it('upsert creates with brandName + DRAFT, only touching sent fields', async () => {
  (prisma.brandProfile.upsert as jest.Mock).mockImplementation(({ create }) => Promise.resolve({ id: 'b1', ...create }));
  const res = await svc.upsert('ws-1', { brandName: 'Acme', valueProps: ['fast', 'cheap'] });
  const call = (prisma.brandProfile.upsert as jest.Mock).mock.calls[0][0];
  expect(call.where).toEqual({ workspaceId: 'ws-1' });
  expect(call.create).toMatchObject({ workspaceId: 'ws-1', brandName: 'Acme', valueProps: ['fast', 'cheap'], status: 'DRAFT' });
  // A field not sent must not appear in the update payload (partial-safe).
  expect('tagline' in call.update).toBe(false);
});

it('get returns the workspace profile', async () => {
  (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'b1', brandName: 'Acme' });
  expect(await svc.get('ws-1')).toMatchObject({ brandName: 'Acme' });
  expect(prisma.brandProfile.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1' } });
});
```

- [ ] **Step 3: Run → FAIL** (`npx jest brand-profile.service.spec`).

- [ ] **Step 4: Implement** (mirror `brand-kit.service.ts`'s partial-safe `upsert`):

```ts
@Injectable()
export class BrandProfileService {
  constructor(private readonly prisma: PrismaService) {}

  get(workspaceId: string) {
    return this.prisma.brandProfile.findUnique({ where: { workspaceId } });
  }

  upsert(workspaceId: string, dto: BrandProfilePayload) {
    const data: any = {};
    for (const k of ['brandName','tagline','description','valueProps','toneWords','voiceGuide','icpDescription','audienceObjections','offerings','socialHandles','status'] as const) {
      if ((dto as any)[k] !== undefined) data[k] = (dto as any)[k];
    }
    return this.prisma.brandProfile.upsert({
      where: { workspaceId },
      create: { workspaceId, brandName: dto.brandName ?? 'My brand', status: 'DRAFT', ...data },
      update: data,
    });
  }
}
```

- [ ] **Step 5: Controller routes** — in `marketing-brand-brain.controller.ts`, inject `BrandProfileService` and add:
```ts
  @Get('profile')
  getProfile(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.profiles.get(a.workspaceId);
  }
  @Put('profile')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'brand_brain.profile.update', resourceType: 'brand_profile' })
  putProfile(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: BrandProfilePayload) {
    return this.profiles.upsert(a.workspaceId, dto);
  }
```
Provide + export `BrandProfileService` in `marketing.module.ts` (add to `providers` and `exports`).

- [ ] **Step 6: Run + typecheck + arch.** `npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest brand-profile.service.spec workspace-scoping.arch`. Expected: PASS (the `findUnique`/`upsert` by workspaceId are workspace-scoped).

- [ ] **Step 7: Commit** `feat(brand-brain): BrandProfile service + GET/PUT profile endpoint`.

## Task 3: `BrandContextService` — the cached always-on brand block

**Files:**
- Create: `backend/src/modules/marketing/brand-brain/brand-context.service.ts`, `.spec.ts`
- Modify: `marketing.module.ts` (provide + export)

**Interfaces:**
- Produces: `summaryFor(workspaceId: string): Promise<string | null>` — a compact plain-text block (brandName, description, top valueProps, tone, ICP one-liner, top objections) from the `ACTIVE` `BrandProfile`, or `null` when none/DRAFT. Cached per workspace (a `Map` with a short TTL) + `invalidate(workspaceId)`.

- [ ] **Step 1: Write the failing test:**
```ts
it('builds a compact block from an ACTIVE profile, omitting empty sections', async () => {
  profiles.get.mockResolvedValue({ status: 'ACTIVE', brandName: 'Acme', description: 'We sell X to Y.', valueProps: ['fast','cheap'], toneWords: ['warm'], icpDescription: 'SMB cafes', audienceObjections: ['too pricey'] });
  const block = await svc.summaryFor('ws-1');
  expect(block).toContain('Brand: Acme');
  expect(block).toContain('We sell X to Y.');
  expect(block).toContain('fast');
  expect(block).toContain('SMB cafes');
});
it('returns null for a DRAFT or missing profile (callers behave as before)', async () => {
  profiles.get.mockResolvedValue({ status: 'DRAFT', brandName: 'Acme' });
  expect(await svc.summaryFor('ws-1')).toBeNull();
  profiles.get.mockResolvedValue(null);
  expect(await svc.summaryFor('ws-1')).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (inject `BrandProfileService`; a `Map<string,{block:string|null,exp:number}>` cache, TTL ~60s):
```ts
async summaryFor(workspaceId: string): Promise<string | null> {
  const hit = this.cache.get(workspaceId);
  if (hit && hit.exp > Date.now()) return hit.block;
  const p = await this.profiles.get(workspaceId);
  const block = p && p.status === 'ACTIVE' ? this.render(p) : null;
  this.cache.set(workspaceId, { block, exp: Date.now() + 60_000 });
  return block;
}
private render(p: any): string {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const lines = [
    `Brand: ${p.brandName}`,
    p.description || '',
    arr(p.valueProps).length ? `Selling points: ${arr(p.valueProps).join('; ')}` : '',
    arr(p.toneWords).length ? `Voice: ${arr(p.toneWords).join(', ')}${p.voiceGuide ? ` — ${p.voiceGuide}` : ''}` : '',
    p.icpDescription ? `Ideal customer: ${p.icpDescription}` : '',
    arr(p.audienceObjections).length ? `Common objections to preempt: ${arr(p.audienceObjections).join('; ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
invalidate(workspaceId: string) { this.cache.delete(workspaceId); }
```
Call `invalidate` from `BrandProfileService.upsert` (inject it, or emit — simplest: `BrandProfileService` calls `this.context.invalidate(workspaceId)` after upsert; wire the dep).

- [ ] **Step 4: Run → PASS + typecheck.**

- [ ] **Step 5: Commit** `feat(brand-brain): cached always-on brand context block`.

## Task 4: Wire the brand block into `conversation-ai-engine.buildSystem`

**Files:**
- Modify: `backend/src/modules/marketing/channels/conversation-ai-engine.service.ts`
- Modify: its spec.

**Interfaces:** Consumes `BrandContextService.summaryFor`.

- [ ] **Step 1: Write the failing test** (extend `conversation-ai-engine.service.spec.ts`): when `BrandContextService.summaryFor` returns a block, the AI system prompt contains an "About this brand" section; when it returns null, the prompt is unchanged.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Inject `BrandContextService`. `buildSystem` currently takes `(agent, lead, kb)` — add a 4th param `brand: string | null`. In `reply()` (line ~217, before `buildSystem` at 223) and the follow-up path (line ~480), fetch `const brand = await this.brandContext.summaryFor(workspaceId);` and pass it. In `buildSystem`, right after the `persona/tone/goals/guardrails` pushes and before the `Reply in language code` line, add:
```ts
if (brand) parts.push(`About this brand (ground every reply in this):\n${brand}`);
```

- [ ] **Step 4: Run → PASS + typecheck** (mock `BrandContextService` in the spec's `makeDeps`).

- [ ] **Step 5: Commit** `feat(brand-brain): ground conversation AI in the brand block`.

## Task 5: Wire the brand block into `content-ai.compose`

**Files:** Modify `content-ai.service.ts` + spec.

- [ ] **Step 1: Failing test** — with a brand block, the compose system prompt contains it (and the brand voice); without, the prompt is the current productName/description form.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Inject `BrandContextService`. In `compose`, after the `ws` fetch, `const brand = await this.brandContext.summaryFor(workspaceId);`. Prepend to the `system` array (before the copywriter line): if `brand`, replace the `You are a senior B2B marketing copywriter for "${ws?.productName}"` + `Product:` lines with a single richer block `About this brand:\n${brand}` while keeping the language/channel/limits lines. Keep the existing productName fallback when `brand` is null.
- [ ] **Step 4: Run → PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(brand-brain): ground content AI in the brand block`.

## Task 6: Wire the brand block into social-campaigns + netgsm-ivr + research brief

**Files:** Modify `social-campaigns.service.ts`, `netgsm-ivr.service.ts`, `research-worker.service.ts` + their specs.

**Interfaces:** Consumes `BrandContextService.summaryFor`. (Right-sized as one task: three small identical injections that share the "inject brand block if present" pattern; a reviewer accepts/rejects them together.)

- [ ] **Step 1: Failing tests** — one per surface: social `generateItem` passes the brand block into the `contentAi.compose` `context` (or the `mediaGen` prompt); `netgsm-ivr.generateInfo` prepends the brand block to its system; `research-worker.buildBrief` includes a `BRAND:` line when a block exists.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — inject `BrandContextService` into each; in `social-campaigns.generateItem` (line ~432) fetch the block once and append to the compose `context`; in `netgsm-ivr.generateInfo` prepend `About this brand:\n${brand}` to the system string; in `research-worker.buildBrief` add `brand ? \`BRAND CONTEXT: ${brand}\` : ''` to the parts array (thread the block through `research-job.service.toJob` OR fetch it in the worker before `buildBrief` — the worker has `workspaceId` on the job). Each null-safe (omit when no block).
- [ ] **Step 4: Run → PASS + typecheck** (mock `BrandContextService` in each spec).
- [ ] **Step 5: Commit** `feat(brand-brain): ground social/voice/research in the brand block`.

## Task 7: FE — Brand Profile editor on the /branding Brain tab + GettingStarted step

**Files:**
- Create: `frontend/src/pages/marketing/brandBrain/BrandProfileEditor.tsx`, `.test.tsx`
- Modify: `frontend/src/features/marketing/api/brandBrain.service.ts` (add `getBrandProfile`/`putBrandProfile`)
- Modify: `frontend/src/pages/marketing/brandBrain/BrandBrainPage.tsx` (host the editor above the existing search/reindex) OR `BrandingSettingsPage.tsx`
- Modify: `frontend/src/features/marketing/components/GettingStarted.tsx` (add a `brand` step)

**Interfaces:** Consumes `GET/PUT /marketing/brand-profile`.

- [ ] **Step 1: API.** Add to `brandBrain.service.ts`:
```ts
export const getBrandProfile = () => marketingApi.get('/brand-brain/profile').then(r => r.data);
export const putBrandProfile = (p: BrandProfilePayload) => marketingApi.put('/brand-brain/profile', p).then(r => r.data);
```
- [ ] **Step 2: Failing test** (Vitest + testing-library) — the editor loads the profile, edits `brandName` + valueProps + tone + ICP, saves via `putBrandProfile`, and shows a success toast; a "mark Active" control flips `status` to `'ACTIVE'` (so the AI grounding turns on).
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** the editor form (react-hook-form + zod, reuse the `Field`/`Input`/`Textarea`/tag-input primitives; array fields for valueProps/toneWords/objections/offerings). Render it on the Brain tab above the existing citation search. Add the GettingStarted `brand` step: `{ id: 'brand', to: '/branding?tab=brain', done: (profile.data?.status === 'ACTIVE') }` + i18n keys.
- [ ] **Step 5: Run + tsc** (`npx tsc`, `npx vitest run` the new test + GettingStarted test).
- [ ] **Step 6: Commit** `feat(brand-brain): FE brand profile editor + getting-started step`.

**Phase 1 done:** every AI is brand-grounded the moment a workspace marks its BrandProfile `ACTIVE`; targeting/grounding improve with zero extraction.

---

# PHASE 2 — Async extraction pipeline

Turns "type it all in" into "paste your links, AI drafts it." Metered, failure-isolated, resumable.

## Task 8: `BrandAnalysisRun` schema + reversible migration

- [ ] Add the `BrandAnalysisRun` model (spec §1) to `schema.prisma`; `migration.sql` (`CREATE TABLE IF NOT EXISTS brand_analysis_runs` + `@@index([workspaceId, status])`) + `down.sql` (`DROP TABLE IF EXISTS`). Generate + tsc. Commit `feat(brand-brain): BrandAnalysisRun model + reversible migration`.

## Task 9: Provider methods for crawl + social + GBP

**Files:** Modify `research/providers/firecrawl.provider.ts`, `apify.provider.ts` + specs; `budget/research-spend.service.ts` (units).

**Interfaces (follow the EXACT existing conventions — `isConfigured()` gate, throw on real failure, env-var defaults):**
- `FirecrawlProvider.crawl(url, opts: { limit: number }): Promise<Array<{ url: string; markdown: string }>>` — POST `/v1/crawl` (or `/v1/map` + bounded `/v1/scrape`), bounded to `opts.limit` pages.
- `ApifyProvider.runActor(actorSlug: string, input: object): Promise<any[]>` — the generic `run-sync-get-dataset-items` call the two existing methods already do inline; extract it so social/GBP actors reuse it. Add `scrapeSocial(network, handle)` + `scrapeGoogleBusiness(url)` thin wrappers over `runActor` with the actor slugs behind env vars (`APIFY_<NET>_ACTOR`, `APIFY_GBP_ACTOR`).
- New `ResearchSpendService` units: `FIRECRAWL_CRAWL`, `APIFY_SOCIAL`, `APIFY_GBP` (metered only after a successful call, like `dispatchResearchTool`).

- [ ] Per-method: failing test (mocked `fetch`/provider — configured path returns parsed items, unconfigured returns `null`/`[]`, HTTP failure throws) → implement → pass. Commit `feat(brand-brain): provider crawl + social + GBP methods (metered)`.

## Task 10: Source adapters (website / social / gbp / uploads)

**Files:** Create `brand-brain/sources/{website,social,gbp,upload}.source.ts` + specs.

**Interfaces:** each `BrandSource.collect(workspaceId, input): Promise<{ status: 'ok'|'inert'|'error'; raw: unknown; error?: string }>` — never throws (catches, records status), inert when its provider `isConfigured()` is false. Website → `firecrawl.crawl`; social → resolve handles from input OR `social-planner.listAccounts` then `apify.scrapeSocial`; gbp → `apify.scrapeGoogleBusiness`; upload → read the R2 keys (images become BrandKit candidates, docs text-extracted).

- [ ] Per-adapter: failing test (mocked provider, inert-fallback case, error-isolation case) → implement → pass. Commit `feat(brand-brain): source adapters (website/social/gbp/uploads)`.

## Task 11: Synthesis — strict-JSON draft from gathered material

**Files:** Create `brand-brain/brand-synthesis.service.ts` + spec; add `AI_CREDIT_COSTS['brand.analyze']`.

**Interfaces:** `synthesize(workspaceId, sourceResults, defaultLanguage): Promise<BrandAnalysisDraft>` — one bounded Claude call with a strict-JSON schema returning `{ profile: BrandProfilePayload, researchProfile: { icpDescription, businessTypes: string[], geo }, brandKitHints: { palette?, tone?, hashtags?, cta? }, knowledgeDocs: { title, content }[] }`. Metered `creditCost('brand.analyze')` reserve/refund. Malformed output → retry once then throw.

- [ ] Failing test (mocked anthropic returns a valid JSON draft; a malformed first response retries) → implement (mirror the structured-output pattern used elsewhere) → pass. Commit `feat(brand-brain): AI synthesis of the brand draft`.

## Task 12: `BrandAnalysisService` + the `brand-brain.analyze` ScheduledJob

**Files:** Create `brand-brain/brand-analysis.service.ts` + `brand-analysis.runner.ts` + specs; register the handler in `marketing.module.ts` (`onModuleInit`).

**Interfaces:**
- `startAnalysis(workspaceId, inputs): Promise<{ runId: string }>` — creates a `BrandAnalysisRun` (QUEUED), `scheduledJob.schedule({ kind: 'brand-brain.analyze', dedupKey: workspaceId, runAt: now, payload: { runId } })`.
- Runner handler: load the run → RUNNING → run each source adapter (cache `sourceResults`) → `synthesize` → store `draft` → `READY_FOR_REVIEW`. Per-source failure isolated; synthesis failure → `FAILED`. Reuses `ClaimedJob`/`registerHandler` exactly like `research-runner.service.ts`.
- `getRun(workspaceId, runId)` for polling.

- [ ] Failing test (mocked adapters + synthesis; asserts the run transitions QUEUED→…→READY_FOR_REVIEW and caches sourceResults) → implement → pass. Commit `feat(brand-brain): async analysis run + scheduled handler`.

## Task 13: Apply — seed profile + BrandKit + ResearchProfile + KnowledgeDocs (diff-safe)

**Files:** Create `brand-brain/brand-apply.service.ts` + spec; endpoints on the controller.

**Interfaces:** `apply(workspaceId, runId, editedDraft): Promise<void>` — in a transaction: upsert `BrandProfile` (`ACTIVE`, `lastAnalyzedAt`); **seed** `BrandKit` (only fields the user hasn't edited since last apply — compare against current), `ResearchProfile` (create/update the targeting), `Workspace.productName/productDescription/settings.businessTypes` (only if unset or unchanged-by-user); create the `KnowledgeDoc`s (`source='brand-brain'`) + `brandBrain.reindexWorkspace`. Invalidate `BrandContextService`. Route `POST /brand-brain/analyze` (start), `GET /brand-brain/run/:id` (poll), `POST /brand-brain/apply` (MANAGER, settings.manage, @Audit).

- [ ] Failing tests: apply seeds a fresh workspace fully; a re-apply does NOT clobber a user-edited BrandKit field (diff-safe); KnowledgeDocs created + reindex called. Implement → pass + arch. Commit `feat(brand-brain): apply — seed brand kit/research/knowledge (diff-safe)`.

---

# PHASE 3 — First-login wizard + polish

## Task 14: FE analysis API + polling hook

- [ ] Add `startAnalysis(inputs)`, `getRun(id)`, `applyRun(runId, editedDraft)` to `brandBrain.service.ts`; a `useBrandAnalysis` hook that starts a run and polls `getRun` until `READY_FOR_REVIEW`/`FAILED`. Test + tsc. Commit `feat(brand-brain): FE analysis API + polling hook`.

## Task 15: FE — first-login wizard (sources → analyzing → review → apply)

**Files:** Create `brandBrain/BrandBrainWizard.tsx` + `.test.tsx`; a route (e.g. `/brand-brain/setup`); a "Set up with AI" entry on the Brain tab; the GettingStarted step deep-links here.

- [ ] Steps: (1) sources form — website URL, social handles (prefilled from connected accounts), GBP URL, drag-drop uploads (reuse `uploadReferenceImage`'s multipart pattern); (2) analyzing — the polling hook, non-blocking, resumable; (3) review — the draft rendered into the editable Phase-1 editor + proposed ResearchProfile + BrandKit hints, per-field diff on re-analyze; (4) apply → `applyRun`. Tests: wizard renders nothing-missing, submit calls `startAnalysis`, review→apply calls `applyRun` then routes to dashboard. Commit `feat(brand-brain): first-login brand setup wizard`.

## Task 16: Provider-inert + entitlement gating + full regression

- [ ] Confirm every source degrades to manual entry when its provider is unconfigured (a wizard test with `isConfigured()` false shows the manual form + a per-source note). Gate `analyze`/`apply` behind MANAGER + the AI feature; the always-on block stays free. Run the full backend membership/brand specs + `workspace-scoping.arch` + the full FE suite. Migration round-trips re-verified. Commit `test(brand-brain): inert fallbacks + gating + full-suite regression`.

---

## Self-review notes (coverage vs spec)

- §1 data model + migration → Tasks 1, 8. §2 extraction pipeline → Tasks 9–12. §3 wizard + trigger → Tasks 7 (getting-started), 15. §4 AI consumption wiring → Tasks 3–6 (always-on block into all five surfaces) + Task 13 (research targeting seeding) + FTS deep-retrieval is automatic (brand docs are KnowledgeDocs). §5 cost/error/security/testing → per-task TDD + Tasks 11–13 (metered), 16 (inert/gating/regression). Owns-vs-seeds rule → Task 13's diff-safe seeding. Phasing 1/2/3 → the three plan sections. No spec section is left without a task.
