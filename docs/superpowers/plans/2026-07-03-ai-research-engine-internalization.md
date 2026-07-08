# AI Research Engine — Internalization Plan

> **For agentic workers:** implement task-by-task; each task ends with an independently testable deliverable. Steps use `- [ ]`.

**Goal:** Replace the external nightly Claude routine (firecrawl/apify MCPs) with a native, multi-tenant, self-serve prospect-research engine inside the backend — every workspace authors its ICP brief, the platform researches on a schedule (and on-demand), candidates land in a review queue, and the firecrawl/apify/LLM cost meters into the workspace budget.

**Architecture:** A bounded, backend-hosted research **agent** (an `AnthropicService` tool-loop, modelled on `AskAiService.ask()`) drives **outbound source providers** (Firecrawl + Apify + web-search, modelled on `FalProvider`, platform-keyed + env-gated). Each run is wrapped in `AgentRunService.track()` (every source call = one `ToolCallLog`); cost settles into the tenant budget via a new `RESEARCH` `SpendLedger` channel + tariff (mirroring `ConversationSpendService`). Qualified candidates land in a new `ResearchCandidate` review queue; on **accept** they flow through the existing, production-grade `MarketingLeadsIngestService.ingest()` (dedup + daily-quota + Lead creation). The nightly cadence uses the existing `ScheduledJobRunnerService` (`research.run` kind). The external `/api/internal/research/*` endpoint + `RESEARCH_ROUTINE_TOKEN` are retired.

**Tech Stack:** NestJS + Prisma (Postgres), Anthropic (`AnthropicService`, native tool-use), Firecrawl REST, Apify REST (Google Maps/Places + Instagram + directory actors), React 18 + `@/components/ui`. Reversible up/down migrations.

## Global Constraints
- **Owner decisions (2026-07-03):** (1) **Platform-keyed + metered** — platform holds `FIRECRAWL_API_KEY`/`APIFY_TOKEN`; each run's cost debits the workspace budget (with markup). (2) **Review queue first** — candidates are staged, not auto-injected into live Leads. (3) **Bounded agent** — retire the external routine.
- Multi-tenant: every read/write workspace-scoped. Features **env-gated inert** until keys set (no scary errors — a "connect research" state, per the UX pass).
- Reversible up/down migrations, round-trip verified against the docker postgres (5433) `mig_verify` DB.
- Reuse verbatim (do NOT reimplement): `MarketingLeadsIngestService.ingest()` (dedup/quota/clip/settle), `ResearchProfile` CRUD, `usageToday`, `ScheduledJobRunnerService`, `AnthropicService`, `AiCreditsService` + `ai-credit-costs` (tripwire spec forces a cost decision), `AgentRunService` + `ToolCallLog`, `SpendLedgerService` + `ChannelTariffService`, `safeFetch` (SSRF), `FalProvider` pattern.
- New i18n keys → `en` + `tr`. No AI trailer in commits.
- Money/cost safety: every provider is timeout-bounded + reserve-credits-before / refund-on-failure; per-run hard caps (max iterations, max tool calls, credit ceiling, wall-clock) so a single run can't run away on spend.

---

## Phase 0 — Cost rails + source-provider seam (foundation, no behaviour change)

### Task 0.1 — RESEARCH spend channel + tariff + settle
**Files:** Modify `backend/prisma/schema.prisma` (extend `SpendChannel`/enums are string-typed, so no enum migration — `SpendLedger.channel`/`SpendReason` are `String`; add `RESEARCH` to the TS unions + tariff constants). Create `backend/src/modules/marketing/budget/research-spend.service.ts` (+ spec). Modify `channel-tariff` seed (a reversible data migration adding default `RESEARCH` tariffs: `FIRECRAWL_PAGE`, `APIFY_RUN`, `RESEARCH_LEAD`). Modify `ai-credit-costs.ts` (add `research.enrich` + `research.qualify` cost/tier — the tripwire spec forces this).
**Interfaces produced:** `ResearchSpendService.settle(workspaceId, { unit: 'FIRECRAWL_PAGE'|'APIFY_RUN'|'RESEARCH_LEAD', qty, budgetId?, ref })` → debits `SpendLedger` via `ChannelTariffService.price(...)`, best-effort (never throws into the caller), mirroring `ConversationSpendService`.
- [ ] Write the reversible tariff-seed migration (up: insert platform-default RESEARCH tariffs `ON CONFLICT DO NOTHING`; down: delete exactly those rows by key). Round-trip verify.
- [ ] `ResearchSpendService` + spec (asserts a firecrawl page debits the priced amount into the ledger; asserts best-effort no-throw when no tariff).
- [ ] Add `research.enrich`/`research.qualify` to `AI_CREDIT_COSTS` (+ update the tripwire spec).

### Task 0.2 — Source-provider seam (Firecrawl + Apify + web-search)
**Files:** Create `backend/src/modules/marketing/research/providers/research-source.provider.ts` (interface + types), `firecrawl.provider.ts`, `apify.provider.ts`, `web-search.provider.ts` (+ specs). Register in `marketing.module.ts`.
**Interfaces produced:**
```
interface ResearchSourceProvider {
  isEnabled(): boolean;                                   // env key present
  searchPlaces(q: { query: string; geo: Geo; limit: number }): Promise<PlaceHit[]>;   // Apify Google-Maps actor
  scrape(url: string): Promise<{ markdown: string; meta: Record<string,unknown> }>;    // Firecrawl scrape
  extract(url: string, schema: object): Promise<Record<string,unknown>>;               // Firecrawl extract
  searchWeb(query: string, limit: number): Promise<WebHit[]>;                          // web-search
  lookupInstagram?(handle: string): Promise<SocialHit | null>;                         // Apify IG actor
}
```
- [ ] Model each provider on `FalProvider`: env-gated (`isEnabled()` false → the whole engine reports "not configured" gracefully), timeout-bounded, `safeFetch` where the URL is caller-influenced (scrape/extract), typed results. Return `[]`/`null` inert when disabled.
- [ ] Specs: enabled=false path returns inert; a mocked Firecrawl/Apify HTTP response maps to the typed result; timeout surfaces cleanly.

**Phase 0 gate:** backend tsc + the new specs + full backend suite green; migration round-trips; nothing wired into a live flow yet (pure additive).

---

## Phase 1 — The research agent worker (native engine)

### Task 1.1 — Extract job assembly into a shared service
**Files:** Create `backend/src/modules/marketing/research/research-job.service.ts`. Refactor `internal-research.controller.ts` to call it (keep the external endpoint working for now).
**Interfaces produced:** `ResearchJobService.buildJobs()` → the exact job list the controller emits today (one per ACTIVE `ResearchProfile` of every ACTIVE, quota-remaining workspace; `remainingToday` via `ingest.usageToday`); `buildJob(workspaceId, profileId)` for on-demand single-profile runs.
- [ ] Move the controller's `jobs()` body into `buildJobs()`; controller delegates. Spec parity test (same output shape).

### Task 1.2 — Research toolset (providers as Anthropic tools)
**Files:** Create `backend/src/modules/marketing/research/research-toolset.ts`.
**Interfaces produced:** `buildResearchTools(ctx)` → Anthropic `tools[]` (`search_places`, `scrape_page`, `extract_business`, `search_web`, `lookup_instagram`) + a `dispatch(runId, toolName, args)` that: calls the matching provider → records a `ToolCallLog` via `AgentRunService.recordTool` → `ResearchSpendService.settle(...)` for the unit consumed → returns the tool_result payload (or a fed-back error string on failure, never throwing the loop).
- [ ] Cap each tool's result size (feed the LLM trimmed markdown/JSON). Spec: dispatch records a ToolCallLog + settles spend + trims output.

### Task 1.3 — `ResearchWorkerService` (the bounded tool-loop)
**Files:** Create `backend/src/modules/marketing/research/research-worker.service.ts` (+ spec). Register in `marketing.module.ts`.
**Interfaces produced:** `runProfile(job): Promise<ResearchRunResult>` — wraps in `AgentRunService.track(ws, {agent:'research', goal, input})`; reserves an `AiCredits` ceiling; runs the loop (`AnthropicService.complete({system, messages, tools})` → `dispatch` toolUses → feed tool_results → repeat) under **hard caps** `MAX_ITERS`, `MAX_TOOL_CALLS`, `MAX_WALL_MS`, credit ceiling; the final assistant message must return structured candidates matching `IngestLeadCandidateDto` (validated; malformed → dropped + logged); returns `{ researched, candidates[] }`. The system prompt encodes STEP 2/3 of the routine (evidence-based qualification, hard disqualifiers, exclusions, `externalRef` dedup format, output in `profile.language`).
- [ ] Bound candidate volume by `min(remainingToday>0 ? remainingToday+buffer : cap, maxBatchSize)` (cost-bounded, not just quota-bounded).
- [ ] Refund the credit reserve on infra failure (mirror `AskAiService`).
- [ ] Spec: with mocked providers + a stubbed `AnthropicService` returning tool calls then a final candidate list, `runProfile` produces validated candidates, logs tool calls, and respects the iteration cap.

### Task 1.4 — Nightly + on-demand scheduling
**Files:** Modify `marketing.module.ts` (register `research.run` handler in `onModuleInit`). Create `backend/src/modules/marketing/research/research.cron.ts` (`@Cron(EVERY_DAY_AT_3AM)` → for each `buildJobs()` job, `ScheduledJobService.schedule({ kind:'research.run', dedupKey: profileId, payload:{workspaceId,profileId} })`). The handler calls `ResearchWorkerService.runProfile` then stages candidates (Phase 2).
- [ ] Self-rescheduling not needed (the nightly `@Cron` re-enqueues); `dedupKey=profileId` collapses duplicates.
- [ ] Spec: the handler is registered and, given a job, invokes `runProfile` and stages the result.

**Phase 1 gate:** worker runs end-to-end against mocked providers; with no keys it's inert (0 candidates, clean log); backend suite green.

---

## Phase 2 — Review queue + structured candidate storage (the SaaS trust surface)

### Task 2.1 — `ResearchCandidate` model + service
**Files:** Reversible migration `..._research_candidates`. Modify `schema.prisma` (`model ResearchCandidate`: id, workspaceId, profileId, agentRunId?, externalRef, businessName, city, region?, businessType, phone?, instagram?, website?, email?, branchCount?, currentSystem?, stage?, priority, **painPoint, evidence, pitch** (first-class Text cols), score Float?, status `PENDING|ACCEPTED|REJECTED`, createdAt; `@@unique([workspaceId, externalRef, profileId])`). Create `research-candidate.service.ts` (+ spec).
**Interfaces produced:** `stage(workspaceId, profileId, agentRunId, candidates[])` (idempotent upsert into PENDING — dedup on externalRef so a re-run doesn't duplicate a still-pending suggestion); `list(workspaceId, {status,profileId})`; `accept(workspaceId, ids[])` → maps to `IngestLeadCandidateDto[]` → `MarketingLeadsIngestService.ingest()` (this is where daily lead quota is consumed) → mark ACCEPTED with the ingest outcome; `reject(workspaceId, ids[])`.
- [ ] Round-trip verify migration. Specs: stage is idempotent; accept funnels through `ingest()` and respects quota/dedup; reject is terminal.

### Task 2.2 — Controller + wire the worker to stage
**Files:** Create `marketing-research-candidates.controller.ts` (`marketing/research/candidates`, MANAGER + `settings.manage`, `@Audit`): `GET` (list by status), `POST accept`, `POST reject`, `GET runs` (AgentRun trail for research). Modify the `research.run` handler (Task 1.4) to call `candidateService.stage(...)` with the worker output + stamp `ResearchProfile.lastRunAt/lastRunStats`.
- [ ] Spec: accept/reject endpoints gated + audited; list returns PENDING for the workspace only.

### Task 2.3 — Frontend "AI Suggestions" inbox
**Files:** Create `frontend/src/pages/marketing/research/ResearchSuggestionsPage.tsx` + service fns. Add route + a tab/section on the existing `ResearchSettingsPage` (or a `/research/suggestions` sub-nav). Use `@/components/ui` (Card, Badge, Checkbox, Button, QueryStateBoundary, EmptyState, ConfirmDialog) — a card per candidate showing businessName/city/type, **painPoint + evidence (with source link) + the agent's pitch**, stage/priority badges, and per-row + bulk Accept/Reject. i18n en+tr.
- [ ] Empty/loading/error states + a graceful "research not configured yet" callout when providers are disabled. Page test (renders a suggestion, accept calls the endpoint).

**Phase 2 gate:** a mocked run stages candidates → they appear in the inbox → Accept creates real Leads via `ingest()` (respecting quota/dedup); frontend + backend suites green.

---

## Phase 3 — Self-serve run controls + targeting completeness

### Task 3.1 — "Run now" + dry-run preview + run history
**Files:** Add `POST marketing/research/profiles/:id/run` (enqueues a `research.run` ScheduledJob for that profile, throttled) + optional `?preview=1` dry-run (runs the loop with a low cap, returns candidates WITHOUT staging, for a "what would this find" peek). Surface a "Run now" button + last-run stats + the AgentRun trail on `ResearchSettingsPage`.
- [ ] Throttle + a per-workspace concurrent-run guard (advisory lock). Cost gauge (leads quota + research credits + firecrawl/apify spend this period).

### Task 3.2 — Expose the full targeting model
**Files:** Modify `ResearchProfileForm.tsx` + `researchProfilePayload.ts` to expose `businessTypes[]` (chips, UPPER_SNAKE) and `geo.regions` (already in the DTO/schema, just unreachable from UI).
- [ ] Form validation + payload mapping; existing form test updated.

**Phase 3 gate:** a user can create a profile with full targeting, hit "Run now", preview, watch it populate the suggestions inbox, and see the cost — with zero external routine.

---

## Phase 4 — Retire the external routine + IA polish

### Task 4.1 — Decommission the external ingress
**Files:** Remove (or feature-flag OFF then remove one release later) `InternalResearchController`, `ResearchTokenGuard`, `RESEARCH_ROUTINE_TOKEN` from `internal.module.ts` + env docs. The customer `x-ingest-token` ingress (`marketing/leads/ingest`) stays — that's for tenants' own integrations.
- [ ] Keep `MarketingLeadsIngestService` unchanged (both paths + the native worker use it).

### Task 4.2 — Naming / IA
**Files:** Unify "AI Research" naming; consider co-locating the AI-lead surfaces (Research settings + Suggestions inbox + AI_RESEARCH lead filter) under one hub; clarify vs the unrelated PageSpeed "Prospecting" audit page.

### Task 4.3 (deferred / optional)
- BYO-key: sealed per-workspace Firecrawl/Apify keys (a `ResearchProviderConfig` sealed-secret + provider resolves tenant key → platform key fallback).
- Register the research tools in `McpToolRegistry` so an operator/agent can invoke them ad-hoc through the broker (scope + approval + audit) — additive.

---

## Reuse map (do NOT rebuild)
| Need | Reuse |
|---|---|
| Write leads (dedup, quota, clip, settle) | `MarketingLeadsIngestService.ingest()` |
| ICP brief CRUD + quota meter | `ResearchProfile` + `MarketingResearchService` + `usageToday` |
| Schedule nightly + on-demand | `ScheduledJobRunnerService` (`research.run` kind) |
| LLM + tool-use + credit meter | `AnthropicService` + `AiCreditsService` + `ai-credit-costs` |
| Run observability + tool audit | `AgentRunService.track()` + `ToolCallLog` |
| Per-tenant cost ledger | `SpendLedgerService` + `ChannelTariffService` (+ new RESEARCH channel) |
| SSRF-safe fetch / paid-API client pattern | `safeFetch` / `FalProvider` |

## Risks / notes
- **Cost runaway** is the top risk → hard per-run caps (iters/tools/wall/credits) + reserve-before-run + the budget kill-switch already halts autonomy.
- **Quality** → the review queue is the backstop; nothing reaches the sales floor unvetted. Score threshold auto-accept can come later.
- **Provider ToS** → Apify actors for Maps/IG are the compliant path; keep the provider seam swappable.
- Daily **lead quota** now gates *accepts*, not raw research; a separate research-run cap + budget gates *cost*.
