# Strategy Engine — Design Spec

**Date:** 2026-07-22 · **Status:** design approved (owner: from-scratch, comprehensive) — ready for planning.
**One-liner:** A new primary subsystem that turns a guided onboarding into a *living, archetype-adaptive MarketingStrategy* which becomes the single brain driving every downstream capability (lead-finding, content, channels, ads) — default propose-approve, opt-in autonomous.

## Owner decisions (locked)
1. **Universal adaptive brain** — one engine interviews ANY business, classifies its archetype (B2B-local / B2C-ecom / B2C-community / SaaS / creator / game-server …) and produces the right strategy for each (restaurant→Maps-outbound AND Metin2→Reddit-memes).
2. **Hybrid intake** — auto-analyze (scrape site/social/GBP) + adaptive AI interview that only asks what it couldn't infer + the strategic intent.
3. **Propose-approve by default, opt-in autonomous** — reuse the Growth Autopilot SHADOW/ASSISTED/AUTONOMOUS lanes + kill-switch.
4. **From-scratch engine as the PRIMARY architecture** — existing mature pieces (Brand Brain, ResearchProfile/research-worker, Growth Autopilot, Content/Social/Ads) are NOT discarded; they become **executors/components UNDER** the Strategy Engine. No working code is thrown away; it is re-homed.

## 1. Architecture
```
strategy/  (NEW — the primary brain)
 ├─ intake/        Hybrid onboarding: auto-analysis + adaptive AI interview + archetype detection
 ├─ synthesis/     The strategist reasoning loop → produces/updates the MarketingStrategy
 ├─ model          MarketingStrategy (living, versioned) + Archetype registry
 ├─ orchestrator/  Strategy → typed ActionPlan → routes to executors (approve-gated / autonomous)
 └─ feedback/      Execution results → re-synthesis (living strategy)

Executors (existing, re-homed under the engine — the engine CONFIGURES + drives them):
 • Brand Brain        → the "product/brand understanding" source-gathering + synthesis feeding Strategy.Identity
 • research-worker    → B2B LEAD_HUNT executor (Strategy auto-generates the ResearchProfile)
 • Growth Autopilot   → ad-spend/budget executor + the autonomy-lane machinery the orchestrator reuses
 • Content AI/Planner → CONTENT executor (driven by Strategy content pillars)
 • Ads                → AD_CAMPAIGN executor
 • (NEW) community    → COMMUNITY_ENGAGE executor (B2C channels; phased)
```
**Isolation:** each unit has one job + a typed interface. `intake` knows nothing about executors; `synthesis` emits a pure `MarketingStrategy`; `orchestrator` maps `ActionPlan` items to executor calls behind an `Executor` interface; executors don't know about the Strategy model (they take plain config). This keeps the brain testable without live vendors and lets executors evolve independently.

## 2. Data model (additive migration; Prisma)
```prisma
model MarketingStrategy {
  id            String   @id @default(uuid())
  workspaceId   String   @unique          // one live strategy per workspace
  version       Int      @default(1)      // bumped on each re-synthesis
  status        String   @default("DRAFT")// DRAFT | ACTIVE | ARCHIVED
  archetype     String                    // BUSINESS_ARCHETYPE key
  /// The full synthesized strategy (Identity, ICP/Audience, Channels, Content
  /// pillars, Goals/KPIs, Budget, Competitors, Positioning). JSON so the shape
  /// can evolve without migrations; a zod schema (strategy.schema.ts) validates.
  brief         Json
  autonomyLevel String   @default("ASSISTED") // SHADOW | ASSISTED | AUTONOMOUS
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@map("marketing_strategies")
}

model StrategyIntakeSession {
  id            String   @id @default(uuid())
  workspaceId   String
  status        String   @default("IN_PROGRESS") // IN_PROGRESS | COMPLETE | ABANDONED
  /// Turn-by-turn interview transcript + the auto-analysis payload + answers.
  transcript    Json
  autoAnalysis  Json?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([workspaceId, status])
  @@map("strategy_intake_sessions")
}

model StrategyAction {
  id           String   @id @default(uuid())
  workspaceId  String
  strategyId   String
  kind         String   // LEAD_HUNT | CONTENT | CHANNEL_SETUP | AD_CAMPAIGN | COMMUNITY_ENGAGE
  title        String
  rationale    String   @db.Text
  payload      Json     // executor-specific config the orchestrator hands to the executor
  priority     String   @default("MEDIUM") // LOW|MEDIUM|HIGH
  status       String   @default("PROPOSED") // PROPOSED | APPROVED | RUNNING | DONE | FAILED | DISMISSED
  resultRef    String?  // link to the executor's produced entity (research run, post, campaign…)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@index([workspaceId, strategyId, status])
  @@map("strategy_actions")
}
```
Reuses existing: `WorkspaceSubscription`/entitlements (gate the feature + credit spend), `AiCreditsService` (meter synthesis + interview turns), `AgentRunService`/ToolCallLog (audit each run), `ResearchProfile` (generated, not hand-authored), Growth Autopilot autonomy machinery.

## 3. Archetype system (`strategy/archetypes.ts`)
A registry of BUSINESS_ARCHETYPE entries; each defines: default channel fit-scores, the interview question set deltas, the lead approach (B2B-prospecting vs B2C-audience), and content-style priors. Tripwire-pinned like `ai-credit-costs`. Initial set: `B2B_LOCAL_SERVICE`, `B2B_SAAS`, `B2C_ECOMMERCE`, `B2C_COMMUNITY_NICHE` (the Metin2 case), `CREATOR_MEDIA`, `LOCAL_RETAIL_FOOD`, `OTHER`. Adding one is a config + tripwire change, never a migration.

## 4. Intake (hybrid onboarding)
- **Endpoint set** `POST /marketing/strategy/intake/start` (URL + optional socials + one-liner) → runs auto-analysis (reuse Brand Brain source providers: website/social/GBP) → returns the first adaptive question batch. `POST /marketing/strategy/intake/answer` → advances the AI interview (bounded turn loop, credit-metered as `strategy.interview`). `POST /marketing/strategy/intake/finish` → triggers synthesis.
- **Adaptive interview:** an AI turn-loop seeded with the auto-analysis; asks ONLY gaps + strategic intent (goal, audience specifics, budget, competitors, constraints, offer). Archetype-conditioned question deltas. Hard caps (turns/tokens/wall) like research-worker.
- **Archetype detection:** classifier step (part of synthesis) sets `MarketingStrategy.archetype`.

## 5. Synthesis (the strategist brain)
A bounded Claude tool-loop (mirrors `research-worker`): inputs = auto-analysis + interview transcript + **live market research** (competitor + audience + channel discovery via the existing firecrawl/apify research tools). Output = a validated `MarketingStrategy.brief` (zod-checked). **This is where the B2C reasoning lives:** for a `B2C_COMMUNITY_NICHE` archetype it researches where the audience gathers (subreddits/Discords/forums) + what content patterns resonate (memes/tutorials) and writes them into Channels + Content pillars. Credit-metered `strategy.synthesize`; AgentRun-audited; hard caps + reserved-credit ceiling.

## 6. Orchestrator (strategy → execution)
- Synthesis emits an **ActionPlan** = ordered `StrategyAction`s, each typed + carrying executor-ready `payload`.
- An `Executor` interface (`kind → (workspaceId, payload) → resultRef`) with one adapter per kind:
  - `LEAD_HUNT` → build a `ResearchProfile` from the strategy ICP + run `research-worker` (B2B) OR a B2C audience/community target list.
  - `CONTENT` → generate posts from content pillars via Content AI + stage in Social Planner.
  - `CHANNEL_SETUP` → surface a "connect X" prompt for a channel the strategy needs.
  - `AD_CAMPAIGN` → create a campaign shell + hand budget to the Growth Autopilot.
  - `COMMUNITY_ENGAGE` → (phased) channel-native content for Reddit/Discord/forums.
- **Autonomy:** default `ASSISTED` → actions sit `PROPOSED` in an approval queue (reuse `ApprovalRequestService`) → approve → `RUNNING`→`DONE`. `AUTONOMOUS` → auto-execute under the autopilot guardrails + kill-switch. `SHADOW` → record only.

## 7. Feedback loop (living strategy)
A `@Cron` (advisory-locked) + event hooks feed execution outcomes (leads staged, post engagement, ROAS from AdMetric, autopilot signals) back into a **re-synthesis** that bumps `MarketingStrategy.version` and refreshes the ActionPlan. Same money-safety caps as synthesis.

## 8. UI (Strategy Console)
- **Onboarding** on new-workspace: the step-by-step intake (auto-analysis progress → adaptive Q&A → strategy reveal).
- **Strategy Console** (a top-level surface): the living strategy (archetype, audience, channels, pillars, goals, budget), the ActionPlan approval queue, autonomy toggle + kill-switch, and the version history / feedback insights.

## 9. Phasing (comprehensive; each phase ships independently)
- **P1 — Core brain:** data model + archetype registry + hybrid intake (auto-analysis reuse + adaptive interview) + synthesis → MarketingStrategy + ActionPlan generation (no execution yet) + minimal Strategy Console (reveal + approve UI). Credit-metered, AgentRun-audited, TDD.
- **P2 — B2B executor wiring:** `LEAD_HUNT` → auto-generate ResearchProfile + run research-worker; `CONTENT` → Content AI/Planner; approval-queue execution.
- **P3 — B2C brain:** audience/community/channel reasoning in synthesis + channel-native content strategy (the Metin2 case) + `COMMUNITY_ENGAGE` payload (content produced; posting deferred to P5).
- **P4 — Ads + autonomy + living loop:** `AD_CAMPAIGN` → autopilot; wire SHADOW/ASSISTED/AUTONOMOUS lanes; feedback re-synthesis cron.
- **P5 — New execution channels:** Reddit/Discord/forum posting integrations for `COMMUNITY_ENGAGE`.

## 10. Reuse vs new
**New:** strategy data model, archetype registry, adaptive intake service, synthesis brain, orchestrator + Executor adapters, feedback loop, Strategy Console UI, B2C audience/channel reasoning.
**Reused:** Brand Brain source providers + synthesis, research-worker + ResearchProfile, Growth Autopilot autonomy/budget, Content AI/Social Planner, Ads, ApprovalRequestService, AiCreditsService/entitlements, AgentRunService, firecrawl/apify research tools.

## 11. Money/cost safety
Every AI step (interview turn, synthesis, re-synthesis) reserves credits (new `ai-credit-costs` actions: `strategy.interview`, `strategy.synthesize`) with hard caps (turns/tool-calls/wall + reserved ceiling), inert when AI/sources unconfigured. firecrawl/apify metered via the RESEARCH SpendLedger channel. Autonomous execution bounded by the autopilot guardrails.

## 12. Testing
Unit: archetype registry tripwire; intake turn-loop (adaptive question selection, caps, credit reserve/refund); synthesis output validated by the strategy zod schema (mock the AI + research tools — assert it maps archetype→channels/pillars, never on live vendors); orchestrator maps each ActionKind to the right executor with the right payload; approval-gated vs autonomous execution; feedback re-synthesis idempotency. Follow the repo's deep-mocked-Prisma + mocked-Anthropic patterns (see research-worker.service.spec).

## 13. Out of scope (v1)
- Replacing the existing manual ResearchProfile UI (kept; the engine just also generates them).
- Real Reddit/Discord posting (P5, its own integration effort).
- Multi-strategy per workspace (one live strategy; versioned).
