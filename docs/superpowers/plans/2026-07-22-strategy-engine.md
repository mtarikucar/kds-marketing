# Strategy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Backend = NestJS + Prisma + jest (deep-mocked PrismaService, mocked Anthropic). The synthesis/intake AI loops MIRROR `backend/src/modules/marketing/research/research-worker.service.ts` (read it first — same bounded-tool-loop + AgentRun + credit-reserve/refund + hard-caps shape).

**Goal:** A living, archetype-adaptive `MarketingStrategy`, built from a hybrid onboarding, that becomes the single brain driving lead/content/channel/ad execution (propose-approve default, opt-in autonomous).

**Architecture:** New `backend/src/modules/marketing/strategy/` subsystem = intake (auto-analysis + adaptive AI interview) → synthesis (bounded Claude tool-loop → MarketingStrategy + ActionPlan) → orchestrator (typed ActionPlan → executor adapters over existing subsystems) → feedback (re-synthesis). Existing Brand Brain / research-worker / autopilot / content become executors under it.

**Tech Stack:** NestJS, Prisma (Postgres), Anthropic SDK, zod (validate the strategy brief), jest. Reuse: `AiCreditsService`, `AgentRunService`, `AnthropicService`, `ResearchSourcesService` + `RESEARCH_TOOLS`, `ApprovalRequestService`, `BrandContextService`.

Spec: `docs/superpowers/specs/2026-07-22-strategy-engine-design.md`.

---
## File structure (P1)
- Create `strategy/strategy.types.ts` — `BusinessArchetype` union, `ActionKind` union, `Executor` interface, `MarketingStrategyBrief` type.
- Create `strategy/strategy.schema.ts` — zod schema for `MarketingStrategyBrief` + `validateBrief()`.
- Create `strategy/archetypes.ts` — archetype registry (`ARCHETYPES`, `archetypeMeta()`), tripwire-pinned.
- Create `strategy/archetypes.tripwire.spec.ts`.
- Create `strategy/intake/strategy-intake.service.ts` (+ `.spec.ts`) — start/answer/finish + auto-analysis + adaptive interview loop.
- Create `strategy/intake/strategy-intake.controller.ts`.
- Create `strategy/synthesis/strategy-synthesis.service.ts` (+ `.spec.ts`) — bounded tool-loop → brief + ActionPlan.
- Create `strategy/strategy.service.ts` (+ `.spec.ts`) — CRUD + action approve/dismiss.
- Create `strategy/strategy.controller.ts` — console endpoints.
- Create `strategy/strategy.module.ts`; register in `marketing.module.ts`.
- Modify `backend/prisma/schema.prisma` — 3 models; add migration `20260722xxxxxx_strategy_engine`.
- Modify `ai/ai-credit-costs.ts` + `ai-credit-costs.tripwire.spec.ts` — `strategy.interview` (2), `strategy.synthesize` (8).
- Frontend P1: `frontend/src/pages/marketing/strategy/StrategyOnboarding.tsx` + `StrategyConsolePage.tsx` + `strategy.service.ts`.

---
## P1 — Core brain

### Task 1: Prisma models + generate
**Files:** Modify `backend/prisma/schema.prisma`; Create `backend/prisma/migrations/20260722160000_strategy_engine/migration.sql`.
- [ ] **Step 1** Add the 3 models from spec §2 (`MarketingStrategy`, `StrategyIntakeSession`, `StrategyAction`) to schema.prisma.
- [ ] **Step 2** Hand-write `migration.sql` (CREATE TABLE ×3 with the indexes/`@@map` names). Parity-check vs a shadow PG before merge.
- [ ] **Step 3** `cd backend && npm run prisma:generate` — expect success.
- [ ] **Step 4** Commit `feat(strategy): schema — MarketingStrategy/IntakeSession/StrategyAction`.

### Task 2: types + zod brief schema
**Files:** Create `strategy/strategy.types.ts`, `strategy/strategy.schema.ts`; Test `strategy/strategy.schema.spec.ts`.
- [ ] **Step 1 (RED)** Test: `validateBrief(goodBrief)` returns ok; `validateBrief({})` throws/returns error. `goodBrief` has `identity{product,voice,positioning,usp}`, `audience`, `channels[]{key,fitScore,rationale}`, `contentPillars[]{title,angle,formats,tone}`, `goals{objective,kpis}`, `budget`, `competitors[]`.
- [ ] **Step 2** Run → FAIL (module missing).
- [ ] **Step 3** Define `ActionKind = 'LEAD_HUNT'|'CONTENT'|'CHANNEL_SETUP'|'AD_CAMPAIGN'|'COMMUNITY_ENGAGE'`, `BusinessArchetype` union, `Executor` interface (`kind: ActionKind; run(workspaceId,payload): Promise<{resultRef?:string}>`), `MarketingStrategyBrief` type in types.ts; a zod schema mirroring it in strategy.schema.ts + `validateBrief`.
- [ ] **Step 4** Run → PASS. **Step 5** Commit.

### Task 3: archetype registry + tripwire
**Files:** Create `strategy/archetypes.ts`, `strategy/archetypes.tripwire.spec.ts`.
- [ ] **Step 1 (RED)** Tripwire test pins the archetype keys set `['B2B_LOCAL_SERVICE','B2B_SAAS','B2C_ECOMMERCE','B2C_COMMUNITY_NICHE','CREATOR_MEDIA','LOCAL_RETAIL_FOOD','OTHER']` and asserts each has `{ channelPriors: Record<channel,number>, interviewDeltas: string[], leadApproach: 'B2B_PROSPECT'|'B2C_AUDIENCE' }`.
- [ ] **Step 2** FAIL. **Step 3** Implement `ARCHETYPES` map + `archetypeMeta(key)`. B2C_COMMUNITY_NICHE → leadApproach 'B2C_AUDIENCE', channelPriors favor community/social; B2B_* → 'B2B_PROSPECT'.
- [ ] **Step 4** PASS. **Step 5** Commit.

### Task 4: credit costs
**Files:** Modify `ai/ai-credit-costs.ts` + `ai-credit-costs.tripwire.spec.ts`.
- [ ] Add `'strategy.interview': {credits:2,tier:'default'}`, `'strategy.synthesize': {credits:8,tier:'default'}`; pin both in the tripwire (values + key set). Run `npx jest ai-credit-costs` → PASS. Commit.

### Task 5: intake service — auto-analysis + adaptive interview
**Files:** Create `strategy/intake/strategy-intake.service.ts` + `.spec.ts`.
Read `research-worker.service.ts` for the bounded-loop shape. The interview is a bounded Anthropic tool-loop: system = "You are an onboarding strategist. Given the auto-analysis, ask ONLY the gaps + strategic intent. Adapt questions to the detected archetype. Emit questions via ask_questions; when you have enough, call intake_done." Tools: `ask_questions({questions:[]})`, `intake_done`.
- [ ] **Step 1 (RED)** Test `start(ws,{url,socials,oneLiner})`: with `ResearchSourcesService` + `AnthropicService` mocked, creates a `StrategyIntakeSession` (status IN_PROGRESS), runs auto-analysis (mock returns product/category), reserves `strategy.interview` credit, returns first `questions[]`. Test `answer(ws,sessionId,answers)`: advances the loop, returns next questions OR `{done:true}`. Test caps: never exceeds MAX turns. Test refund on AI failure.
- [ ] **Step 2** FAIL. **Step 3** Implement mirroring research-worker (MAX_TURNS=6, wall-cap, `credits.reserve/refund`, `AgentRunService.track`). auto-analysis reuses Brand Brain source providers (inject them). Persist transcript + autoAnalysis on the session.
- [ ] **Step 4** PASS (targeted). **Step 5** Commit.

### Task 6: synthesis service — brief + ActionPlan
**Files:** Create `strategy/synthesis/strategy-synthesis.service.ts` + `.spec.ts`.
Bounded Claude tool-loop (research-worker clone): inputs = session.autoAnalysis + transcript. Tools = the existing `RESEARCH_TOOLS` (market/audience/competitor research) + `submit_strategy({archetype, brief, actions[]})`. System = "You are a senior marketing strategist. Research the market with the tools, then submit ONE strategy: classify the archetype, produce a complete brief (identity/audience/channels/contentPillars/goals/budget/competitors), and a prioritized ActionPlan (typed actions with executor-ready payloads). For B2C_COMMUNITY_NICHE, research WHERE the audience gathers + what content resonates and put it in channels+pillars."
- [ ] **Step 1 (RED)** Test `synthesize(ws,sessionId)`: mocked AI returns a `submit_strategy` tool call → service validates the brief via `validateBrief`, upserts `MarketingStrategy` (status ACTIVE, archetype set), inserts the `StrategyAction`s (status PROPOSED), reserves `strategy.synthesize` credit, AgentRun-audited. Invalid brief → rejected (no upsert). Refund on failure.
- [ ] **Step 2** FAIL. **Step 3** Implement (clone research-worker's loop + validate/persist). **Step 4** PASS. **Step 5** Commit.

### Task 7: strategy service — read + approve/dismiss actions
**Files:** Create `strategy/strategy.service.ts` + `.spec.ts`.
- [ ] `getStrategy(ws)`, `listActions(ws,{status?})`, `approveAction(ws,actionId)` (PROPOSED→APPROVED), `dismissAction(ws,actionId)` (→DISMISSED), `setAutonomy(ws,level)`. TDD each (mocked Prisma). Execution wiring is P2 — approve just flips status in P1. Commit.

### Task 8: controllers + module + wiring
**Files:** Create `strategy/strategy-intake.controller.ts`, `strategy/strategy.controller.ts`, `strategy/strategy.module.ts`; Modify `marketing.module.ts`.
- [ ] Intake: `POST /marketing/strategy/intake/{start,answer,finish}`. Console: `GET /marketing/strategy`, `GET /marketing/strategy/actions`, `POST /marketing/strategy/actions/:id/{approve,dismiss}`, `POST /marketing/strategy/autonomy`. DTOs + workspace-scoped auth guards (match existing controllers). Register module in marketing.module.ts. Build-compile validates DI + grep-verify registration. Commit.

### Task 9: frontend — onboarding + console (minimal)
**Files:** Create `frontend/src/pages/marketing/strategy/StrategyOnboarding.tsx`, `StrategyConsolePage.tsx`, `frontend/src/features/marketing/api/strategy.service.ts`; wire a route + trigger onboarding for a workspace with no ACTIVE strategy.
- [ ] Onboarding: URL/socials/one-liner form → start → render adaptive questions → answer loop → finish → strategy reveal. Console: show the brief (archetype/audience/channels/pillars/goals) + the ActionPlan approval queue (approve/dismiss) + autonomy toggle. Vitest for the api-service + a render smoke test. Commit.

### P1 gate
Backend targeted suites (`strategy*`, `ai-credit-costs`) + build green; frontend tsc + vitest green; migration parity-checked. Commit + push + PR.

---
## P2 — B2B executor wiring
- `LEAD_HUNT` executor: map `MarketingStrategy` ICP → build a `ResearchProfile` (reuse the model) → run `research-worker`; `resultRef` = the run id. `CONTENT` executor: content pillars → Content AI drafts → stage in Social Planner. Orchestrator: `approveAction` (or autonomous lane) → dispatch to the `Executor` for that kind → status RUNNING→DONE, stamp `resultRef`. TDD each executor + the dispatcher.

## P3 — B2C brain
- Synthesis gains explicit audience/community/channel discovery for `B2C_AUDIENCE` archetypes (subreddits/Discords/forums + content patterns) written into channels+pillars. `COMMUNITY_ENGAGE` produces channel-native content (posting deferred to P5). The Metin2 case is the acceptance test.

## P4 — Ads + autonomy + living loop
- `AD_CAMPAIGN` executor → Growth Autopilot campaign + budget. Wire SHADOW/ASSISTED/AUTONOMOUS lanes into the orchestrator (reuse autopilot guardrails + kill-switch). Feedback `@Cron` (advisory-locked) folds execution outcomes (staged leads, engagement, ROAS) → re-synthesis (version bump) → refreshed ActionPlan.

## P5 — New execution channels
- Reddit/Discord/forum posting integrations for `COMMUNITY_ENGAGE` (own OAuth/creds + adapters), gated + credit-metered like the social publishers.

---
## Self-review
- **Spec coverage:** §2 data model→Task 1; §3 archetypes→Task 3; §4 intake→Task 5+8; §5 synthesis→Task 6; §6 orchestrator→P2; §7 feedback→P4; §8 UI→Task 9; §11 cost→Task 4 + reserve/refund in 5/6; §12 testing→every task TDD. B2C (§ P3), channels (§ P5). Covered.
- **Placeholders:** none — each task names files, test intent, and the concrete interface/keys.
- **Type consistency:** `ActionKind`/`BusinessArchetype`/`Executor`/`MarketingStrategyBrief` defined once (Task 2), referenced consistently (Tasks 3/5/6/7 + P2).
