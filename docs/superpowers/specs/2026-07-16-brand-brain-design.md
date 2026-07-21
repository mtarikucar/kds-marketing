# Brand Brain — Design Spec

**Date:** 2026-07-16
**Status:** Approved (design) — pending implementation plan
**Branch:** `feat/brand-brain`

## Problem

When someone starts using the platform there is no single place to teach it about
the product/brand they sell. What little exists is **write-once and fragmented**:

- `Workspace.productName/productUrl/productDescription` + `settings.businessTypes` are
  collected only at register (`register-workspace.dto.ts`) — there is **no post-register
  edit UI**.
- `BrandKit` (logo/palette/tone/reference images/hashtags/CTA) exists but is **only
  consumed by the Social Campaign engine** (`social-campaigns.service.ts`).
- `ResearchProfile` (ICP/geo/businessTypes) is a separate, manually-filled targeting record.
- A `brand-brain` module already does cited chunk retrieval over `KnowledgeChunk`, but it is
  **not wired into any AI prompt** — it's an orphaned search UI.

As a result the AIs are under-grounded: `conversation-ai-engine.buildSystem` injects
agent+lead+KB but **no product/brand context**; `content-ai.compose` sees only
`productName`/`productDescription`; the research agent targets from thin Workspace fields.

## Goal

On first login the user provides everything known about the product they sell — website,
social accounts, uploaded photos/materials, Google Business — and the system **auto-extracts**
a consolidated brand profile. That profile then (1) **seeds the AI researcher's lead
targeting** and (2) **grounds every workspace AI** (conversation replies, content generation,
social studio, voice) — always-on for the core facts, retrievable for the deep material.

## Non-goals

- Replacing `WorkspaceBranding` (the customer-facing white-label brand — brandName/accentColor/
  logo). Brand Brain is the *internal* AI-grounding brand knowledge; the two coexist.
- A separate embeddings provider rollout — the design works FTS-first and upgrades to
  embedding re-rank only if/when a provider is configured (same posture as the existing
  brand-brain module).
- Scheduled auto-recrawl. v1 is a one-time analyze + a manual "Re-analyze" action.
- Multi-brand per workspace. One `BrandProfile` per workspace (matches `BrandKit`'s `@@unique`).

## Chosen approach — Extend the existing `brand-brain` module (Approach C)

Build on the already-scaffolded `brand-brain` module + the `/branding` "Brain" tab. The
consolidated brand knowledge splits cleanly into two tiers:

- **A structured `BrandProfile` header** — the *always-on compact summary* injected into every
  AI system prompt (identity, voice, ICP, selling points, objections, offerings).
- **The full crawled/scraped materials as `KnowledgeDoc` + `KnowledgeChunk`** — the *deep,
  retrievable* tier, which finally wires the orphaned chunk retrieval into the grounding path.

Rejected: **A** (a brand-new standalone model that overlaps BrandKit/WorkspaceBranding/
ResearchProfile — dual-source-of-truth risk, most new surface); **B** (no new model, fill the 4
existing stores directly — leaves brand knowledge scattered with nowhere for value-props /
objections / offerings and forces a 4-table join on every prompt).

### The "owns vs seeds" boundary (the load-bearing rule)

- **BrandProfile OWNS** the *new* facets: brand identity, voice/tone guide, ICP, value props,
  audience objections, offerings, source provenance, social handles.
- **BrandProfile SEEDS** (writes a proposed draft into, then never silently overwrites):
  `BrandKit` (visual identity), `ResearchProfile` (targeting), and
  `Workspace.productName/productDescription/settings.businessTypes` (so every existing consumer
  that reads those keeps working unchanged).
- Seeding is a **first-write + reconcile-on-re-analyze** operation: on "Re-analyze", changed
  facets are shown as a diff and the user confirms per-field; a field the user has edited since
  the last apply is never clobbered.

## 1. Data model & migration

### New `BrandProfile` (one per workspace — the structured header)

```
model BrandProfile {
  id                 String    @id @default(uuid())
  workspaceId        String    @unique
  // Identity
  brandName          String
  tagline            String?
  description        String?   @db.Text        // 2-4 sentences: what we sell + for whom
  valueProps         Json?     // string[] — the key selling points
  // Voice
  toneWords          Json?     // string[]  e.g. ["warm","expert","concise"]
  voiceGuide         String?   @db.Text        // messaging do / don't
  // Audience (feeds research targeting + AI empathy)
  icpDescription     String?   @db.Text
  audienceObjections Json?     // string[] — common objections the AI should preempt
  // Offerings
  offerings          Json?     // [{ name, blurb, price? }]
  // Provenance
  sources            Json?     // [{ type:'website'|'social'|'gbp'|'upload', url?, handle?, scrapedAt }]
  socialHandles      Json?     // [{ network, handle }]
  // Lifecycle
  status             String    @default("DRAFT")  // DRAFT | ACTIVE
  lastAnalyzedAt     DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  @@map("brand_profiles")
}
```

### New `BrandAnalysisRun` (one active per workspace — the async pipeline record)

```
model BrandAnalysisRun {
  id            String    @id @default(uuid())
  workspaceId   String
  status        String    @default("QUEUED")  // QUEUED | RUNNING | READY_FOR_REVIEW | APPLIED | FAILED
  inputs        Json      // { websiteUrl?, socialHandles[], gbpUrl?, uploadKeys[] }
  sourceResults Json?     // per-source raw+status, cached so re-synthesis doesn't re-crawl
  draft         Json?     // the AI-synthesized BrandProfile + proposed ResearchProfile + BrandKit hints + selected doc refs
  costUsd       Float?    // metered external spend (Firecrawl/Apify) for this run
  error         String?
  createdAt     DateTime  @default(now())
  completedAt   DateTime?
  @@index([workspaceId, status])
  @@map("brand_analysis_runs")
}
```

### Reused, not created

- `KnowledgeDoc` (+ its `searchVector` FTS) and `KnowledgeChunk` — brand materials land here
  with `source='brand-brain'`, so the **existing FTS grounding automatically includes them**.
- `BrandKit`, `ResearchProfile`, `Workspace` product fields — seeded (see the owns/seeds rule).

### Migration (reversible — CLAUDE.md up/down)

- **up:** `CREATE TABLE IF NOT EXISTS brand_profiles`, `brand_analysis_runs` + indexes. Additive
  only; no change to existing tables.
- **down:** `DROP TABLE IF EXISTS` both. No data loss (the seeded consumer rows are pre-existing
  tables and are left intact).

## 2. Extraction pipeline

A metered, failure-isolated, async multi-source pipeline that rides the existing ScheduledJob
runner + advisory-lock backbone, and the AI Research engine's **metered source-provider seam**
(Firecrawl/Apify are the metered external providers; the seam already exists and is inert
without keys).

**Orchestration** — `BrandBrainAnalysisService`:
- `startAnalysis(workspaceId, inputs)` → creates a `BrandAnalysisRun` (QUEUED), schedules a
  `brand-brain.analyze` ScheduledJob with `dedupKey = workspaceId` (one active analyze per
  workspace). Returns the run id for polling.
- The handler runs each source adapter, caches per-source results on the run, then the synthesis
  step, then flips the run to `READY_FOR_REVIEW`. A per-source failure is isolated (logged,
  status recorded) and never aborts the others; a synthesis failure → `FAILED` with a message.

**Source adapters** (one interface, each metered + inert-fallback):
- **Website** — Firecrawl `map` to enumerate pages, then bounded `scrape` of the highest-value
  pages (home, products/services, about, pricing, FAQ; cap ~15 pages) → markdown.
- **Social** — Apify actor per network (IG/FB/LinkedIn/TikTok): recent posts + bio + images.
  Handles resolved from the provided links OR existing `SocialAccount` rows (`network`+`handle`).
- **Google Business** — Apify GBP + reviews actor → profile (category/location) + top reviews.
- **Uploads** — user files already in R2: images become BrandKit reference-image candidates;
  PDFs/office docs are text-extracted into knowledge material.

**Synthesis** — one bounded, strict-JSON Claude call (the structured-output contract used
elsewhere) takes all gathered raw material and returns:
- the `BrandProfile` draft (identity/voice/ICP/valueProps/objections/offerings),
- a **proposed `ResearchProfile`** (icpDescription + inferred `businessTypes` ⊆ workspace list +
  `geo` from GBP/site) — this is the "who to collect leads from" foundation,
- **BrandKit hints** (palette sampled from site/images, tone, hashtags, CTA),
- the selection of which raw materials become `KnowledgeDoc`s (with titles).

**Cost rails:** external spend metered via the research metered-budget seam + bounded
crawl/scrape/actor counts recorded on `BrandAnalysisRun.costUsd`; the synthesis LLM call metered
against `ai-credits` (reserve → refund-on-failure, the established pattern). Re-synthesis reuses
cached `sourceResults` (no re-crawl) unless the user forces a fresh crawl.

## 3. Wizard UX + first-login trigger

**Trigger:** a first-login **full-screen, skippable** wizard for a fresh workspace (route under
the marketing app, e.g. `/brand-brain/setup`); re-openable any time from the `/branding` **Brain**
tab. A `GettingStarted` "Build your Brand Brain" step is added and a dashboard banner tracks an
in-progress run.

**Steps:**
1. **Sources** — website URL, social handles (prefilled from connected `SocialAccount`s), GBP
   URL, and drag-drop upload of images/materials (R2, size/type validated). "Analyze" starts the
   async run.
2. **Analyzing** — non-blocking progress with per-source status (poll the run; the user may leave
   and come back — the GettingStarted step + banner resume it).
3. **Review draft** — the synthesized `BrandProfile` + proposed `ResearchProfile` + BrandKit hints
   + selected knowledge docs, **all editable**. On a re-analyze, a per-field diff vs the current
   values (edited fields flagged, never auto-overwritten).
4. **Apply** — writes `BrandProfile` (`ACTIVE`), seeds BrandKit/ResearchProfile/Workspace fields
   (respecting edits), creates the `KnowledgeDoc`s, triggers a chunk reindex, marks the run
   `APPLIED`.

**Gating:** MANAGER+, behind the AI/knowledge feature the workspace already uses. When no source
provider is configured (no Firecrawl/Apify keys), the wizard degrades gracefully to the manual
form (every draft field is hand-editable) and says so per-source — never crashes.

## 4. AI consumption wiring (the point of the feature)

**Always-on compact brand block** — `BrandContextService.summaryFor(workspaceId)` returns a
short cached block (brandName, what-we-sell, top valueProps, tone words, ICP one-liner, top
objections) derived from the `ACTIVE` `BrandProfile`. Injected into:
- `conversation-ai-engine.buildSystem` — new "About this brand" section alongside agent+lead+KB.
- `content-ai.compose` — replaces the thin productName/description with the full brand block +
  tone/voice guide.
- `social-campaigns` generation — augments the existing BrandKit feed with the brand block.
- `netgsm-ivr.generateInfo` and the other voice grounding callers.
- `research-worker.buildBrief` — the brief now reads the richer `BrandProfile` ICP/valueProps/geo
  (via the seeded `ResearchProfile`) → sharper lead targeting.

The block is **cached** (invalidated on BrandProfile write) so it costs one small read per prompt.
Empty/absent BrandProfile → the block is omitted and every caller behaves exactly as today (safe,
incremental rollout).

**Deep retrieval** — brand materials are ordinary `KnowledgeDoc`s, so the existing
`KnowledgeService.search` (FTS, always available, `kbDocIds`-scoped) already grounds on them with
no new wiring. `BrandBrainService.search` (chunk + citation + optional embedding re-rank) becomes
the **upgrade path** for grounding when embeddings are configured, falling back to FTS. No dual
source of truth: `KnowledgeDoc` is the store, FTS the floor, chunk/embedding the enhancement.

**Research targeting production** — applying the analysis seeds the `ResearchProfile`, so the
research agent immediately has a brand-derived ICP + businessTypes + geo to collect leads
against. This is the explicit "workspace decides which leads to gather for the AI researcher"
requirement.

## 5. Cost, error handling, security, testing

- **Provider-inert fallback:** each source no-ops cleanly if its provider isn't configured; the
  wizard still works with the available sources + manual entry. Per-source status surfaced.
- **Cost rails:** metered research budget + bounded crawl/scrape/actor counts (recorded on the
  run) + ai-credits reserve/refund for the synthesis call. One active analyze per workspace
  (dedupKey) prevents runaway spend.
- **Security:** all outbound URL fetches go through `safeFetch` (SSRF-safe); everything
  workspace-scoped; MANAGER+ gating; uploaded files size/type validated and stored in R2 under
  the workspace prefix; any extracted content HTML-escaped where rendered; no provider secret ever
  leaves the sealed store.
- **Testing:** per-source adapter units (mocked provider + inert fallback); the synthesis
  strict-JSON contract (malformed model output rejected/retried); the seed-with-diff logic
  (user-edited field preserved on re-analyze); each AI-prompt injection (brand block present when
  ACTIVE, omitted when absent); the reversible migration round-trip (up→down→up); the
  workspace-scoping arch fitness (new bulk ops carry a literal workspaceId; cross-workspace-free).

## Rollout / phasing (for the implementation plan)

- **Phase 1 — foundation & wiring (ships value immediately):** `BrandProfile` model + reversible
  migration + CRUD + `BrandContextService` + wire the always-on block into all AI surfaces +
  the `/branding` Brain tab as a manual editor. Even with zero auto-extraction, the AIs are now
  brand-grounded and the research targeting is seedable by hand.
- **Phase 2 — extraction pipeline:** `BrandAnalysisRun` + the async `brand-brain.analyze` job +
  source adapters (website/social/GBP/uploads) + synthesis + the review/apply flow + seeding.
- **Phase 3 — first-login wizard + polish:** the full-screen onboarding wizard, GettingStarted
  step, progress banner, re-analyze diff, embedding-upgrade retrieval path.

## Open edge cases to handle in the plan

- A workspace with a connected `SocialAccount` but no public posts (private/empty) — social
  adapter returns empty, not an error; synthesis proceeds on the other sources.
- Re-analyze after the user has hand-edited seeded BrandKit/ResearchProfile — the per-field diff
  must detect "user changed this since last apply" and default to keep-user-value.
- A very large site (Firecrawl map returns hundreds of pages) — the page cap + a
  highest-value-first ordering keep cost bounded; log what was skipped.
- Language: the synthesis output language follows `Workspace.defaultLanguage`; a Turkish brand
  yields a Turkish brand block and Turkish knowledge docs.
- Feature-flag / entitlement: the wizard and extraction are gated; the always-on brand block is
  free (a plain DB read), so grounding improves for every plan the moment a BrandProfile exists.
