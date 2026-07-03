# Growth Studio — Unified Marketing Experience (design)

Date: 2026-07-03 · Branch: `feat/ai-growth-engine`

## Goal
Consolidate the scattered marketing/social/content/budget/trend pages into ONE
tabbed **Growth Studio**, and add a **Weekly Planner** that generates a full
week of draft content + a budget analysis in one click. Approved direction
(user): replace the Marketing hub entirely with the Studio; weekly plan =
full-week DRAFT + budget; budget analysis = allocate the monthly growth budget
across the plan with over/under warnings. No auto-publish — human approval
throughout (consistent with the rest of the system).

## Phase A — Growth Studio shell (IA consolidation)
- New nav: the **Marketing hub** (Budget, Trends, Content Calendar, Campaigns,
  Email Templates, Social Planner, Social Campaigns, Trigger Links, Reviews,
  Affiliates) is replaced by a single **Growth Studio** entry → `/studio`.
- `GrowthStudioPage` = one `PageHeader` + a `Tabs` bar, `?tab=` deep-linkable:
  1. **calendar** (default) — full content calendar + "Generate weekly plan"
  2. **campaigns** — normal campaigns + social campaigns + social planner
  3. **trends** — trend remix
  4. **budget** — Budget Autopilot console
  5. **more** — Email Templates, Trigger Links, Reviews, Affiliates
- Embedded pages take an optional `embedded` prop that suppresses their own
  `PageHeader` (the Studio provides the shell). Legacy pages that are hard to
  split render as-is (their header becomes the section header).
- Old routes (`/budget`, `/trends`, `/content-calendar`, `/campaigns`, `/social`,
  `/social-campaigns`) redirect to `/studio?tab=…` so links + command palette
  still work.

## Phase B — Full content calendar
- Replace the agenda list with a real **month/week grid** merging ALL sources,
  color-coded by type + channel: scheduled social posts, social-campaign items,
  normal campaign sends, and weekly-plan drafts.
- Month/week toggle; day click → items for that day. Reuses the backend
  `UnifiedCalendarService` (extended to include weekly-plan drafts).

## Phase C — Weekly Planner (flagship orchestration)
- Data model (reversible migration): `WeeklyPlan` (workspaceId, weekStart,
  status, budgetTotal, budgetBreakdown JSON) + `WeeklyPlanItem` (planId, day,
  type SOCIAL_POST|CONTENT_IDEA|CAMPAIGN|TREND_REMIX, channel, title, draft,
  estCost, status DRAFT|APPROVED|DISCARDED, refId).
- `WeeklyPlannerService.generate(ws, weekStart)`: reads Brand Brain + active
  GrowthBudget + connected channels + trends → produces per-day DRAFT items →
  runs a budget analysis (per-item est cost from ChannelTariff/credit costs;
  allocate against the monthly budget; flag over/under) → persists the plan.
- Frontend: "Generate weekly plan" → review panel (week of drafts + budget
  breakdown: allocated / remaining / over-budget warning). Edit/approve/discard
  each item; approved items flow into scheduled social posts. Nothing publishes
  automatically.

## Engineering constraints
- TDD; reversible up/down migrations round-tripped on the throwaway `mig_verify`
  DB; match existing `@/components/ui` + service + react-query + i18n patterns;
  workspace-scoping + decoupling arch specs stay green; env-gated where external
  creds are needed; no Claude trace in commits.
