# Frontend Redesign — Phase 6: Architecture & Quality Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Finalize the redesign's engineering quality: route-level code-splitting, icon consolidation (Heroicons→Lucide, drop the dep), accessibility audit + fixes, a Playwright E2E smoke, CI wiring, and a documented stance on the typed-API-layer.

**Worktree:** `/home/tarik/.config/superpowers/worktrees/kds-marketing-frontend-redesign`; branch `feat/frontend-redesign`. Per-task `npm test && npm run -s build` green, then commit.

## Scope decision — typed API layer / DTO-Model (documented, not a 30-page sweep)

The spec listed "API Layer" + "DTO/Model". The app ALREADY has: typed domain models (`features/marketing/types.ts`), Zod schemas validating form payloads (`features/marketing/schemas.ts`), and two configured axios instances with interceptors (`marketingApi`/`platformApi`). A full indirection layer (per-endpoint typed service functions) across 30+ pages is large and low-ROI right now. **Decision:** Task 5 establishes the typed-service pattern for ONE feature (leads) as a reference + a short ADR documenting the convention; full rollout is an explicit, low-risk follow-up. This honors YAGNI while giving the pattern a home. (If the controller wants the full sweep, it becomes its own phase.)

## Task 1: Route-level lazy loading (code splitting / bundle)
**File:** `frontend/src/App.tsx`. Convert EVERY page import to `React.lazy(() => import('...'))` and wrap the route element trees in a single `<Suspense fallback={<RouteFallback/>}>` (a centered `Spinner`/`Skeleton`). Keep the layouts (`MarketingLayout`, `PlatformLayout`) eager (they wrap many routes) but lazy-load the PAGE elements. Preserve all guards, nesting, realms, and paths exactly. Create `frontend/src/components/RouteFallback.tsx`. Verify the build now emits per-route chunks and the `index` chunk shrinks. Commit: `perf(frontend): route-level lazy loading + Suspense fallbacks`.

## Task 2: Heroicons → Lucide + drop dependency
Migrate the remaining Heroicons usages to lucide-react in: `features/marketing/navigation.ts` (the nav-item `icon`s — map each Heroicon to its closest lucide equivalent), `features/marketing/components/{AskAiPanel,ActivityTimeline,Breadcrumbs,ClickToDialButton}.tsx`. Then `npm remove @heroicons/react` and confirm no `@heroicons` imports remain (`grep -r "@heroicons" src` → empty). Re-skin those four feature components to tokens while touched. Commit: `refactor(frontend): migrate Heroicons→Lucide, drop @heroicons/react`.

## Task 3: Accessibility pass
- Enhance the ui `Breadcrumbs` to accept an optional render/`as` for SPA `Link` (so platform/detail breadcrumbs do client nav, not full reload) — and update the one platform usage.
- Audit overlays: ensure every `Dialog`/`ConfirmDialog`/`Sheet` has a Title + Description (or `aria-describedby`) so Radix's advisory is clean; add `VisuallyHidden` titles/descriptions where a visible one doesn't fit.
- Add an automated axe check: a test that renders the dev `UiKitchenSinkPage` and runs `@axe-core/react` or `axe-core` against it, asserting no serious/critical violations (install `axe-core` + `@axe-core/playwright` or `jest-axe`-style for vitest). Fix any serious findings.
Commit: `a11y(frontend): SPA breadcrumbs, dialog descriptions, axe smoke + fixes`.

## Task 4: Playwright E2E smoke
Add `@playwright/test` (dev dep) + `playwright.config.ts` (baseURL from env, webServer optional) + `frontend/e2e/smoke.spec.ts`: a smoke that (against a dev server or mocked) loads `/login`, asserts the Console login renders, toggles dark mode (asserts `html.dark`), and checks the login form fields exist. Keep it resilient (no backend dependency — assert UI/theme, not a real login). Add an `npm run e2e` script. Commit: `test(frontend): Playwright E2E smoke (login + dark-mode toggle)`.

## Task 5: Typed-service reference + ADR
Create `frontend/src/features/marketing/api/leads.service.ts` — typed functions wrapping the leads endpoints (`listLeads(params): Promise<PaginatedResponse<Lead>>`, `getLead(id)`, `upsertLead(...)`, etc.) using `marketingApi` + the existing `Lead`/`PaginatedResponse` types; refactor the Leads list + detail queries to call the service (proving the pattern, no behavior change). Write `docs/superpowers/adr/2026-06-15-frontend-api-service-layer.md` documenting the convention + the deferred full-rollout. Commit: `refactor(frontend/api): typed leads service (reference) + ADR for service-layer convention`.

## Task 6: CI wiring + final gate + bundle report
- Update `.github/workflows/ci.yml` frontend job (if present) to keep running `lint` + `test` + `build`; add an OPTIONAL non-blocking `e2e` step (or document running it locally).
- Run the full gate: `npm run lint && npm test && npm run -s build`; capture the new per-route chunk sizes + the shrunken `index` chunk vs the pre-Phase-6 ~500kB. Commit any CI edit: `ci(frontend): keep lint+test+build; document e2e`.

## Phase 6 Done — Definition of Done
- Routes lazy-load (per-route chunks; smaller initial bundle); no Heroicons; a11y advisories cleared + axe smoke green; Playwright smoke present; typed-service pattern established + documented; CI runs the suite; full gate green.
- **Redesign complete:** all 6 phases done on `feat/frontend-redesign`.
