# AI Social Content Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI Social Content Studio that generates on-brand images/videos (via fal.ai), stores them durably, and drives a goal/cadence-aware Social Campaign engine that plans, generates, approves, and auto-publishes social posts — cross-linked to blast campaigns and Meta ads.

**Architecture:** A new media-generation layer (`MediaProvider` → `FalProvider`, `MediaGenService`) reserves credits, submits to fal.ai's queue, polls/finalizes via the existing `ScheduledJob` runner, and re-hosts results to R2; a `BrandKit` per workspace conditions generations. A `SocialCampaign` engine (service + scheduled-job handlers) plans calendar items per cadence, generates copy+media, and gates publishing through automation modes and a brand-safety check, reusing the existing Social Planner publish path. A thin cross-link service provisions companion social campaigns from blasts and pushes generated assets to Meta ad creatives.

**Tech Stack:** NestJS 11 / Express 5 backend (Prisma/PostgreSQL, Node 24 `fetch`), React + react-query + Vite frontend, Tailwind UI kit, fal.ai media models, Cloudflare R2 storage, Anthropic for copy + brand-safety.

## Global Constraints
- NestJS 11 / Express 5 (Express-5 `req.params` gotcha applies).
- Prisma reversible up/down migrations honored via the project's real convention: forward-only `migration.sql` per folder, additive + nullable + backward-compatible, with an explicit manual rollback (`down.sql` or a commented `ROLLBACK` block) that drops exactly what the up added.
- No BullMQ — use the existing `ScheduledJob` queue (`ScheduledJobService.schedule` / `ScheduledJobRunnerService.registerHandler` + `JobRescheduleDirective`).
- Reuse the existing R2 storage service for all media (no new bucket/client).
- fal.ai is hidden behind the `MediaProvider` abstraction (`FalProvider`); nothing else talks to fal directly.
- Credits follow reserve → reconcile → refund: reserve an estimate at submit, reconcile to actual on READY, refund on FAILED/BLOCKED.
- `FAL_KEY`-absent ⇒ media generation is inert (provider `isConfigured()` false; endpoints 503).
- Gate features with `@RequiresFeature` flags (`mediaGen`, `socialCampaigns`) plus `MANAGER` role and `campaigns.send` RBAC.
- NO Claude/AI trailer in commits, PRs, or branch names — plain conventional commits, user identity only.
- i18n TR/EN parity for every new key (`aiStudio.*`, `brandKit.*`, `socialCampaign.*`, `social.composer.*`, `nav.*`).
- Default video cap 10s (`MEDIA_GEN_MAX_VIDEO_SEC`).
- `dailyPublishCap` default 2.
- `MEDIA_GEN_MAX_INFLIGHT` default 4.

## File Structure

**Milestone 1 — Core backend (media generation engine)**
- `backend/src/modules/marketing/ai/media/media-asset.constants.ts` — asset type/status vocabularies + terminal-status helpers (Task 1)
- `backend/prisma/schema.prisma` (+`migrations/20260630120000_ai_media_assets/`) — `BrandKit` + `GeneratedAsset` models + forward/rollback migration (Task 2)
- `backend/src/modules/marketing/ai/media/media-models.config.ts` — fal model catalog, prices, credit/USD estimators (Task 3)
- `backend/src/modules/marketing/ai/ai-credit-costs.ts` — `media.image.generate` / `media.video.generate` credit rows (Task 4)
- `backend/src/modules/marketing/ai/providers/media-provider.interface.ts` + `fal.provider.ts` — provider abstraction + fal queue client (Task 5)
- `backend/src/modules/marketing/ai/media/media-gen.service.ts` — request/finalize/poll/sweep + read/regen/delete/webhook (Tasks 6, 7, 8, 10)
- `backend/src/modules/marketing/ai/media/brand-kit.service.ts` — Brand Kit get/upsert + reference-image upload (Task 9)
- `backend/src/modules/marketing/controllers/marketing-media.controller.ts` + `marketing-media-webhook.controller.ts` — media + brand-kit REST + fal webhook (Task 10)
- `backend/src/modules/billing/entitlements.service.ts` + `prisma/seed-packages.ts` — `mediaGen` feature flag (Task 10)

**Milestone 2 — AI Content Studio frontend**
- `frontend/src/features/marketing/api/media.service.ts` — typed media API client (Task 11)
- `frontend/src/features/marketing/api/brandKit.service.ts` — typed Brand Kit API client (Task 12)
- `frontend/src/pages/marketing/social/AiStudioPage.tsx` — generation panel + live-polling cards + asset library; route/nav (Task 13)
- `frontend/src/pages/marketing/social/PostComposerDialog.tsx` + `SocialPlannerPage.tsx` — composer "AI ile Üret" Sheet + `seedMedia` hand-off (Task 14)
- `frontend/src/pages/marketing/BrandKitPage.tsx` — Brand Kit settings page; route/nav (Task 15)
- `frontend/src/i18n/locales/{en,tr}/marketing.json` — `aiStudio.*` / `brandKit.*` / `social.composer.*` keys (Task 16)

**Milestone 3 — Social Campaign engine backend**
- `backend/src/modules/billing/entitlements.service.ts` + `prisma/seed-packages.ts` — `socialCampaigns` feature flag (Task 17)
- `backend/prisma/schema.prisma` (+`migrations/20260630120000_social_campaign_engine/`) — `SocialCampaign`/`SocialCampaignItem` models, enums, `SocialPost` columns, `GeneratedAsset` relation (Task 18)
- `backend/src/modules/marketing/social-campaigns/cadence.util.ts` — `nextCadenceSlot` helper (Task 19)
- `backend/src/modules/marketing/social-campaigns/social-campaigns.service.ts` — CRUD/lifecycle/plan-confirm + planner/generate/confirm handlers (Tasks 20, 21, 22)
- `backend/src/modules/marketing/social-campaigns/social-campaigns.controller.ts` — REST surface behind `socialCampaigns` gate (Task 23)

**Milestone 4 — Social Campaign engine frontend**
- `frontend/src/components/ui/Stepper.tsx` — accessible wizard primitive (Task 24)
- `frontend/src/features/marketing/api/socialCampaigns.service.ts` — typed campaign API client (Task 25)
- `frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.tsx` — campaign list page (Task 26)
- `frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.tsx` — stepped builder wizard (Task 27)
- `frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.tsx` — content-calendar view (Task 28)
- `frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.tsx` + `SocialCampaignDetailPage.tsx` — approval queue + detail page (Task 29)
- `frontend/src/pages/marketing/campaigns/CampaignDetailDialog.tsx` + `CampaignsPage.tsx` — blast detail dialog + cross-link (Task 30)
- `frontend/src/App.tsx` + `features/marketing/navigation.ts` — lazy routes + left-nav (Task 31)
- `frontend/src/i18n/locales/{en,tr}/marketing.json` — `socialCampaign.*` + `nav.socialCampaigns` keys (Task 32)

**Milestone 5 — Cross-linkage (campaigns ↔ social ↔ ads)**
- `backend/prisma/schema.prisma` (+`migrations/20260630120000_campaign_social_campaign_id/`) — nullable `Campaign.socialCampaignId` (Task 33)
- `backend/src/modules/marketing/social-campaigns/social-campaign-link.service.ts` — provision-from-blast + push-asset-to-Meta-ad (Tasks 34, 38)
- `backend/src/modules/marketing/controllers/marketing-campaigns.controller.ts` — `POST /campaigns/:id/social` (Task 35)
- `backend/src/modules/marketing/ads/meta-ads-management.client.ts` — Meta `uploadAdImage` + `createAdCreative` (Task 36)
- `backend/src/modules/marketing/ads/ad-management.service.ts` — `pushImageCreative` (Task 37)
- `backend/src/modules/marketing/controllers/marketing-ads.controller.ts` — `POST /ads/accounts/:id/creatives/from-asset` (Task 38)
- `frontend/src/features/marketing/api/social-link.service.ts` — typed FE api for provisioning + creative push (Task 39)
- `frontend/src/pages/marketing/CampaignsPage.tsx` — "Create social content" action (Task 40)
- `frontend/src/pages/marketing/social/SendToMetaAdDialog.tsx` — send-to-Meta-ad dialog (Task 41)

---

## Milestone 1: Core Backend — Media Generation Engine

### Task 1: Asset type/status value vocabularies (constants + union types)

**Files:**
- Create: `backend/src/modules/marketing/ai/media/media-asset.constants.ts`
- Test: `backend/src/modules/marketing/ai/media/media-asset.constants.spec.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `export const GENERATED_ASSET_TYPES = ['IMAGE','VIDEO'] as const; export type GeneratedAssetType = (typeof GENERATED_ASSET_TYPES)[number];`
  - `export const GENERATED_ASSET_STATUSES = ['QUEUED','GENERATING','READY','FAILED','BLOCKED'] as const; export type GeneratedAssetStatus = (typeof GENERATED_ASSET_STATUSES)[number];`
  - `export const TERMINAL_ASSET_STATUSES: ReadonlySet<GeneratedAssetStatus>` = {READY, FAILED, BLOCKED}
  - `export function isTerminalAssetStatus(s: string): boolean`

> NOTE (codebase grounding): this project has **zero Prisma `enum` blocks** — every status field is a `String` column with a `//`-comment value list (e.g. `SocialPost.status String @default("DRAFT") // DRAFT|SCHEDULED|...`). So the milestone's "new enums" are modeled the codebase's real way: `String` DB columns + these TS `as const` vocabularies, validated at the app layer. This is the deliberate, grounded deviation from the word "enum."

- [ ] **Step 1: Write the failing test** — real code:
```ts
import {
  GENERATED_ASSET_TYPES,
  GENERATED_ASSET_STATUSES,
  TERMINAL_ASSET_STATUSES,
  isTerminalAssetStatus,
} from './media-asset.constants';

describe('media-asset constants', () => {
  it('pins the asset type + status vocabularies', () => {
    expect([...GENERATED_ASSET_TYPES]).toEqual(['IMAGE', 'VIDEO']);
    expect([...GENERATED_ASSET_STATUSES]).toEqual([
      'QUEUED', 'GENERATING', 'READY', 'FAILED', 'BLOCKED',
    ]);
  });

  it('treats READY/FAILED/BLOCKED as terminal, QUEUED/GENERATING as not', () => {
    expect([...TERMINAL_ASSET_STATUSES].sort()).toEqual(['BLOCKED', 'FAILED', 'READY']);
    expect(isTerminalAssetStatus('READY')).toBe(true);
    expect(isTerminalAssetStatus('BLOCKED')).toBe(true);
    expect(isTerminalAssetStatus('GENERATING')).toBe(false);
    expect(isTerminalAssetStatus('QUEUED')).toBe(false);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/media-asset.constants.spec.ts` (from `backend/`). Fails: `Cannot find module './media-asset.constants'`.
- [ ] **Step 3: Implement** — real code:
```ts
export const GENERATED_ASSET_TYPES = ['IMAGE', 'VIDEO'] as const;
export type GeneratedAssetType = (typeof GENERATED_ASSET_TYPES)[number];

export const GENERATED_ASSET_STATUSES = [
  'QUEUED', 'GENERATING', 'READY', 'FAILED', 'BLOCKED',
] as const;
export type GeneratedAssetStatus = (typeof GENERATED_ASSET_STATUSES)[number];

export const TERMINAL_ASSET_STATUSES: ReadonlySet<GeneratedAssetStatus> = new Set([
  'READY', 'FAILED', 'BLOCKED',
]);

export function isTerminalAssetStatus(s: string): boolean {
  return TERMINAL_ASSET_STATUSES.has(s as GeneratedAssetStatus);
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/media-asset.constants.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): asset type/status vocabularies for AI content studio"`

---

### Task 2: Prisma `BrandKit` + `GeneratedAsset` models + forward migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260630120000_ai_media_assets/migration.sql`
- Create: `backend/prisma/migrations/20260630120000_ai_media_assets/down.sql`
- Test: `backend/src/modules/marketing/ai/media/generated-asset.model.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `BrandKit`, `GeneratedAsset` → generated client accessors `prisma.brandKit`, `prisma.generatedAsset`, and `Prisma.ModelName.BrandKit` / `Prisma.ModelName.GeneratedAsset`. Fields later tasks read/write: `GeneratedAsset { id, workspaceId, type, status, provider, model, providerRequestId, prompt, negativePrompt, params, url, r2Key, mime, width, height, durationSec, thumbnailUrl, thumbnailR2Key, costCredits, costCreditsReserved, costUsd, error, socialCampaignId, createdById }`.

> `socialCampaignId` is a **plain nullable `String` column now** — the `SocialCampaign` model does not exist until Milestone 3, so NO `@relation` is declared here; the relation is wired in Milestone 3 (Task 18). Stated explicitly so no FK constraint is emitted prematurely.

- [ ] **Step 1: Write the failing test** — real code (asserts the generated client knows the models; uses `Prisma.ModelName`, available after `prisma generate`):
```ts
import { Prisma } from '@prisma/client';

describe('AI media Prisma models', () => {
  it('exposes BrandKit and GeneratedAsset on the generated client', () => {
    expect(Prisma.ModelName.BrandKit).toBe('BrandKit');
    expect(Prisma.ModelName.GeneratedAsset).toBe('GeneratedAsset');
  });

  it('GeneratedAsset carries the credit-reconcile + idempotency fields', () => {
    const fields = Prisma.dmmf.datamodel.models
      .find((m) => m.name === 'GeneratedAsset')!
      .fields.map((f) => f.name);
    for (const f of [
      'providerRequestId', 'costCreditsReserved', 'costCredits',
      'r2Key', 'socialCampaignId', 'status', 'type',
    ]) {
      expect(fields).toContain(f);
    }
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/generated-asset.model.spec.ts`. Fails: `Prisma.ModelName.BrandKit` is `undefined` (`.toBe('BrandKit')` fails) and `find(...)` returns `undefined`.
- [ ] **Step 3: Implement** — append to `backend/prisma/schema.prisma` (after the `SocialPostTarget` block):
```prisma
/// One Brand Kit per workspace — logo, palette, tone, 3–5 reference images,
/// reused as conditioning across AI media generations (AI Content Studio).
model BrandKit {
  id              String   @id @default(uuid())
  workspaceId     String   @unique
  logoUrl         String?
  logoR2Key       String?
  /// Array of hex color strings.
  palette         Json?
  tone            String?  @db.Text
  /// [{ url, r2Key, mime }] — 3–5 reference images (R2).
  referenceImages Json     @default("[]")
  defaultHashtags String[]
  defaultCta      String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("brand_kits")
}

/// A single AI-generated media asset (image or video) and its generation
/// lifecycle. status: QUEUED|GENERATING|READY|FAILED|BLOCKED. fal result URLs
/// are re-hosted to R2 on READY; `r2Key` is the canonical store.
model GeneratedAsset {
  id                  String   @id @default(uuid())
  workspaceId         String
  type                String   // IMAGE | VIDEO
  status              String   @default("QUEUED") // QUEUED|GENERATING|READY|FAILED|BLOCKED
  provider            String   // e.g. "fal"
  model               String   // provider model id
  providerRequestId   String?  // idempotency key for webhook/poll convergence
  prompt              String   @db.Text
  negativePrompt      String?
  /// aspectRatio, durationSec, seed, referenceImageUrls, count, etc.
  params              Json     @default("{}")
  url                 String?
  r2Key               String?
  mime                String?
  width               Int?
  height              Int?
  durationSec         Float?
  thumbnailUrl        String?
  thumbnailR2Key      String?
  costCredits         Int?     // reconciled actual
  costCreditsReserved Int?     // estimate reserved at submit (for refund/reconcile)
  costUsd             Decimal? @db.Decimal(10, 4)
  error               String?
  /// Plain nullable column now; SocialCampaign relation wired in Milestone 3.
  socialCampaignId    String?
  createdById         String
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([workspaceId, status])
  @@index([providerRequestId])
  @@map("generated_assets")
}
```
`migration.sql` (forward-only, the project's real Prisma-migrate convention; additive, safe on populated DBs):
```sql
-- AI Social Content Studio (Milestone 1): Brand Kit + generated media assets.
-- Additive only; no changes to existing tables.
CREATE TABLE "brand_kits" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "logoR2Key" TEXT,
    "palette" JSONB,
    "tone" TEXT,
    "referenceImages" JSONB NOT NULL DEFAULT '[]',
    "defaultHashtags" TEXT[],
    "defaultCta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_kits_workspaceId_key" ON "brand_kits"("workspaceId");

CREATE TABLE "generated_assets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "url" TEXT,
    "r2Key" TEXT,
    "mime" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "thumbnailUrl" TEXT,
    "thumbnailR2Key" TEXT,
    "costCredits" INTEGER,
    "costCreditsReserved" INTEGER,
    "costUsd" DECIMAL(10,4),
    "error" TEXT,
    "socialCampaignId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "generated_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "generated_assets_workspaceId_status_idx" ON "generated_assets"("workspaceId", "status");
CREATE INDEX "generated_assets_providerRequestId_idx" ON "generated_assets"("providerRequestId");
```
`down.sql` (companion rollback — honors the global reversible-migration rule; `prisma migrate deploy` applies only `migration.sql`, so this extra file is inert to the tool but gives an exact, tightly-scoped manual revert that drops only what the up added and touches no user data):
```sql
-- Manual rollback for 20260630120000_ai_media_assets (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created.
DROP TABLE IF EXISTS "generated_assets";
DROP TABLE IF EXISTS "brand_kits";
```
Then regenerate the client: `npx prisma generate` (from `backend/`).
- [ ] **Step 4: Run test, expect PASS** — `npx prisma generate && npm test -- src/modules/marketing/ai/media/generated-asset.model.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): BrandKit + GeneratedAsset models and migration"`

---

### Task 3: `media-models.config.ts` — fal model map, prices, credit estimate

**Files:**
- Create: `backend/src/modules/marketing/ai/media/media-models.config.ts`
- Test: `backend/src/modules/marketing/ai/media/media-models.config.spec.ts`

**Interfaces:**
- Consumes: `GeneratedAssetType` from `media-asset.constants` (Task 1).
- Produces:
  - `export interface MediaModel { id: string; type: GeneratedAssetType; label: string; priceUsd?: number; pricePerSecUsd?: number; credits?: number; creditsPerSec?: number; }`
  - `export const MEDIA_MODELS: Record<string, MediaModel>`
  - `export const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4'; export const DEFAULT_VIDEO_MODEL = 'fal-ai/kling-video/v2.1/standard';`
  - `export function getMediaModel(id: string): MediaModel | undefined`
  - `export function estimateMediaCredits(modelId: string, durationSec?: number): number` (image → `credits`; video → `ceil(creditsPerSec × durationSec)`)
  - `export function estimateMediaUsd(modelId: string, durationSec?: number): number`

- [ ] **Step 1: Write the failing test** — real code:
```ts
import {
  MEDIA_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  getMediaModel,
  estimateMediaCredits,
  estimateMediaUsd,
} from './media-models.config';

describe('media-models config', () => {
  it('registers the spec default image + video models', () => {
    expect(getMediaModel(DEFAULT_IMAGE_MODEL)?.type).toBe('IMAGE');
    expect(getMediaModel(DEFAULT_VIDEO_MODEL)?.type).toBe('VIDEO');
    expect(MEDIA_MODELS['fal-ai/bytedance/seedance/v1/pro'].type).toBe('VIDEO');
  });

  it('estimates image credits as a flat per-image cost', () => {
    expect(estimateMediaCredits(DEFAULT_IMAGE_MODEL)).toBe(
      MEDIA_MODELS[DEFAULT_IMAGE_MODEL].credits,
    );
  });

  it('estimates video credits as ceil(creditsPerSec * duration)', () => {
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(estimateMediaCredits(DEFAULT_VIDEO_MODEL, 5)).toBe(
      Math.ceil((m.creditsPerSec ?? 0) * 5),
    );
  });

  it('estimates USD for video as pricePerSec * duration (bookkeeping)', () => {
    const m = MEDIA_MODELS[DEFAULT_VIDEO_MODEL];
    expect(estimateMediaUsd(DEFAULT_VIDEO_MODEL, 5)).toBeCloseTo((m.pricePerSecUsd ?? 0) * 5, 6);
  });

  it('falls back to a safe non-zero estimate for an unknown model', () => {
    expect(estimateMediaCredits('fal-ai/unknown')).toBeGreaterThan(0);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/media-models.config.spec.ts`. Fails: cannot find module.
- [ ] **Step 3: Implement** — real code:
```ts
import { GeneratedAssetType } from './media-asset.constants';

export interface MediaModel {
  id: string;
  type: GeneratedAssetType;
  label: string;
  /** Flat USD per image (image models). */
  priceUsd?: number;
  /** USD per second (video models). */
  pricePerSecUsd?: number;
  /** Flat credits per image (image models). */
  credits?: number;
  /** Credits per second (video models). */
  creditsPerSec?: number;
}

export const DEFAULT_IMAGE_MODEL = 'fal-ai/bytedance/seedream/v4';
export const DEFAULT_VIDEO_MODEL = 'fal-ai/kling-video/v2.1/standard';

/**
 * fal.ai model catalog (verified at implementation time). Credits are the
 * customer-facing meter; prices are USD bookkeeping. ~1 credit ≈ $0.01 of
 * generation spend, rounded up so we never under-charge.
 */
export const MEDIA_MODELS: Record<string, MediaModel> = {
  'fal-ai/qwen-image': { id: 'fal-ai/qwen-image', type: 'IMAGE', label: 'Draft image', priceUsd: 0.02, credits: 2 },
  'fal-ai/bytedance/seedream/v4': { id: 'fal-ai/bytedance/seedream/v4', type: 'IMAGE', label: 'Final image', priceUsd: 0.03, credits: 3 },
  'fal-ai/kling-video/v2.1/standard': { id: 'fal-ai/kling-video/v2.1/standard', type: 'VIDEO', label: 'Short video', pricePerSecUsd: 0.025, creditsPerSec: 3 },
  'fal-ai/bytedance/seedance/v1/pro': { id: 'fal-ai/bytedance/seedance/v1/pro', type: 'VIDEO', label: 'Premium video', pricePerSecUsd: 0.15, creditsPerSec: 15 },
  'fal-ai/veo3/fast': { id: 'fal-ai/veo3/fast', type: 'VIDEO', label: 'Video + audio', pricePerSecUsd: 0.25, creditsPerSec: 25 },
};

const FALLBACK_IMAGE_CREDITS = 3;

export function getMediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS[id];
}

export function estimateMediaCredits(modelId: string, durationSec?: number): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return FALLBACK_IMAGE_CREDITS;
  if (m.type === 'VIDEO') {
    const secs = Math.max(1, durationSec ?? 5);
    return Math.max(1, Math.ceil((m.creditsPerSec ?? 0) * secs));
  }
  return Math.max(1, m.credits ?? FALLBACK_IMAGE_CREDITS);
}

export function estimateMediaUsd(modelId: string, durationSec?: number): number {
  const m = MEDIA_MODELS[modelId];
  if (!m) return 0;
  if (m.type === 'VIDEO') return (m.pricePerSecUsd ?? 0) * Math.max(1, durationSec ?? 5);
  return m.priceUsd ?? 0;
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/media-models.config.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): fal model catalog with prices and credit estimator"`

---

### Task 4: Credit-cost rows `media.image.generate` / `media.video.generate`

**Files:**
- Modify: `backend/src/modules/marketing/ai/ai-credit-costs.ts`
- Modify: `backend/src/modules/marketing/ai/ai-credit-costs.tripwire.spec.ts`

**Interfaces:**
- Consumes: existing `AI_CREDIT_COSTS`, `creditCost`, `tierFor` (recon §2).
- Produces: two new metered actions `'media.image.generate'` and `'media.video.generate'` on `AI_CREDIT_COSTS` (so `AiAction` includes them and the per-model estimate has a registered floor + tripwire coverage).

- [ ] **Step 1: Write the failing test** — extend the tripwire spec. Replace the pinned key array and add an assertion:
```ts
// in the "pins the metered AI actions" test, the sorted array becomes:
expect(Object.keys(AI_CREDIT_COSTS).sort()).toEqual([
  'ask_ai.question',
  'content.compose',
  'conversation.followup',
  'conversation.reply',
  'funnel.draft',
  'media.image.generate',
  'media.video.generate',
  'review.reply_draft',
  'voice.turn',
  'workflow.ai_classify',
  'workflow.ai_generate',
  'workflow.draft',
]);

// new test:
it('prices media generation as a positive default-tier floor', () => {
  expect(creditCost('media.image.generate')).toBeGreaterThan(0);
  expect(creditCost('media.video.generate')).toBeGreaterThan(0);
  expect(tierFor('media.image.generate')).toBe('default');
  expect(tierFor('media.video.generate')).toBe('default');
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/ai-credit-costs.tripwire.spec.ts`. Fails: keys array mismatch + `creditCost('media.image.generate')` is a TS error / `undefined`.
- [ ] **Step 3: Implement** — add two rows to `AI_CREDIT_COSTS` in `ai-credit-costs.ts`:
```ts
  'voice.turn': { credits: 2, tier: 'default' as AiModelTier },
  // AI Social Content Studio — per-model estimate (media-models.config) governs
  // the reserve; these are the registered floor + tripwire-pinned cost decision.
  'media.image.generate': { credits: 3, tier: 'default' as AiModelTier },
  'media.video.generate': { credits: 15, tier: 'default' as AiModelTier },
} as const;
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/ai-credit-costs.tripwire.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): register media.image/video.generate credit costs"`

---

### Task 5: `MediaProvider` interface + `FalProvider` (submit / getResult, BLOCKED mapping)

**Files:**
- Create: `backend/src/modules/marketing/ai/providers/media-provider.interface.ts`
- Create: `backend/src/modules/marketing/ai/providers/fal.provider.ts`
- Test: `backend/src/modules/marketing/ai/providers/fal.provider.spec.ts`

**Interfaces:**
- Consumes: nothing external (uses global `fetch`, Node 24).
- Produces:
  - `media-provider.interface.ts`:
    ```ts
    export interface MediaGenSubmit { type: 'IMAGE'|'VIDEO'; model: string; prompt: string; negativePrompt?: string; aspectRatio?: string; durationSec?: number; referenceImageUrls?: string[]; seed?: number; webhookUrl?: string; }
    export interface MediaGenOutput { url: string; mime: string; width?: number; height?: number; durationSec?: number; }
    export type MediaGenStatus = 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED'|'FAILED'|'BLOCKED';
    export interface MediaGenResult { status: MediaGenStatus; outputs?: MediaGenOutput[]; error?: string; }
    export interface MediaProvider { readonly name: string; isConfigured(): boolean; submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }>; getResult(requestId: string, model: string): Promise<MediaGenResult>; }
    export const MEDIA_PROVIDER = 'MEDIA_PROVIDER';
    ```
  - `FalProvider implements MediaProvider` (injectable, `name='fal'`).

> Deviation from the spec's `getResult(requestId)`: fal's queue REST API addresses results **per-model** (`/{model}/requests/{id}`), so `getResult` takes `(requestId, model)`. `GeneratedAsset.model` is persisted, so the poll handler/webhook always have it.

- [ ] **Step 1: Write the failing test** — real code (mocks global `fetch`):
```ts
import { FalProvider } from './fal.provider';

describe('FalProvider', () => {
  const OLD = process.env.FAL_KEY;
  let provider: FalProvider;
  beforeEach(() => { process.env.FAL_KEY = 'fal-test-key'; provider = new FalProvider(); });
  afterEach(() => { process.env.FAL_KEY = OLD; jest.restoreAllMocks(); });

  it('is inert when FAL_KEY is absent', () => {
    delete process.env.FAL_KEY;
    expect(new FalProvider().isConfigured()).toBe(false);
  });

  it('submits to the fal queue and returns the request id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ request_id: 'req-123' }),
    } as any);
    const res = await provider.submit({
      type: 'IMAGE', model: 'fal-ai/qwen-image', prompt: 'a cat',
      webhookUrl: 'https://app/hook',
    });
    expect(res.providerRequestId).toBe('req-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://queue.fal.run/fal-ai/qwen-image?fal_webhook=https%3A%2F%2Fapp%2Fhook');
    expect((init as any).headers.Authorization).toBe('Key fal-test-key');
  });

  it('maps COMPLETED image output (content_type → mime, dims)', async () => {
    jest.spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        images: [{ url: 'https://fal/out.png', content_type: 'image/png', width: 1024, height: 1024 }],
      }) } as any);
    const r = await provider.getResult('req-1', 'fal-ai/qwen-image');
    expect(r.status).toBe('COMPLETED');
    expect(r.outputs).toEqual([{ url: 'https://fal/out.png', mime: 'image/png', width: 1024, height: 1024, durationSec: undefined }]);
  });

  it('maps IN_PROGRESS through unchanged', async () => {
    jest.spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }) } as any);
    expect((await provider.getResult('req-1', 'm')).status).toBe('IN_PROGRESS');
  });

  it('maps a content-policy error to BLOCKED, not FAILED', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 422,
      json: async () => ({ detail: 'NSFW content detected by safety checker' }),
    } as any);
    const r = await provider.getResult('req-1', 'm');
    expect(r.status).toBe('BLOCKED');
    expect(r.error).toMatch(/NSFW/i);
  });

  it('maps a generic provider error to FAILED', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 500, json: async () => ({ detail: 'internal error' }),
    } as any);
    expect((await provider.getResult('req-1', 'm')).status).toBe('FAILED');
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/providers/fal.provider.spec.ts`. Fails: cannot find module `./fal.provider`.
- [ ] **Step 3: Implement** — create the interface file (signatures above), then `fal.provider.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import {
  MediaProvider, MediaGenSubmit, MediaGenResult, MediaGenOutput, MediaGenStatus,
} from './media-provider.interface';

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const BLOCK_RE = /nsfw|moderat|content polic|safety|flagged|prohibited/i;

/**
 * fal.ai queue REST provider. Inert until FAL_KEY is set (mirrors R2 fallback).
 * Submit returns a request_id; getResult polls status then fetches the result.
 * Moderation rejections map to BLOCKED (refunded), other errors to FAILED.
 */
@Injectable()
export class FalProvider implements MediaProvider {
  readonly name = 'fal';
  private readonly logger = new Logger(FalProvider.name);

  isConfigured(): boolean {
    return !!process.env.FAL_KEY;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
  }

  async submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }> {
    if (!this.isConfigured()) throw new Error('fal provider is not configured');
    const input: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;
    if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
    if (opts.durationSec) input.duration = opts.durationSec;
    if (opts.referenceImageUrls?.length) input.image_urls = opts.referenceImageUrls;
    if (opts.seed !== undefined) input.seed = opts.seed;

    let url = `${FAL_QUEUE_BASE}/${opts.model}`;
    if (opts.webhookUrl) url += `?fal_webhook=${encodeURIComponent(opts.webhookUrl)}`;

    const res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(input) });
    if (!res.ok) {
      const detail = await this.readDetail(res);
      throw new Error(`fal submit failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { request_id?: string };
    if (!body.request_id) throw new Error('fal submit returned no request_id');
    return { providerRequestId: body.request_id };
  }

  async getResult(requestId: string, model: string): Promise<MediaGenResult> {
    const statusRes = await fetch(
      `${FAL_QUEUE_BASE}/${model}/requests/${requestId}/status`,
      { headers: this.headers() },
    );
    if (!statusRes.ok) return this.errorResult(await this.readDetail(statusRes));

    const statusBody = (await statusRes.json()) as { status?: string };
    const s = statusBody.status;
    if (s === 'IN_QUEUE' || s === 'IN_PROGRESS') return { status: s as MediaGenStatus };
    if (s !== 'COMPLETED') return this.errorResult(s ?? 'unknown fal status');

    const resultRes = await fetch(
      `${FAL_QUEUE_BASE}/${model}/requests/${requestId}`,
      { headers: this.headers() },
    );
    if (!resultRes.ok) return this.errorResult(await this.readDetail(resultRes));
    return { status: 'COMPLETED', outputs: this.mapOutputs(await resultRes.json()) };
  }

  private mapOutputs(body: any): MediaGenOutput[] {
    const out: MediaGenOutput[] = [];
    for (const img of body?.images ?? []) {
      out.push({ url: img.url, mime: img.content_type ?? 'image/png', width: img.width, height: img.height, durationSec: undefined });
    }
    const videos = body?.video ? [body.video] : (body?.videos ?? []);
    for (const v of videos) {
      out.push({ url: v.url, mime: v.content_type ?? 'video/mp4', width: v.width, height: v.height, durationSec: v.duration });
    }
    return out;
  }

  private async readDetail(res: Response): Promise<string> {
    try {
      const b = (await res.json()) as any;
      return typeof b?.detail === 'string' ? b.detail : JSON.stringify(b?.detail ?? b);
    } catch { return `HTTP ${res.status}`; }
  }

  private errorResult(message: string): MediaGenResult {
    return { status: BLOCK_RE.test(message) ? 'BLOCKED' : 'FAILED', error: message };
  }
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/providers/fal.provider.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): MediaProvider abstraction + FalProvider"`

---

### Task 6: `MediaGenService.requestGeneration` (reserve → create → submit → schedule poll, concurrency cap)

**Files:**
- Create: `backend/src/modules/marketing/ai/media/media-gen.service.ts`
- Test: `backend/src/modules/marketing/ai/media/media-gen.service.request.spec.ts`

**Interfaces:**
- Consumes: `AiCreditsService.reserve/refund` (recon §2); `estimateMediaCredits`, `estimateMediaUsd`, `getMediaModel` (Task 3); `MediaProvider.submit/isConfigured` (Task 5); `ScheduledJobService.schedule({workspaceId,kind,runAt,payload,dedupKey,maxAttempts})` (recon §1); `R2StorageService` (recon §3). Constants from Task 1.
- Produces:
  - `export const MEDIA_GEN_POLL_KIND = 'social.media.generate.poll';`
  - `export const MEDIA_GEN_CLEANUP_KIND = 'social.media.cleanup.orphans';`
  - `export interface RequestGenerationDto { type: 'IMAGE'|'VIDEO'; model?: string; prompt: string; negativePrompt?: string; aspectRatio?: string; durationSec?: number; referenceImageUrls?: string[]; seed?: number; createdById: string; socialCampaignId?: string; }`
  - `async requestGeneration(workspaceId: string, dto: RequestGenerationDto): Promise<{ assetId: string }>`

- [ ] **Step 1: Write the failing test** — real code (plain-mock Prisma per recon §7):
```ts
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { MediaGenService, MEDIA_GEN_POLL_KIND } from './media-gen.service';
import { DEFAULT_IMAGE_MODEL } from './media-models.config';

const WS = 'ws-1';
function makeSvc() {
  const prisma: any = {
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: jest.fn().mockReturnValue(true), submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }), getResult: jest.fn() };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true) };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any);
  return { svc, prisma, credits, provider, jobs };
}

describe('MediaGenService.requestGeneration', () => {
  it('rejects when the provider is not configured', async () => {
    const { svc, provider } = makeSvc();
    provider.isConfigured.mockReturnValue(false);
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects over the per-workspace in-flight cap', async () => {
    const { svc, prisma } = makeSvc();
    prisma.generatedAsset.count.mockResolvedValue(4);
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('reserves credits, creates QUEUED, submits, stores requestId, schedules the poll', async () => {
    const { svc, prisma, credits, provider, jobs } = makeSvc();
    const res = await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'a cat', createdById: 'u1' });

    expect(res).toEqual({ assetId: 'asset-1' });
    // reserve BEFORE submit, with the per-model estimate (default image model → 3)
    expect(credits.reserve).toHaveBeenCalledWith(WS, 3);
    expect(prisma.generatedAsset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: WS, status: 'QUEUED', provider: 'fal', model: DEFAULT_IMAGE_MODEL, costCreditsReserved: 3 }),
    }));
    expect(provider.submit).toHaveBeenCalled();
    expect(prisma.generatedAsset.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1' },
      data: expect.objectContaining({ status: 'GENERATING', providerRequestId: 'req-9' }),
    }));
    expect(jobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: MEDIA_GEN_POLL_KIND, workspaceId: WS,
      payload: { assetId: 'asset-1', workspaceId: WS }, dedupKey: 'media-gen-asset-1',
    }));
  });

  it('refunds and marks FAILED when provider.submit throws', async () => {
    const { svc, prisma, credits, provider } = makeSvc();
    provider.submit.mockRejectedValue(new Error('fal 500'));
    await expect(svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'x', createdById: 'u1' })).rejects.toThrow('fal 500');
    expect(credits.refund).toHaveBeenCalledWith(WS, 3);
    expect(prisma.generatedAsset.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asset-1' }, data: expect.objectContaining({ status: 'FAILED' }),
    }));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/media-gen.service.request.spec.ts`. Fails: cannot find module.
- [ ] **Step 3: Implement** — create `media-gen.service.ts` (this task = constructor + `requestGeneration`; `finalizeAsset` + handlers land in Task 7/8, so leave a stub that throws `NotImplemented` is unnecessary — only add what this test needs):
```ts
import { Injectable, Logger, BadRequestException, ServiceUnavailableException, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AiCreditsService } from '../ai-credits.service';
import { ScheduledJobService } from '../../scheduling/scheduled-job.service';
import { R2StorageService } from '../../social-planner/r2-storage.service';
import { MediaProvider, MEDIA_PROVIDER } from '../providers/media-provider.interface';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, getMediaModel, estimateMediaCredits, estimateMediaUsd } from './media-models.config';

export const MEDIA_GEN_POLL_KIND = 'social.media.generate.poll';
export const MEDIA_GEN_CLEANUP_KIND = 'social.media.cleanup.orphans';

const MAX_INFLIGHT = Number(process.env.MEDIA_GEN_MAX_INFLIGHT ?? 4);
const MAX_VIDEO_SEC = Number(process.env.MEDIA_GEN_MAX_VIDEO_SEC ?? 10);
const POLL_DELAY_MS = 20_000;

export interface RequestGenerationDto {
  type: 'IMAGE' | 'VIDEO';
  model?: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  durationSec?: number;
  referenceImageUrls?: string[];
  seed?: number;
  createdById: string;
  socialCampaignId?: string;
}

@Injectable()
export class MediaGenService {
  private readonly logger = new Logger(MediaGenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
    @Inject(MEDIA_PROVIDER) private readonly provider: MediaProvider,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly r2: R2StorageService,
  ) {}

  async requestGeneration(workspaceId: string, dto: RequestGenerationDto): Promise<{ assetId: string }> {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException({ code: 'MEDIA_GEN_NOT_CONFIGURED', message: 'Media generation is not configured' });
    }

    const inflight = await this.prisma.generatedAsset.count({
      where: { workspaceId, status: { in: ['QUEUED', 'GENERATING'] } },
    });
    if (inflight >= MAX_INFLIGHT) {
      throw new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: `Too many running generations (max ${MAX_INFLIGHT})` });
    }

    const model = dto.model ?? (dto.type === 'VIDEO' ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL);
    const durationSec = dto.type === 'VIDEO' ? Math.min(dto.durationSec ?? 5, MAX_VIDEO_SEC) : undefined;
    const estimate = estimateMediaCredits(model, durationSec);

    await this.credits.reserve(workspaceId, estimate);

    const params: Prisma.InputJsonValue = {
      aspectRatio: dto.aspectRatio ?? null,
      durationSec: durationSec ?? null,
      seed: dto.seed ?? null,
      referenceImageUrls: dto.referenceImageUrls ?? [],
    };
    const asset = await this.prisma.generatedAsset.create({
      data: {
        workspaceId,
        type: dto.type,
        status: 'QUEUED',
        provider: this.provider.name,
        model,
        prompt: dto.prompt,
        negativePrompt: dto.negativePrompt ?? null,
        params,
        durationSec: durationSec ?? null,
        costCreditsReserved: estimate,
        costUsd: new Prisma.Decimal(estimateMediaUsd(model, durationSec)),
        socialCampaignId: dto.socialCampaignId ?? null,
        createdById: dto.createdById,
      },
      select: { id: true },
    });

    try {
      const { providerRequestId } = await this.provider.submit({
        type: dto.type,
        model,
        prompt: dto.prompt,
        negativePrompt: dto.negativePrompt,
        aspectRatio: dto.aspectRatio,
        durationSec,
        referenceImageUrls: dto.referenceImageUrls,
        seed: dto.seed,
        webhookUrl: this.webhookUrl(),
      });
      await this.prisma.generatedAsset.update({
        where: { id: asset.id },
        data: { status: 'GENERATING', providerRequestId },
      });
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: MEDIA_GEN_POLL_KIND,
        runAt: new Date(Date.now() + POLL_DELAY_MS),
        payload: { assetId: asset.id, workspaceId },
        dedupKey: `media-gen-${asset.id}`,
        maxAttempts: 30,
      });
    } catch (e: any) {
      await this.credits.refund(workspaceId, estimate);
      await this.prisma.generatedAsset.update({
        where: { id: asset.id },
        data: { status: 'FAILED', error: String(e?.message ?? e) },
      });
      throw e;
    }

    return { assetId: asset.id };
  }

  private webhookUrl(): string | undefined {
    const base = process.env.PUBLIC_BASE_URL;
    const secret = process.env.FAL_WEBHOOK_SECRET;
    if (!base || !secret) return undefined;
    return `${base.replace(/\/+$/, '')}/marketing/ai/media/webhook?token=${encodeURIComponent(secret)}`;
  }
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/media-gen.service.request.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): MediaGenService.requestGeneration with reserve + concurrency cap"`

---

### Task 7: `MediaGenService.finalizeAsset` + poll handler + `OnModuleInit` registration + module wiring

**Files:**
- Modify: `backend/src/modules/marketing/ai/media/media-gen.service.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts`
- Test: `backend/src/modules/marketing/ai/media/media-gen.service.finalize.spec.ts`

**Interfaces:**
- Consumes: `MediaGenResult` (Task 5); `R2StorageService.upload(workspaceId, {mimetype,buffer,size}): Promise<{url,key,mime}>` (recon §3); `AiCreditsService.refund/reserve`; `estimateMediaCredits`; `TERMINAL_ASSET_STATUSES`/`isTerminalAssetStatus` (Task 1); `ScheduledJobRunnerService.registerHandler` (recon §1); `JobRescheduleDirective`.
- Produces:
  - `async finalizeAsset(assetId: string, result: MediaGenResult): Promise<void>` (idempotent, terminal-safe, dedupe via the `notIn terminal` claim; COMPLETED→download+R2+reconcile, BLOCKED/FAILED→refund).
  - `async pollGeneration(assetId: string, workspaceId: string): Promise<void | JobRescheduleDirective>` (registered for `MEDIA_GEN_POLL_KIND`; re-fetches via `provider.getResult`, finalizes on terminal, else reschedules itself).
  - `MediaGenService implements OnModuleInit` registering `MEDIA_GEN_POLL_KIND` (and the orphan sweep kind in Task 8).

- [ ] **Step 1: Write the failing test** — real code:
```ts
import { MediaGenService } from './media-gen.service';

const WS = 'ws-1';
function buf() { return Buffer.from('binary'); }

function makeSvc(asset: any) {
  const prisma: any = {
    generatedAsset: {
      findUnique: jest.fn().mockResolvedValue(asset),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: () => true, submit: jest.fn(), getResult: jest.fn() };
  const jobs = { schedule: jest.fn() };
  const r2 = { isConfigured: () => true, upload: jest.fn().mockResolvedValue({ url: 'https://r2/cat.png', key: 'social/ws-1/x.png', mime: 'image/png' }) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any);
  // stub the server-side download so no real network call
  (svc as any).download = jest.fn().mockResolvedValue({ buffer: buf(), size: 6 });
  return { svc, prisma, credits, provider, r2 };
}

const QUEUED = { id: 'a1', workspaceId: WS, status: 'GENERATING', model: 'fal-ai/qwen-image', costCreditsReserved: 2, params: {}, type: 'IMAGE' };

describe('MediaGenService.finalizeAsset', () => {
  it('COMPLETED → downloads, uploads to R2, sets READY, reconciles credits', async () => {
    const { svc, prisma, r2 } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/cat.png', mime: 'image/png', width: 1024, height: 1024 }] });
    expect(r2.upload).toHaveBeenCalledWith(WS, expect.objectContaining({ mimetype: 'image/png' }));
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', status: { notIn: ['READY', 'FAILED', 'BLOCKED'] } },
      data: expect.objectContaining({ status: 'READY', url: 'https://r2/cat.png', r2Key: 'social/ws-1/x.png', costCredits: 2 }),
    }));
  });

  it('BLOCKED → refunds the reservation, no R2 upload', async () => {
    const { svc, credits, r2, prisma } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'BLOCKED', error: 'NSFW' });
    expect(r2.upload).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledWith(WS, 2);
    expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'BLOCKED', error: 'NSFW' }),
    }));
  });

  it('FAILED → refunds the reservation', async () => {
    const { svc, credits } = makeSvc({ ...QUEUED });
    await svc.finalizeAsset('a1', { status: 'FAILED', error: 'boom' });
    expect(credits.refund).toHaveBeenCalledWith(WS, 2);
  });

  it('is a no-op when the asset is already terminal (idempotent)', async () => {
    const { svc, credits, r2 } = makeSvc({ ...QUEUED, status: 'READY' });
    await svc.finalizeAsset('a1', { status: 'COMPLETED', outputs: [{ url: 'u', mime: 'image/png' }] });
    expect(r2.upload).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('does not double-refund when the claim is lost (count 0)', async () => {
    const { svc, prisma, credits } = makeSvc({ ...QUEUED });
    prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
    await svc.finalizeAsset('a1', { status: 'FAILED', error: 'boom' });
    expect(credits.refund).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/media-gen.service.finalize.spec.ts`. Fails: constructor arity (no `runner` arg) / `finalizeAsset` undefined.
- [ ] **Step 3: Implement** — extend `media-gen.service.ts`: add `OnModuleInit`, inject `ScheduledJobRunnerService`, add `finalizeAsset`, `pollGeneration`, a private `download`, and `reconcile`:
```ts
// add imports
import { OnModuleInit } from '@nestjs/common';
import { ScheduledJobRunnerService, JobRescheduleDirective } from '../../scheduling/scheduled-job-runner.service';
import { MediaGenResult } from '../providers/media-provider.interface';
import { TERMINAL_ASSET_STATUSES, isTerminalAssetStatus } from './media-asset.constants';

const TERMINAL = [...TERMINAL_ASSET_STATUSES]; // ['READY','FAILED','BLOCKED']
const POLL_RETRY_MS = 30_000;

// class now: export class MediaGenService implements OnModuleInit {
//   constructor(..., private readonly runner: ScheduledJobRunnerService) {}

  onModuleInit(): void {
    this.runner.registerHandler(MEDIA_GEN_POLL_KIND, (job) =>
      this.pollGeneration(job.payload.assetId, job.payload.workspaceId));
    // MEDIA_GEN_CLEANUP_KIND registered in Task 8.
  }

  async pollGeneration(assetId: string, _workspaceId: string): Promise<void | JobRescheduleDirective> {
    const asset = await this.prisma.generatedAsset.findUnique({
      where: { id: assetId },
      select: { status: true, model: true, providerRequestId: true },
    });
    if (!asset || isTerminalAssetStatus(asset.status) || !asset.providerRequestId) return;
    const result = await this.provider.getResult(asset.providerRequestId, asset.model);
    if (result.status === 'IN_QUEUE' || result.status === 'IN_PROGRESS') {
      return { reschedule: { runAt: new Date(Date.now() + POLL_RETRY_MS) } };
    }
    await this.finalizeAsset(assetId, result);
  }

  async finalizeAsset(assetId: string, result: MediaGenResult): Promise<void> {
    const asset = await this.prisma.generatedAsset.findUnique({ where: { id: assetId } });
    if (!asset || isTerminalAssetStatus(asset.status)) return; // idempotent / terminal-safe
    const reserved = asset.costCreditsReserved ?? 0;

    if (result.status === 'COMPLETED') {
      const primary = (result.outputs ?? [])[0];
      if (!primary) return this.failTerminal(asset, 'provider returned no output', reserved);
      const dl = await this.download(primary.url);
      const stored = await this.r2.upload(asset.workspaceId, {
        mimetype: primary.mime, buffer: dl.buffer, size: dl.size,
      });
      const actual = estimateMediaCredits(asset.model, primary.durationSec ?? asset.durationSec ?? undefined);
      const claim = await this.prisma.generatedAsset.updateMany({
        where: { id: assetId, status: { notIn: TERMINAL } },
        data: {
          status: 'READY', url: stored.url, r2Key: stored.key, mime: stored.mime,
          width: primary.width ?? null, height: primary.height ?? null,
          durationSec: primary.durationSec ?? asset.durationSec ?? null,
          costCredits: actual, error: null,
        },
      });
      if (claim.count === 1) await this.reconcile(asset.workspaceId, reserved, actual);
      return;
    }

    const status = result.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: assetId, status: { notIn: TERMINAL } },
      data: { status, error: result.error ?? null },
    });
    if (claim.count === 1) await this.credits.refund(asset.workspaceId, reserved);
  }

  private async failTerminal(asset: { id: string; workspaceId: string }, error: string, reserved: number): Promise<void> {
    const claim = await this.prisma.generatedAsset.updateMany({
      where: { id: asset.id, status: { notIn: TERMINAL } },
      data: { status: 'FAILED', error },
    });
    if (claim.count === 1) await this.credits.refund(asset.workspaceId, reserved);
  }

  private async reconcile(workspaceId: string, reserved: number, actual: number): Promise<void> {
    const diff = reserved - actual;
    if (diff > 0) await this.credits.refund(workspaceId, diff);
    else if (diff < 0) await this.credits.reserve(workspaceId, -diff).catch((e) =>
      this.logger.warn(`reconcile top-up failed for ${workspaceId}: ${e?.message ?? e}`));
  }

  /** Download a provider result URL server-side (provider URLs expire). */
  private async download(url: string): Promise<{ buffer: Buffer; size: number }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, size: buffer.length };
  }
```
Then wire into `marketing.module.ts`: add imports near the AI imports block (after line 105/`ContentAiService`), register the provider token + service in `providers`:
```ts
import { MediaGenService } from './ai/media/media-gen.service';
import { FalProvider } from './ai/providers/fal.provider';
import { MEDIA_PROVIDER } from './ai/providers/media-provider.interface';
// ...in providers: [ ... ]
    FalProvider,
    { provide: MEDIA_PROVIDER, useExisting: FalProvider },
    MediaGenService,
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/media-gen.service.finalize.spec.ts && npm test -- src/modules/marketing/ai/media/media-gen.service.request.spec.ts` (both still green; constructor arity changed — the request spec's `makeSvc` must add a `runner` mock arg: update it to `new MediaGenService(prisma, credits, provider, jobs, r2, { registerHandler: jest.fn() } as any)`).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): finalizeAsset (R2 + reconcile + refund) and poll handler"`

---

### Task 8: Orphan-retention sweep handler `social.media.cleanup.orphans`

**Files:**
- Modify: `backend/src/modules/marketing/ai/media/media-gen.service.ts`
- Test: `backend/src/modules/marketing/ai/media/media-gen.service.sweep.spec.ts`

**Interfaces:**
- Consumes: `R2StorageService.deleteKeys(keys: string[])` (recon §3); `ScheduledJobRunnerService.registerHandler` + `JobRescheduleDirective` self-reschedule.
- Produces: `async sweepOrphanAssets(): Promise<{ deleted: number }>` deleting READY-but-unattached (`socialCampaignId IS NULL`) assets older than `MEDIA_GEN_RETENTION_DAYS` (default 30); registers `MEDIA_GEN_CLEANUP_KIND` in `onModuleInit` and self-reschedules daily.

- [ ] **Step 1: Write the failing test** — real code:
```ts
import { MediaGenService, MEDIA_GEN_CLEANUP_KIND } from './media-gen.service';

function makeSvc(rows: any[]) {
  const prisma: any = {
    generatedAsset: {
      findMany: jest.fn().mockResolvedValue(rows),
      deleteMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
  };
  const r2 = { isConfigured: () => true, deleteKeys: jest.fn().mockResolvedValue(undefined) };
  const runner = { registerHandler: jest.fn() };
  const svc = new MediaGenService(prisma, {} as any, { isConfigured: () => true } as any, {} as any, r2 as any, runner as any);
  return { svc, prisma, r2, runner };
}

describe('MediaGenService.sweepOrphanAssets', () => {
  it('deletes R2 keys then the rows for old READY unattached assets', async () => {
    const { svc, prisma, r2 } = makeSvc([
      { id: 'a1', r2Key: 'social/ws/a.png', thumbnailR2Key: null },
      { id: 'a2', r2Key: 'social/ws/b.mp4', thumbnailR2Key: 'social/ws/b.jpg' },
    ]);
    const res = await svc.sweepOrphanAssets();
    expect(prisma.generatedAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'READY', socialCampaignId: null }),
    }));
    expect(r2.deleteKeys).toHaveBeenCalledWith(['social/ws/a.png', 'social/ws/b.mp4', 'social/ws/b.jpg']);
    expect(prisma.generatedAsset.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a1', 'a2'] } } });
    expect(res).toEqual({ deleted: 2 });
  });

  it('registers the cleanup kind on init', () => {
    const { svc, runner } = makeSvc([]);
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(MEDIA_GEN_CLEANUP_KIND, expect.any(Function));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/media-gen.service.sweep.spec.ts`. Fails: `sweepOrphanAssets` undefined / cleanup kind not registered.
- [ ] **Step 3: Implement** — add to `media-gen.service.ts`:
```ts
const RETENTION_DAYS = Number(process.env.MEDIA_GEN_RETENTION_DAYS ?? 30);
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// in onModuleInit(), add:
    this.runner.registerHandler(MEDIA_GEN_CLEANUP_KIND, async () => {
      await this.sweepOrphanAssets();
      return { reschedule: { runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) } };
    });

  /** Remove READY-but-unattached assets older than the retention window
   *  (R2 objects first, then rows). Attached/campaign assets are exempt. */
  async sweepOrphanAssets(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.generatedAsset.findMany({
      where: { status: 'READY', socialCampaignId: null, createdAt: { lt: cutoff } },
      select: { id: true, r2Key: true, thumbnailR2Key: true },
    });
    if (!rows.length) return { deleted: 0 };
    const keys = rows.flatMap((r) => [r.r2Key, r.thumbnailR2Key].filter(Boolean) as string[]);
    await this.r2.deleteKeys(keys);
    await this.prisma.generatedAsset.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return { deleted: rows.length };
  }
```
Schedule the first sweep at startup (idempotent via dedupKey) — append to `onModuleInit`:
```ts
    void this.scheduledJobs.schedule({
      workspaceId: 'system',
      kind: MEDIA_GEN_CLEANUP_KIND,
      runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
      payload: {},
      dedupKey: 'media-gen-orphan-sweep',
    }).catch(() => undefined);
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/media-gen.service.sweep.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): orphan-asset retention sweep handler"`

---

### Task 9: `BrandKitService` (get / upsert + reference-image upload)

**Files:**
- Create: `backend/src/modules/marketing/ai/media/brand-kit.service.ts`
- Test: `backend/src/modules/marketing/ai/media/brand-kit.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService.brandKit` (Task 2); `R2StorageService.upload/isConfigured` (recon §3).
- Produces:
  - `export interface BrandKitPayload { logoUrl?: string|null; logoR2Key?: string|null; palette?: string[]|null; tone?: string|null; referenceImages?: Array<{url:string;r2Key?:string;mime?:string}>; defaultHashtags?: string[]; defaultCta?: string|null; }`
  - `async get(workspaceId: string): Promise<BrandKit | null>`
  - `async upsert(workspaceId: string, dto: BrandKitPayload): Promise<BrandKit>`
  - `async addReferenceImage(workspaceId: string, file: UploadInput): Promise<{ url: string; r2Key: string; mime: string }>` (uploads to R2, appends to `referenceImages`, cap 5).

- [ ] **Step 1: Write the failing test** — real code:
```ts
import { BadRequestException } from '@nestjs/common';
import { BrandKitService } from './brand-kit.service';

const WS = 'ws-1';
function makeSvc(existing: any = null) {
  const prisma: any = {
    brandKit: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockImplementation(({ create, update }) => ({ id: 'bk-1', workspaceId: WS, ...(existing ? update : create) })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'bk-1', workspaceId: WS, ...data })),
    },
  };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true), upload: jest.fn().mockResolvedValue({ url: 'https://r2/ref.png', key: 'social/ws-1/ref.png', mime: 'image/png' }) };
  return { svc: new BrandKitService(prisma, r2 as any), prisma, r2 };
}

describe('BrandKitService', () => {
  it('upserts one kit per workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.upsert(WS, { tone: 'playful', defaultHashtags: ['#x'] });
    expect(prisma.brandKit.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS },
      create: expect.objectContaining({ workspaceId: WS, tone: 'playful' }),
    }));
  });

  it('uploads a reference image to R2 and appends it (cap 5)', async () => {
    const { svc, prisma, r2 } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: [] });
    const res = await svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 });
    expect(r2.upload).toHaveBeenCalledWith(WS, expect.objectContaining({ mimetype: 'image/png' }));
    expect(res).toEqual({ url: 'https://r2/ref.png', r2Key: 'social/ws-1/ref.png', mime: 'image/png' });
    expect(prisma.brandKit.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { referenceImages: [{ url: 'https://r2/ref.png', r2Key: 'social/ws-1/ref.png', mime: 'image/png' }] },
    }));
  });

  it('rejects a 6th reference image', async () => {
    const five = [1,2,3,4,5].map((i) => ({ url: `u${i}`, r2Key: `k${i}`, mime: 'image/png' }));
    const { svc } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: five });
    await expect(svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects upload when R2 is not configured', async () => {
    const { svc, r2 } = makeSvc({ id: 'bk-1', workspaceId: WS, referenceImages: [] });
    r2.isConfigured.mockReturnValue(false);
    await expect(svc.addReferenceImage(WS, { mimetype: 'image/png', buffer: Buffer.from('x'), size: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/ai/media/brand-kit.service.spec.ts`. Fails: cannot find module.
- [ ] **Step 3: Implement** — real code:
```ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { R2StorageService, UploadInput } from '../../social-planner/r2-storage.service';

const MAX_REFERENCE_IMAGES = 5;

export interface ReferenceImage { url: string; r2Key?: string; mime?: string; }
export interface BrandKitPayload {
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette?: string[] | null;
  tone?: string | null;
  referenceImages?: ReferenceImage[];
  defaultHashtags?: string[];
  defaultCta?: string | null;
}

@Injectable()
export class BrandKitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  get(workspaceId: string) {
    return this.prisma.brandKit.findUnique({ where: { workspaceId } });
  }

  upsert(workspaceId: string, dto: BrandKitPayload) {
    const data = {
      logoUrl: dto.logoUrl ?? null,
      logoR2Key: dto.logoR2Key ?? null,
      palette: (dto.palette ?? null) as Prisma.InputJsonValue,
      tone: dto.tone ?? null,
      ...(dto.referenceImages ? { referenceImages: dto.referenceImages as unknown as Prisma.InputJsonValue } : {}),
      ...(dto.defaultHashtags ? { defaultHashtags: dto.defaultHashtags } : {}),
      defaultCta: dto.defaultCta ?? null,
    };
    return this.prisma.brandKit.upsert({
      where: { workspaceId },
      create: { workspaceId, referenceImages: [], defaultHashtags: [], ...data },
      update: data,
    });
  }

  async addReferenceImage(workspaceId: string, file: UploadInput): Promise<ReferenceImage> {
    if (!this.r2.isConfigured()) {
      throw new BadRequestException('Media upload is not configured (set R2_* env).');
    }
    const kit = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
    const existing = ((kit?.referenceImages as unknown as ReferenceImage[]) ?? []);
    if (existing.length >= MAX_REFERENCE_IMAGES) {
      throw new BadRequestException(`At most ${MAX_REFERENCE_IMAGES} reference images allowed`);
    }
    const uploaded = await this.r2.upload(workspaceId, file);
    const ref: ReferenceImage = { url: uploaded.url, r2Key: uploaded.key, mime: uploaded.mime };
    const next = [...existing, ref];
    if (kit) {
      await this.prisma.brandKit.update({ where: { workspaceId }, data: { referenceImages: next as unknown as Prisma.InputJsonValue } });
    } else {
      await this.prisma.brandKit.create({ data: { workspaceId, referenceImages: next as unknown as Prisma.InputJsonValue, defaultHashtags: [] } });
    }
    return ref;
  }
}
```
Add `BrandKitService` to `marketing.module.ts` providers (next to `MediaGenService`).
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/ai/media/brand-kit.service.spec.ts`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): BrandKitService get/upsert + reference-image upload"`

---

### Task 10: Controller endpoints + DTOs + `mediaGen` feature flag + webhook

**Files:**
- Create: `backend/src/modules/marketing/controllers/marketing-media.controller.ts`
- Create: `backend/src/modules/marketing/controllers/marketing-media-webhook.controller.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (register both controllers)
- Modify: `backend/src/modules/billing/entitlements.service.ts` (add `mediaGen` to `FEATURE_KEYS`)
- Modify: `backend/src/modules/billing/entitlements.tripwire.spec.ts` (pin `mediaGen`)
- Modify: `backend/prisma/seed-packages.ts` (add `mediaGen` to every `features` block)
- Add list/get/regenerate/delete to `MediaGenService` (`listAssets`, `getAsset`, `regenerate`, `deleteAsset`, `finalizeByRequestId`)
- Test: `backend/src/modules/marketing/controllers/marketing-media.controller.spec.ts`

**Interfaces:**
- Consumes: `MediaGenService.requestGeneration/finalizeAsset` (Tasks 6–7); `BrandKitService` (Task 9); guards `MarketingGuard, MarketingRolesGuard, PermissionsGuard, FeatureGuard` + `@RequiresFeature` (recon §5); `@CurrentMarketingUser`/`MarketingUserPayload`; `@MarketingRoles('MANAGER')`; `@RequirePermission('campaigns.send')`; `FileInterceptor` (recon §8 controller).
- Produces: REST surface from spec §8 (media + brand-kit); `mediaGen` `FeatureKey`; `MediaGenService.finalizeByRequestId(workspaceId|null, providerRequestId, result)` for webhook idempotency.

- [ ] **Step 1: Write the failing test** — real code (controller with mocked services; verifies routing + webhook token guard + feature gating wiring):
```ts
import { UnauthorizedException } from '@nestjs/common';
import { MarketingMediaController } from './marketing-media.controller';
import { MarketingMediaWebhookController } from './marketing-media-webhook.controller';

const user: any = { workspaceId: 'ws-1', userId: 'u1' };
function makeMedia() {
  const gen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'a1' }), listAssets: jest.fn().mockResolvedValue([]), getAsset: jest.fn().mockResolvedValue({ id: 'a1' }), regenerate: jest.fn().mockResolvedValue({ assetId: 'a2' }), deleteAsset: jest.fn().mockResolvedValue({ deleted: true }) };
  const brand = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 'bk-1' }), addReferenceImage: jest.fn().mockResolvedValue({ url: 'u', r2Key: 'k', mime: 'image/png' }) };
  return { ctrl: new MarketingMediaController(gen as any, brand as any), gen, brand };
}

describe('MarketingMediaController', () => {
  it('POST /generate passes workspace + createdById to the service', async () => {
    const { ctrl, gen } = makeMedia();
    const res = await ctrl.generate({ type: 'IMAGE', prompt: 'a cat' } as any, user);
    expect(res).toEqual({ assetId: 'a1' });
    expect(gen.requestGeneration).toHaveBeenCalledWith('ws-1', expect.objectContaining({ type: 'IMAGE', prompt: 'a cat', createdById: 'u1' }));
  });

  it('GET /generations/:id scopes by workspace', async () => {
    const { ctrl, gen } = makeMedia();
    await ctrl.getOne('a1', user);
    expect(gen.getAsset).toHaveBeenCalledWith('ws-1', 'a1');
  });

  it('PUT /brand-kit upserts', async () => {
    const { ctrl, brand } = makeMedia();
    await ctrl.putBrandKit({ tone: 'x' } as any, user);
    expect(brand.upsert).toHaveBeenCalledWith('ws-1', { tone: 'x' });
  });
});

describe('MarketingMediaWebhookController', () => {
  const OLD = process.env.FAL_WEBHOOK_SECRET;
  afterEach(() => { process.env.FAL_WEBHOOK_SECRET = OLD; });

  it('rejects a wrong token', async () => {
    process.env.FAL_WEBHOOK_SECRET = 'secret';
    const gen = { finalizeByRequestId: jest.fn() };
    const ctrl = new MarketingMediaWebhookController(gen as any);
    await expect(ctrl.receive('nope', { request_id: 'r1', status: 'OK' } as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(gen.finalizeByRequestId).not.toHaveBeenCalled();
  });

  it('maps a fal COMPLETED webhook to finalizeByRequestId', async () => {
    process.env.FAL_WEBHOOK_SECRET = 'secret';
    const gen = { finalizeByRequestId: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new MarketingMediaWebhookController(gen as any);
    const r = await ctrl.receive('secret', { request_id: 'r1', status: 'OK', payload: { images: [{ url: 'u', content_type: 'image/png' }] } } as any);
    expect(r).toEqual({ ok: true });
    expect(gen.finalizeByRequestId).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'COMPLETED' }));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/modules/marketing/controllers/marketing-media.controller.spec.ts`. Fails: controllers don't exist.
- [ ] **Step 3: Implement** —
  (a) Add `mediaGen` to `FEATURE_KEYS` (`entitlements.service.ts`, after `'invoicing'`), pin it in `entitlements.tripwire.spec.ts` (insert `'mediaGen'` into the sorted array between `'invoicing'` and `'reviews'`), and add `mediaGen: <bool>` to **every** `features: { ... }` block in `prisma/seed-packages.ts` (the tripwire requires all keys on all packages — set `false` on the starter package, `true` on paid tiers).
  (b) Add to `MediaGenService` the read/regenerate/delete/webhook helpers:
```ts
  listAssets(workspaceId: string, filter: { type?: string; status?: string; socialCampaignId?: string } = {}) {
    return this.prisma.generatedAsset.findMany({
      where: { workspaceId, ...(filter.type ? { type: filter.type } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.socialCampaignId ? { socialCampaignId: filter.socialCampaignId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }
  async getAsset(workspaceId: string, id: string) {
    const a = await this.prisma.generatedAsset.findFirst({ where: { id, workspaceId } });
    if (!a) throw new NotFoundException('asset not found');
    return a;
  }
  async regenerate(workspaceId: string, id: string, createdById: string) {
    const a = await this.getAsset(workspaceId, id);
    const p = (a.params ?? {}) as any;
    return this.requestGeneration(workspaceId, { type: a.type as 'IMAGE' | 'VIDEO', model: a.model, prompt: a.prompt, negativePrompt: a.negativePrompt ?? undefined, aspectRatio: p.aspectRatio ?? undefined, durationSec: a.durationSec ?? undefined, referenceImageUrls: p.referenceImageUrls ?? undefined, seed: p.seed ?? undefined, createdById, socialCampaignId: a.socialCampaignId ?? undefined });
  }
  async deleteAsset(workspaceId: string, id: string): Promise<{ deleted: boolean }> {
    const a = await this.getAsset(workspaceId, id);
    await this.r2.deleteKeys([a.r2Key, a.thumbnailR2Key].filter(Boolean) as string[]);
    await this.prisma.generatedAsset.delete({ where: { id } });
    return { deleted: true };
  }
  /** Webhook idempotency: resolve the asset by providerRequestId, then finalize. */
  async finalizeByRequestId(providerRequestId: string, result: MediaGenResult): Promise<void> {
    const a = await this.prisma.generatedAsset.findFirst({ where: { providerRequestId }, select: { id: true } });
    if (!a) return; // unknown/duplicate request → ignore
    await this.finalizeAsset(a.id, result);
  }
```
(add `NotFoundException` to the `@nestjs/common` import.)
  (c) `marketing-media.controller.ts` (class-validated inline DTOs, guards mirroring `social-planner.controller.ts` + `FeatureGuard`/`@RequiresFeature('mediaGen')` from recon §5):
```ts
import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize, IsUrl } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { MediaGenService } from '../ai/media/media-gen.service';
import { BrandKitService } from '../ai/media/brand-kit.service';

class GenerateDto {
  @IsIn(['IMAGE', 'VIDEO']) type: 'IMAGE' | 'VIDEO';
  @IsString() @MaxLength(2000) prompt: string;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsOptional() @IsString() @MaxLength(1000) negativePrompt?: string;
  @IsOptional() @IsIn(['1:1', '9:16', '16:9', '4:5']) aspectRatio?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) durationSec?: number;
  @IsOptional() @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(5) referenceImageUrls?: string[];
  @IsOptional() @IsInt() seed?: number;
}
class BrandKitDto {
  @IsOptional() @IsString() @MaxLength(1000) logoUrl?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(12) palette?: string[];
  @IsOptional() @IsString() @MaxLength(2000) tone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) defaultHashtags?: string[];
  @IsOptional() @IsString() @MaxLength(300) defaultCta?: string;
}

@MarketingRoute()
@Controller('marketing')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('mediaGen')
export class MarketingMediaController {
  constructor(private readonly gen: MediaGenService, private readonly brand: BrandKitService) {}

  @Post('ai/media/generate')
  @RequirePermission('campaigns.send')
  generate(@Body() dto: GenerateDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.requestGeneration(u.workspaceId, { ...dto, createdById: u.userId });
  }

  @Get('ai/media/generations')
  list(@Query('type') type: string, @Query('status') status: string, @Query('campaignId') campaignId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.listAssets(u.workspaceId, { type, status, socialCampaignId: campaignId });
  }

  @Get('ai/media/generations/:id')
  getOne(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.getAsset(u.workspaceId, id);
  }

  @Post('ai/media/generations/:id/regenerate')
  @RequirePermission('campaigns.send')
  regenerate(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.regenerate(u.workspaceId, id, u.userId);
  }

  @Delete('ai/media/generations/:id')
  @RequirePermission('campaigns.send')
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.deleteAsset(u.workspaceId, id);
  }

  @Get('brand-kit')
  getBrandKit(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.get(u.workspaceId);
  }

  @Put('brand-kit')
  @RequirePermission('campaigns.send')
  putBrandKit(@Body() dto: BrandKitDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.upsert(u.workspaceId, dto);
  }

  @Post('brand-kit/reference-image')
  @RequirePermission('campaigns.send')
  @UseInterceptors(FileInterceptor('file'))
  addReference(@UploadedFile() file: any, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.addReferenceImage(u.workspaceId, { originalname: file?.originalname, mimetype: file?.mimetype, buffer: file?.buffer, size: file?.size });
  }
}
```
  (d) `marketing-media-webhook.controller.ts` (public, token-guarded, idempotent — pattern from `public-inbound-webhook.controller.ts`):
```ts
import { Body, Controller, Post, Query, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MediaGenService } from '../ai/media/media-gen.service';
import { MediaGenResult } from '../ai/providers/media-provider.interface';

interface FalWebhookBody { request_id?: string; status?: string; payload?: any; error?: string; }

/** Public fal completion callback. Token-guarded via FAL_WEBHOOK_SECRET; the
 *  body is mapped to a MediaGenResult and finalized idempotently by request_id. */
@Controller('marketing/ai/media')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class MarketingMediaWebhookController {
  constructor(private readonly gen: MediaGenService) {}

  @Post('webhook')
  async receive(@Query('token') token: string, @Body() body: FalWebhookBody): Promise<{ ok: true }> {
    const secret = process.env.FAL_WEBHOOK_SECRET;
    if (!secret || token !== secret) throw new UnauthorizedException();
    if (body.request_id) {
      await this.gen.finalizeByRequestId(body.request_id, this.mapBody(body));
    }
    return { ok: true };
  }

  private mapBody(body: FalWebhookBody): MediaGenResult {
    if (body.status && body.status !== 'OK' && body.status !== 'COMPLETED') {
      const msg = body.error ?? 'fal webhook error';
      return { status: /nsfw|moderat|content polic|safety/i.test(msg) ? 'BLOCKED' : 'FAILED', error: msg };
    }
    const out: MediaGenResult['outputs'] = [];
    for (const img of body.payload?.images ?? []) out.push({ url: img.url, mime: img.content_type ?? 'image/png', width: img.width, height: img.height });
    const vids = body.payload?.video ? [body.payload.video] : (body.payload?.videos ?? []);
    for (const v of vids) out.push({ url: v.url, mime: v.content_type ?? 'video/mp4', durationSec: v.duration });
    return { status: 'COMPLETED', outputs: out };
  }
}
```
  (e) Register both controllers in `marketing.module.ts` `controllers: [...]`. The webhook controller must be exempt from `MarketingGuard` — it carries no `@MarketingRoute()`/guards and authenticates via the `token` query param, matching the public-webhook precedent.
- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/modules/marketing/controllers/marketing-media.controller.spec.ts && npm test -- src/modules/billing/entitlements.tripwire.spec.ts`, then full build typecheck: `npm run build`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(media): media + brand-kit endpoints, fal webhook, mediaGen feature flag"`

---

## Milestone 2: AI Content Studio Frontend

### Task 11: `media.service.ts` — typed AI-media API client

**Files:**
- Create: `frontend/src/features/marketing/api/media.service.ts`
- Test: `frontend/src/features/marketing/api/media.service.test.ts`

**Interfaces:**
- Consumes: `marketingApi` default axios instance (`baseURL = ${API_URL}/marketing`), paths relative to `/marketing`. Backend routes from spec §8: `POST /ai/media/generate`, `GET /ai/media/generations`, `GET /ai/media/generations/:id`, `POST /ai/media/generations/:id/regenerate`, `DELETE /ai/media/generations/:id`. Asset shape from §5.3.
- Produces: `GeneratedAsset`, `GeneratedAssetType`, `GeneratedAssetStatus`, `GenerateMediaPayload`, `GenerationFilters`; functions `generateMedia`, `listGenerations`, `getGeneration`, `regenerateMedia`, `deleteGeneration`, `isTerminal`.

- [ ] **Step 1: Write the failing test** — `frontend/src/features/marketing/api/media.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  generateMedia,
  listGenerations,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  isTerminal,
} from './media.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('media.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateMedia POSTs the payload to /ai/media/generate and returns { assetId }', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-1' } });
    const out = await generateMedia({ type: 'IMAGE', prompt: 'a cat', aspectRatio: '1:1' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generate', {
      type: 'IMAGE',
      prompt: 'a cat',
      aspectRatio: '1:1',
    });
    expect(out).toEqual({ assetId: 'a-1' });
  });

  it('listGenerations passes filters as query params', async () => {
    api.get.mockResolvedValue({ data: [] });
    await listGenerations({ type: 'VIDEO', status: 'READY' });
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations', {
      params: { type: 'VIDEO', status: 'READY' },
    });
  });

  it('getGeneration hits the :id status route', async () => {
    api.get.mockResolvedValue({ data: { id: 'a-1', status: 'GENERATING' } });
    const a = await getGeneration('a-1');
    expect(api.get).toHaveBeenCalledWith('/ai/media/generations/a-1');
    expect(a.status).toBe('GENERATING');
  });

  it('regenerateMedia and deleteGeneration use the right verbs/paths', async () => {
    api.post.mockResolvedValue({ data: { assetId: 'a-2' } });
    api.delete.mockResolvedValue({ data: { message: 'ok' } });
    expect(await regenerateMedia('a-1')).toEqual({ assetId: 'a-2' });
    expect(api.post).toHaveBeenCalledWith('/ai/media/generations/a-1/regenerate');
    expect(await deleteGeneration('a-1')).toEqual({ message: 'ok' });
    expect(api.delete).toHaveBeenCalledWith('/ai/media/generations/a-1');
  });

  it('isTerminal is true only for READY/FAILED/BLOCKED', () => {
    expect(isTerminal('READY')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('GENERATING')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — from `frontend/`: `npm test -- src/features/marketing/api/media.service.test.ts`. Fails: `Failed to resolve import "./media.service"` (module does not exist).

- [ ] **Step 3: Implement** — `frontend/src/features/marketing/api/media.service.ts`:
```ts
/**
 * media.service.ts — typed API for AI Content Studio media generation
 * (spec §8). Paths are relative to /marketing.
 */
import marketingApi from './marketingApi';

export type GeneratedAssetType = 'IMAGE' | 'VIDEO';
export type GeneratedAssetStatus = 'QUEUED' | 'GENERATING' | 'READY' | 'FAILED' | 'BLOCKED';

export interface GeneratedAsset {
  id: string;
  type: GeneratedAssetType;
  status: GeneratedAssetStatus;
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string | null;
  params: Record<string, unknown>;
  url?: string | null;
  r2Key?: string | null;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  thumbnailUrl?: string | null;
  costCredits?: number | null;
  error?: string | null;
  socialCampaignId?: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateMediaPayload {
  type: GeneratedAssetType;
  prompt: string;
  model?: string;
  quality?: 'DRAFT' | 'FINAL';
  negativePrompt?: string;
  aspectRatio?: '1:1' | '9:16' | '16:9' | '4:5';
  durationSec?: number;
}

export interface GenerationFilters {
  type?: GeneratedAssetType;
  status?: GeneratedAssetStatus;
  campaignId?: string;
}

export const generateMedia = (p: GenerateMediaPayload): Promise<{ assetId: string }> =>
  marketingApi.post('/ai/media/generate', p).then((r) => r.data);

export const listGenerations = (f: GenerationFilters = {}): Promise<GeneratedAsset[]> =>
  marketingApi.get('/ai/media/generations', { params: f }).then((r) => r.data);

export const getGeneration = (id: string): Promise<GeneratedAsset> =>
  marketingApi.get(`/ai/media/generations/${id}`).then((r) => r.data);

export const regenerateMedia = (id: string): Promise<{ assetId: string }> =>
  marketingApi.post(`/ai/media/generations/${id}/regenerate`).then((r) => r.data);

export const deleteGeneration = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/ai/media/generations/${id}`).then((r) => r.data);

/** Polling stop condition — true once the asset will not change again. */
export const isTerminal = (s: GeneratedAssetStatus): boolean =>
  s === 'READY' || s === 'FAILED' || s === 'BLOCKED';
```

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/features/marketing/api/media.service.test.ts` (5 passing).

- [ ] **Step 5: Commit** —
```
git add frontend/src/features/marketing/api/media.service.ts frontend/src/features/marketing/api/media.service.test.ts
git commit -m "feat(ai-studio): typed media-generation API service"
```

---

### Task 12: `brandKit.service.ts` — typed Brand Kit API client

**Files:**
- Create: `frontend/src/features/marketing/api/brandKit.service.ts`
- Test: `frontend/src/features/marketing/api/brandKit.service.test.ts`

**Interfaces:**
- Consumes: `marketingApi`; routes from §8: `GET /brand-kit`, `PUT /brand-kit`, `POST /brand-kit/reference-image` (multipart). Shape from §5.2.
- Produces: `BrandKit`, `BrandKitMedia`, `BrandKitPayload`; functions `getBrandKit`, `updateBrandKit`, `uploadReferenceImage`.

- [ ] **Step 1: Write the failing test** — `frontend/src/features/marketing/api/brandKit.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

import marketingApi from './marketingApi';
import { getBrandKit, updateBrandKit, uploadReferenceImage } from './brandKit.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

const KIT = {
  id: 'bk-1',
  logoUrl: null,
  logoR2Key: null,
  palette: ['#111111'],
  tone: 'friendly',
  referenceImages: [],
  defaultHashtags: ['#jeeta'],
  defaultCta: 'Book now',
  createdAt: '2026-06-30T00:00:00Z',
  updatedAt: '2026-06-30T00:00:00Z',
};

describe('brandKit.service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getBrandKit GETs /brand-kit', async () => {
    api.get.mockResolvedValue({ data: KIT });
    expect(await getBrandKit()).toEqual(KIT);
    expect(api.get).toHaveBeenCalledWith('/brand-kit');
  });

  it('updateBrandKit PUTs the payload', async () => {
    api.put.mockResolvedValue({ data: KIT });
    await updateBrandKit({ tone: 'bold', defaultHashtags: ['#a'] });
    expect(api.put).toHaveBeenCalledWith('/brand-kit', { tone: 'bold', defaultHashtags: ['#a'] });
  });

  it('uploadReferenceImage posts multipart form-data to /brand-kit/reference-image', async () => {
    api.post.mockResolvedValue({ data: KIT });
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    await uploadReferenceImage(file);
    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = api.post.mock.calls[0];
    expect(url).toBe('/brand-kit/reference-image');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/features/marketing/api/brandKit.service.test.ts`. Fails: cannot resolve `./brandKit.service`.

- [ ] **Step 3: Implement** — `frontend/src/features/marketing/api/brandKit.service.ts`:
```ts
/**
 * brandKit.service.ts — typed Brand Kit API (spec §5.2 / §8).
 * One kit per workspace; paths relative to /marketing.
 */
import marketingApi from './marketingApi';

export interface BrandKitMedia {
  url: string;
  r2Key: string;
  mime: string;
}

export interface BrandKit {
  id: string;
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette: string[];
  tone?: string | null;
  referenceImages: BrandKitMedia[];
  defaultHashtags: string[];
  defaultCta?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandKitPayload {
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette?: string[];
  tone?: string | null;
  defaultHashtags?: string[];
  defaultCta?: string | null;
}

export const getBrandKit = (): Promise<BrandKit> =>
  marketingApi.get('/brand-kit').then((r) => r.data);

export const updateBrandKit = (p: BrandKitPayload): Promise<BrandKit> =>
  marketingApi.put('/brand-kit', p).then((r) => r.data);

export const uploadReferenceImage = (file: File): Promise<BrandKit> => {
  const fd = new FormData();
  fd.append('file', file);
  return marketingApi
    .post('/brand-kit/reference-image', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
};
```

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/features/marketing/api/brandKit.service.test.ts` (3 passing).

- [ ] **Step 5: Commit** —
```
git add frontend/src/features/marketing/api/brandKit.service.ts frontend/src/features/marketing/api/brandKit.service.test.ts
git commit -m "feat(ai-studio): typed Brand Kit API service"
```

---

### Task 13: `AiStudioPage.tsx` — generation panel, live polling cards, asset library + route/nav

**Files:**
- Create: `frontend/src/pages/marketing/social/AiStudioPage.tsx`
- Test: `frontend/src/pages/marketing/social/AiStudioPage.test.tsx`
- Modify: `frontend/src/App.tsx` (lazy import + `<Route>`), `frontend/src/features/marketing/navigation.ts` (nav child)

**Interfaces:**
- Consumes: from Task 11 — `generateMedia`, `listGenerations`, `getGeneration`, `regenerateMedia`, `deleteGeneration`, `isTerminal`, `GeneratedAsset`, `GeneratedAssetType`, `GenerateMediaPayload`. UI primitives from `@/components/ui` (`PageHeader, Card*, Button, Field, Textarea, Input, SegmentedControl, Select*, Badge, EmptyState, Spinner, IconButton`). `useNavigate` from `react-router-dom`. `react-query` (`useQuery` with `refetchInterval`, `useMutation`, `useQueryClient`). `toast` from `sonner`. `useTranslation('marketing')`.
- Produces: default-export `AiStudioPage`. "Add to post" calls `navigate('/social', { state: { seedMedia: [{ url, key, mime }] } })` (consumed in Task 14). Query keys `['marketing','aiStudio','generations', filters]` and `['marketing','aiStudio','asset', id]`.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/social/AiStudioPage.test.tsx`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AiStudioPage from './AiStudioPage';
import * as mediaService from '../../../features/marketing/api/media.service';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('../../../features/marketing/api/media.service', () => ({
  generateMedia: vi.fn(),
  listGenerations: vi.fn(),
  getGeneration: vi.fn(),
  regenerateMedia: vi.fn(),
  deleteGeneration: vi.fn(),
  isTerminal: (s: string) => s === 'READY' || s === 'FAILED' || s === 'BLOCKED',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const READY = {
  id: 'a-ready', type: 'IMAGE', status: 'READY', provider: 'fal', model: 'fal-ai/qwen-image',
  prompt: 'a cat', params: {}, url: 'https://r2/img.png', r2Key: 'social/ws/img.png',
  mime: 'image/png', createdById: 'u1', createdAt: '', updatedAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AiStudioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mediaService.listGenerations).mockResolvedValue([READY] as never);
    vi.mocked(mediaService.getGeneration).mockResolvedValue(READY as never);
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-new' });
  });

  it('renders the page heading and the library asset from listGenerations', async () => {
    render(<AiStudioPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/a cat/i)).toBeInTheDocument();
  });

  it('submitting the prompt calls generateMedia with the panel values', async () => {
    render(<AiStudioPage />, { wrapper });
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a dog');
    await userEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() =>
      expect(mediaService.generateMedia).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'IMAGE', prompt: 'a dog' }),
      ),
    );
  });

  it('"Add to post" on a READY asset navigates to /social with seedMedia state', async () => {
    render(<AiStudioPage />, { wrapper });
    const addBtn = await screen.findByRole('button', { name: /add to post/i });
    await userEvent.click(addBtn);
    expect(navigate).toHaveBeenCalledWith('/social', {
      state: { seedMedia: [{ url: 'https://r2/img.png', key: 'social/ws/img.png', mime: 'image/png' }] },
    });
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/pages/marketing/social/AiStudioPage.test.tsx`. Fails: cannot resolve `./AiStudioPage`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/social/AiStudioPage.tsx`:
```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Download, RefreshCw, Trash2, Plus } from 'lucide-react';
import {
  PageHeader,
  Card,
  CardContent,
  Button,
  IconButton,
  Field,
  Textarea,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  EmptyState,
  Spinner,
} from '@/components/ui';
import {
  generateMedia,
  listGenerations,
  getGeneration,
  regenerateMedia,
  deleteGeneration,
  isTerminal,
  type GeneratedAsset,
  type GeneratedAssetType,
  type GenerateMediaPayload,
} from '../../../features/marketing/api/media.service';
import type { MediaItemValue } from './socialSchemas';

const ASPECT_RATIOS: GenerateMediaPayload['aspectRatio'][] = ['1:1', '9:16', '16:9', '4:5'];
const IMAGE_MODELS = [
  { value: 'fal-ai/qwen-image', labelKey: 'aiStudio.model.draftImage', fallback: 'Draft image' },
  { value: 'fal-ai/bytedance/seedream/v4', labelKey: 'aiStudio.model.finalImage', fallback: 'Final image' },
];
const VIDEO_MODELS = [
  { value: 'fal-ai/kling-video/v2.1/standard', labelKey: 'aiStudio.model.cheapVideo', fallback: 'Standard video' },
  { value: 'fal-ai/bytedance/seedance/v1/pro', labelKey: 'aiStudio.model.premiumVideo', fallback: 'Premium video' },
  { value: 'fal-ai/veo3/fast', labelKey: 'aiStudio.model.videoAudio', fallback: 'Video + audio' },
];
const MAX_VIDEO_SEC = 10;
const STATUS_TONE: Record<GeneratedAsset['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  QUEUED: 'neutral', GENERATING: 'warning', READY: 'success', FAILED: 'danger', BLOCKED: 'danger',
};

export default function AiStudioPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [type, setType] = useState<GeneratedAssetType>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(IMAGE_MODELS[0].value);
  const [aspectRatio, setAspectRatio] = useState<GenerateMediaPayload['aspectRatio']>('1:1');
  const [durationSec, setDurationSec] = useState(5);
  const [count, setCount] = useState(1);
  const [filterType, setFilterType] = useState<'' | GeneratedAssetType>('');
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const models = type === 'IMAGE' ? IMAGE_MODELS : VIDEO_MODELS;

  const library = useQuery({
    queryKey: ['marketing', 'aiStudio', 'generations', filterType],
    queryFn: () => listGenerations(filterType ? { type: filterType } : {}),
  });

  const invalidateLibrary = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'aiStudio', 'generations'] });

  const generate = useMutation({
    mutationFn: async () => {
      const payload: GenerateMediaPayload = {
        type,
        prompt: prompt.trim(),
        model,
        aspectRatio,
        ...(type === 'VIDEO' ? { durationSec } : {}),
      };
      const n = Math.max(1, Math.min(4, count));
      const results = await Promise.all(Array.from({ length: n }, () => generateMedia(payload)));
      return results.map((r) => r.assetId);
    },
    onSuccess: (ids) => {
      setPendingIds((prev) => [...ids, ...prev]);
      toast.success(t('aiStudio.toast.started', 'Generation started'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('aiStudio.toast.failed', 'Generation failed')),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => regenerateMedia(id),
    onSuccess: ({ assetId }) => {
      setPendingIds((prev) => [assetId, ...prev]);
      toast.success(t('aiStudio.toast.started', 'Generation started'));
    },
    onError: () => toast.error(t('aiStudio.toast.failed', 'Generation failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteGeneration(id),
    onSuccess: () => {
      invalidateLibrary();
      toast.success(t('aiStudio.toast.deleted', 'Asset deleted'));
    },
    onError: () => toast.error(t('aiStudio.toast.deleteFailed', 'Delete failed')),
  });

  const addToPost = (a: GeneratedAsset) => {
    if (!a.url) return;
    const media: MediaItemValue = { url: a.url, key: a.r2Key ?? undefined, mime: a.mime ?? undefined };
    navigate('/social', { state: { seedMedia: [media] } });
  };

  const onType = (next: GeneratedAssetType) => {
    setType(next);
    setModel((next === 'IMAGE' ? IMAGE_MODELS : VIDEO_MODELS)[0].value);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('aiStudio.title', 'AI Content Studio')}
        description={t('aiStudio.subtitle', 'Generate images and video for your social posts.')}
      />

      {/* Generation panel */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <SegmentedControl<GeneratedAssetType>
            aria-label={t('aiStudio.mediaType', 'Media type')}
            value={type}
            onChange={onType}
            options={[
              { value: 'IMAGE', label: t('aiStudio.type.image', 'Image') },
              { value: 'VIDEO', label: t('aiStudio.type.video', 'Video') },
            ]}
          />

          <Field label={t('aiStudio.prompt', 'Prompt')}>
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('aiStudio.promptPlaceholder', 'Describe the image or video to generate…')}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('aiStudio.model', 'Model')}>
              {({ id }) => (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id={id} aria-label={t('aiStudio.model', 'Model')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {t(m.labelKey, m.fallback)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <Field label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
              {({ id }) => (
                <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as typeof aspectRatio)}>
                  <SelectTrigger id={id} aria-label={t('aiStudio.aspectRatio', 'Aspect ratio')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIOS.map((r) => (
                      <SelectItem key={r} value={r!}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {type === 'VIDEO' && (
              <Field label={t('aiStudio.duration', 'Duration (sec)')} hint={`1 – ${MAX_VIDEO_SEC}`}>
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={MAX_VIDEO_SEC}
                    value={durationSec}
                    onChange={(e) =>
                      setDurationSec(Math.max(1, Math.min(MAX_VIDEO_SEC, Number(e.target.value))))
                    }
                  />
                )}
              </Field>
            )}

            <Field label={t('aiStudio.count', 'How many')} hint="1 – 4">
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={4}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value))))}
                />
              )}
            </Field>
          </div>

          <Button
            onClick={() => generate.mutate()}
            loading={generate.isPending}
            disabled={!prompt.trim()}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t('aiStudio.generate', 'Generate')}
          </Button>
        </CardContent>
      </Card>

      {/* Live generation cards */}
      {pendingIds.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t('aiStudio.generating', 'Generating')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {pendingIds.map((id) => (
              <GenerationCard
                key={id}
                assetId={id}
                onTerminal={(a) => {
                  setPendingIds((prev) => prev.filter((x) => x !== id));
                  invalidateLibrary();
                  if (a.status === 'BLOCKED') toast.error(t('aiStudio.toast.blocked', 'Blocked by moderation'));
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Asset library */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('aiStudio.library', 'Library')}</h2>
          <SegmentedControl<'' | GeneratedAssetType>
            aria-label={t('aiStudio.filterType', 'Filter by type')}
            value={filterType}
            onChange={setFilterType}
            options={[
              { value: '', label: t('aiStudio.filter.all', 'All') },
              { value: 'IMAGE', label: t('aiStudio.type.image', 'Image') },
              { value: 'VIDEO', label: t('aiStudio.type.video', 'Video') },
            ]}
          />
        </div>

        {library.isLoading ? (
          <Spinner />
        ) : !library.data?.length ? (
          <EmptyState
            title={t('aiStudio.empty.title', 'No assets yet')}
            description={t('aiStudio.empty.desc', 'Generate your first image or video above.')}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {library.data.map((a) => (
              <Card key={a.id} className="overflow-hidden">
                <div className="aspect-square bg-surface-muted">
                  {a.type === 'VIDEO' && a.url ? (
                    <video src={a.url} className="h-full w-full object-cover" controls muted />
                  ) : a.url ? (
                    <img src={a.url} alt={a.prompt} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <CardContent className="space-y-2 p-3">
                  <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                  <p className="line-clamp-2 text-caption text-muted-foreground" title={a.prompt}>
                    {a.prompt}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" disabled={a.status !== 'READY'} onClick={() => addToPost(a)}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {t('aiStudio.addToPost', 'Add to post')}
                    </Button>
                    {a.url && (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={t('aiStudio.download', 'Download')}
                        onClick={() => window.open(a.url!, '_blank', 'noopener')}
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('aiStudio.regenerate', 'Regenerate')}
                      onClick={() => regenerate.mutate(a.id)}
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('aiStudio.delete', 'Delete')}
                      onClick={() => remove.mutate(a.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** A single in-flight generation; polls until terminal, then notifies the parent. */
function GenerationCard({
  assetId,
  onTerminal,
}: {
  assetId: string;
  onTerminal: (a: GeneratedAsset) => void;
}) {
  const { t } = useTranslation('marketing');
  const { data } = useQuery({
    queryKey: ['marketing', 'aiStudio', 'asset', assetId],
    queryFn: async () => {
      const a = await getGeneration(assetId);
      if (isTerminal(a.status)) onTerminal(a);
      return a;
    },
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 4000),
  });

  return (
    <Card className="flex aspect-square items-center justify-center bg-surface-muted">
      <div className="flex flex-col items-center gap-2 text-caption text-muted-foreground">
        <Spinner />
        <span>{data?.status ?? t('aiStudio.status.queued', 'QUEUED')}</span>
      </div>
    </Card>
  );
}
```
Then wire the route in `frontend/src/App.tsx` — add the lazy import beside the other social import (after line 94):
```tsx
const AiStudioPage = lazy(() => import('./pages/marketing/social/AiStudioPage'));
```
and a `<Route>` next to `/social` (after line 246):
```tsx
<Route path="/ai/studio" element={<S><AiStudioPage /></S>} />
```
Add the nav child in `frontend/src/features/marketing/navigation.ts`, into the `marketing` hub's `children` directly after the `/social` entry (line 178; `Sparkles` is already imported at line 18):
```ts
{ path: '/ai/studio', labelKey: 'nav.aiStudio', label: 'AI Studio', icon: Sparkles, managerOnly: true },
```

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/pages/marketing/social/AiStudioPage.test.tsx` (3 passing). Then `tsc` for type safety.

- [ ] **Step 5: Commit** —
```
git add frontend/src/pages/marketing/social/AiStudioPage.tsx frontend/src/pages/marketing/social/AiStudioPage.test.tsx frontend/src/App.tsx frontend/src/features/marketing/navigation.ts
git commit -m "feat(ai-studio): Content Studio page with live polling cards and asset library"
```

---

### Task 14: Composer "AI ile Üret" Sheet + `seedMedia` hand-off

**Files:**
- Modify: `frontend/src/pages/marketing/social/PostComposerDialog.tsx` (inline generate Sheet + `seedMedia` prop)
- Modify: `frontend/src/pages/marketing/social/SocialPlannerPage.tsx` (consume `location.state.seedMedia`)
- Test: `frontend/src/pages/marketing/social/PostComposerDialog.test.tsx` (new)

**Interfaces:**
- Consumes: Task 11 `generateMedia`, `getGeneration`, `isTerminal`, `GeneratedAssetType`. Existing `PostComposerDialogProps`, `MediaItemValue` ({url, key?, mime?}). `Sheet`/`SheetContent`/`SheetTitle`/`SheetDescription` from `@/components/ui/Sheet`. `useNavigate`/`useLocation` from `react-router-dom`.
- Produces: extended `PostComposerDialogProps` with optional `seedMedia?: MediaItemValue[]`. Generated asset drops into the media field as `{ url, key: r2Key, mime }`.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/social/PostComposerDialog.test.tsx`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostComposerDialog } from './PostComposerDialog';
import * as mediaService from '../../../features/marketing/api/media.service';

vi.mock('../../../features/marketing/api/social-planner.service', () => ({
  getTiktokCreatorInfo: vi.fn(),
}));
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));
vi.mock('../../../features/marketing/api/media.service', () => ({
  generateMedia: vi.fn(),
  getGeneration: vi.fn(),
  isTerminal: (s: string) => s === 'READY' || s === 'FAILED' || s === 'BLOCKED',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ACCOUNT = {
  id: 'acc-1', network: 'FACEBOOK', externalId: '1', displayName: 'Acme',
  accessToken: '••••', tokenExpiresAt: null, enabled: true, createdAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('PostComposerDialog AI generate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seedMedia prefills the media list when creating a new post', () => {
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[ACCOUNT as never]}
        onSubmit={() => {}}
        isPending={false}
        seedMedia={[{ url: 'https://r2/x.png', key: 'k', mime: 'image/png' }]}
      />,
      { wrapper },
    );
    expect(screen.getByText('x.png')).toBeInTheDocument();
  });

  it('generating in the AI panel appends a READY asset to the media list', async () => {
    vi.mocked(mediaService.generateMedia).mockResolvedValue({ assetId: 'a-1' });
    vi.mocked(mediaService.getGeneration).mockResolvedValue({
      id: 'a-1', type: 'IMAGE', status: 'READY', provider: 'fal', model: 'm',
      prompt: 'p', params: {}, url: 'https://r2/gen.png', r2Key: 'social/ws/gen.png',
      mime: 'image/png', createdById: 'u', createdAt: '', updatedAt: '',
    } as never);

    render(
      <PostComposerDialog open onOpenChange={() => {}} accounts={[ACCOUNT as never]} onSubmit={() => {}} isPending={false} />,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: /ai ile üret/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /prompt/i }), 'a sunset');
    await userEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => expect(screen.getByText('gen.png')).toBeInTheDocument());
    expect(mediaService.generateMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'IMAGE', prompt: 'a sunset' }),
    );
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/pages/marketing/social/PostComposerDialog.test.tsx`. Fails: no `AI ile Üret` button / `seedMedia` prop unknown.

- [ ] **Step 3: Implement** — in `PostComposerDialog.tsx`:

(a) Extend props (after line 53 in `PostComposerDialogProps`):
```ts
  /** Media to pre-load into a NEW post (e.g. an asset handed off from AI Studio). */
  seedMedia?: MediaItemValue[];
```
Add `seedMedia` to the destructured params and the `else` branch of the populate effect (line 121) so a fresh composer starts with it:
```ts
    } else {
      form.reset({
        content: '', media: seedMedia ?? [], formats: {}, targetAccountIds: [], scheduledAt: '',
      });
      setTiktokOpts({});
    }
```
and add `seedMedia` to that effect's dep array.

(b) Add imports at top:
```ts
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/Sheet';
import { Sparkles } from 'lucide-react';
import {
  generateMedia,
  getGeneration,
  isTerminal,
  type GeneratedAssetType,
} from '../../../features/marketing/api/media.service';
```

(c) Add local state inside the component:
```ts
  const [aiOpen, setAiOpen] = useState(false);
```

(d) In the media `Controller` render, add an "AI ile Üret" button beside the Upload/Add-URL buttons (inside the `<div className="flex gap-2">` at line 269), and render the panel; both use `field.onChange`:
```tsx
<Button
  type="button"
  variant="outline"
  size="sm"
  disabled={items.length >= 10}
  onClick={() => setAiOpen(true)}
>
  <Sparkles className="h-4 w-4" aria-hidden="true" />
  {t('social.composer.aiGenerate', { defaultValue: 'AI ile Üret' })}
</Button>
```
and immediately after the media list block, still inside the Controller render:
```tsx
<AiGeneratePanel
  open={aiOpen}
  onOpenChange={setAiOpen}
  onAdd={(media) => field.onChange([...(field.value ?? []), media])}
/>
```

(e) Add the panel component at the bottom of the file:
```tsx
interface AiGeneratePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (media: MediaItemValue) => void;
}

function AiGeneratePanel({ open, onOpenChange, onAdd }: AiGeneratePanelProps) {
  const { t } = useTranslation('marketing');
  const [type, setType] = useState<GeneratedAssetType>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    try {
      const { assetId } = await generateMedia({ type, prompt: text });
      // Poll until terminal (composer is short-lived; cap the wait).
      for (let i = 0; i < 60; i += 1) {
        const a = await getGeneration(assetId);
        if (isTerminal(a.status)) {
          if (a.status === 'READY' && a.url) {
            onAdd({ url: a.url, key: a.r2Key ?? undefined, mime: a.mime ?? undefined });
            toast.success(t('social.composer.aiAdded', { defaultValue: 'Added to post' }));
            onOpenChange(false);
          } else {
            toast.error(t('social.composer.aiFailed', { defaultValue: 'Generation failed' }));
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      toast.error(t('social.composer.aiTimeout', { defaultValue: 'Still generating — check the Studio' }));
    } catch {
      toast.error(t('social.composer.aiFailed', { defaultValue: 'Generation failed' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 max-w-[90vw] space-y-4 p-6">
        <SheetTitle>{t('social.composer.aiTitle', { defaultValue: 'Generate with AI' })}</SheetTitle>
        <SheetDescription className="sr-only">
          {t('social.composer.aiTitle', { defaultValue: 'Generate with AI' })}
        </SheetDescription>
        <div className="flex gap-2">
          <Button type="button" variant={type === 'IMAGE' ? 'default' : 'outline'} size="sm" onClick={() => setType('IMAGE')}>
            {t('social.composer.aiImage', { defaultValue: 'Image' })}
          </Button>
          <Button type="button" variant={type === 'VIDEO' ? 'default' : 'outline'} size="sm" onClick={() => setType('VIDEO')}>
            {t('social.composer.aiVideo', { defaultValue: 'Video' })}
          </Button>
        </div>
        <Field label={t('social.composer.aiPrompt', { defaultValue: 'Prompt' })}>
          {({ id }) => (
            <Textarea
              id={id}
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('social.composer.aiPromptPlaceholder', { defaultValue: 'Describe the media…' })}
            />
          )}
        </Field>
        <Button type="button" onClick={run} loading={busy} disabled={!prompt.trim()}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {t('social.composer.aiRun', { defaultValue: 'Generate' })}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
```

(f) In `SocialPlannerPage.tsx`, consume the hand-off. Add `import { useLocation } from 'react-router-dom';`, read state once, and seed the composer:
```ts
  const location = useLocation();
  const seedMedia = (location.state as { seedMedia?: MediaItemValue[] } | null)?.seedMedia;
  useEffect(() => {
    if (seedMedia?.length) {
      setEditingPost(null);
      setComposerOpen(true);
      // Clear router state so a refresh/back doesn't re-seed.
      window.history.replaceState({}, '');
    }
  }, [seedMedia]);
```
and pass `seedMedia={editingPost ? undefined : seedMedia}` to the `<PostComposerDialog>` (import `MediaItemValue` from `./socialSchemas` and `useEffect` if not already imported).

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/pages/marketing/social/PostComposerDialog.test.tsx` (2 passing) and re-run `npm test -- src/pages/marketing/social/SocialPlannerPage.test.tsx` to confirm no regression. Then `tsc`.

- [ ] **Step 5: Commit** —
```
git add frontend/src/pages/marketing/social/PostComposerDialog.tsx frontend/src/pages/marketing/social/PostComposerDialog.test.tsx frontend/src/pages/marketing/social/SocialPlannerPage.tsx
git commit -m "feat(ai-studio): composer AI generate panel and Studio add-to-post hand-off"
```

---

### Task 15: Brand Kit settings page

**Files:**
- Create: `frontend/src/pages/marketing/BrandKitPage.tsx`
- Test: `frontend/src/pages/marketing/BrandKitPage.test.tsx`
- Modify: `frontend/src/App.tsx` (lazy import + `<Route path="/brand-kit">`), `frontend/src/features/marketing/navigation.ts` (settings-hub child)

**Interfaces:**
- Consumes: Task 12 `getBrandKit`, `updateBrandKit`, `uploadReferenceImage`, `BrandKit`, `BrandKitPayload`. Existing `marketingApi` for logo upload via the proven `/social-planner/media` endpoint (recon §3: returns `{url,key,mime}`). UI primitives `PageHeader, Card*, Field, Input, Textarea, Button, IconButton`. `react-query`, `toast`, `useTranslation('marketing')`.
- Produces: default-export `BrandKitPage`. Query key `['marketing','brandKit']`.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/BrandKitPage.test.tsx`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BrandKitPage from './BrandKitPage';
import * as brandKitService from '../../features/marketing/api/brandKit.service';

vi.mock('../../features/marketing/api/brandKit.service', () => ({
  getBrandKit: vi.fn(),
  updateBrandKit: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string) => def ?? key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KIT = {
  id: 'bk-1', logoUrl: null, logoR2Key: null, palette: ['#1e40af'], tone: 'friendly',
  referenceImages: [], defaultHashtags: ['#jeeta'], defaultCta: 'Book now',
  createdAt: '', updatedAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('BrandKitPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(brandKitService.getBrandKit).mockResolvedValue(KIT as never);
    vi.mocked(brandKitService.updateBrandKit).mockResolvedValue(KIT as never);
  });

  it('renders the heading and populates fields from getBrandKit', async () => {
    render(<BrandKitPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('friendly')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Book now')).toBeInTheDocument();
  });

  it('saving sends the edited tone/cta/hashtags to updateBrandKit', async () => {
    render(<BrandKitPage />, { wrapper });
    const tone = await screen.findByDisplayValue('friendly');
    await userEvent.clear(tone);
    await userEvent.type(tone, 'bold and playful');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(brandKitService.updateBrandKit).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'bold and playful',
          defaultCta: 'Book now',
          defaultHashtags: ['#jeeta'],
        }),
      ),
    );
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/pages/marketing/BrandKitPage.test.tsx`. Fails: cannot resolve `./BrandKitPage`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/BrandKitPage.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Upload, Trash2 } from 'lucide-react';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Input,
  Textarea,
  Button,
  IconButton,
} from '@/components/ui';
import marketingApi from '../../features/marketing/api/marketingApi';
import {
  getBrandKit,
  updateBrandKit,
  uploadReferenceImage,
  type BrandKit,
} from '../../features/marketing/api/brandKit.service';

export default function BrandKitPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const logoRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);

  const [tone, setTone] = useState('');
  const [palette, setPalette] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [cta, setCta] = useState('');

  const { data } = useQuery<BrandKit>({
    queryKey: ['marketing', 'brandKit'],
    queryFn: getBrandKit,
  });

  useEffect(() => {
    if (!data) return;
    setTone(data.tone ?? '');
    setPalette((data.palette ?? []).join(', '));
    setHashtags((data.defaultHashtags ?? []).join(' '));
    setCta(data.defaultCta ?? '');
  }, [data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'brandKit'] });

  const save = useMutation({
    mutationFn: () =>
      updateBrandKit({
        tone: tone.trim() || null,
        palette: palette.split(',').map((s) => s.trim()).filter(Boolean),
        defaultHashtags: hashtags.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        defaultCta: cta.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.saved', 'Brand kit saved'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('brandKit.saveFailed', 'Save failed')),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      const { data: m } = await marketingApi.post('/social-planner/media', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return updateBrandKit({ logoUrl: m.url, logoR2Key: m.key });
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.logoUploaded', 'Logo uploaded'));
    },
    onError: () => toast.error(t('brandKit.logoFailed', 'Upload failed')),
  });

  const uploadRef = useMutation({
    mutationFn: (file: File) => uploadReferenceImage(file),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.refUploaded', 'Reference image added'));
    },
    onError: () => toast.error(t('brandKit.refFailed', 'Upload failed')),
  });

  const removeRef = useMutation({
    mutationFn: (r2Key: string) =>
      updateBrandKit({
        // referenceImages is managed by the backend; PUT with the filtered list.
      } as never).then(() =>
        marketingApi.put('/brand-kit', {
          referenceImages: (data?.referenceImages ?? []).filter((i) => i.r2Key !== r2Key),
        }),
      ),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.refRemoved', 'Reference image removed'));
    },
    onError: () => toast.error(t('brandKit.refFailed', 'Upload failed')),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={t('brandKit.title', 'Brand Kit')}
        description={t('brandKit.subtitle', 'Logo, palette, tone and references reused across AI generations.')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('brandKit.identity', 'Brand identity')}</CardTitle>
          <CardDescription>{t('brandKit.identityDesc', 'Used to keep generated content on-brand.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Logo */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-foreground">{t('brandKit.logo', 'Logo')}</span>
            <div className="flex items-center gap-3">
              {data?.logoUrl && <img src={data.logoUrl} alt="logo" className="h-12 w-12 rounded object-contain" />}
              <input
                ref={logoRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && uploadLogo.mutate(e.target.files[0])}
              />
              <Button type="button" variant="outline" size="sm" loading={uploadLogo.isPending} onClick={() => logoRef.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t('brandKit.uploadLogo', 'Upload logo')}
              </Button>
            </div>
          </div>

          <Field label={t('brandKit.palette', 'Palette (comma-separated hex)')}>
            {({ id }) => <Input id={id} placeholder="#1e40af, #f59e0b" value={palette} onChange={(e) => setPalette(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.tone', 'Brand tone / voice')}>
            {({ id }) => <Textarea id={id} rows={3} value={tone} onChange={(e) => setTone(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.hashtags', 'Default hashtags')}>
            {({ id }) => <Input id={id} placeholder="#jeeta #marketing" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.cta', 'Default call-to-action')}>
            {({ id }) => <Input id={id} value={cta} onChange={(e) => setCta(e.target.value)} />}
          </Field>

          {/* Reference images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{t('brandKit.references', 'Reference images')}</span>
              <input
                ref={refRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && uploadRef.mutate(e.target.files[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={uploadRef.isPending}
                disabled={(data?.referenceImages?.length ?? 0) >= 5}
                onClick={() => refRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t('brandKit.addReference', 'Add reference')}
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {(data?.referenceImages ?? []).map((img) => (
                <div key={img.r2Key} className="relative">
                  <img src={img.url} alt="reference" className="aspect-square w-full rounded object-cover" />
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label={t('brandKit.removeReference', 'Remove')}
                    className="absolute end-1 top-1 bg-surface/80"
                    onClick={() => removeRef.mutate(img.r2Key)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {t('brandKit.save', 'Save')}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
```
Wire route in `App.tsx` (lazy import near the other marketing pages):
```tsx
const BrandKitPage = lazy(() => import('./pages/marketing/BrandKitPage'));
```
and a `<Route>` near `/branding` (after line 234):
```tsx
<Route path="/brand-kit" element={<S><BrandKitPage /></S>} />
```
Add nav child in `navigation.ts` settings hub `children` right after the `/branding` entry (line 248; `Palette` already imported):
```ts
{ path: '/brand-kit', labelKey: 'nav.brandKit', label: 'Brand Kit', icon: Palette, managerOnly: true },
```

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/pages/marketing/BrandKitPage.test.tsx` (2 passing). Then `tsc`.

- [ ] **Step 5: Commit** —
```
git add frontend/src/pages/marketing/BrandKitPage.tsx frontend/src/pages/marketing/BrandKitPage.test.tsx frontend/src/App.tsx frontend/src/features/marketing/navigation.ts
git commit -m "feat(ai-studio): Brand Kit settings page"
```

---

### Task 16: i18n — `aiStudio.*` / `brandKit.*` keys + extract `social.composer.*` defaults (en + tr)

**Files:**
- Modify: `frontend/src/i18n/locales/en/marketing.json`, `frontend/src/i18n/locales/tr/marketing.json`
- Test: `frontend/src/i18n/marketing-parity.test.ts` (new)

**Interfaces:**
- Consumes: keys referenced by Tasks 13–15 (`aiStudio.*`, `brandKit.*`, `nav.aiStudio`, `nav.brandKit`) and the inline `social.composer.*` defaults in `PostComposerDialog.tsx`.
- Produces: populated `aiStudio`, `brandKit`, and `social.composer` namespaces in both locales, kept in parity by the test.

- [ ] **Step 1: Write the failing test** — `frontend/src/i18n/marketing-parity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

type Json = Record<string, unknown>;
const flat = (o: Json, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flat(v as Json, `${p}${k}.`)
      : [`${p}${k}`],
  );

describe('marketing i18n — AI Studio / Brand Kit', () => {
  it('en defines the new namespaces and nav keys', () => {
    expect((en as Json).aiStudio).toBeTruthy();
    expect((en as Json).brandKit).toBeTruthy();
    expect(flat(en as Json)).toEqual(expect.arrayContaining(['nav.aiStudio', 'nav.brandKit']));
  });

  it('tr mirrors every aiStudio / brandKit / social.composer key in en', () => {
    const want = flat(en as Json).filter((k) =>
      /^(aiStudio|brandKit|social\.composer)\./.test(k),
    );
    const have = new Set(flat(tr as Json));
    expect(want.filter((k) => !have.has(k))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npm test -- src/i18n/marketing-parity.test.ts`. Fails: `en.aiStudio` undefined; `nav.aiStudio`/`nav.brandKit` and `social.composer.*` keys absent.

- [ ] **Step 3: Implement** — add to `en/marketing.json`: `nav.aiStudio: "AI Studio"`, `nav.brandKit: "Brand Kit"`, plus an `aiStudio` object (`title, subtitle, mediaType, type.image, type.video, prompt, promptPlaceholder, model, model.draftImage, model.finalImage, model.cheapVideo, model.premiumVideo, model.videoAudio, aspectRatio, duration, count, generate, generating, library, filterType, filter.all, addToPost, download, regenerate, delete, status.queued, empty.title, empty.desc, toast.started, toast.failed, toast.deleted, toast.deleteFailed, toast.blocked`), a `brandKit` object (`title, subtitle, identity, identityDesc, logo, uploadLogo, palette, tone, hashtags, cta, references, addReference, removeReference, save, saved, saveFailed, logoUploaded, logoFailed, refUploaded, refFailed, refRemoved`), and a `social.composer` object holding every default string currently inline in `PostComposerDialog.tsx` (`editTitle, createTitle, subtitle, content, contentPlaceholder, media, uploadMedia, addMedia, noMedia, accounts, noAccounts, noAccountsHint, format, format_FEED, format_REEL, format_STORY, formatHint, uploadFailed, create, schedule, scheduleHint, aiGenerate, aiAdded, aiFailed, aiTimeout, aiTitle, aiImage, aiVideo, aiPrompt, aiPromptPlaceholder, aiRun` plus the `tiktok.*` subtree). Use the exact English defaults already in the component as the values. Then add the Turkish equivalents under the same paths in `tr/marketing.json` (e.g. `aiStudio.title: "AI İçerik Stüdyosu"`, `aiStudio.generate: "Üret"`, `brandKit.title: "Marka Kiti"`, `social.composer.createTitle: "Yeni gönderi"`, `social.composer.aiGenerate: "AI ile Üret"`). Keep both objects key-identical so the parity test passes.

- [ ] **Step 4: Run test, expect PASS** — `npm test -- src/i18n/marketing-parity.test.ts` (2 passing). Then run the full frontend build to confirm JSON + types are valid: `npm run build`.

- [ ] **Step 5: Commit** —
```
git add frontend/src/i18n/locales/en/marketing.json frontend/src/i18n/locales/tr/marketing.json frontend/src/i18n/marketing-parity.test.ts
git commit -m "i18n(ai-studio): add aiStudio/brandKit keys and extract social.composer defaults (en+tr)"
```

---

## Milestone 3: Social Campaign Engine — Backend

### Task 17: Add the `socialCampaigns` feature flag (entitlements + tripwire + seed packages)

**Files:**
- Modify: `backend/src/modules/billing/entitlements.service.ts`
- Modify: `backend/prisma/seed-packages.ts`
- Test: `backend/src/modules/billing/entitlements.tripwire.spec.ts`

**Interfaces:**
- Consumes: `FEATURE_KEYS` (`as const` string tuple), `FeatureKey = (typeof FEATURE_KEYS)[number]`.
- Produces: `'socialCampaigns'` as a valid `FeatureKey`, usable by `@RequiresFeature('socialCampaigns')` in Task 23.

> Note: Task 10 already added `mediaGen` to `FEATURE_KEYS` and to every seed-package `features` block. Insert `socialCampaigns` alongside it; the tripwire's pinned sorted array must include **both** new keys.

- [ ] **Step 1: Write the failing test** — extend the existing drift-tripwire's pinned array (insert in sorted order):
```ts
// entitlements.tripwire.spec.ts — inside the "pins the feature vocabulary" it()
expect([...FEATURE_KEYS].sort()).toEqual([
  'advancedReports', 'agentStudio', 'apiAccess', 'askAi', 'autoAssign',
  'campaigns', 'commissions', 'conversationAi', 'funnels', 'installations',
  'invoicing', 'mediaGen', 'reviews', 'socialCampaigns', 'telephony', 'voiceAi', 'workflows',
]);
```
(The two `seed-packages.ts` blocks-must-list-every-key assertions already in this spec will also fail until the seed edit below.)
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- entitlements.tripwire` → fails: received array missing `'socialCampaigns'`; and "seed-packages.ts grants exactly the known keys" fails (keys mismatch).
- [ ] **Step 3: Implement** — append the key to `FEATURE_KEYS` in `entitlements.service.ts` (after `'invoicing'`/`'mediaGen'`):
```ts
  'invoicing',
  'mediaGen',
  // AI Social Content Studio — Social Campaign engine (Milestone 3).
  'socialCampaigns',
] as const;
```
Then add `socialCampaigns: <bool>,` immediately after the `mediaGen:` line inside **every** `features: { … }` block in `prisma/seed-packages.ts` (all 5 packages — grant `true` on the higher tiers, `false` on the entry tier to match each package's `campaigns` value):
```ts
      mediaGen: false,
      socialCampaigns: false,
```
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- entitlements.tripwire`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(entitlements): add socialCampaigns feature flag"`

---

### Task 18: Prisma — SocialCampaign / SocialCampaignItem models, enums, SocialPost columns, GeneratedAsset relation

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260630120000_social_campaign_engine/migration.sql`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaigns.schema.spec.ts`

**Interfaces:**
- Consumes: existing `model SocialPost` (L2845) and the Milestone-1 `model GeneratedAsset` (Task 2 — already carries a nullable `socialCampaignId String?` column with no relation yet).
- Produces: Prisma models `SocialCampaign`, `SocialCampaignItem`; enums `SocialCampaignStatus`, `SocialCampaignAutomationMode`, `SocialCampaignPlanningMode`, `SocialCampaignItemStatus`; `SocialPost.socialCampaignId`/`campaignItemId`; `SocialCampaign.assets GeneratedAsset[]` back-relation. These names are consumed by all later tasks.

> Migration convention note: this project uses **forward-only Prisma Migrate** (one `migration.sql` per folder, no down file — confirmed in recon). The global "reversible up/down" rule does not match this tooling, so this migration is additive, nullable, and backward-compatible (existing rows unaffected) per the recon guidance.

- [ ] **Step 1: Write the failing test** — assert the generated client knows the new models/enums:
```ts
// social-campaigns.schema.spec.ts
import { Prisma } from '@prisma/client';

describe('Social Campaign schema', () => {
  it('exposes the new models', () => {
    expect(Prisma.ModelName.SocialCampaign).toBe('SocialCampaign');
    expect(Prisma.ModelName.SocialCampaignItem).toBe('SocialCampaignItem');
  });
  it('exposes the new enums', () => {
    expect(Prisma.SocialCampaignStatus.ACTIVE).toBe('ACTIVE');
    expect(Prisma.SocialCampaignAutomationMode.FULL_AUTO).toBe('FULL_AUTO');
    expect(Prisma.SocialCampaignPlanningMode.AI_PROPOSE).toBe('AI_PROPOSE');
    expect(Prisma.SocialCampaignItemStatus.NEEDS_APPROVAL).toBe('NEEDS_APPROVAL');
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- social-campaigns.schema` → fails: `Prisma.ModelName.SocialCampaign` is `undefined` / `Prisma.SocialCampaignStatus` is undefined.
- [ ] **Step 3: Implement** —
  (a) Add the enums + models to `schema.prisma` (after `model SocialPostTarget`, L2885):
```prisma
enum SocialCampaignStatus { DRAFT ACTIVE PAUSED COMPLETED CANCELLED }
enum SocialCampaignAutomationMode { APPROVAL SEMI_AUTO FULL_AUTO }
enum SocialCampaignPlanningMode { AI_PROPOSE AI_FULL USER_TOPICS }
enum SocialCampaignItemStatus { PLANNED GENERATING NEEDS_APPROVAL APPROVED SCHEDULED PUBLISHED FAILED SKIPPED }

/// AI Social Content Studio — a goal/theme/cadence-driven content calendar that
/// auto-progresses generated posts. One per workspace per campaign.
model SocialCampaign {
  id                 String   @id @default(uuid())
  workspaceId        String
  name               String
  goal               String?
  theme              String?
  /// { audience?, keyMessages?, languages?, productRefs?, topics?[] }
  brief              Json
  status             SocialCampaignStatus @default(DRAFT)
  automationMode     SocialCampaignAutomationMode
  planningMode       SocialCampaignPlanningMode
  /// { perWeek?, daysOfWeek:number[], timeOfDay:'HH:MM', timezone? }
  cadence            Json
  startDate          DateTime
  endDate            DateTime?
  targetAccountIds   String[]
  mediaKinds         String[]
  defaultImageModel  String?
  defaultVideoModel  String?
  dailyPublishCap    Int      @default(2)
  linkedCampaignId   String?
  linkedAdCampaignId String?
  /// { planned, generated, approved, published }
  stats              Json?
  createdById        String
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  items  SocialCampaignItem[]
  assets GeneratedAsset[]

  @@index([workspaceId, status])
  @@map("social_campaigns")
}

/// One planned slot in a SocialCampaign's calendar.
model SocialCampaignItem {
  id                String   @id @default(uuid())
  socialCampaignId  String
  campaign          SocialCampaign @relation(fields: [socialCampaignId], references: [id], onDelete: Cascade)
  workspaceId       String
  sequenceIndex     Int
  scheduledFor      DateTime
  status            SocialCampaignItemStatus @default(PLANNED)
  topic             String?
  socialPostId      String?
  generatedAssetIds String[]
  error             String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([socialCampaignId, status])
  @@index([workspaceId, status])
  @@map("social_campaign_items")
}
```
  (b) Add to `model SocialPost` (after `updatedAt`, before `targets`):
```prisma
  socialCampaignId String?
  campaignItemId   String?
```
  and add the index next to the existing `@@index`:
```prisma
  @@index([socialCampaignId])
```
  (c) In the Milestone-1 `model GeneratedAsset`, replace the bare `socialCampaignId String?` line with the wired relation:
```prisma
  socialCampaignId String?
  socialCampaign   SocialCampaign? @relation(fields: [socialCampaignId], references: [id], onDelete: SetNull)
```
  (d) Create `backend/prisma/migrations/20260630120000_social_campaign_engine/migration.sql`:
```sql
-- AI Social Content Studio — Social Campaign engine (Milestone 3).
-- Additive only: new enums + two tables, two nullable columns on social_posts,
-- and the FK wiring the pre-existing generated_assets.socialCampaignId column to
-- the new social_campaigns table. Safe on populated tables; no backfill needed.

CREATE TYPE "SocialCampaignStatus" AS ENUM ('DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED');
CREATE TYPE "SocialCampaignAutomationMode" AS ENUM ('APPROVAL','SEMI_AUTO','FULL_AUTO');
CREATE TYPE "SocialCampaignPlanningMode" AS ENUM ('AI_PROPOSE','AI_FULL','USER_TOPICS');
CREATE TYPE "SocialCampaignItemStatus" AS ENUM ('PLANNED','GENERATING','NEEDS_APPROVAL','APPROVED','SCHEDULED','PUBLISHED','FAILED','SKIPPED');

CREATE TABLE "social_campaigns" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "goal" TEXT,
  "theme" TEXT,
  "brief" JSONB NOT NULL,
  "status" "SocialCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "automationMode" "SocialCampaignAutomationMode" NOT NULL,
  "planningMode" "SocialCampaignPlanningMode" NOT NULL,
  "cadence" JSONB NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3),
  "targetAccountIds" TEXT[],
  "mediaKinds" TEXT[],
  "defaultImageModel" TEXT,
  "defaultVideoModel" TEXT,
  "dailyPublishCap" INTEGER NOT NULL DEFAULT 2,
  "linkedCampaignId" TEXT,
  "linkedAdCampaignId" TEXT,
  "stats" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_campaigns_workspaceId_status_idx" ON "social_campaigns"("workspaceId","status");

CREATE TABLE "social_campaign_items" (
  "id" TEXT NOT NULL,
  "socialCampaignId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sequenceIndex" INTEGER NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" "SocialCampaignItemStatus" NOT NULL DEFAULT 'PLANNED',
  "topic" TEXT,
  "socialPostId" TEXT,
  "generatedAssetIds" TEXT[],
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_campaign_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_campaign_items_socialCampaignId_status_idx" ON "social_campaign_items"("socialCampaignId","status");
CREATE INDEX "social_campaign_items_workspaceId_status_idx" ON "social_campaign_items"("workspaceId","status");

ALTER TABLE "social_posts" ADD COLUMN "socialCampaignId" TEXT;
ALTER TABLE "social_posts" ADD COLUMN "campaignItemId" TEXT;
CREATE INDEX "social_posts_socialCampaignId_idx" ON "social_posts"("socialCampaignId");

ALTER TABLE "social_campaign_items"
  ADD CONSTRAINT "social_campaign_items_socialCampaignId_fkey"
  FOREIGN KEY ("socialCampaignId") REFERENCES "social_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_assets"
  ADD CONSTRAINT "generated_assets_socialCampaignId_fkey"
  FOREIGN KEY ("socialCampaignId") REFERENCES "social_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```
  (e) Regenerate the client + apply: `cd backend && npx prisma generate && npm run prisma:migrate`.
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- social-campaigns.schema`. Also verify schema/migration agree: `cd backend && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` (exit 0 = in sync).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): SocialCampaign/Item models + migration; wire GeneratedAsset relation"`

---

### Task 19: Cadence helper — `nextCadenceSlot`

**Files:**
- Create: `backend/src/modules/marketing/social-campaigns/cadence.util.ts`
- Test: `backend/src/modules/marketing/social-campaigns/cadence.util.spec.ts`

**Interfaces:**
- Produces: `interface Cadence { perWeek?: number; daysOfWeek: number[]; timeOfDay: string; timezone?: string }` and `export function nextCadenceSlot(cadence: Cadence, from: Date): Date | null` — consumed by the planner job in Task 21.

- [ ] **Step 1: Write the failing test:**
```ts
// cadence.util.spec.ts
import { nextCadenceSlot, Cadence } from './cadence.util';

const cadence = (over: Partial<Cadence> = {}): Cadence => ({
  daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'UTC', ...over,
});

describe('nextCadenceSlot', () => {
  it('returns the next configured weekday at timeOfDay, strictly after `from`', () => {
    const from = new Date('2026-07-06T10:00:00Z'); // a Monday, after 09:00
    const slot = nextCadenceSlot(cadence(), from)!;
    expect(slot).not.toBeNull();
    expect([1, 3, 5]).toContain(slot.getUTCDay());
    expect(slot.getUTCHours()).toBe(9);
    expect(slot.getUTCMinutes()).toBe(0);
    expect(slot.getTime()).toBeGreaterThan(from.getTime());
  });

  it('uses the same day when `from` is before timeOfDay on a configured day', () => {
    const from = new Date('2026-07-06T08:00:00Z'); // Monday 08:00, day is configured
    const slot = nextCadenceSlot(cadence(), from)!;
    expect(slot.getUTCDate()).toBe(6);
    expect(slot.getUTCHours()).toBe(9);
  });

  it('returns null when no weekday is configured', () => {
    expect(nextCadenceSlot(cadence({ daysOfWeek: [] }), new Date())).toBeNull();
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- cadence.util` → fails: `Cannot find module './cadence.util'`.
- [ ] **Step 3: Implement** — `cadence.util.ts`:
```ts
export interface Cadence {
  perWeek?: number;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  /** 'HH:MM', interpreted in UTC; `timezone` is stored for display only. */
  timeOfDay: string;
  timezone?: string;
}

/**
 * The next slot strictly after `from` whose weekday is one of cadence.daysOfWeek
 * at cadence.timeOfDay (UTC). Scans the next 8 days (covers same-day-later plus
 * a full week wrap). Returns null when no weekday is configured.
 */
export function nextCadenceSlot(cadence: Cadence, from: Date): Date | null {
  const days = (cadence.daysOfWeek ?? []).filter((d) => d >= 0 && d <= 6);
  if (days.length === 0) return null;
  const [hh, mm] = (cadence.timeOfDay ?? '09:00').split(':').map((n) => parseInt(n, 10));
  for (let offset = 0; offset <= 7; offset++) {
    const cand = new Date(from);
    cand.setUTCDate(cand.getUTCDate() + offset);
    cand.setUTCHours(hh || 0, mm || 0, 0, 0);
    if (days.includes(cand.getUTCDay()) && cand.getTime() > from.getTime()) return cand;
  }
  return null;
}
```
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- cadence.util`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): cadence next-slot helper"`

---

### Task 20: SocialCampaignsService — CRUD + lifecycle (activate/pause/resume/cancel) + plan confirm

**Files:**
- Create: `backend/src/modules/marketing/social-campaigns/social-campaigns.service.ts`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `ScheduledJobService.schedule(opts, tx?)`, `ScheduledJobService.cancel(kind, dedupKey, tx?)`; `ScheduledJobRunnerService.registerHandler(kind, fn)`; `ClaimedJob`, `JobHandlerResult` from `../scheduling/scheduled-job-runner.service`; `ContentAiService`, `SocialPlannerService`, `AnthropicService`, `AiCreditsService`, `MediaGenService` (constructor injection only here).
- Produces: kind constants `SOCIAL_CAMPAIGN_PLAN_KIND='social.campaign.plan'`, `SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND='social.campaign.item.generate'`, `SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND='social.campaign.item.confirm'`; `planDedup(id)`, `generateDedup(id)`, `confirmDedup(id)`; methods `create/list/get/update/activate/pause/resume/cancel/listItems/confirmPlan/bumpStats`; private helper `getOwned`. The job-handler methods (`planTick`, `generateItem`, `confirmItem`) are added in Tasks 21–22.

- [ ] **Step 1: Write the failing test** (plain-mock convention):
```ts
// social-campaigns.service.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SocialCampaignsService,
  SOCIAL_CAMPAIGN_PLAN_KIND,
  SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND,
  planDedup,
} from './social-campaigns.service';

const WS = 'ws-1';

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', goal: 'awareness', theme: 'summer',
    brief: { audience: 'SMBs', topics: ['t1', 't2'] }, status: 'DRAFT',
    automationMode: 'APPROVAL', planningMode: 'AI_FULL',
    cadence: { daysOfWeek: [1, 3], timeOfDay: '09:00', timezone: 'UTC' },
    startDate: new Date('2026-07-01T00:00:00Z'), endDate: null,
    targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'], dailyPublishCap: 2,
    defaultImageModel: null, defaultVideoModel: null, createdById: 'u-1', stats: null,
    ...over,
  };
}

function build() {
  const prisma: any = {
    socialCampaign: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    socialCampaignItem: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
    socialPost: { create: jest.fn(), findFirst: jest.fn() },
    brandKit: { findUnique: jest.fn() },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1'), cancel: jest.fn().mockResolvedValue(true) };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn() };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
  );
  return { svc, prisma, scheduledJobs, runner, contentAi, planner, anthropic, credits, mediaGen };
}

describe('SocialCampaignsService — lifecycle + plan confirm', () => {
  it('registers the three job kinds on init', () => {
    const { svc, runner } = build();
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_PLAN_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, expect.any(Function));
    expect(runner.registerHandler).toHaveBeenCalledTimes(3);
  });

  it('activate DRAFT → ACTIVE and enqueues the planner with a stable dedupKey', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'DRAFT' }));
    prisma.socialCampaign.update.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    await svc.activate(WS, 'c-1');
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'ACTIVE' } });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_PLAN_KIND, dedupKey: planDedup('c-1'),
      payload: { campaignId: 'c-1', workspaceId: WS },
    }));
  });

  it('activate rejects from a terminal status', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'CANCELLED' }));
    await expect(svc.activate(WS, 'c-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pause → PAUSED and cancels the planner job', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'ACTIVE' }));
    prisma.socialCampaign.update.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    await svc.pause(WS, 'c-1');
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'PAUSED' } });
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup('c-1'));
  });

  it('confirmPlan fans out generation for PLANNED items with a topic', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce({ id: 'c-1', planningMode: 'AI_PROPOSE' });
    prisma.socialCampaignItem.findMany.mockResolvedValueOnce([{ id: 'i-1' }, { id: 'i-2' }]);
    const res = await svc.confirmPlan(WS, 'c-1');
    expect(res).toEqual({ confirmed: 2 });
    expect(scheduledJobs.schedule).toHaveBeenCalledTimes(2);
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, payload: { itemId: 'i-1', workspaceId: WS },
    }));
  });

  it('get throws NotFound for a cross-workspace id', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(null);
    await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- social-campaigns.service` → fails: `Cannot find module './social-campaigns.service'`.
- [ ] **Step 3: Implement** — `social-campaigns.service.ts` (the three handler methods are stubbed here as `private` and filled in Tasks 21–22; `onModuleInit` registers all three so wiring is testable now):
```ts
import {
  BadRequestException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService, ClaimedJob, JobHandlerResult,
} from '../scheduling/scheduled-job-runner.service';
import { ContentAiService } from '../ai/content-ai.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { MediaGenService } from '../ai/media/media-gen.service'; // Milestone 1
import { SocialPlannerService } from '../social-planner/social-planner.service';
import { Cadence, nextCadenceSlot } from './cadence.util';

export const SOCIAL_CAMPAIGN_PLAN_KIND = 'social.campaign.plan';
export const SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND = 'social.campaign.item.generate';
export const SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND = 'social.campaign.item.confirm';

export const planDedup = (id: string) => `social-campaign-plan-${id}`;
export const generateDedup = (id: string) => `social-campaign-generate-${id}`;
export const confirmDedup = (id: string) => `social-campaign-confirm-${id}`;

export interface CreateSocialCampaignInput {
  name: string;
  goal?: string;
  theme?: string;
  brief: Record<string, unknown>;
  automationMode: 'APPROVAL' | 'SEMI_AUTO' | 'FULL_AUTO';
  planningMode: 'AI_PROPOSE' | 'AI_FULL' | 'USER_TOPICS';
  cadence: Cadence;
  startDate: Date;
  endDate?: Date;
  targetAccountIds: string[];
  mediaKinds: string[];
  defaultImageModel?: string;
  defaultVideoModel?: string;
  dailyPublishCap?: number;
  linkedCampaignId?: string;
  createdById: string;
}

@Injectable()
export class SocialCampaignsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly contentAi: ContentAiService,
    private readonly planner: SocialPlannerService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly mediaGen: MediaGenService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(SOCIAL_CAMPAIGN_PLAN_KIND, (job: ClaimedJob) =>
      this.planTick(job.payload.campaignId, job.payload.workspaceId));
    this.runner.registerHandler(SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, (job: ClaimedJob) =>
      this.generateItem(job.payload.itemId, job.payload.workspaceId));
    this.runner.registerHandler(SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, (job: ClaimedJob) =>
      this.confirmItem(job.payload.itemId, job.payload.workspaceId));
  }

  // ───────────────────────────────────────────────────────────── CRUD

  async create(workspaceId: string, input: CreateSocialCampaignInput) {
    return this.prisma.socialCampaign.create({
      data: {
        workspaceId,
        name: input.name,
        goal: input.goal ?? null,
        theme: input.theme ?? null,
        brief: input.brief as Prisma.InputJsonValue,
        automationMode: input.automationMode,
        planningMode: input.planningMode,
        cadence: input.cadence as unknown as Prisma.InputJsonValue,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        targetAccountIds: input.targetAccountIds,
        mediaKinds: input.mediaKinds,
        defaultImageModel: input.defaultImageModel ?? null,
        defaultVideoModel: input.defaultVideoModel ?? null,
        dailyPublishCap: input.dailyPublishCap ?? 2,
        linkedCampaignId: input.linkedCampaignId ?? null,
        createdById: input.createdById,
        status: 'DRAFT',
      },
    });
  }

  list(workspaceId: string) {
    return this.prisma.socialCampaign.findMany({
      where: { workspaceId }, orderBy: { createdAt: 'desc' },
    });
  }

  async get(workspaceId: string, id: string) {
    return this.getOwned(workspaceId, id);
  }

  async update(workspaceId: string, id: string, patch: Partial<CreateSocialCampaignInput>) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT campaigns can be edited');
    }
    return this.prisma.socialCampaign.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief as Prisma.InputJsonValue } : {}),
        ...(patch.automationMode !== undefined ? { automationMode: patch.automationMode } : {}),
        ...(patch.planningMode !== undefined ? { planningMode: patch.planningMode } : {}),
        ...(patch.cadence !== undefined ? { cadence: patch.cadence as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
        ...(patch.targetAccountIds !== undefined ? { targetAccountIds: patch.targetAccountIds } : {}),
        ...(patch.mediaKinds !== undefined ? { mediaKinds: patch.mediaKinds } : {}),
        ...(patch.defaultImageModel !== undefined ? { defaultImageModel: patch.defaultImageModel } : {}),
        ...(patch.defaultVideoModel !== undefined ? { defaultVideoModel: patch.defaultVideoModel } : {}),
        ...(patch.dailyPublishCap !== undefined ? { dailyPublishCap: patch.dailyPublishCap } : {}),
        ...(patch.linkedCampaignId !== undefined ? { linkedCampaignId: patch.linkedCampaignId } : {}),
      },
    });
  }

  listItems(workspaceId: string, campaignId: string) {
    return this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, socialCampaignId: campaignId },
      orderBy: { sequenceIndex: 'asc' },
    });
  }

  // ──────────────────────────────────────────────────────── Lifecycle

  async activate(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (!['DRAFT', 'PAUSED'].includes(c.status)) {
      throw new BadRequestException(`Cannot activate from ${c.status}`);
    }
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.enqueuePlan(workspaceId, id);
    return this.get(workspaceId, id);
  }

  async resume(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'PAUSED') throw new BadRequestException(`Cannot resume from ${c.status}`);
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.enqueuePlan(workspaceId, id);
    return this.get(workspaceId, id);
  }

  async pause(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (c.status !== 'ACTIVE') throw new BadRequestException(`Cannot pause from ${c.status}`);
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'PAUSED' } });
    await this.scheduledJobs.cancel(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup(id));
    return this.get(workspaceId, id);
  }

  async cancel(workspaceId: string, id: string) {
    const c = await this.getOwned(workspaceId, id);
    if (['COMPLETED', 'CANCELLED'].includes(c.status)) {
      throw new BadRequestException(`Cannot cancel from ${c.status}`);
    }
    await this.prisma.socialCampaign.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.scheduledJobs.cancel(SOCIAL_CAMPAIGN_PLAN_KIND, planDedup(id));
    return this.get(workspaceId, id);
  }

  /** AI_PROPOSE: user confirms the proposed plan → fan out generation. */
  async confirmPlan(workspaceId: string, campaignId: string): Promise<{ confirmed: number }> {
    const c = await this.prisma.socialCampaign.findFirst({
      where: { id: campaignId, workspaceId }, select: { id: true, planningMode: true },
    });
    if (!c) throw new NotFoundException('Social campaign not found');
    const items = await this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, socialCampaignId: campaignId, status: 'PLANNED', topic: { not: null } },
      select: { id: true },
    });
    for (const it of items) {
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
        payload: { itemId: it.id, workspaceId }, dedupKey: generateDedup(it.id),
      });
    }
    return { confirmed: items.length };
  }

  // ──────────────────────────────────────────────────────── Helpers

  private async enqueuePlan(workspaceId: string, id: string) {
    await this.scheduledJobs.schedule({
      workspaceId, kind: SOCIAL_CAMPAIGN_PLAN_KIND, runAt: new Date(),
      payload: { campaignId: id, workspaceId }, dedupKey: planDedup(id),
    });
  }

  private async getOwned(workspaceId: string, id: string) {
    const c = await this.prisma.socialCampaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw new NotFoundException('Social campaign not found');
    return c;
  }

  async bumpStats(campaignId: string, delta: Record<string, number>): Promise<void> {
    const c = await this.prisma.socialCampaign.findUnique({
      where: { id: campaignId }, select: { stats: true },
    });
    const stats = { ...((c?.stats as Record<string, number>) ?? {}) };
    for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] ?? 0) + v;
    await this.prisma.socialCampaign.update({
      where: { id: campaignId }, data: { stats: stats as Prisma.InputJsonValue },
    });
  }

  // Filled in by Tasks 21 (planTick, generateItem) and 22 (confirmItem).
  private async planTick(_campaignId: string, _workspaceId: string): Promise<JobHandlerResult> { return; }
  private async generateItem(_itemId: string, _workspaceId: string): Promise<void> { return; }
  private async confirmItem(_itemId: string, _workspaceId: string): Promise<JobHandlerResult> { return; }
}
```
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- social-campaigns.service`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): service CRUD, lifecycle, plan-confirm + job registration"`

---

### Task 21: Planner `social.campaign.plan` (3 planning modes, cadence ticks, stop-on-pause) + `social.campaign.item.generate` (3 automation modes)

**Files:**
- Modify: `backend/src/modules/marketing/social-campaigns/social-campaigns.service.ts`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaigns.planner.spec.ts`

**Interfaces:**
- Consumes: `nextCadenceSlot(cadence, from)`; `ContentAiService.compose(workspaceId, { kind:'social', goal, tone?, audience?, context?, variants? }): Promise<{ body: string; subject?: string; variants?: string[] }>`; `MediaGenService.requestGeneration(workspaceId, { type:'IMAGE'|'VIDEO'; prompt; model?; aspectRatio?; durationSec?; referenceImageUrls?; socialCampaignId?; campaignItemId? }, createdById): Promise<{ assetId: string }>` (Milestone 1); `ScheduledJobService.schedule`; `JobRescheduleDirective`.
- Produces: implemented `planTick(campaignId, workspaceId): Promise<JobHandlerResult>` and `generateItem(itemId, workspaceId): Promise<void>`.

- [ ] **Step 1: Write the failing test:**
```ts
// social-campaigns.planner.spec.ts
import {
  SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND,
} from './social-campaigns.service';

const WS = 'ws-1';

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', goal: 'awareness', theme: 'summer',
    brief: { audience: 'SMBs', topics: ['User topic A', 'User topic B'] }, status: 'ACTIVE',
    automationMode: 'APPROVAL', planningMode: 'AI_FULL',
    cadence: { daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'UTC' },
    startDate: new Date('2026-07-01T00:00:00Z'), endDate: null,
    targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'], dailyPublishCap: 2,
    defaultImageModel: 'fal-ai/qwen-image', defaultVideoModel: null, createdById: 'u-1', stats: null,
    ...over,
  };
}

function build() {
  const prisma: any = {
    socialCampaign: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    socialCampaignItem: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn() },
    socialPost: { create: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    brandKit: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const scheduledJobs = { schedule: jest.fn().mockResolvedValue('j'), cancel: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn().mockResolvedValue({ body: 'AI topic line\nrest' }) };
  const planner = { schedulePost: jest.fn() };
  const anthropic = { isEnabled: () => true, complete: jest.fn() };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'a-1' }) };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
  );
  return { svc, prisma, scheduledJobs, contentAi, mediaGen };
}

const plan = (svc: any, ws = WS) => (svc as any).planTick('c-1', ws);
const gen = (svc: any, ws = WS) => (svc as any).generateItem('i-1', ws);

describe('planTick — planning modes + cadence + stop', () => {
  it('AI_FULL: derives a topic, creates an item, fans out generation, reschedules', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'AI_FULL' }));
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    const res = await plan(svc);
    expect(contentAi.compose).toHaveBeenCalledTimes(1);
    expect(prisma.socialCampaignItem.create).toHaveBeenCalled();
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, payload: { itemId: 'i-1', workspaceId: WS },
    }));
    expect(res).toEqual({ reschedule: expect.objectContaining({ payload: { campaignId: 'c-1', workspaceId: WS } }) });
  });

  it('AI_PROPOSE: creates a PLANNED item but does NOT fan out generation', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'AI_PROPOSE' }));
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    await plan(svc);
    expect(contentAi.compose).toHaveBeenCalledTimes(1);
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND }),
    );
  });

  it('USER_TOPICS: uses brief.topics (no AI topic call) and fans out generation', async () => {
    const { svc, prisma, scheduledJobs, contentAi } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ planningMode: 'USER_TOPICS' }));
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0); // 0 items so far → topics[0]
    prisma.socialCampaignItem.create.mockResolvedValueOnce({ id: 'i-1' });
    await plan(svc);
    expect(contentAi.compose).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ topic: 'User topic A' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND }),
    );
  });

  it('stop-on-pause: a non-ACTIVE campaign creates nothing and does not reschedule', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(makeCampaign({ status: 'PAUSED' }));
    const res = await plan(svc);
    expect(res).toBeUndefined();
    expect(prisma.socialCampaignItem.create).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('completes when the next slot is past endDate', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaign.findFirst.mockResolvedValueOnce(
      makeCampaign({ endDate: new Date('2026-07-01T00:00:00Z') }),
    );
    await plan(svc);
    expect(prisma.socialCampaign.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { status: 'COMPLETED' } });
  });
});

describe('generateItem — automation-mode transitions', () => {
  function primeItem(prisma: any, automationMode: string) {
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce({
      id: 'i-1', socialCampaignId: 'c-1', workspaceId: WS, scheduledFor: new Date('2026-07-08T09:00:00Z'),
      status: 'PLANNED', topic: 'Topic', campaign: makeCampaign({ automationMode }),
    });
  }

  it('composes copy, requests media, creates a draft post linked to the campaign', async () => {
    const { svc, prisma, contentAi, mediaGen } = build();
    primeItem(prisma, 'APPROVAL');
    await gen(svc);
    expect(contentAi.compose).toHaveBeenCalledWith(WS, expect.objectContaining({ kind: 'social' }));
    expect(mediaGen.requestGeneration).toHaveBeenCalledWith(
      WS, expect.objectContaining({ type: 'IMAGE', socialCampaignId: 'c-1', campaignItemId: 'i-1' }), 'u-1',
    );
    expect(prisma.socialPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ socialCampaignId: 'c-1', campaignItemId: 'i-1', status: 'DRAFT' }) }),
    );
  });

  it('APPROVAL → item NEEDS_APPROVAL, no confirm job', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'APPROVAL');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_APPROVAL', socialPostId: 'post-1' }) }),
    );
    expect(scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND }),
    );
  });

  it('SEMI_AUTO → item SCHEDULED + confirm gate enqueued at scheduledFor', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'SEMI_AUTO');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, runAt: new Date('2026-07-08T09:00:00Z'),
      payload: { itemId: 'i-1', workspaceId: WS },
    }));
  });

  it('FULL_AUTO → item SCHEDULED + confirm gate enqueued', async () => {
    const { svc, prisma, scheduledJobs } = build();
    primeItem(prisma, 'FULL_AUTO');
    await gen(svc);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SCHEDULED' }) }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND }),
    );
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- social-campaigns.planner` → fails: `planTick` returns `undefined` (stub) so AI_FULL assertions on `compose`/`create`/`schedule` fail.
- [ ] **Step 3: Implement** — replace the two stub methods in `social-campaigns.service.ts` (delete the `planTick`/`generateItem` stubs):
```ts
  // ──────────────────────────────────────────── social.campaign.plan

  private async planTick(campaignId: string, workspaceId: string): Promise<JobHandlerResult> {
    const c = await this.prisma.socialCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!c || c.status !== 'ACTIVE') return; // stop-on-pause / cancel / completed

    const last = await this.prisma.socialCampaignItem.findFirst({
      where: { socialCampaignId: campaignId },
      orderBy: { scheduledFor: 'desc' },
      select: { scheduledFor: true, sequenceIndex: true },
    });
    const now = new Date();
    const from = last?.scheduledFor && last.scheduledFor > now ? last.scheduledFor
      : c.startDate > now ? c.startDate : now;
    const slot = nextCadenceSlot(c.cadence as unknown as Cadence, from);
    if (!slot || (c.endDate && slot > c.endDate)) {
      await this.prisma.socialCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
      return;
    }

    const brief = (c.brief ?? {}) as Record<string, any>;
    let topic: string | undefined;
    if (c.planningMode === 'USER_TOPICS') {
      const topics: string[] = Array.isArray(brief.topics) ? brief.topics : [];
      const used = await this.prisma.socialCampaignItem.count({ where: { socialCampaignId: campaignId } });
      topic = topics[used];
      if (!topic) return; // user supplied no further topics — idle (no reschedule)
    } else {
      const t = await this.contentAi.compose(workspaceId, {
        kind: 'social',
        goal: `Propose ONE short, concrete post topic (max 12 words) for: ${c.goal ?? c.name}. `
          + `Theme: ${c.theme ?? ''}. Reply with only the topic, no preamble.`,
        audience: brief.audience,
      });
      topic = t.body.split('\n')[0].trim().slice(0, 200);
    }

    const seq = (last?.sequenceIndex ?? -1) + 1;
    const item = await this.prisma.socialCampaignItem.create({
      data: { socialCampaignId: campaignId, workspaceId, sequenceIndex: seq, scheduledFor: slot, status: 'PLANNED', topic: topic ?? null },
    });
    await this.bumpStats(campaignId, { planned: 1 });

    // AI_PROPOSE waits for the user to confirm the plan (Task 20.confirmPlan).
    if (c.planningMode !== 'AI_PROPOSE') {
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
        payload: { itemId: item.id, workspaceId }, dedupKey: generateDedup(item.id),
      });
    }
    return { reschedule: { runAt: slot, payload: { campaignId, workspaceId } } };
  }

  // ─────────────────────────────────── social.campaign.item.generate

  private async generateItem(itemId: string, workspaceId: string): Promise<void> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId }, include: { campaign: true },
    });
    if (!item || !item.campaign || item.campaign.status !== 'ACTIVE') return;
    const c = item.campaign;
    await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'GENERATING' } });

    const brandKit = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
    const brief = (c.brief ?? {}) as Record<string, any>;

    let copy: { body: string };
    try {
      copy = await this.contentAi.compose(workspaceId, {
        kind: 'social',
        goal: item.topic ?? c.goal ?? c.name,
        tone: (brandKit as any)?.tone ?? undefined,
        audience: brief.audience,
        context: [c.theme, brief.keyMessages, (brandKit as any)?.defaultCta].filter(Boolean).join('\n') || undefined,
      });
    } catch (e) {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'FAILED', error: String((e as Error).message).slice(0, 500) },
      });
      return;
    }

    const refImages: string[] = Array.isArray((brandKit as any)?.referenceImages)
      ? ((brandKit as any).referenceImages as any[]).map((r) => r?.url).filter(Boolean) : [];
    const kinds = c.mediaKinds.length ? c.mediaKinds : ['IMAGE'];
    const assetIds: string[] = [];
    for (const kind of kinds) {
      const isVideo = kind === 'VIDEO';
      const { assetId } = await this.mediaGen.requestGeneration(workspaceId, {
        type: isVideo ? 'VIDEO' : 'IMAGE',
        prompt: `${item.topic ?? c.theme ?? c.name}. ${copy.body}`.slice(0, 1500),
        model: (isVideo ? c.defaultVideoModel : c.defaultImageModel) ?? undefined,
        referenceImageUrls: refImages,
        socialCampaignId: c.id,
        campaignItemId: item.id,
      }, c.createdById);
      assetIds.push(assetId);
    }

    const hashtags = Array.isArray((brandKit as any)?.defaultHashtags)
      ? ((brandKit as any).defaultHashtags as string[]).join(' ') : '';
    const post = await this.prisma.socialPost.create({
      data: {
        workspaceId, content: [copy.body, hashtags].filter(Boolean).join('\n\n'),
        mediaUrls: [], status: 'DRAFT', socialCampaignId: c.id, campaignItemId: item.id,
      },
    });

    if (c.automationMode === 'APPROVAL') {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'NEEDS_APPROVAL', socialPostId: post.id, generatedAssetIds: assetIds },
      });
    } else {
      // SEMI_AUTO + FULL_AUTO: schedule the slot and gate it at scheduledFor.
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'SCHEDULED', socialPostId: post.id, generatedAssetIds: assetIds },
      });
      await this.scheduledJobs.schedule({
        workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_CONFIRM_KIND, runAt: item.scheduledFor,
        payload: { itemId, workspaceId }, dedupKey: confirmDedup(itemId),
      });
    }
    await this.bumpStats(c.id, { generated: 1 });
  }
```
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- social-campaigns.planner`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): planner ticks (3 planning modes) + item-generate (3 automation modes)"`

---

### Task 22: `social.campaign.item.confirm` (SEMI_AUTO/FULL_AUTO gate, dailyPublishCap rollover, brand-safety check) + item approve/reject/regenerate

**Files:**
- Modify: `backend/src/modules/marketing/social-campaigns/social-campaigns.service.ts`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaigns.confirm.spec.ts`

**Interfaces:**
- Consumes: `AnthropicService.isEnabled()`, `AnthropicService.complete({ system, messages, maxTokens?, tier? }): Promise<{ text: string }>`; `AiCreditsService.reserve(ws, cost)` / `refund(ws, cost)`; `creditCost('workflow.ai_classify')`, `tierFor('workflow.ai_classify')` from `../ai/ai-credit-costs`; `SocialPlannerService.schedulePost(workspaceId, postId, scheduledAt, targetAccountIds?)`; `JobRescheduleDirective`.
- Produces: implemented `confirmItem(itemId, workspaceId): Promise<JobHandlerResult>`; public `approveItem`, `rejectItem`, `regenerateItem`.

- [ ] **Step 1: Write the failing test:**
```ts
// social-campaigns.confirm.spec.ts
import { NotFoundException } from '@nestjs/common';
import { SocialCampaignsService, SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, generateDedup } from './social-campaigns.service';

const WS = 'ws-1';
const SLOT = new Date('2026-07-08T09:00:00Z');

function makeCampaign(over: Partial<any> = {}) {
  return {
    id: 'c-1', workspaceId: WS, name: 'Launch', status: 'ACTIVE', automationMode: 'FULL_AUTO',
    targetAccountIds: ['acc-1'], dailyPublishCap: 2, ...over,
  };
}
function makeItem(over: Partial<any> = {}) {
  return { id: 'i-1', socialCampaignId: 'c-1', workspaceId: WS, scheduledFor: SLOT, status: 'SCHEDULED', socialPostId: 'post-1', campaign: makeCampaign(), ...over };
}

function build() {
  const prisma: any = {
    socialCampaign: { findUnique: jest.fn().mockResolvedValue({ stats: null }), update: jest.fn() },
    socialCampaignItem: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), update: jest.fn() },
    socialPost: { findFirst: jest.fn().mockResolvedValue({ id: 'post-1', content: 'Nice copy' }) },
  };
  const scheduledJobs = { schedule: jest.fn(), cancel: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const contentAi = { compose: jest.fn() };
  const planner = { schedulePost: jest.fn().mockResolvedValue({}) };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn().mockResolvedValue({ text: 'SAFE' }) };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  const mediaGen = { requestGeneration: jest.fn() };
  const svc = new SocialCampaignsService(
    prisma, scheduledJobs as any, runner as any, contentAi as any,
    planner as any, anthropic as any, credits as any, mediaGen as any,
  );
  return { svc, prisma, scheduledJobs, planner, anthropic, credits };
}
const confirm = (svc: any) => (svc as any).confirmItem('i-1', WS);

describe('confirmItem — gate, cap rollover, brand-safety', () => {
  it('FULL_AUTO under cap + SAFE copy → publishes via the planner, item PUBLISHED', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(0);
    await confirm(svc);
    expect(planner.schedulePost).toHaveBeenCalledWith(WS, 'post-1', expect.any(Date), ['acc-1']);
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) }),
    );
  });

  it('over dailyPublishCap → reschedules to the next day, no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    prisma.socialCampaignItem.count.mockResolvedValueOnce(2); // cap = 2 already published today
    const res = await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    const next = new Date('2026-07-09T09:00:00Z');
    expect(res).toEqual({ reschedule: { runAt: next, payload: { itemId: 'i-1', workspaceId: WS } } });
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scheduledFor: next }) }),
    );
  });

  it('brand-safety BLOCK → item SKIPPED, no publish, no double-charge (refund only on error)', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.complete.mockResolvedValueOnce({ text: 'BLOCK' });
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED', error: expect.stringContaining('brand-safety') }) }),
    );
  });

  it('a user veto (item already SKIPPED) cancels the pending publish job', async () => {
    const { svc, prisma, scheduledJobs, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'SKIPPED' }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('stop-on-pause: paused campaign → no publish', async () => {
    const { svc, prisma, planner } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ campaign: makeCampaign({ status: 'PAUSED' }) }));
    await confirm(svc);
    expect(planner.schedulePost).not.toHaveBeenCalled();
  });

  it('skips the Claude check (treats as safe) when AI is disabled', async () => {
    const { svc, prisma, planner, anthropic } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem());
    anthropic.isEnabled.mockReturnValue(false);
    await confirm(svc);
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(planner.schedulePost).toHaveBeenCalled();
  });
});

describe('item approve / reject / regenerate', () => {
  it('approveItem: NEEDS_APPROVAL → APPROVED', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.approveItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'APPROVED' } }),
    );
  });

  it('rejectItem → SKIPPED', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'NEEDS_APPROVAL' }));
    await svc.rejectItem(WS, 'i-1');
    expect(prisma.socialCampaignItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SKIPPED' } }),
    );
  });

  it('regenerateItem re-enqueues generation', async () => {
    const { svc, prisma, scheduledJobs } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(makeItem({ status: 'FAILED' }));
    await svc.regenerateItem(WS, 'i-1');
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, dedupKey: generateDedup('i-1'),
    }));
  });

  it('approveItem throws NotFound for an unknown item', async () => {
    const { svc, prisma } = build();
    prisma.socialCampaignItem.findFirst.mockResolvedValueOnce(null);
    await expect(svc.approveItem(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- social-campaigns.confirm` → fails: `confirmItem` stub returns undefined (no publish/reschedule) and `approveItem` is not a function.
- [ ] **Step 3: Implement** — add the import and replace the `confirmItem` stub; add the three public methods. At the top, extend imports:
```ts
import { creditCost, tierFor } from '../ai/ai-credit-costs';
```
Replace the `confirmItem` stub with:
```ts
  // ──────────────────────────────────── social.campaign.item.confirm

  private async confirmItem(itemId: string, workspaceId: string): Promise<JobHandlerResult> {
    const item = await this.prisma.socialCampaignItem.findFirst({
      where: { id: itemId, workspaceId }, include: { campaign: true },
    });
    if (!item || !item.campaign || !item.socialPostId) return;
    const c = item.campaign;
    if (c.status !== 'ACTIVE') return; // stop-on-pause / cancel

    // User veto (reject set the item SKIPPED before the gate fired).
    if (item.status !== 'SCHEDULED') return;

    // dailyPublishCap rollover — count items already PUBLISHED in this UTC day.
    const dayStart = new Date(item.scheduledFor); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const publishedToday = await this.prisma.socialCampaignItem.count({
      where: { socialCampaignId: c.id, status: 'PUBLISHED', scheduledFor: { gte: dayStart, lt: dayEnd } },
    });
    if (publishedToday >= c.dailyPublishCap) {
      const next = new Date(item.scheduledFor); next.setUTCDate(next.getUTCDate() + 1);
      await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { scheduledFor: next } });
      return { reschedule: { runAt: next, payload: { itemId, workspaceId } } };
    }

    const post = await this.prisma.socialPost.findFirst({
      where: { id: item.socialPostId, workspaceId }, select: { id: true, content: true },
    });
    if (!post) return;

    const safe = await this.brandSafetyCheck(workspaceId, post.content);
    if (!safe) {
      await this.prisma.socialCampaignItem.update({
        where: { id: itemId }, data: { status: 'SKIPPED', error: 'Blocked by brand-safety check' },
      });
      return;
    }

    // Hand off to the existing social.publish path (per-network adapters unchanged).
    await this.planner.schedulePost(workspaceId, post.id, new Date(), c.targetAccountIds);
    await this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'PUBLISHED' } });
    await this.bumpStats(c.id, { published: 1 });
  }

  /** SAFE/BLOCK copy screen via Claude; inert (allow) when AI is disabled. */
  private async brandSafetyCheck(workspaceId: string, copy: string): Promise<boolean> {
    if (!this.anthropic.isEnabled()) return true;
    await this.credits.reserve(workspaceId, creditCost('workflow.ai_classify'));
    try {
      const res = await this.anthropic.complete({
        system: 'You are a brand-safety reviewer. Reply with exactly one word: SAFE or BLOCK. '
          + 'BLOCK only for hate, harassment, sexually explicit, illegal, or defamatory content.',
        messages: [{ role: 'user', content: copy.slice(0, 2000) }],
        maxTokens: 4,
        tier: tierFor('workflow.ai_classify'),
      });
      return !/BLOCK/i.test(res.text);
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('workflow.ai_classify'));
      return true; // fail-open on transient errors — don't strand the chain
    }
  }

  // ──────────────────────────────────────────── Approval-queue actions

  async approveItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
    if (item.status !== 'NEEDS_APPROVAL') {
      throw new BadRequestException(`Cannot approve an item in status ${item.status}`);
    }
    return this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'APPROVED' } });
  }

  async rejectItem(workspaceId: string, itemId: string) {
    await this.getOwnedItem(workspaceId, itemId);
    return this.prisma.socialCampaignItem.update({ where: { id: itemId }, data: { status: 'SKIPPED' } });
  }

  async regenerateItem(workspaceId: string, itemId: string) {
    const item = await this.getOwnedItem(workspaceId, itemId);
    await this.scheduledJobs.schedule({
      workspaceId, kind: SOCIAL_CAMPAIGN_ITEM_GENERATE_KIND, runAt: new Date(),
      payload: { itemId, workspaceId }, dedupKey: generateDedup(itemId),
    });
    return item;
  }

  private async getOwnedItem(workspaceId: string, itemId: string) {
    const item = await this.prisma.socialCampaignItem.findFirst({ where: { id: itemId, workspaceId } });
    if (!item) throw new NotFoundException('Campaign item not found');
    return item;
  }
```
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- social-campaigns.confirm` (and re-run `npm test -- social-campaigns` to confirm no regressions).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): item-confirm gate (cap rollover + brand-safety) + approve/reject/regenerate"`

---

### Task 23: Controller + module wiring (`socialCampaigns` feature gate)

**Files:**
- Create: `backend/src/modules/marketing/social-campaigns/social-campaigns.controller.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `SocialCampaignsService` (all public methods from Tasks 20–22); guard/decorator stack from `social-planner.controller.ts` plus `FeatureGuard`/`RequiresFeature` from `../guards/feature.guard`; `MarketingUserPayload` (`u.workspaceId`, `u.userId`).
- Produces: REST surface under `/marketing/social-campaigns` matching spec §8.

- [ ] **Step 1: Write the failing test** (thin controller→service delegation, plain mock):
```ts
// social-campaigns.controller.spec.ts
import { SocialCampaignsController } from './social-campaigns.controller';

const u: any = { workspaceId: 'ws-1', userId: 'u-1' };

function build() {
  const svc = {
    create: jest.fn().mockResolvedValue({ id: 'c-1' }),
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'c-1' }),
    update: jest.fn().mockResolvedValue({ id: 'c-1' }),
    activate: jest.fn().mockResolvedValue({ id: 'c-1', status: 'ACTIVE' }),
    pause: jest.fn(), resume: jest.fn(), cancel: jest.fn(),
    listItems: jest.fn().mockResolvedValue([]),
    confirmPlan: jest.fn().mockResolvedValue({ confirmed: 0 }),
    approveItem: jest.fn(), rejectItem: jest.fn(), regenerateItem: jest.fn(),
  };
  return { ctrl: new SocialCampaignsController(svc as any), svc };
}

describe('SocialCampaignsController', () => {
  it('create passes workspaceId + createdById and coerces dates', async () => {
    const { ctrl, svc } = build();
    await ctrl.create({
      name: 'Launch', brief: { audience: 'x' }, automationMode: 'APPROVAL', planningMode: 'AI_FULL',
      cadence: { daysOfWeek: [1], timeOfDay: '09:00' }, startDate: '2026-07-01T00:00:00Z',
      targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'],
    } as any, u);
    expect(svc.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      name: 'Launch', createdById: 'u-1', startDate: new Date('2026-07-01T00:00:00Z'),
    }));
  });

  it('activate delegates by id', async () => {
    const { ctrl, svc } = build();
    await ctrl.activate('c-1', u);
    expect(svc.activate).toHaveBeenCalledWith('ws-1', 'c-1');
  });

  it('confirmPlan delegates', async () => {
    const { ctrl, svc } = build();
    await ctrl.confirmPlan('c-1', u);
    expect(svc.confirmPlan).toHaveBeenCalledWith('ws-1', 'c-1');
  });

  it('item actions delegate by itemId', async () => {
    const { ctrl, svc } = build();
    await ctrl.approveItem('i-1', u);
    await ctrl.rejectItem('i-1', u);
    await ctrl.regenerateItem('i-1', u);
    expect(svc.approveItem).toHaveBeenCalledWith('ws-1', 'i-1');
    expect(svc.rejectItem).toHaveBeenCalledWith('ws-1', 'i-1');
    expect(svc.regenerateItem).toHaveBeenCalledWith('ws-1', 'i-1');
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `cd backend && npm test -- social-campaigns.controller` → fails: `Cannot find module './social-campaigns.controller'`.
- [ ] **Step 3: Implement** — `social-campaigns.controller.ts`:
```ts
import {
  Body, Controller, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString,
  ArrayMaxSize, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SocialCampaignsService } from './social-campaigns.service';

const AUTOMATION = ['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'] as const;
const PLANNING = ['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'] as const;

class CadenceDto {
  @IsOptional() @IsInt() @Min(1) perWeek?: number;
  @IsArray() @IsInt({ each: true }) @ArrayMaxSize(7) daysOfWeek: number[];
  @IsString() @MaxLength(5) timeOfDay: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

class CreateSocialCampaignDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(500) goal?: string;
  @IsOptional() @IsString() @MaxLength(500) theme?: string;
  @IsObject() brief: Record<string, unknown>;
  @IsIn(AUTOMATION) automationMode: (typeof AUTOMATION)[number];
  @IsIn(PLANNING) planningMode: (typeof PLANNING)[number];
  @ValidateNested() @Type(() => CadenceDto) cadence: CadenceDto;
  @IsDateString() startDate: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) targetAccountIds: string[];
  @IsArray() @IsIn(['IMAGE', 'VIDEO'], { each: true }) @ArrayMaxSize(2) mediaKinds: string[];
  @IsOptional() @IsString() @MaxLength(200) defaultImageModel?: string;
  @IsOptional() @IsString() @MaxLength(200) defaultVideoModel?: string;
  @IsOptional() @IsInt() @Min(1) dailyPublishCap?: number;
  @IsOptional() @IsString() @MaxLength(100) linkedCampaignId?: string;
}

class UpdateSocialCampaignDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) goal?: string;
  @IsOptional() @IsString() @MaxLength(500) theme?: string;
  @IsOptional() @IsObject() brief?: Record<string, unknown>;
  @IsOptional() @IsIn(AUTOMATION) automationMode?: (typeof AUTOMATION)[number];
  @IsOptional() @IsIn(PLANNING) planningMode?: (typeof PLANNING)[number];
  @IsOptional() @ValidateNested() @Type(() => CadenceDto) cadence?: CadenceDto;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) targetAccountIds?: string[];
  @IsOptional() @IsArray() @IsIn(['IMAGE', 'VIDEO'], { each: true }) @ArrayMaxSize(2) mediaKinds?: string[];
  @IsOptional() @IsString() @MaxLength(200) defaultImageModel?: string;
  @IsOptional() @IsString() @MaxLength(200) defaultVideoModel?: string;
  @IsOptional() @IsInt() @Min(1) dailyPublishCap?: number;
  @IsOptional() @IsString() @MaxLength(100) linkedCampaignId?: string;
}

@MarketingRoute()
@Controller('marketing/social-campaigns')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('socialCampaigns')
export class SocialCampaignsController {
  constructor(private readonly svc: SocialCampaignsService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'social-campaign.create', resourceType: 'social-campaign', captureBody: ['name', 'automationMode', 'planningMode'] })
  @RequirePermission('campaigns.send')
  create(@Body() dto: CreateSocialCampaignDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, {
      ...dto,
      startDate: new Date(dto.startDate),
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      createdById: u.userId,
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'social-campaign.update', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  update(@Param('id') id: string, @Body() dto: UpdateSocialCampaignDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, {
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    } as any);
  }

  @Post(':id/activate')
  @Audit({ action: 'social-campaign.activate', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  activate(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.activate(u.workspaceId, id);
  }

  @Post(':id/pause')
  @RequirePermission('campaigns.send')
  pause(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.pause(u.workspaceId, id);
  }

  @Post(':id/resume')
  @RequirePermission('campaigns.send')
  resume(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.resume(u.workspaceId, id);
  }

  @Post(':id/cancel')
  @Audit({ action: 'social-campaign.cancel', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  cancel(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.cancel(u.workspaceId, id);
  }

  @Get(':id/items')
  listItems(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listItems(u.workspaceId, id);
  }

  @Post(':id/plan/confirm')
  @RequirePermission('campaigns.send')
  confirmPlan(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.confirmPlan(u.workspaceId, id);
  }

  @Post('items/:itemId/approve')
  @Audit({ action: 'social-campaign.item.approve', resourceType: 'social-campaign-item', resourceIdParam: 'itemId' })
  @RequirePermission('campaigns.send')
  approveItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.approveItem(u.workspaceId, itemId);
  }

  @Post('items/:itemId/reject')
  @Audit({ action: 'social-campaign.item.reject', resourceType: 'social-campaign-item', resourceIdParam: 'itemId' })
  @RequirePermission('campaigns.send')
  rejectItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.rejectItem(u.workspaceId, itemId);
  }

  @Post('items/:itemId/regenerate')
  @RequirePermission('campaigns.send')
  regenerateItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.regenerateItem(u.workspaceId, itemId);
  }
}
```
Then wire into `marketing.module.ts`: add imports near the social-planner imports
```ts
import { SocialCampaignsController } from './social-campaigns/social-campaigns.controller';
import { SocialCampaignsService } from './social-campaigns/social-campaigns.service';
```
add `SocialCampaignsController` to the `controllers:` array (next to `SocialPlannerController`) and `SocialCampaignsService` to the `providers:` array (next to `SocialPlannerService`). (`MediaGenService` is already provided by Milestone 1; `ContentAiService`, `AnthropicService`, `AiCreditsService`, `ScheduledJobService`, `ScheduledJobRunnerService`, `SocialPlannerService` are already registered.)
- [ ] **Step 4: Run test, expect PASS** — `cd backend && npm test -- social-campaigns.controller`. Then compile + full feature suite + tripwire: `cd backend && npx tsc --noEmit && npm test -- social-campaigns entitlements.tripwire`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(social-campaigns): REST controller (CRUD + lifecycle + items) behind socialCampaigns feature gate"`

---

## Milestone 4: Social Campaign Engine — Frontend

### Task 24: `Stepper` accessible wizard primitive in `components/ui/`

**Files:**
- Create: `frontend/src/components/ui/Stepper.tsx`
- Test: `frontend/src/components/ui/Stepper.test.tsx`
- Modify: `frontend/src/components/ui/index.ts`

**Interfaces:**
- Consumes: `cn` from `./cn` (existing).
- Produces:
  ```ts
  export interface StepperStep { id: string; label: string; }
  export interface StepperProps {
    steps: StepperStep[];
    current: number;                       // 0-based active index
    onStepClick?: (index: number) => void; // only fired for already-completed steps
    className?: string;
    'aria-label': string;
  }
  export function Stepper(props: StepperProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test** — `frontend/src/components/ui/Stepper.test.tsx`:
  ```tsx
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import { describe, it, expect, vi } from 'vitest';
  import { Stepper } from './Stepper';

  const STEPS = [
    { id: 'goal', label: 'Goal' },
    { id: 'brief', label: 'Brief' },
    { id: 'review', label: 'Review' },
  ];

  describe('Stepper', () => {
    it('renders a nav landmark with the provided aria-label', () => {
      render(<Stepper steps={STEPS} current={0} aria-label="Builder steps" />);
      expect(screen.getByRole('navigation', { name: 'Builder steps' })).toBeInTheDocument();
    });

    it('marks the current step with aria-current="step"', () => {
      render(<Stepper steps={STEPS} current={1} aria-label="Builder steps" />);
      expect(screen.getByRole('button', { name: /Brief/ })).toHaveAttribute('aria-current', 'step');
      expect(screen.getByRole('button', { name: /Goal/ })).not.toHaveAttribute('aria-current', 'step');
    });

    it('invokes onStepClick for a completed step but not a future one', async () => {
      const user = userEvent.setup();
      const onStepClick = vi.fn();
      render(<Stepper steps={STEPS} current={1} onStepClick={onStepClick} aria-label="Builder steps" />);
      await user.click(screen.getByRole('button', { name: /Goal/ }));    // completed → allowed
      expect(onStepClick).toHaveBeenCalledWith(0);
      onStepClick.mockClear();
      await user.click(screen.getByRole('button', { name: /Review/ }));   // future → disabled, no-op
      expect(onStepClick).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — from `frontend/`: `npx vitest run src/components/ui/Stepper.test.tsx`. Expected failure: `Failed to resolve import "./Stepper"` (file does not exist).

- [ ] **Step 3: Implement** — `frontend/src/components/ui/Stepper.tsx`:
  ```tsx
  import { cn } from './cn';

  export interface StepperStep {
    id: string;
    label: string;
  }

  export interface StepperProps {
    steps: StepperStep[];
    current: number;
    onStepClick?: (index: number) => void;
    className?: string;
    'aria-label': string;
  }

  export function Stepper({
    steps,
    current,
    onStepClick,
    className,
    'aria-label': ariaLabel,
  }: StepperProps) {
    return (
      <nav aria-label={ariaLabel} className={cn('w-full', className)}>
        <ol role="list" className="flex items-center gap-2">
          {steps.map((step, index) => {
            const isActive = index === current;
            const isComplete = index < current;
            const canNavigate = isComplete && !!onStepClick;
            return (
              <li key={step.id} className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  aria-current={isActive ? 'step' : undefined}
                  disabled={!canNavigate}
                  onClick={() => canNavigate && onStepClick!(index)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'text-foreground'
                      : isComplete
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'cursor-default text-muted-foreground/60',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs',
                      isActive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : isComplete
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border',
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="hidden sm:inline">{step.label}</span>
                </button>
                {index < steps.length - 1 && <span aria-hidden className="h-px flex-1 bg-border" />}
              </li>
            );
          })}
        </ol>
      </nav>
    );
  }
  ```
  Then append to `frontend/src/components/ui/index.ts` (after the `SegmentedControl` export block, line 36):
  ```ts
  export { Stepper, type StepperProps, type StepperStep } from './Stepper';
  ```

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/components/ui/Stepper.test.tsx`, then `npx tsc --noEmit` (typecheck). Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/components/ui/Stepper.tsx frontend/src/components/ui/Stepper.test.tsx frontend/src/components/ui/index.ts
  git commit -m "feat(ui): add accessible Stepper/Wizard primitive"
  ```

---

### Task 25: `socialCampaigns.service.ts` typed API

**Files:**
- Create: `frontend/src/features/marketing/api/socialCampaigns.service.ts`
- Test: `frontend/src/features/marketing/api/socialCampaigns.service.test.ts`

**Interfaces:**
- Consumes: `marketingApi` default export (axios, `baseURL .../marketing`) — paths relative to `/marketing`.
- Produces: `SocialCampaignStatus`, `SocialCampaignAutomationMode`, `SocialCampaignPlanningMode`, `SocialCampaignItemStatus`, `SocialCampaignCadence`, `SocialCampaignBrief`, `SocialCampaign`, `SocialCampaignPayload`, `SocialCampaignItem`; functions `listSocialCampaigns`, `getSocialCampaign`, `createSocialCampaign`, `updateSocialCampaign`, `setCampaignLifecycle`, `listSocialCampaignItems`, `confirmSocialCampaignPlan`, `reviewSocialCampaignItem`.

- [ ] **Step 1: Write the failing test** — `frontend/src/features/marketing/api/socialCampaigns.service.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';

  const get = vi.fn();
  const post = vi.fn();
  const patch = vi.fn();
  vi.mock('./marketingApi', () => ({
    default: {
      get: (...a: unknown[]) => get(...a),
      post: (...a: unknown[]) => post(...a),
      patch: (...a: unknown[]) => patch(...a),
    },
  }));

  import {
    listSocialCampaigns,
    createSocialCampaign,
    setCampaignLifecycle,
    listSocialCampaignItems,
    confirmSocialCampaignPlan,
    reviewSocialCampaignItem,
    type SocialCampaignPayload,
  } from './socialCampaigns.service';

  describe('socialCampaigns.service', () => {
    beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); });

    it('lists campaigns from /social-campaigns', async () => {
      get.mockResolvedValue({ data: [{ id: 'sc1' }] });
      const res = await listSocialCampaigns();
      expect(get).toHaveBeenCalledWith('/social-campaigns');
      expect(res).toEqual([{ id: 'sc1' }]);
    });

    it('creates a campaign, forwarding linkedCampaignId for the cross-link', async () => {
      post.mockResolvedValue({ data: { id: 'sc2' } });
      const payload: SocialCampaignPayload = {
        name: 'Launch',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: { perWeek: 3, daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'Europe/Istanbul' },
        startDate: '2026-07-01',
        targetAccountIds: ['a1'],
        mediaKinds: ['IMAGE'],
        linkedCampaignId: 'c1',
      };
      const res = await createSocialCampaign(payload);
      expect(post).toHaveBeenCalledWith('/social-campaigns', payload);
      expect(res).toEqual({ id: 'sc2' });
    });

    it('posts lifecycle actions to /:id/:action', async () => {
      post.mockResolvedValue({ data: { id: 'sc1', status: 'ACTIVE' } });
      await setCampaignLifecycle('sc1', 'activate');
      expect(post).toHaveBeenCalledWith('/social-campaigns/sc1/activate');
    });

    it('confirms a proposed plan and lists/reviews items', async () => {
      get.mockResolvedValue({ data: [{ id: 'it1' }] });
      await listSocialCampaignItems('sc1');
      expect(get).toHaveBeenCalledWith('/social-campaigns/sc1/items');

      post.mockResolvedValue({ data: { message: 'ok' } });
      await confirmSocialCampaignPlan('sc1');
      expect(post).toHaveBeenCalledWith('/social-campaigns/sc1/plan/confirm');

      post.mockResolvedValue({ data: { id: 'it1', status: 'APPROVED' } });
      await reviewSocialCampaignItem('it1', 'approve');
      expect(post).toHaveBeenCalledWith('/social-campaigns/items/it1/approve');
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/features/marketing/api/socialCampaigns.service.test.ts`. Expected: `Failed to resolve import "./socialCampaigns.service"`.

- [ ] **Step 3: Implement** — `frontend/src/features/marketing/api/socialCampaigns.service.ts`:
  ```ts
  /**
   * socialCampaigns.service.ts — Social Campaign / content-calendar engine
   * (AI Social Content Studio §8). Typed client over marketingApi; all paths
   * are relative to /marketing. Server state is consumed via react-query.
   */
  import marketingApi from './marketingApi';

  export type SocialCampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  export type SocialCampaignAutomationMode = 'APPROVAL' | 'SEMI_AUTO' | 'FULL_AUTO';
  export type SocialCampaignPlanningMode = 'AI_PROPOSE' | 'AI_FULL' | 'USER_TOPICS';
  export type SocialCampaignItemStatus =
    | 'PLANNED'
    | 'GENERATING'
    | 'NEEDS_APPROVAL'
    | 'APPROVED'
    | 'SCHEDULED'
    | 'PUBLISHED'
    | 'FAILED'
    | 'SKIPPED';

  export interface SocialCampaignCadence {
    perWeek: number;
    daysOfWeek: number[]; // 0=Sun … 6=Sat
    timeOfDay: string;    // 'HH:mm'
    timezone: string;     // IANA tz
  }

  export interface SocialCampaignBrief {
    audience?: string;
    keyMessages?: string[];
    languages?: string[];
    productRefs?: string[];
  }

  export interface SocialCampaign {
    id: string;
    name: string;
    goal: string | null;
    theme: string | null;
    brief: SocialCampaignBrief;
    status: SocialCampaignStatus;
    automationMode: SocialCampaignAutomationMode;
    planningMode: SocialCampaignPlanningMode;
    cadence: SocialCampaignCadence;
    startDate: string;
    endDate: string | null;
    targetAccountIds: string[];
    mediaKinds: string[];
    dailyPublishCap: number;
    linkedCampaignId: string | null;
    linkedAdCampaignId: string | null;
    stats: Record<string, number> | null;
    createdAt: string;
    updatedAt: string;
  }

  export interface SocialCampaignPayload {
    name: string;
    goal?: string;
    theme?: string;
    brief?: SocialCampaignBrief;
    automationMode: SocialCampaignAutomationMode;
    planningMode: SocialCampaignPlanningMode;
    cadence: SocialCampaignCadence;
    startDate: string;
    endDate?: string;
    targetAccountIds: string[];
    mediaKinds: string[];
    dailyPublishCap?: number;
    linkedCampaignId?: string;
  }

  export interface SocialCampaignItem {
    id: string;
    socialCampaignId: string;
    sequenceIndex: number;
    scheduledFor: string;
    status: SocialCampaignItemStatus;
    topic: string | null;
    socialPostId: string | null;
    generatedAssetIds: string[];
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }

  export const listSocialCampaigns = (): Promise<SocialCampaign[]> =>
    marketingApi.get('/social-campaigns').then((r) => r.data);

  export const getSocialCampaign = (id: string): Promise<SocialCampaign> =>
    marketingApi.get(`/social-campaigns/${id}`).then((r) => r.data);

  export const createSocialCampaign = (payload: SocialCampaignPayload): Promise<SocialCampaign> =>
    marketingApi.post('/social-campaigns', payload).then((r) => r.data);

  export const updateSocialCampaign = (
    id: string,
    payload: Partial<SocialCampaignPayload>,
  ): Promise<SocialCampaign> =>
    marketingApi.patch(`/social-campaigns/${id}`, payload).then((r) => r.data);

  export const setCampaignLifecycle = (
    id: string,
    action: 'activate' | 'pause' | 'resume' | 'cancel',
  ): Promise<SocialCampaign> =>
    marketingApi.post(`/social-campaigns/${id}/${action}`).then((r) => r.data);

  export const listSocialCampaignItems = (id: string): Promise<SocialCampaignItem[]> =>
    marketingApi.get(`/social-campaigns/${id}/items`).then((r) => r.data);

  export const confirmSocialCampaignPlan = (id: string): Promise<{ message: string }> =>
    marketingApi.post(`/social-campaigns/${id}/plan/confirm`).then((r) => r.data);

  export const reviewSocialCampaignItem = (
    itemId: string,
    action: 'approve' | 'reject' | 'regenerate',
  ): Promise<SocialCampaignItem> =>
    marketingApi.post(`/social-campaigns/items/${itemId}/${action}`).then((r) => r.data);
  ```

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/features/marketing/api/socialCampaigns.service.test.ts`, then `npx tsc --noEmit`. Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/features/marketing/api/socialCampaigns.service.ts frontend/src/features/marketing/api/socialCampaigns.service.test.ts
  git commit -m "feat(social-campaigns): typed socialCampaigns API service"
  ```

---

### Task 26: Social Campaign list page

**Files:**
- Create: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.tsx`
- Test: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.test.tsx`

**Interfaces:**
- Consumes: `listSocialCampaigns`, `SocialCampaign`, `SocialCampaignStatus` (Task 25); `PageHeader`, `Button`, `Badge`, `Card`, `CardContent`, `EmptyState`, `Spinner` from `@/components/ui/*`; `useQuery`; `Link` from `react-router-dom`.
- Produces: `export default function SocialCampaignsPage(): JSX.Element` (route `/social-campaigns`).

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { MemoryRouter } from 'react-router-dom';
  import type { ReactNode } from 'react';

  const listSocialCampaigns = vi.fn();
  vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
    listSocialCampaigns: () => listSocialCampaigns(),
  }));
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({
      t: (_k: string, d?: string) => d ?? _k,
      i18n: { language: 'en' },
    }),
  }));

  import SocialCampaignsPage from './SocialCampaignsPage';

  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  describe('SocialCampaignsPage', () => {
    beforeEach(() => listSocialCampaigns.mockReset());

    it('renders campaign rows returned by the service', async () => {
      listSocialCampaigns.mockResolvedValue([
        { id: 'sc1', name: 'Summer Launch', status: 'ACTIVE', automationMode: 'APPROVAL' },
      ]);
      render(<SocialCampaignsPage />, { wrapper });
      expect(await screen.findByText('Summer Launch')).toBeInTheDocument();
      expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    });

    it('shows an empty state when there are no campaigns', async () => {
      listSocialCampaigns.mockResolvedValue([]);
      render(<SocialCampaignsPage />, { wrapper });
      expect(await screen.findByText('No social campaigns yet')).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignsPage.test.tsx`. Expected: cannot resolve `./SocialCampaignsPage`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.tsx`:
  ```tsx
  import { useQuery } from '@tanstack/react-query';
  import { useTranslation } from 'react-i18next';
  import { Link } from 'react-router-dom';
  import { Plus, CalendarRange } from 'lucide-react';
  import {
    listSocialCampaigns,
    type SocialCampaign,
    type SocialCampaignStatus,
  } from '../../../features/marketing/api/socialCampaigns.service';
  import { PageHeader } from '@/components/ui/PageHeader';
  import { Button } from '@/components/ui/Button';
  import { Badge, type BadgeProps } from '@/components/ui/Badge';
  import { Card, CardContent } from '@/components/ui/Card';
  import { EmptyState } from '@/components/ui/EmptyState';
  import { Spinner } from '@/components/ui/Spinner';

  const STATUS_TONE: Record<SocialCampaignStatus, BadgeProps['tone']> = {
    ACTIVE: 'success',
    DRAFT: 'neutral',
    PAUSED: 'warning',
    COMPLETED: 'info',
    CANCELLED: 'neutral',
  };

  export default function SocialCampaignsPage() {
    const { t } = useTranslation('marketing');
    const { data, isLoading } = useQuery<SocialCampaign[]>({
      queryKey: ['marketing', 'social-campaigns'],
      queryFn: listSocialCampaigns,
    });

    return (
      <div className="space-y-6">
        <PageHeader
          title={t('socialCampaign.title', 'Social Campaigns')}
          description={t('socialCampaign.subtitle', 'AI-planned social content calendars')}
          actions={
            <Button asChild>
              <Link to="/social-campaigns/new">
                <Plus className="h-4 w-4" /> {t('socialCampaign.new', 'New campaign')}
              </Link>
            </Button>
          }
        />
        {isLoading ? (
          <Spinner />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={<CalendarRange className="h-6 w-6" />}
            title={t('socialCampaign.emptyTitle', 'No social campaigns yet')}
            description={t(
              'socialCampaign.emptyBody',
              'Create a campaign to let AI plan and publish your social content.',
            )}
          />
        ) : (
          <div className="grid gap-3">
            {data.map((sc) => (
              <Card key={sc.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <Link to={`/social-campaigns/${sc.id}`} className="font-medium hover:underline">
                    {sc.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{sc.automationMode}</Badge>
                    <Badge tone={STATUS_TONE[sc.status]}>{sc.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignsPage.test.tsx`, then `npx tsc --noEmit`. Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.tsx frontend/src/pages/marketing/socialCampaigns/SocialCampaignsPage.test.tsx
  git commit -m "feat(social-campaigns): campaign list page"
  ```

---

### Task 27: Stepped Social Campaign builder (uses `Stepper`)

**Files:**
- Create: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.tsx`
- Test: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.test.tsx`

**Interfaces:**
- Consumes: `Stepper`, `StepperStep` (Task 24); `createSocialCampaign`, `SocialCampaignPayload`, `SocialCampaignAutomationMode`, `SocialCampaignPlanningMode` (Task 25); `Button`, `Field`, `Input`, `Textarea`, `RadioGroup`, `RadioGroupItem`, `PageHeader` from `@/components/ui/*`; `useMutation`, `useQueryClient`; `useNavigate` from `react-router-dom`; `toast` from `sonner`.
- Produces: `export default function SocialCampaignBuilder(): JSX.Element` (route `/social-campaigns/new`). Six steps: Goal & theme → Brief & Brand Kit → Channels & cadence → Automation mode → Planning mode → Review.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { MemoryRouter } from 'react-router-dom';
  import type { ReactNode } from 'react';

  const createSocialCampaign = vi.fn();
  const navigate = vi.fn();
  vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
    createSocialCampaign: (...a: unknown[]) => createSocialCampaign(...a),
  }));
  vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
    return { ...actual, useNavigate: () => navigate };
  });
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
  }));
  vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

  import SocialCampaignBuilder from './SocialCampaignBuilder';

  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  describe('SocialCampaignBuilder', () => {
    beforeEach(() => { createSocialCampaign.mockReset(); navigate.mockReset(); });

    it('walks every step and submits a full payload on Review', async () => {
      createSocialCampaign.mockResolvedValue({ id: 'sc-new' });
      const user = userEvent.setup();
      render(<SocialCampaignBuilder />, { wrapper });

      // Step 1 — Goal & theme
      await user.type(screen.getByLabelText('Name'), 'Q3 Push');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Step 2 — Brief & Brand Kit
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Step 3 — Channels & cadence
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Step 4 — Automation mode
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Step 5 — Planning mode
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // Step 6 — Review → Create
      await user.click(screen.getByRole('button', { name: 'Create campaign' }));

      expect(createSocialCampaign).toHaveBeenCalledTimes(1);
      const payload = createSocialCampaign.mock.calls[0][0];
      expect(payload).toMatchObject({
        name: 'Q3 Push',
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        mediaKinds: ['IMAGE'],
      });
      expect(payload.cadence).toMatchObject({ perWeek: expect.any(Number) });
      expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-new');
    });

    it('blocks advancing past step 1 without a name', async () => {
      const user = userEvent.setup();
      render(<SocialCampaignBuilder />, { wrapper });
      await user.click(screen.getByRole('button', { name: 'Next' }));
      // still on step 1 — the Name field is present, Review's submit is not
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create campaign' })).not.toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignBuilder.test.tsx`. Expected: cannot resolve `./SocialCampaignBuilder`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.tsx`:
  ```tsx
  import { useState } from 'react';
  import { useMutation, useQueryClient } from '@tanstack/react-query';
  import { useNavigate } from 'react-router-dom';
  import { useTranslation } from 'react-i18next';
  import { toast } from 'sonner';
  import { Stepper, type StepperStep } from '@/components/ui/Stepper';
  import { PageHeader } from '@/components/ui/PageHeader';
  import { Button } from '@/components/ui/Button';
  import { Field } from '@/components/ui/Field';
  import { Input } from '@/components/ui/Input';
  import { Textarea } from '@/components/ui/Textarea';
  import { RadioGroup, RadioGroupItem } from '@/components/ui/RadioGroup';
  import { Label } from '@/components/ui/Label';
  import {
    createSocialCampaign,
    type SocialCampaignPayload,
    type SocialCampaignAutomationMode,
    type SocialCampaignPlanningMode,
  } from '../../../features/marketing/api/socialCampaigns.service';

  interface BuilderState {
    name: string;
    goal: string;
    theme: string;
    audience: string;
    perWeek: number;
    mediaKinds: string[];
    automationMode: SocialCampaignAutomationMode;
    planningMode: SocialCampaignPlanningMode;
  }

  const INITIAL: BuilderState = {
    name: '',
    goal: '',
    theme: '',
    audience: '',
    perWeek: 3,
    mediaKinds: ['IMAGE'],
    automationMode: 'APPROVAL',
    planningMode: 'AI_PROPOSE',
  };

  export default function SocialCampaignBuilder() {
    const { t } = useTranslation('marketing');
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [step, setStep] = useState(0);
    const [s, setS] = useState<BuilderState>(INITIAL);
    const set = <K extends keyof BuilderState>(k: K, v: BuilderState[K]) =>
      setS((prev) => ({ ...prev, [k]: v }));

    const steps: StepperStep[] = [
      { id: 'goal', label: t('socialCampaign.step.goal', 'Goal & theme') },
      { id: 'brief', label: t('socialCampaign.step.brief', 'Brief & Brand Kit') },
      { id: 'channels', label: t('socialCampaign.step.channels', 'Channels & cadence') },
      { id: 'automation', label: t('socialCampaign.step.automation', 'Automation mode') },
      { id: 'planning', label: t('socialCampaign.step.planning', 'Planning mode') },
      { id: 'review', label: t('socialCampaign.step.review', 'Review') },
    ];

    const create = useMutation({
      mutationFn: () => {
        const payload: SocialCampaignPayload = {
          name: s.name.trim(),
          goal: s.goal || undefined,
          theme: s.theme || undefined,
          brief: { audience: s.audience || undefined },
          automationMode: s.automationMode,
          planningMode: s.planningMode,
          cadence: {
            perWeek: s.perWeek,
            daysOfWeek: [1, 3, 5],
            timeOfDay: '09:00',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          startDate: new Date().toISOString(),
          targetAccountIds: [],
          mediaKinds: s.mediaKinds,
        };
        return createSocialCampaign(payload);
      },
      onSuccess: (sc) => {
        queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns'] });
        toast.success(t('socialCampaign.created', 'Campaign created'));
        navigate(`/social-campaigns/${sc.id}`);
      },
      onError: () => toast.error(t('socialCampaign.createFailed', 'Could not create campaign')),
    });

    const canAdvance = step !== 0 || s.name.trim().length > 0;
    const isLast = step === steps.length - 1;

    return (
      <div className="space-y-6">
        <PageHeader
          title={t('socialCampaign.newTitle', 'New social campaign')}
          description={t('socialCampaign.newSubtitle', 'AI plans and progresses your content.')}
        />
        <Stepper
          steps={steps}
          current={step}
          aria-label={t('socialCampaign.stepsLabel', 'Campaign builder steps')}
          onStepClick={setStep}
        />

        <div className="max-w-xl space-y-4">
          {step === 0 && (
            <>
              <Field label={t('socialCampaign.f.name', 'Name')}>
                <Input value={s.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label={t('socialCampaign.f.goal', 'Goal')}>
                <Input value={s.goal} onChange={(e) => set('goal', e.target.value)} />
              </Field>
              <Field label={t('socialCampaign.f.theme', 'Theme')}>
                <Input value={s.theme} onChange={(e) => set('theme', e.target.value)} />
              </Field>
            </>
          )}

          {step === 1 && (
            <Field label={t('socialCampaign.f.audience', 'Audience')}>
              <Textarea value={s.audience} onChange={(e) => set('audience', e.target.value)} />
            </Field>
          )}

          {step === 2 && (
            <Field label={t('socialCampaign.f.perWeek', 'Posts per week')}>
              <Input
                type="number"
                min={1}
                value={s.perWeek}
                onChange={(e) => set('perWeek', Number(e.target.value) || 1)}
              />
            </Field>
          )}

          {step === 3 && (
            <RadioGroup
              value={s.automationMode}
              onValueChange={(v) => set('automationMode', v as SocialCampaignAutomationMode)}
            >
              {(['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'] as const).map((m) => (
                <div key={m} className="flex items-center gap-2">
                  <RadioGroupItem value={m} id={`auto-${m}`} />
                  <Label htmlFor={`auto-${m}`}>{m}</Label>
                </div>
              ))}
            </RadioGroup>
          )}

          {step === 4 && (
            <RadioGroup
              value={s.planningMode}
              onValueChange={(v) => set('planningMode', v as SocialCampaignPlanningMode)}
            >
              {(['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'] as const).map((m) => (
                <div key={m} className="flex items-center gap-2">
                  <RadioGroupItem value={m} id={`plan-${m}`} />
                  <Label htmlFor={`plan-${m}`}>{m}</Label>
                </div>
              ))}
            </RadioGroup>
          )}

          {step === 5 && (
            <dl className="space-y-1 text-sm">
              <div><dt className="inline font-medium">{t('socialCampaign.f.name', 'Name')}: </dt><dd className="inline">{s.name}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.automation', 'Automation')}: </dt><dd className="inline">{s.automationMode}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.planning', 'Planning')}: </dt><dd className="inline">{s.planningMode}</dd></div>
              <div><dt className="inline font-medium">{t('socialCampaign.f.perWeek', 'Posts per week')}: </dt><dd className="inline">{s.perWeek}</dd></div>
            </dl>
          )}
        </div>

        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="secondary" onClick={() => setStep((n) => n - 1)}>
              {t('common.back', 'Back')}
            </Button>
          )}
          {isLast ? (
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              {t('socialCampaign.create', 'Create campaign')}
            </Button>
          ) : (
            <Button disabled={!canAdvance} onClick={() => setStep((n) => n + 1)}>
              {t('common.next', 'Next')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  ```
  Note: `Field` renders its `label` as a `<label>` associated with the wrapped `Input`, so `getByLabelText('Name')` resolves (verify `Field` wires `htmlFor`/`id` — it does per the shared kit; if it associates by wrapping, the query still works). `Button variant="secondary"` matches the kit's variant enum.

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignBuilder.test.tsx`, then `npx tsc --noEmit`. Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.tsx frontend/src/pages/marketing/socialCampaigns/SocialCampaignBuilder.test.tsx
  git commit -m "feat(social-campaigns): stepped campaign builder wizard"
  ```

---

### Task 28: Calendar view of `SocialCampaignItem`s (presentational)

**Files:**
- Create: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.tsx`
- Test: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.test.tsx`

**Interfaces:**
- Consumes: `SocialCampaignItem`, `SocialCampaignItemStatus` (Task 25); `Badge`, `Card`, `CardContent`, `EmptyState` from `@/components/ui/*`.
- Produces: `SocialCampaignCalendarProps { items: SocialCampaignItem[]; }` and `SocialCampaignCalendar(props)`. Groups items by `scheduledFor` calendar day (ascending), renders each day with its items + status badges.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen } from '@testing-library/react';
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
  }));

  import { SocialCampaignCalendar } from './SocialCampaignCalendar';
  import type { SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

  const item = (over: Partial<SocialCampaignItem>): SocialCampaignItem => ({
    id: 'it', socialCampaignId: 'sc', sequenceIndex: 0, scheduledFor: '2026-07-01T09:00:00.000Z',
    status: 'PLANNED', topic: null, socialPostId: null, generatedAssetIds: [], error: null,
    createdAt: '', updatedAt: '', ...over,
  });

  describe('SocialCampaignCalendar', () => {
    it('groups items by day and shows topic + status', () => {
      render(
        <SocialCampaignCalendar
          items={[
            item({ id: 'a', topic: 'Summer sale', status: 'NEEDS_APPROVAL', scheduledFor: '2026-07-01T09:00:00.000Z' }),
            item({ id: 'b', topic: 'Customer story', status: 'PUBLISHED', scheduledFor: '2026-07-03T09:00:00.000Z' }),
          ]}
        />,
      );
      expect(screen.getByText('Summer sale')).toBeInTheDocument();
      expect(screen.getByText('Customer story')).toBeInTheDocument();
      expect(screen.getByText('NEEDS_APPROVAL')).toBeInTheDocument();
      expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    });

    it('renders an empty state when there are no items', () => {
      render(<SocialCampaignCalendar items={[]} />);
      expect(screen.getByText('No content scheduled yet')).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignCalendar.test.tsx`. Expected: cannot resolve `./SocialCampaignCalendar`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.tsx`:
  ```tsx
  import { useTranslation } from 'react-i18next';
  import { CalendarRange } from 'lucide-react';
  import { Badge, type BadgeProps } from '@/components/ui/Badge';
  import { Card, CardContent } from '@/components/ui/Card';
  import { EmptyState } from '@/components/ui/EmptyState';
  import {
    type SocialCampaignItem,
    type SocialCampaignItemStatus,
  } from '../../../features/marketing/api/socialCampaigns.service';

  const ITEM_TONE: Record<SocialCampaignItemStatus, BadgeProps['tone']> = {
    PLANNED: 'neutral',
    GENERATING: 'info',
    NEEDS_APPROVAL: 'warning',
    APPROVED: 'info',
    SCHEDULED: 'info',
    PUBLISHED: 'success',
    FAILED: 'danger',
    SKIPPED: 'neutral',
  };

  export interface SocialCampaignCalendarProps {
    items: SocialCampaignItem[];
  }

  export function SocialCampaignCalendar({ items }: SocialCampaignCalendarProps) {
    const { t } = useTranslation('marketing');

    if (items.length === 0) {
      return (
        <EmptyState
          icon={<CalendarRange className="h-6 w-6" />}
          title={t('socialCampaign.calendarEmpty', 'No content scheduled yet')}
        />
      );
    }

    const byDay = new Map<string, SocialCampaignItem[]>();
    for (const it of [...items].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))) {
      const day = it.scheduledFor.slice(0, 10); // YYYY-MM-DD
      const bucket = byDay.get(day) ?? [];
      bucket.push(it);
      byDay.set(day, bucket);
    }

    return (
      <div className="space-y-4">
        {[...byDay.entries()].map(([day, dayItems]) => (
          <div key={day} className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">{day}</h3>
            {dayItems.map((it) => (
              <Card key={it.id}>
                <CardContent className="flex items-center justify-between p-3">
                  <span className="truncate text-sm">
                    {it.topic ?? t('socialCampaign.untitled', 'Untitled post')}
                  </span>
                  <Badge tone={ITEM_TONE[it.status]}>{it.status}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        ))}
      </div>
    );
  }
  ```
  Note: confirm `'danger'` is a valid `BadgeProps['tone']` in `Badge.tsx`; if the kit names it `'destructive'`/`'error'`, use that literal instead (check `badge` cva tone keys before implementing).

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/pages/marketing/socialCampaigns/SocialCampaignCalendar.test.tsx`, then `npx tsc --noEmit`. Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.tsx frontend/src/pages/marketing/socialCampaigns/SocialCampaignCalendar.test.tsx
  git commit -m "feat(social-campaigns): content-calendar view of campaign items"
  ```

---

### Task 29: Approval queue + Social Campaign detail page

**Files:**
- Create: `frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.tsx`
- Create: `frontend/src/pages/marketing/socialCampaigns/SocialCampaignDetailPage.tsx`
- Test: `frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.test.tsx`

**Interfaces:**
- Consumes: `SocialCampaignItem` (Task 25); `SocialCampaignCalendar` (Task 28); `getSocialCampaign`, `listSocialCampaignItems`, `reviewSocialCampaignItem`, `setCampaignLifecycle` (Task 25); `Button`, `Card`, `CardContent`, `EmptyState`, `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `PageHeader`, `Spinner` from `@/components/ui/*`; `useParams` from `react-router-dom`.
- Produces: `ApprovalQueueProps { items, onReview, pendingId? }`, `ApprovalQueue(props)`, and `default SocialCampaignDetailPage()` (route `/social-campaigns/:id`).

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
  }));

  import { ApprovalQueue } from './ApprovalQueue';
  import type { SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

  const item = (over: Partial<SocialCampaignItem>): SocialCampaignItem => ({
    id: 'it', socialCampaignId: 'sc', sequenceIndex: 0, scheduledFor: '2026-07-01T09:00:00.000Z',
    status: 'NEEDS_APPROVAL', topic: 'Draft post', socialPostId: null, generatedAssetIds: [],
    error: null, createdAt: '', updatedAt: '', ...over,
  });

  describe('ApprovalQueue', () => {
    it('lists only NEEDS_APPROVAL items and wires approve/reject/regenerate', async () => {
      const user = userEvent.setup();
      const onReview = vi.fn();
      render(
        <ApprovalQueue
          items={[
            item({ id: 'a', topic: 'Needs review' }),
            item({ id: 'b', status: 'PUBLISHED', topic: 'Already out' }),
          ]}
          onReview={onReview}
        />,
      );
      expect(screen.getByText('Needs review')).toBeInTheDocument();
      expect(screen.queryByText('Already out')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(onReview).toHaveBeenCalledWith('a', 'approve');
      await user.click(screen.getByRole('button', { name: 'Reject' }));
      expect(onReview).toHaveBeenCalledWith('a', 'reject');
      await user.click(screen.getByRole('button', { name: 'Regenerate' }));
      expect(onReview).toHaveBeenCalledWith('a', 'regenerate');
    });

    it('shows an empty state when nothing needs approval', () => {
      render(<ApprovalQueue items={[item({ status: 'PUBLISHED' })]} onReview={vi.fn()} />);
      expect(screen.getByText('Nothing waiting for approval')).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/pages/marketing/socialCampaigns/ApprovalQueue.test.tsx`. Expected: cannot resolve `./ApprovalQueue`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.tsx`:
  ```tsx
  import { useTranslation } from 'react-i18next';
  import { CheckCircle2 } from 'lucide-react';
  import { Button } from '@/components/ui/Button';
  import { Card, CardContent } from '@/components/ui/Card';
  import { EmptyState } from '@/components/ui/EmptyState';
  import { type SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

  export interface ApprovalQueueProps {
    items: SocialCampaignItem[];
    onReview: (itemId: string, action: 'approve' | 'reject' | 'regenerate') => void;
    pendingId?: string | null;
  }

  export function ApprovalQueue({ items, onReview, pendingId }: ApprovalQueueProps) {
    const { t } = useTranslation('marketing');
    const queue = items.filter((it) => it.status === 'NEEDS_APPROVAL');

    if (queue.length === 0) {
      return (
        <EmptyState
          icon={<CheckCircle2 className="h-6 w-6" />}
          title={t('socialCampaign.queueEmpty', 'Nothing waiting for approval')}
        />
      );
    }

    return (
      <div className="space-y-3">
        {queue.map((it) => (
          <Card key={it.id}>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <span className="truncate text-sm">
                {it.topic ?? t('socialCampaign.untitled', 'Untitled post')}
              </span>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" loading={pendingId === it.id} onClick={() => onReview(it.id, 'approve')}>
                  {t('socialCampaign.approve', 'Approve')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onReview(it.id, 'regenerate')}>
                  {t('socialCampaign.regenerate', 'Regenerate')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onReview(it.id, 'reject')}>
                  {t('socialCampaign.reject', 'Reject')}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  ```
  Then `frontend/src/pages/marketing/socialCampaigns/SocialCampaignDetailPage.tsx` (composes calendar + queue; no separate test — covered by its parts + typecheck):
  ```tsx
  import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
  import { useParams } from 'react-router-dom';
  import { useTranslation } from 'react-i18next';
  import { toast } from 'sonner';
  import { PageHeader } from '@/components/ui/PageHeader';
  import { Spinner } from '@/components/ui/Spinner';
  import { Button } from '@/components/ui/Button';
  import { Badge } from '@/components/ui/Badge';
  import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
  import { SocialCampaignCalendar } from './SocialCampaignCalendar';
  import { ApprovalQueue } from './ApprovalQueue';
  import {
    getSocialCampaign,
    listSocialCampaignItems,
    reviewSocialCampaignItem,
    setCampaignLifecycle,
  } from '../../../features/marketing/api/socialCampaigns.service';

  export default function SocialCampaignDetailPage() {
    const { t } = useTranslation('marketing');
    const { id = '' } = useParams();
    const queryClient = useQueryClient();

    const campaignQuery = useQuery({
      queryKey: ['marketing', 'social-campaigns', id],
      queryFn: () => getSocialCampaign(id),
      enabled: !!id,
    });
    const itemsQuery = useQuery({
      queryKey: ['marketing', 'social-campaigns', id, 'items'],
      queryFn: () => listSocialCampaignItems(id),
      enabled: !!id,
      refetchInterval: 15_000,
    });

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns', id, 'items'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns', id] });
    };

    const review = useMutation({
      mutationFn: ({ itemId, action }: { itemId: string; action: 'approve' | 'reject' | 'regenerate' }) =>
        reviewSocialCampaignItem(itemId, action),
      onSuccess: () => { invalidate(); toast.success(t('socialCampaign.itemUpdated', 'Item updated')); },
      onError: () => toast.error(t('socialCampaign.itemUpdateFailed', 'Action failed')),
    });

    const lifecycle = useMutation({
      mutationFn: (action: 'activate' | 'pause' | 'resume' | 'cancel') => setCampaignLifecycle(id, action),
      onSuccess: () => { invalidate(); toast.success(t('socialCampaign.lifecycleOk', 'Updated')); },
      onError: () => toast.error(t('socialCampaign.lifecycleFailed', 'Action failed')),
    });

    if (campaignQuery.isLoading || !campaignQuery.data) return <Spinner />;
    const c = campaignQuery.data;
    const items = itemsQuery.data ?? [];

    return (
      <div className="space-y-6">
        <PageHeader
          title={c.name}
          description={c.goal ?? undefined}
          actions={
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{c.status}</Badge>
              {c.status === 'ACTIVE' ? (
                <Button variant="secondary" loading={lifecycle.isPending} onClick={() => lifecycle.mutate('pause')}>
                  {t('socialCampaign.pause', 'Pause')}
                </Button>
              ) : c.status === 'PAUSED' ? (
                <Button loading={lifecycle.isPending} onClick={() => lifecycle.mutate('resume')}>
                  {t('socialCampaign.resume', 'Resume')}
                </Button>
              ) : c.status === 'DRAFT' ? (
                <Button loading={lifecycle.isPending} onClick={() => lifecycle.mutate('activate')}>
                  {t('socialCampaign.activate', 'Activate')}
                </Button>
              ) : null}
            </div>
          }
        />
        <Tabs defaultValue="calendar">
          <TabsList>
            <TabsTrigger value="calendar">{t('socialCampaign.tabCalendar', 'Calendar')}</TabsTrigger>
            <TabsTrigger value="queue">{t('socialCampaign.tabQueue', 'Approval queue')}</TabsTrigger>
          </TabsList>
          <TabsContent value="calendar">
            <SocialCampaignCalendar items={items} />
          </TabsContent>
          <TabsContent value="queue">
            <ApprovalQueue
              items={items}
              pendingId={review.isPending ? review.variables?.itemId : null}
              onReview={(itemId, action) => review.mutate({ itemId, action })}
            />
          </TabsContent>
        </Tabs>
      </div>
    );
  }
  ```

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/pages/marketing/socialCampaigns/ApprovalQueue.test.tsx`, then `npx tsc --noEmit` (typechecks the detail page too). Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.tsx frontend/src/pages/marketing/socialCampaigns/ApprovalQueue.test.tsx frontend/src/pages/marketing/socialCampaigns/SocialCampaignDetailPage.tsx
  git commit -m "feat(social-campaigns): approval queue and campaign detail page"
  ```

---

### Task 30: Campaign UX uplift — blast-campaign detail dialog + "Create social content" cross-link

**Files:**
- Create: `frontend/src/pages/marketing/campaigns/CampaignDetailDialog.tsx`
- Test: `frontend/src/pages/marketing/campaigns/CampaignDetailDialog.test.tsx`
- Modify: `frontend/src/pages/marketing/CampaignsPage.tsx`

**Interfaces:**
- Consumes: `marketingApi` (`GET /campaigns/:id` for stats, `GET /campaigns/:id/recipients` — returns `{ id, leadId, status, sentAt, openedAt, clickedAt, error }[]`); `createSocialCampaign`, `SocialCampaignPayload` (Task 25); `Dialog*`, `Button`, `Badge`, `Table`/`THead`/`TBody`/`TR`/`TH`/`TD`, `Spinner`, `Callout` from `@/components/ui/*`; `useQuery`, `useMutation`; `useNavigate`; `toast`.
- Produces: `CampaignDetailDialogProps { campaignId: string | null; onClose: () => void; }` and `CampaignDetailDialog(props)`.

- [ ] **Step 1: Write the failing test** — `frontend/src/pages/marketing/campaigns/CampaignDetailDialog.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { MemoryRouter } from 'react-router-dom';
  import type { ReactNode } from 'react';

  const get = vi.fn();
  vi.mock('../../../features/marketing/api/marketingApi', () => ({
    default: { get: (...a: unknown[]) => get(...a) },
  }));
  const createSocialCampaign = vi.fn();
  vi.mock('../../../features/marketing/api/socialCampaigns.service', () => ({
    createSocialCampaign: (...a: unknown[]) => createSocialCampaign(...a),
  }));
  const navigate = vi.fn();
  vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
    return { ...actual, useNavigate: () => navigate };
  });
  vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
  }));
  vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

  import { CampaignDetailDialog } from './CampaignDetailDialog';

  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  describe('CampaignDetailDialog', () => {
    beforeEach(() => { get.mockReset(); createSocialCampaign.mockReset(); navigate.mockReset(); });

    it('loads stats and recipients for the campaign', async () => {
      get.mockImplementation((url: string) =>
        url.endsWith('/recipients')
          ? Promise.resolve({ data: [{ id: 'r1', leadId: 'l1', status: 'SENT', sentAt: null, openedAt: null, clickedAt: null, error: null }] })
          : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: { recipients: 1, sent: 1 } } }),
      );
      render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
      expect(await screen.findByText('l1')).toBeInTheDocument();
      expect(get).toHaveBeenCalledWith('/campaigns/c1');
      expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients');
    });

    it('provisions a social campaign linked to this blast and navigates to it', async () => {
      get.mockImplementation((url: string) =>
        url.endsWith('/recipients')
          ? Promise.resolve({ data: [] })
          : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: {} } }),
      );
      createSocialCampaign.mockResolvedValue({ id: 'sc-new' });
      const user = userEvent.setup();
      render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
      await screen.findByText('Promo');
      await user.click(screen.getByRole('button', { name: 'Create social content' }));
      expect(createSocialCampaign).toHaveBeenCalledTimes(1);
      expect(createSocialCampaign.mock.calls[0][0]).toMatchObject({ name: 'Promo', linkedCampaignId: 'c1' });
      expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-new');
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/pages/marketing/campaigns/CampaignDetailDialog.test.tsx`. Expected: cannot resolve `./CampaignDetailDialog`.

- [ ] **Step 3: Implement** — `frontend/src/pages/marketing/campaigns/CampaignDetailDialog.tsx`:
  ```tsx
  import { useQuery, useMutation } from '@tanstack/react-query';
  import { useNavigate } from 'react-router-dom';
  import { useTranslation } from 'react-i18next';
  import { toast } from 'sonner';
  import { Sparkles } from 'lucide-react';
  import marketingApi from '../../../features/marketing/api/marketingApi';
  import {
    createSocialCampaign,
    type SocialCampaignPayload,
  } from '../../../features/marketing/api/socialCampaigns.service';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogTitle,
    DialogDescription,
  } from '@/components/ui/Dialog';
  import { Button } from '@/components/ui/Button';
  import { Badge } from '@/components/ui/Badge';
  import { Spinner } from '@/components/ui/Spinner';
  import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';

  interface CampaignFull {
    id: string;
    name: string;
    channel: string;
    status: string;
    stats?: Record<string, number> | null;
  }
  interface RecipientRow {
    id: string;
    leadId: string;
    status: string;
    sentAt: string | null;
    openedAt: string | null;
    clickedAt: string | null;
    error: string | null;
  }

  export interface CampaignDetailDialogProps {
    campaignId: string | null;
    onClose: () => void;
  }

  export function CampaignDetailDialog({ campaignId, onClose }: CampaignDetailDialogProps) {
    const { t } = useTranslation('marketing');
    const navigate = useNavigate();
    const open = !!campaignId;

    const campaignQuery = useQuery<CampaignFull>({
      queryKey: ['marketing', 'campaigns', campaignId],
      queryFn: () => marketingApi.get(`/campaigns/${campaignId}`).then((r) => r.data),
      enabled: open,
    });
    const recipientsQuery = useQuery<RecipientRow[]>({
      queryKey: ['marketing', 'campaigns', campaignId, 'recipients'],
      queryFn: () => marketingApi.get(`/campaigns/${campaignId}/recipients`).then((r) => r.data),
      enabled: open,
    });

    const provision = useMutation({
      mutationFn: () => {
        const c = campaignQuery.data!;
        const payload: SocialCampaignPayload = {
          name: c.name,
          automationMode: 'APPROVAL',
          planningMode: 'AI_PROPOSE',
          cadence: {
            perWeek: 3,
            daysOfWeek: [1, 3, 5],
            timeOfDay: '09:00',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          startDate: new Date().toISOString(),
          targetAccountIds: [],
          mediaKinds: ['IMAGE'],
          linkedCampaignId: c.id,
        };
        return createSocialCampaign(payload);
      },
      onSuccess: (sc) => {
        toast.success(t('socialCampaign.provisioned', 'Social campaign created'));
        navigate(`/social-campaigns/${sc.id}`);
      },
      onError: () => toast.error(t('socialCampaign.provisionFailed', 'Could not create social content')),
    });

    const c = campaignQuery.data;
    const recipients = recipientsQuery.data ?? [];

    return (
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>{c?.name ?? t('campaigns.detail', 'Campaign')}</DialogTitle>
            <DialogDescription>
              {t('campaigns.detailSubtitle', 'Recipients and delivery stats')}
            </DialogDescription>
          </DialogHeader>

          {!c ? (
            <Spinner />
          ) : (
            <div className="space-y-4 overflow-y-auto">
              <div className="flex flex-wrap gap-2 text-sm">
                {Object.entries(c.stats ?? {}).map(([k, v]) => (
                  <Badge key={k} tone="neutral">{k}: {v}</Badge>
                ))}
              </div>
              <Table>
                <THead>
                  <TR>
                    <TH>{t('campaigns.recLead', 'Lead')}</TH>
                    <TH>{t('campaigns.recStatus', 'Status')}</TH>
                    <TH>{t('campaigns.recError', 'Error')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {recipients.map((r) => (
                    <TR key={r.id}>
                      <TD>{r.leadId}</TD>
                      <TD>{r.status}</TD>
                      <TD>{r.error ?? ''}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="secondary"
              loading={provision.isPending}
              disabled={!c}
              onClick={() => provision.mutate()}
            >
              <Sparkles className="h-4 w-4" /> {t('socialCampaign.crossLink', 'Create social content')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  ```
  Then wire the entry point in `frontend/src/pages/marketing/CampaignsPage.tsx`: add `import { CampaignDetailDialog } from './campaigns/CampaignDetailDialog';`, a `const [detailId, setDetailId] = useState<string | null>(null);` state, a per-row "Details" `IconButton`/`Button` calling `setDetailId(c.id)`, and render `<CampaignDetailDialog campaignId={detailId} onClose={() => setDetailId(null)} />` once near the page's other dialogs. (Place the trigger next to the existing per-row action buttons around the launch/edit controls.)

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/pages/marketing/campaigns/CampaignDetailDialog.test.tsx`, then re-run `npx vitest run src/pages/marketing/CampaignsPage.test.tsx` (regression) and `npx tsc --noEmit`. All pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/pages/marketing/campaigns/CampaignDetailDialog.tsx frontend/src/pages/marketing/campaigns/CampaignDetailDialog.test.tsx frontend/src/pages/marketing/CampaignsPage.tsx
  git commit -m "feat(campaigns): campaign detail dialog with recipients and social cross-link"
  ```

---

### Task 31: Lazy routes + left-nav items

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/marketing/navigation.ts`

**Interfaces:**
- Consumes: `SocialCampaignsPage` (Task 26), `SocialCampaignBuilder` (Task 27), `SocialCampaignDetailPage` (Task 29); `NavChild` shape (`{ path, labelKey, label, icon?, feature?, managerOnly? }`).
- Produces: routes `/social-campaigns`, `/social-campaigns/new`, `/social-campaigns/:id`; a `NavChild` under the `marketing` hub.

- [ ] **Step 1: Write the failing test** — extend the existing nav test (or add) `frontend/src/features/marketing/navigation.test.ts` (create if absent):
  ```ts
  import { describe, it, expect } from 'vitest';
  import { NAV_HUBS } from './navigation';

  describe('navigation — social campaigns', () => {
    it('exposes a Social Campaigns child under the marketing hub', () => {
      const marketing = NAV_HUBS.find((h) => h.id === 'marketing');
      const child = marketing?.children?.find((c) => c.path === '/social-campaigns');
      expect(child).toBeDefined();
      expect(child?.labelKey).toBe('nav.socialCampaigns');
      expect(child?.managerOnly).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/features/marketing/navigation.test.ts`. Expected: `child` is `undefined` (no `/social-campaigns` nav entry).

- [ ] **Step 3: Implement** —
  In `frontend/src/features/marketing/navigation.ts`, add `CalendarRange` to the existing `lucide-react` import block (near `Share2` on line 46), then insert under the `marketing` hub's `children` (after the `/social` entry, line 178):
  ```ts
  { path: '/social-campaigns', labelKey: 'nav.socialCampaigns', label: 'Social Campaigns', icon: CalendarRange, managerOnly: true },
  ```
  In `frontend/src/App.tsx`, add lazy imports (next to the `SocialPlannerPage` import, line 94):
  ```tsx
  const SocialCampaignsPage      = lazy(() => import('./pages/marketing/socialCampaigns/SocialCampaignsPage'));
  const SocialCampaignBuilder    = lazy(() => import('./pages/marketing/socialCampaigns/SocialCampaignBuilder'));
  const SocialCampaignDetailPage = lazy(() => import('./pages/marketing/socialCampaigns/SocialCampaignDetailPage'));
  ```
  and routes inside the marketing layout group (after the `/social` route, line 246):
  ```tsx
  <Route path="/social-campaigns"      element={<S><SocialCampaignsPage /></S>} />
  <Route path="/social-campaigns/new"  element={<S><SocialCampaignBuilder /></S>} />
  <Route path="/social-campaigns/:id"  element={<S><SocialCampaignDetailPage /></S>} />
  ```

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/features/marketing/navigation.test.ts`, then `npx tsc --noEmit` and `npm run build` (verifies the lazy imports resolve). All pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/App.tsx frontend/src/features/marketing/navigation.ts frontend/src/features/marketing/navigation.test.ts
  git commit -m "feat(social-campaigns): lazy routes and left-nav entry"
  ```

---

### Task 32: i18n `socialCampaign.*` + `nav.socialCampaigns` keys (en/tr)

**Files:**
- Modify: `frontend/src/i18n/locales/en/marketing.json`
- Modify: `frontend/src/i18n/locales/tr/marketing.json`
- Test: `frontend/src/i18n/socialCampaign.i18n.test.ts`

**Interfaces:**
- Consumes: the inline `t(key, default)` defaults used in Tasks 26–30 (`socialCampaign.*`) and the `nav.socialCampaigns` labelKey (Task 31).
- Produces: a `socialCampaign` object + `nav.socialCampaigns` string in both locale files (key-parity guaranteed by the test).

- [ ] **Step 1: Write the failing test** — `frontend/src/i18n/socialCampaign.i18n.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import en from './locales/en/marketing.json';
  import tr from './locales/tr/marketing.json';

  const REQUIRED = [
    'title', 'subtitle', 'new', 'newTitle', 'emptyTitle', 'emptyBody',
    'step.goal', 'step.brief', 'step.channels', 'step.automation', 'step.planning', 'step.review',
    'create', 'created', 'createFailed',
    'approve', 'reject', 'regenerate', 'queueEmpty', 'calendarEmpty',
    'tabCalendar', 'tabQueue', 'activate', 'pause', 'resume',
    'crossLink', 'provisioned', 'provisionFailed',
  ];

  function get(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
  }

  describe('socialCampaign i18n', () => {
    it('en + tr both define every required socialCampaign key', () => {
      for (const k of REQUIRED) {
        expect(get((en as Record<string, unknown>).socialCampaign as Record<string, unknown>, k), `en socialCampaign.${k}`).toBeTruthy();
        expect(get((tr as Record<string, unknown>).socialCampaign as Record<string, unknown>, k), `tr socialCampaign.${k}`).toBeTruthy();
      }
    });

    it('both locales define nav.socialCampaigns', () => {
      expect(((en as Record<string, unknown>).nav as Record<string, unknown>).socialCampaigns).toBeTruthy();
      expect(((tr as Record<string, unknown>).nav as Record<string, unknown>).socialCampaigns).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/i18n/socialCampaign.i18n.test.ts`. Expected: assertions fail (`socialCampaign` object and `nav.socialCampaigns` absent).

- [ ] **Step 3: Implement** — add a top-level `"socialCampaign"` object and a `"socialCampaigns"` entry in the existing `"nav"` object of `frontend/src/i18n/locales/en/marketing.json`:
  ```jsonc
  "socialCampaign": {
    "title": "Social Campaigns",
    "subtitle": "AI-planned social content calendars",
    "new": "New campaign",
    "newTitle": "New social campaign",
    "newSubtitle": "AI plans and progresses your content.",
    "emptyTitle": "No social campaigns yet",
    "emptyBody": "Create a campaign to let AI plan and publish your social content.",
    "stepsLabel": "Campaign builder steps",
    "step": { "goal": "Goal & theme", "brief": "Brief & Brand Kit", "channels": "Channels & cadence", "automation": "Automation mode", "planning": "Planning mode", "review": "Review" },
    "f": { "name": "Name", "goal": "Goal", "theme": "Theme", "audience": "Audience", "perWeek": "Posts per week", "automation": "Automation", "planning": "Planning" },
    "create": "Create campaign",
    "created": "Campaign created",
    "createFailed": "Could not create campaign",
    "untitled": "Untitled post",
    "approve": "Approve",
    "reject": "Reject",
    "regenerate": "Regenerate",
    "queueEmpty": "Nothing waiting for approval",
    "calendarEmpty": "No content scheduled yet",
    "tabCalendar": "Calendar",
    "tabQueue": "Approval queue",
    "activate": "Activate",
    "pause": "Pause",
    "resume": "Resume",
    "itemUpdated": "Item updated",
    "itemUpdateFailed": "Action failed",
    "lifecycleOk": "Updated",
    "lifecycleFailed": "Action failed",
    "crossLink": "Create social content",
    "provisioned": "Social campaign created",
    "provisionFailed": "Could not create social content"
  }
  ```
  and `"socialCampaigns": "Social Campaigns"` inside `"nav"`. Mirror the same key tree in `frontend/src/i18n/locales/tr/marketing.json` with Turkish values (e.g. `"title": "Sosyal Kampanyalar"`, `"new": "Yeni kampanya"`, `"approve": "Onayla"`, `"reject": "Reddet"`, `"regenerate": "Yeniden üret"`, `"calendarEmpty": "Henüz içerik planlanmadı"`, `"crossLink": "Sosyal içerik oluştur"`, `nav.socialCampaigns": "Sosyal Kampanyalar"`, etc.).

- [ ] **Step 4: Run test, expect PASS** — `npx vitest run src/i18n/socialCampaign.i18n.test.ts`, then `npm run build` (validates JSON parses). Both pass.

- [ ] **Step 5: Commit** —
  ```
  git add frontend/src/i18n/locales/en/marketing.json frontend/src/i18n/locales/tr/marketing.json frontend/src/i18n/socialCampaign.i18n.test.ts
  git commit -m "feat(social-campaigns): en/tr i18n for social campaign UI"
  ```

---

## Milestone 5: Cross-Linkage (Campaigns ↔ Social ↔ Ads)

> Note: the `SocialCampaign` model with `linkedCampaignId`/`linkedAdCampaignId` (Task 18) and the `GeneratedAsset` model (Task 2) are produced by Milestones 1 & 3 — Milestone 5 only adds the missing `Campaign.socialCampaignId` column and consumes the rest.

### Task 33: Prisma — add nullable `Campaign.socialCampaignId` (companion-link column)

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `Campaign`, L1564-1605)
- Create: `backend/prisma/migrations/20260630120000_campaign_social_campaign_id/migration.sql`

**Interfaces:**
- Consumes: existing `Campaign` model (`@@map("campaigns")`); `SocialCampaign` model (Task 18) already carries `linkedCampaignId String?` / `linkedAdCampaignId String?` — do NOT re-add those.
- Produces: `Campaign.socialCampaignId String?` column, consumed by Task 34.

- [ ] **Step 1: Write the failing test** — add a schema-presence assertion to a new spec `backend/src/modules/marketing/campaigns/campaign-social-link.schema.spec.ts`:
```ts
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Campaign.socialCampaignId schema column', () => {
  const schema = readFileSync(
    join(__dirname, '../../../../prisma/schema.prisma'),
    'utf8',
  );
  const campaignBlock = schema.slice(
    schema.indexOf('model Campaign {'),
    schema.indexOf('@@map("campaigns")'),
  );

  it('declares a nullable socialCampaignId on the blast Campaign model', () => {
    expect(campaignBlock).toMatch(/socialCampaignId\s+String\?/);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — from `backend/`: `npm test -- campaign-social-link.schema.spec`. Expect: `Expected … to match /socialCampaignId\s+String\?/` (column not present).
- [ ] **Step 3: Implement** — in `schema.prisma`, inside `model Campaign`, add after the `stats Json?` line (L1598):
```prisma
  /// Cross-linkage (AI Social Content Studio §6.3): the companion SocialCampaign
  /// provisioned from this blast. Nullable — manual/legacy campaigns have none.
  socialCampaignId String?
```
Create `backend/prisma/migrations/20260630120000_campaign_social_campaign_id/migration.sql` (project convention = single forward-only `migration.sql`; Prisma Migrate has no down file):
```sql
-- Cross-linkage: a blast Campaign's companion Social Campaign (AI Social Content
-- Studio §6.3). Additive, nullable, no default — safe on populated tables and a
-- clean drop on rollback. ROLLBACK (manual, Prisma is forward-only):
--   ALTER TABLE "campaigns" DROP COLUMN "socialCampaignId";
ALTER TABLE "campaigns" ADD COLUMN "socialCampaignId" TEXT;
```
Regenerate the client: `npx prisma generate` (do NOT run `migrate deploy` against a real DB in CI).
- [ ] **Step 4: Run test, expect PASS** — `npm test -- campaign-social-link.schema.spec`.
- [ ] **Step 5: Commit** — `git add backend/prisma && git commit -m "feat(social-studio): add nullable Campaign.socialCampaignId companion link"`

---

### Task 34: Backend — `SocialCampaignLinkService.provisionFromBlast` (prefill mapping)

**Files:**
- Create: `backend/src/modules/marketing/social-campaigns/social-campaign-link.service.ts`
- Test: `backend/src/modules/marketing/social-campaigns/social-campaign-link.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`backend/src/prisma/prisma.service`); models `campaign` (with `socialCampaignId` from Task 33) and `socialCampaign` (Task 18 — fields per spec §5.4: `name`, `goal`, `theme`, `brief Json`, `status`, `automationMode`, `planningMode`, `cadence Json`, `startDate`, `targetAccountIds String[]`, `mediaKinds String[]`, `dailyPublishCap Int`, `linkedCampaignId String?`, `createdById`).
- Produces: `provisionFromBlast(workspaceId: string, campaignId: string, createdById: string): Promise<{ socialCampaignId: string }>`, consumed by Task 35.

- [ ] **Step 1: Write the failing test** — plain-mock prisma per the recon test convention:
```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialCampaignLinkService } from './social-campaign-link.service';

describe('SocialCampaignLinkService.provisionFromBlast', () => {
  const WS = 'ws-1';
  let prisma: any;
  let adMgmt: any;
  let svc: SocialCampaignLinkService;

  beforeEach(() => {
    prisma = {
      campaign: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      socialCampaign: {
        create: jest.fn().mockResolvedValue({ id: 'sc-9' }),
        update: jest.fn().mockResolvedValue({}),
      },
      generatedAsset: { findFirst: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    adMgmt = { pushImageCreative: jest.fn() };
    svc = new SocialCampaignLinkService(prisma as any, adMgmt as any);
  });

  it('maps subject/body/audienceFilter into a DRAFT social campaign and back-links the blast', async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'camp-1',
      workspaceId: WS,
      name: 'Summer Promo',
      subject: 'Big summer sale',
      body: 'Get 20% off everything this week only.',
      audienceFilter: [{ field: 'city', op: 'eq', value: 'Istanbul' }],
      socialCampaignId: null,
    });

    const out = await svc.provisionFromBlast(WS, 'camp-1', 'user-7');

    expect(out).toEqual({ socialCampaignId: 'sc-9' });
    const data = prisma.socialCampaign.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe(WS);
    expect(data.name).toContain('Summer Promo');
    expect(data.linkedCampaignId).toBe('camp-1');
    expect(data.status).toBe('DRAFT');
    expect(data.createdById).toBe('user-7');
    expect(data.brief.audience).toEqual([{ field: 'city', op: 'eq', value: 'Istanbul' }]);
    expect(data.brief.keyMessages[0]).toContain('20% off');
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { socialCampaignId: 'sc-9' },
    });
  });

  it('rejects when the campaign is missing', async () => {
    prisma.campaign.findFirst.mockResolvedValue(null);
    await expect(svc.provisionFromBlast(WS, 'nope', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a campaign already linked', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'camp-1', workspaceId: WS, name: 'X', body: 'b', socialCampaignId: 'sc-prev' });
    await expect(svc.provisionFromBlast(WS, 'camp-1', 'u')).rejects.toBeInstanceOf(BadRequestException);
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- social-campaign-link.service.spec`. Expect: `Cannot find module './social-campaign-link.service'`.
- [ ] **Step 3: Implement** — create `social-campaign-link.service.ts`:
```ts
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdManagementService } from '../ads/ad-management.service';

/**
 * Cross-linkage between blast Campaigns, the AI Social Content Studio, and Meta
 * ads (design §6.3). Owns the two explicit user actions: provision a companion
 * SocialCampaign from a blast, and push a GeneratedAsset to a Meta ad as a
 * creative. Kept separate from the (Milestone-3) SocialCampaignService so neither
 * milestone edits the other's file.
 */
@Injectable()
export class SocialCampaignLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adMgmt: AdManagementService,
  ) {}

  async provisionFromBlast(
    workspaceId: string,
    campaignId: string,
    createdById: string,
  ): Promise<{ socialCampaignId: string }> {
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.socialCampaignId) {
      throw new BadRequestException('Campaign already linked to a social campaign');
    }

    const excerpt = (campaign.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const brief: Prisma.InputJsonValue = {
      audience: (campaign.audienceFilter ?? []) as Prisma.InputJsonValue,
      keyMessages: excerpt ? [excerpt] : [],
      sourceCampaignId: campaign.id,
      sourceChannel: campaign.channel,
      languages: ['tr'],
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const sc = await tx.socialCampaign.create({
        data: {
          workspaceId,
          name: `${campaign.name} — Social`,
          goal: campaign.subject ?? campaign.name,
          theme: campaign.subject ?? null,
          brief,
          status: 'DRAFT',
          automationMode: 'APPROVAL',
          planningMode: 'AI_PROPOSE',
          cadence: { perWeek: 3, daysOfWeek: [1, 3, 5], timeOfDay: '10:00', timezone: 'Europe/Istanbul' },
          startDate: new Date(),
          targetAccountIds: [],
          mediaKinds: ['IMAGE', 'VIDEO'],
          dailyPublishCap: 2,
          linkedCampaignId: campaign.id,
          createdById,
        },
        select: { id: true },
      });
      await tx.campaign.update({ where: { id: campaign.id }, data: { socialCampaignId: sc.id } });
      return sc;
    });

    return { socialCampaignId: created.id };
  }
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- social-campaign-link.service.spec`.
- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing/social-campaigns && git commit -m "feat(social-studio): provision a SocialCampaign from a blast campaign"`

---

### Task 35: Backend — `POST /marketing/campaigns/:id/social` endpoint + module wiring

**Files:**
- Modify: `backend/src/modules/marketing/controllers/marketing-campaigns.controller.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts` (register `SocialCampaignLinkService` provider; `AdManagementService` provider already registered at L657)
- Test: `backend/src/modules/marketing/controllers/marketing-campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `SocialCampaignLinkService.provisionFromBlast(workspaceId, campaignId, createdById)` (Task 34); `MarketingUserPayload` (`{ id, workspaceId, … }`, `types.ts` L16-27).
- Produces: route `POST /marketing/campaigns/:id/social → { socialCampaignId: string }`, consumed by Task 40.

- [ ] **Step 1: Write the failing test** — controller delegates with `a.id` as `createdById`:
```ts
import { MarketingCampaignsController } from './marketing-campaigns.controller';

describe('MarketingCampaignsController.createSocial', () => {
  it('provisions a social campaign from the blast using the caller id', async () => {
    const campaigns = {} as any;
    const link = { provisionFromBlast: jest.fn().mockResolvedValue({ socialCampaignId: 'sc-1' }) } as any;
    const ctrl = new MarketingCampaignsController(campaigns, link);
    const user = { id: 'u-7', workspaceId: 'ws-1' } as any;

    const out = await ctrl.createSocial(user, 'camp-1');

    expect(out).toEqual({ socialCampaignId: 'sc-1' });
    expect(link.provisionFromBlast).toHaveBeenCalledWith('ws-1', 'camp-1', 'u-7');
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- marketing-campaigns.controller.spec`. Expect: `ctrl.createSocial is not a function` (and a TS arity error on the 2-arg constructor).
- [ ] **Step 3: Implement** — in `marketing-campaigns.controller.ts` add the import and inject the service, then the route:
```ts
import { SocialCampaignLinkService } from '../social-campaigns/social-campaign-link.service';
```
```ts
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly socialLink: SocialCampaignLinkService,
  ) {}
```
```ts
  /** Cross-link (§6.3): provision a companion Social Campaign prefilled from this
   *  blast (subject/body/audience). Sets Campaign.socialCampaignId. */
  @Post(':id/social')
  @RequirePermission('campaigns.send')
  @Audit({ action: 'campaign.social.provision', resourceType: 'campaign', resourceIdParam: 'id' })
  createSocial(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.socialLink.provisionFromBlast(a.workspaceId, id, a.id);
  }
```
Add the `Audit` import (`import { Audit } from '../../audit/audit.decorator';`). In `marketing.module.ts`, add `import { SocialCampaignLinkService } from './social-campaigns/social-campaign-link.service';` and include `SocialCampaignLinkService` in the `providers:` array (near `AdManagementService`, L657).
- [ ] **Step 4: Run test, expect PASS** — `npm test -- marketing-campaigns.controller.spec`; then `npm run build` (compile check).
- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing && git commit -m "feat(social-studio): expose POST campaigns/:id/social provisioning endpoint"`

---

### Task 36: Backend — Meta creative-upload client surface (`uploadAdImage` + `createAdCreative`)

**Files:**
- Modify: `backend/src/modules/marketing/ads/meta-ads-management.client.ts`
- Test: `backend/src/modules/marketing/ads/meta-ads-creative.client.spec.ts`

**Dependency note:** the `ads/` module currently has NO creative-upload surface (`meta-ads-management.client.ts` exposes only list/update/duplicate/create-campaign). This task adds the minimal IMAGE creative path. Video creatives (chunked `/advideos`) are a follow-up. Both calls need a token with `ads_management`, and `createAdCreative` requires a Facebook **Page ID** (`object_story_spec.page_id`) — supplied by the caller since `AdAccount` does not store one.

**Interfaces:**
- Consumes: `metaGraphFetch` (`backend/src/common/util/meta-graph.util.ts` — serializes a JSON `body`, appends token+proof); `MetaWriteResult`, `actOf`, `fail` (existing in the same client file).
- Produces:
  - `export interface MetaImageUploadResult { ok: boolean; hash?: string; error?: string; isAuthError?: boolean; }`
  - `uploadAdImage(token: string, externalAdId: string, base64Bytes: string): Promise<MetaImageUploadResult>`
  - `createAdCreative(token: string, externalAdId: string, input: { pageId: string; message: string; imageHash: string; name?: string }): Promise<MetaWriteResult>`

- [ ] **Step 1: Write the failing test** — mock the shared graph util:
```ts
import * as graph from '../../../common/util/meta-graph.util';
import { uploadAdImage, createAdCreative } from './meta-ads-management.client';

jest.mock('../../../common/util/meta-graph.util');
const mFetch = graph.metaGraphFetch as jest.Mock;

describe('meta-ads creative client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uploadAdImage POSTs base64 bytes to /adimages and returns the hash', async () => {
    mFetch.mockResolvedValue({ ok: true, status: 200, data: { images: { bytes: { hash: 'h-1' } } }, error: null });
    const r = await uploadAdImage('TOKEN', 'act_1', 'QkFTRTY0');
    expect(r).toEqual({ ok: true, hash: 'h-1' });
    expect(mFetch).toHaveBeenCalledWith('/act_1/adimages', expect.objectContaining({
      accessToken: 'TOKEN', method: 'POST', body: { bytes: 'QkFTRTY0' },
    }));
  });

  it('uploadAdImage surfaces a provider error', async () => {
    mFetch.mockResolvedValue({ ok: false, status: 400, data: {}, error: { message: 'bad image', isAuthError: false } });
    const r = await uploadAdImage('TOKEN', 'act_1', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bad image');
  });

  it('createAdCreative builds a photo_data object_story_spec and returns the id', async () => {
    mFetch.mockResolvedValue({ ok: true, status: 200, data: { id: 'cr-1' }, error: null });
    const r = await createAdCreative('TOKEN', 'act_1', { pageId: 'pg-1', message: 'hi', imageHash: 'h-1', name: 'Gen' });
    expect(r).toEqual({ ok: true, id: 'cr-1' });
    expect(mFetch).toHaveBeenCalledWith('/act_1/adcreatives', expect.objectContaining({
      method: 'POST',
      body: {
        name: 'Gen',
        object_story_spec: { page_id: 'pg-1', photo_data: { image_hash: 'h-1', caption: 'hi' } },
      },
    }));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- meta-ads-creative.client.spec`. Expect: `uploadAdImage is not a function` / import undefined.
- [ ] **Step 3: Implement** — append to `meta-ads-management.client.ts`:
```ts
export interface MetaImageUploadResult {
  ok: boolean;
  hash?: string;
  error?: string;
  isAuthError?: boolean;
}

/** Upload an image (base64 bytes) to the ad account's image library → image_hash. */
export async function uploadAdImage(
  token: string,
  externalAdId: string,
  base64Bytes: string,
): Promise<MetaImageUploadResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/adimages`, {
    accessToken: token,
    method: 'POST',
    body: { bytes: base64Bytes },
    timeoutMs: 30_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta upload image') };
  const images = r.data?.images ?? {};
  const first: any = Object.values(images)[0];
  const hash = first?.hash ? String(first.hash) : undefined;
  if (!hash) return { ok: false, error: 'Meta upload image: no hash returned', isAuthError: false };
  return { ok: true, hash };
}

/** Create a page-photo ad creative from an uploaded image_hash (no link needed). */
export async function createAdCreative(
  token: string,
  externalAdId: string,
  input: { pageId: string; message: string; imageHash: string; name?: string },
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/adcreatives`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name ?? 'Generated creative',
      object_story_spec: {
        page_id: input.pageId,
        photo_data: { image_hash: input.imageHash, caption: input.message },
      },
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create creative') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- meta-ads-creative.client.spec`.
- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing/ads && git commit -m "feat(social-studio): add Meta ad image+creative upload client surface"`

---

### Task 37: Backend — `AdManagementService.pushImageCreative` (download → upload → creative)

**Files:**
- Modify: `backend/src/modules/marketing/ads/ad-management.service.ts`
- Test: `backend/src/modules/marketing/ads/ad-management.spec.ts` (extend existing)

**Interfaces:**
- Consumes: `uploadAdImage`, `createAdCreative`, `MetaImageUploadResult`, `MetaWriteResult` (Task 36); existing private `metaAccount(workspaceId, id)` (returns `{ account, token }`) and `onResult(accountId, r)` (L41-70).
- Produces: `pushImageCreative(workspaceId: string, adAccountId: string, input: { imageUrl: string; message: string; pageId: string; name?: string }): Promise<{ creativeId: string; imageHash: string }>`, consumed by Task 38.

- [ ] **Step 1: Write the failing test** — add to `ad-management.spec.ts` (it already mocks `./meta-ads-management.client` and `openSecret`). Stub `global.fetch` for the image download:
```ts
  it('pushImageCreative downloads the image, uploads it, and creates a creative', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('IMG').buffer,
    });
    mClient.uploadAdImage.mockResolvedValue({ ok: true, hash: 'h-1' });
    mClient.createAdCreative.mockResolvedValue({ ok: true, id: 'cr-1' });

    const out = await svc.pushImageCreative('ws', 'acc', {
      imageUrl: 'https://cdn.example/x.png', message: 'hello', pageId: 'pg-1',
    });

    expect(out).toEqual({ creativeId: 'cr-1', imageHash: 'h-1' });
    expect(mClient.uploadAdImage).toHaveBeenCalledWith('TOKEN', 'act_1', expect.any(String));
    expect(mClient.createAdCreative).toHaveBeenCalledWith('TOKEN', 'act_1', {
      pageId: 'pg-1', message: 'hello', imageHash: 'h-1', name: 'Generated creative',
    });
  });

  it('pushImageCreative throws BadRequest when the upload fails', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(3) });
    mClient.uploadAdImage.mockResolvedValue({ ok: false, error: 'bad image' });
    await expect(
      svc.pushImageCreative('ws', 'acc', { imageUrl: 'https://x/y.png', message: 'm', pageId: 'p' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- ad-management.spec`. Expect: `svc.pushImageCreative is not a function`.
- [ ] **Step 3: Implement** — add the imports to `ad-management.service.ts`:
```ts
import {
  listCampaigns,
  listAdSets,
  updateEntity,
  duplicateCampaign,
  createCampaign,
  uploadAdImage,
  createAdCreative,
  MetaAdEntity,
  MetaWriteResult,
} from './meta-ads-management.client';
```
Add the method to the class:
```ts
  /**
   * Push an image (any reachable URL — we use our own R2 asset URL) to a Meta ad
   * account as a page-photo creative. Returns the creative id + image hash. Needs
   * a Facebook Page id (object_story_spec). Video creatives are a follow-up.
   */
  async pushImageCreative(
    workspaceId: string,
    adAccountId: string,
    input: { imageUrl: string; message: string; pageId: string; name?: string },
  ): Promise<{ creativeId: string; imageHash: string }> {
    if (!input.pageId) throw new BadRequestException('A Facebook Page id is required for the creative');
    const { account, token } = await this.metaAccount(workspaceId, adAccountId);

    const res = await fetch(input.imageUrl);
    if (!res.ok) throw new BadRequestException('Could not download the source image');
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');

    const up = await this.onResult(account.id, await uploadAdImage(token, account.externalAdId, base64));
    if (!up.ok || !up.hash) throw new BadRequestException(up.error ?? 'Failed to upload creative image');

    const cr = await this.onResult(
      account.id,
      await createAdCreative(token, account.externalAdId, {
        pageId: input.pageId,
        message: input.message,
        imageHash: up.hash,
        name: input.name ?? 'Generated creative',
      }),
    );
    if (!cr.ok || !cr.id) throw new BadRequestException(cr.error ?? 'Failed to create ad creative');
    return { creativeId: cr.id, imageHash: up.hash };
  }
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- ad-management.spec`.
- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing/ads && git commit -m "feat(social-studio): push an image as a Meta ad creative via AdManagementService"`

---

### Task 38: Backend — `pushAssetToMetaAd` (records `linkedAdCampaignId`) + endpoint

**Files:**
- Modify: `backend/src/modules/marketing/social-campaigns/social-campaign-link.service.ts` (add method)
- Modify: `backend/src/modules/marketing/controllers/marketing-ads.controller.ts` (add route + inject service)
- Test: `backend/src/modules/marketing/social-campaigns/social-campaign-link.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `AdManagementService.pushImageCreative(...)` (Task 37); `GeneratedAsset` model (Task 2 — fields `id`, `workspaceId`, `type`, `status`, `url`, `prompt`, `socialCampaignId`); `SocialCampaign.linkedAdCampaignId` (Task 18).
- Produces: `pushAssetToMetaAd(workspaceId, input: { assetId; adAccountId; adCampaignId; pageId; message? }): Promise<{ creativeId: string; imageHash: string; adCampaignId: string }>`; route `POST /marketing/ads/accounts/:id/creatives/from-asset`, consumed by Task 41.

- [ ] **Step 1: Write the failing test** — add to `social-campaign-link.service.spec.ts`:
```ts
  describe('pushAssetToMetaAd', () => {
    it('pushes a READY image asset and records linkedAdCampaignId on its social campaign', async () => {
      prisma.generatedAsset.findFirst.mockResolvedValue({
        id: 'a-1', workspaceId: WS, type: 'IMAGE', status: 'READY',
        url: 'https://cdn/x.png', prompt: 'a cat', socialCampaignId: 'sc-3',
      });
      adMgmt.pushImageCreative.mockResolvedValue({ creativeId: 'cr-1', imageHash: 'h-1' });

      const out = await svc.pushAssetToMetaAd(WS, {
        assetId: 'a-1', adAccountId: 'acc-1', adCampaignId: 'adc-9', pageId: 'pg-1', message: 'promo',
      });

      expect(out).toEqual({ creativeId: 'cr-1', imageHash: 'h-1', adCampaignId: 'adc-9' });
      expect(adMgmt.pushImageCreative).toHaveBeenCalledWith(WS, 'acc-1', {
        imageUrl: 'https://cdn/x.png', message: 'promo', pageId: 'pg-1',
      });
      expect(prisma.socialCampaign.update).toHaveBeenCalledWith({
        where: { id: 'sc-3' }, data: { linkedAdCampaignId: 'adc-9' },
      });
    });

    it('rejects a non-image or non-ready asset', async () => {
      prisma.generatedAsset.findFirst.mockResolvedValue({ id: 'a-2', workspaceId: WS, type: 'VIDEO', status: 'READY', url: 'u' });
      await expect(
        svc.pushAssetToMetaAd(WS, { assetId: 'a-2', adAccountId: 'acc', adCampaignId: 'c', pageId: 'p' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the link update when the asset has no social campaign', async () => {
      prisma.generatedAsset.findFirst.mockResolvedValue({ id: 'a-3', workspaceId: WS, type: 'IMAGE', status: 'READY', url: 'u', prompt: 'p', socialCampaignId: null });
      adMgmt.pushImageCreative.mockResolvedValue({ creativeId: 'cr-2', imageHash: 'h-2' });
      await svc.pushAssetToMetaAd(WS, { assetId: 'a-3', adAccountId: 'acc', adCampaignId: 'c', pageId: 'p' });
      expect(prisma.socialCampaign.update).not.toHaveBeenCalled();
    });
  });
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- social-campaign-link.service.spec`. Expect: `svc.pushAssetToMetaAd is not a function`.
- [ ] **Step 3: Implement** — add to `SocialCampaignLinkService`:
```ts
  /**
   * Push a READY image GeneratedAsset to a Meta ad as a creative (§6.3). When the
   * asset belongs to a SocialCampaign, record the target ad campaign on it. The
   * push itself is an explicit user action — never automatic.
   */
  async pushAssetToMetaAd(
    workspaceId: string,
    input: { assetId: string; adAccountId: string; adCampaignId: string; pageId: string; message?: string },
  ): Promise<{ creativeId: string; imageHash: string; adCampaignId: string }> {
    const asset = await this.prisma.generatedAsset.findFirst({
      where: { id: input.assetId, workspaceId },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.type !== 'IMAGE') throw new BadRequestException('Only image assets can be pushed as a creative');
    if (asset.status !== 'READY' || !asset.url) throw new BadRequestException('Asset is not ready');

    const res = await this.adMgmt.pushImageCreative(workspaceId, input.adAccountId, {
      imageUrl: asset.url,
      message: input.message ?? asset.prompt,
      pageId: input.pageId,
    });

    if (asset.socialCampaignId) {
      await this.prisma.socialCampaign.update({
        where: { id: asset.socialCampaignId },
        data: { linkedAdCampaignId: input.adCampaignId },
      });
    }
    return { ...res, adCampaignId: input.adCampaignId };
  }
```
In `marketing-ads.controller.ts`, add the DTO + route. Add imports `IsOptional`, and the service:
```ts
import { SocialCampaignLinkService } from '../social-campaigns/social-campaign-link.service';

class PushCreativeDto {
  @IsString() @MaxLength(64) assetId: string;
  @IsString() @MaxLength(64) adCampaignId: string;
  @IsString() @MaxLength(64) pageId: string;
  @IsString() @IsOptional() @MaxLength(2000) message?: string;
}
```
Inject it: `constructor(private readonly adAccounts: AdAccountService, private readonly adMgmt: AdManagementService, private readonly socialLink: SocialCampaignLinkService) {}`. Add the route:
```ts
  /** Push a generated asset to a Meta ad as a creative (§6.3). */
  @Post('accounts/:id/creatives/from-asset')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.creative.from_asset', resourceType: 'ad_account', resourceIdParam: 'id', captureBody: ['assetId', 'adCampaignId'] })
  pushCreative(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: PushCreativeDto,
  ) {
    return this.socialLink.pushAssetToMetaAd(a.workspaceId, {
      assetId: dto.assetId,
      adAccountId: id,
      adCampaignId: dto.adCampaignId,
      pageId: dto.pageId,
      message: dto.message,
    });
  }
```
Add `IsOptional`, `MaxLength` to the `class-validator` import line (L11). Note: `SocialCampaignLinkService` is registered in the module (Task 35), so no extra provider wiring is needed.
- [ ] **Step 4: Run test, expect PASS** — `npm test -- social-campaign-link.service.spec`; then `npm run build`.
- [ ] **Step 5: Commit** — `git add backend/src/modules/marketing && git commit -m "feat(social-studio): push generated asset to Meta ad creative and record linkedAdCampaignId"`

---

### Task 39: Frontend — typed API for provisioning + creative push

**Files:**
- Create: `frontend/src/features/marketing/api/social-link.service.ts`
- Test: `frontend/src/features/marketing/api/social-link.service.test.ts`

**Interfaces:**
- Consumes: `marketingApi` (default axios instance, `baseURL …/marketing`); routes `POST /campaigns/:id/social` (Task 35) and `POST /ads/accounts/:id/creatives/from-asset` (Task 38).
- Produces:
  - `provisionSocialFromCampaign(campaignId: string): Promise<{ socialCampaignId: string }>`
  - `pushAssetToMetaAd(adAccountId: string, payload: PushCreativePayload): Promise<{ creativeId: string; imageHash: string; adCampaignId: string }>`
  - `interface PushCreativePayload { assetId: string; adCampaignId: string; pageId: string; message?: string }`

- [ ] **Step 1: Write the failing test** — mock the axios module:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { post: vi.fn() },
}));
import marketingApi from './marketingApi';
import { provisionSocialFromCampaign, pushAssetToMetaAd } from './social-link.service';

const post = marketingApi.post as unknown as ReturnType<typeof vi.fn>;

describe('social-link.service', () => {
  beforeEach(() => post.mockReset());

  it('provisionSocialFromCampaign posts to the campaign social route', async () => {
    post.mockResolvedValue({ data: { socialCampaignId: 'sc-1' } });
    const out = await provisionSocialFromCampaign('camp-1');
    expect(out).toEqual({ socialCampaignId: 'sc-1' });
    expect(post).toHaveBeenCalledWith('/campaigns/camp-1/social');
  });

  it('pushAssetToMetaAd posts the creative payload to the account route', async () => {
    post.mockResolvedValue({ data: { creativeId: 'cr-1', imageHash: 'h-1', adCampaignId: 'adc-9' } });
    const out = await pushAssetToMetaAd('acc-1', { assetId: 'a-1', adCampaignId: 'adc-9', pageId: 'pg-1' });
    expect(out.creativeId).toBe('cr-1');
    expect(post).toHaveBeenCalledWith('/ads/accounts/acc-1/creatives/from-asset', {
      assetId: 'a-1', adCampaignId: 'adc-9', pageId: 'pg-1',
    });
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — from `frontend/`: `npm test -- social-link.service`. Expect: `Failed to resolve import "./social-link.service"`.
- [ ] **Step 3: Implement** — create `social-link.service.ts`:
```ts
import marketingApi from './marketingApi';

export interface PushCreativePayload {
  assetId: string;
  adCampaignId: string;
  pageId: string;
  message?: string;
}

export const provisionSocialFromCampaign = (
  campaignId: string,
): Promise<{ socialCampaignId: string }> =>
  marketingApi.post(`/campaigns/${campaignId}/social`).then((r) => r.data);

export const pushAssetToMetaAd = (
  adAccountId: string,
  payload: PushCreativePayload,
): Promise<{ creativeId: string; imageHash: string; adCampaignId: string }> =>
  marketingApi.post(`/ads/accounts/${adAccountId}/creatives/from-asset`, payload).then((r) => r.data);
```
- [ ] **Step 4: Run test, expect PASS** — `npm test -- social-link.service`.
- [ ] **Step 5: Commit** — `git add frontend/src/features/marketing/api/social-link.service.ts frontend/src/features/marketing/api/social-link.service.test.ts && git commit -m "feat(social-studio): typed FE api for social provisioning and Meta creative push"`

---

### Task 40: Frontend — "Create social content" action on the campaigns page

**Files:**
- Modify: `frontend/src/pages/marketing/CampaignsPage.tsx`
- Modify: `frontend/src/i18n/locales/en/marketing.json`, `frontend/src/i18n/locales/tr/marketing.json`
- Test: `frontend/src/pages/marketing/CampaignsPage.socialLink.test.tsx`

**Interfaces:**
- Consumes: `provisionSocialFromCampaign(campaignId)` (Task 39); existing `useMutation` + `toast` (`sonner`) + `useTranslation('marketing')` patterns already in `CampaignsPage.tsx`; `useNavigate` (react-router) to jump to the new social campaign.
- Produces: a per-row "Create social content" action that calls the provision mutation and navigates to `/marketing/social-campaigns/:id`.

- [ ] **Step 1: Write the failing test** — mock the api + router, render, click:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig() as object), useNavigate: () => navigate }));
vi.mock('../../features/marketing/api/social-link.service', () => ({
  provisionSocialFromCampaign: vi.fn().mockResolvedValue({ socialCampaignId: 'sc-9' }),
}));
import { provisionSocialFromCampaign } from '../../features/marketing/api/social-link.service';
import { CampaignSocialLinkButton } from './CampaignsPage';

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
);

describe('CampaignSocialLinkButton', () => {
  beforeEach(() => { navigate.mockReset(); });
  it('provisions and navigates to the new social campaign', async () => {
    render(wrap(<CampaignSocialLinkButton campaignId="camp-1" />));
    fireEvent.click(screen.getByRole('button', { name: /social/i }));
    await waitFor(() => expect(provisionSocialFromCampaign).toHaveBeenCalledWith('camp-1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/marketing/social-campaigns/sc-9'));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- CampaignsPage.socialLink`. Expect: `CampaignSocialLinkButton` is not exported.
- [ ] **Step 3: Implement** — in `CampaignsPage.tsx` add imports (`useNavigate` from `react-router-dom`, `provisionSocialFromCampaign` from `../../features/marketing/api/social-link.service`, `Button` from `@/components/ui/Button`, `toast` from `sonner`, `useTranslation`) and export a small component:
```tsx
export function CampaignSocialLinkButton({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const provision = useMutation({
    mutationFn: () => provisionSocialFromCampaign(campaignId),
    onSuccess: (r) => {
      toast.success(t('campaigns.socialCreated', 'Sosyal içerik kampanyası oluşturuldu'));
      navigate(`/marketing/social-campaigns/${r.socialCampaignId}`);
    },
    onError: () => toast.error(t('campaigns.socialCreateFailed', 'Sosyal içerik oluşturulamadı')),
  });
  return (
    <Button variant="outline" size="sm" disabled={provision.isPending} onClick={() => provision.mutate()}>
      {t('campaigns.createSocial', 'Sosyal içerik oluştur')}
    </Button>
  );
}
```
Render `<CampaignSocialLinkButton campaignId={c.id} />` in each campaign row's action cell. Add the three keys to both `en/marketing.json` and `tr/marketing.json` under `campaigns` (`createSocial`, `socialCreated`, `socialCreateFailed`), with English strings in `en/`.
- [ ] **Step 4: Run test, expect PASS** — `npm test -- CampaignsPage.socialLink`; then `npm run build` (typecheck).
- [ ] **Step 5: Commit** — `git add frontend/src/pages/marketing/CampaignsPage.tsx frontend/src/pages/marketing/CampaignsPage.socialLink.test.tsx frontend/src/i18n/locales && git commit -m "feat(social-studio): create-social-content action on the campaigns page"`

---

### Task 41: Frontend — "Send to Meta ad" action in the AI Content Studio asset library

**Files:**
- Create: `frontend/src/pages/marketing/social/SendToMetaAdDialog.tsx`
- Test: `frontend/src/pages/marketing/social/SendToMetaAdDialog.test.tsx`
- Modify: `frontend/src/i18n/locales/en/marketing.json`, `frontend/src/i18n/locales/tr/marketing.json`

**Dependency note:** the asset-library grid (`AiStudioPage.tsx`, Task 13) and the approval queue (Task 29) are produced by Milestones 2/3. This task delivers the self-contained `SendToMetaAdDialog` those grids open from a per-asset "Send to Meta ad" menu action (wired in by passing `assetId`); the dialog owns the account/campaign/page inputs and the push mutation.

**Interfaces:**
- Consumes: `pushAssetToMetaAd(adAccountId, payload)` + `PushCreativePayload` (Task 39); `listAdAccounts`/account listing from `ads.service.ts` (existing `AdAccount` type); `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`, `Input`, `Label`, `Button` from `@/components/ui/*`; `toast` (`sonner`); `useTranslation('marketing')`.
- Produces: `<SendToMetaAdDialog open assetId onClose />` that posts a creative and toasts success/failure.

- [ ] **Step 1: Write the failing test** — mock the push api, render open, fill, submit:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../features/marketing/api/social-link.service', () => ({
  pushAssetToMetaAd: vi.fn().mockResolvedValue({ creativeId: 'cr-1', imageHash: 'h-1', adCampaignId: 'adc-9' }),
}));
import { pushAssetToMetaAd } from '../../../features/marketing/api/social-link.service';
import { SendToMetaAdDialog } from './SendToMetaAdDialog';

const wrap = (ui: React.ReactNode) =>
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('SendToMetaAdDialog', () => {
  beforeEach(() => (pushAssetToMetaAd as ReturnType<typeof vi.fn>).mockClear());
  it('submits the creative push with the entered ids', async () => {
    render(wrap(<SendToMetaAdDialog open assetId="a-1" onClose={() => {}} />));
    fireEvent.change(screen.getByLabelText(/account/i), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText(/campaign/i), { target: { value: 'adc-9' } });
    fireEvent.change(screen.getByLabelText(/page/i), { target: { value: 'pg-1' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(pushAssetToMetaAd).toHaveBeenCalledWith('acc-1', {
      assetId: 'a-1', adCampaignId: 'adc-9', pageId: 'pg-1', message: undefined,
    }));
  });
});
```
- [ ] **Step 2: Run test, expect FAIL** — `npm test -- SendToMetaAdDialog`. Expect: `Failed to resolve import "./SendToMetaAdDialog"`.
- [ ] **Step 3: Implement** — create `SendToMetaAdDialog.tsx`:
```tsx
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field, Label, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { pushAssetToMetaAd } from '../../../features/marketing/api/social-link.service';

interface Props { open: boolean; assetId: string; onClose: () => void; }

export function SendToMetaAdDialog({ open, assetId, onClose }: Props) {
  const { t } = useTranslation('marketing');
  const [adAccountId, setAdAccountId] = useState('');
  const [adCampaignId, setAdCampaignId] = useState('');
  const [pageId, setPageId] = useState('');

  const push = useMutation({
    mutationFn: () => pushAssetToMetaAd(adAccountId, { assetId, adCampaignId, pageId, message: undefined }),
    onSuccess: () => { toast.success(t('aiStudio.sentToAd', 'Reklam görseli olarak gönderildi')); onClose(); },
    onError: () => toast.error(t('aiStudio.sendToAdFailed', 'Reklam görseli gönderilemedi')),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('aiStudio.sendToAd', 'Meta reklamına gönder')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field>
            <Label htmlFor="m-acc">{t('aiStudio.adAccount', 'Reklam hesabı')}</Label>
            <Input id="m-acc" value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)} />
          </Field>
          <Field>
            <Label htmlFor="m-camp">{t('aiStudio.adCampaign', 'Reklam kampanyası')}</Label>
            <Input id="m-camp" value={adCampaignId} onChange={(e) => setAdCampaignId(e.target.value)} />
          </Field>
          <Field>
            <Label htmlFor="m-page">{t('aiStudio.pageId', 'Sayfa ID')}</Label>
            <Input id="m-page" value={pageId} onChange={(e) => setPageId(e.target.value)} />
          </Field>
          <Button
            disabled={push.isPending || !adAccountId || !adCampaignId || !pageId}
            onClick={() => push.mutate()}
          >
            {t('aiStudio.send', 'Gönder')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```
(If `Field`/`Label` are not co-exported from `@/components/ui/Input` in this codebase, import `Label`/`Field` from `@/components/ui/Label`/`@/components/ui/Field` per the real `components/ui/index.ts` exports.) Add the keys (`aiStudio.sendToAd`, `aiStudio.sentToAd`, `aiStudio.sendToAdFailed`, `aiStudio.adAccount`, `aiStudio.adCampaign`, `aiStudio.pageId`, `aiStudio.send`) to both locale files with English strings in `en/` (keep parity with the Task 16 `marketing-parity.test.ts` which mirrors all `aiStudio.*` keys).
- [ ] **Step 4: Run test, expect PASS** — `npm test -- SendToMetaAdDialog`; then `npm run build`.
- [ ] **Step 5: Commit** — `git add frontend/src/pages/marketing/social/SendToMetaAdDialog.tsx frontend/src/pages/marketing/social/SendToMetaAdDialog.test.tsx frontend/src/i18n/locales && git commit -m "feat(social-studio): send-to-Meta-ad dialog for generated assets"`

---

## Spec Coverage Check

| Spec section | Tasks |
| --- | --- |
| §4 — Media generation pipeline & providers | 1, 3, 5, 6, 7, 8 |
| §5.2 — BrandKit data model | 2, 9, 12, 15 |
| §5.3 — GeneratedAsset data model + lifecycle | 1, 2, 6, 7, 8 |
| §5.4 — SocialCampaign / SocialCampaignItem data model | 18, 19, 20, 25 |
| §5.6 — Campaign↔Social companion link column | 33, 34 |
| §6 — Planning + automation modes (plan/generate/confirm) | 20, 21, 22 |
| §6.3 — Cross-linkage (campaigns ↔ social ↔ Meta ads) | 34, 35, 36, 37, 38, 39, 40, 41 |
| §7 — Credits: reserve → reconcile → refund + cost rows | 4, 6, 7, 22 |
| §8 — REST API surface (media, brand-kit, social-campaigns, cross-link) | 10, 11, 12, 23, 25, 35, 38, 39 |
| §9 — Feature flags + RBAC gating (`mediaGen`, `socialCampaigns`, MANAGER, `campaigns.send`) | 10, 17, 23 |
| §10 — Frontend AI Content Studio (panel, library, composer, Brand Kit) | 11, 12, 13, 14, 15 |
| §11 — Frontend Social Campaigns (list, builder, calendar, approval queue, nav) | 24, 25, 26, 27, 28, 29, 30, 31 |
| §12 — i18n TR/EN parity | 16, 32, 40, 41 |

All spec sections §4–§12 map to at least one task. Type/signature consistency verified across milestones: `MediaGenService.requestGeneration` / `finalizeAsset` / `finalizeByRequestId` (Tasks 6, 7, 10) are consumed unchanged by the Social Campaign planner (Task 21) and webhook (Task 10); `GeneratedAsset` fields (`id, type, status, url, r2Key, mime, prompt, socialCampaignId`) are read identically in Tasks 2, 7, 10, 13, 38; `SocialCampaign`/`SocialCampaignItem` enum vocabularies match between Prisma (Task 18), the service (Tasks 20–22), the FE types (Task 25), and the cross-link service (Tasks 34, 38). No coverage gap required adding a task beyond the five milestone lists.