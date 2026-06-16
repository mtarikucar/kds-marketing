# GHL Parity — Phase 3: Frontends for all epics — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch `feat/ghl-parity` (worktree `~/.config/superpowers/worktrees/kds-marketing-ghl-parity`). Console design system (`@/components/ui`) already present (from the merged redesign).

**Goal:** Build React UIs (Console design system) for every new backend capability so the system is usable end-to-end.

## Per-area build contract (apply to EVERY area task)
- Work in the worktree; branch MUST be `feat/ghl-parity`. Frontend in `frontend/`.
- **Use `@/components/ui`** primitives (PageHeader, Card, DataTable, FilterBar, Field+Input/Select/Switch/Checkbox, Dialog, ConfirmDialog, Badge, Tabs, EmptyState, Skeleton, etc.). Tokens only (dark-mode safe). lucide icons. RHF+Zod for forms. TanStack Query hooks calling the real backend endpoints (inspect the controller routes; reuse `marketingApi`/the typed service pattern).
- **Wire it in:** add the page(s) under `frontend/src/pages/marketing/<area>/`, add lazy route(s) in `App.tsx` (respect the existing guard/realm nesting + entitlement), add a nav entry in `features/marketing/navigation.ts` (with the right `feature` entitlement + `managerOnly` where appropriate) so it's reachable. Add i18n keys (inline-fallback pattern used across the app).
- **Gate (frontend):** `npm run lint && npm test && npm run -s build` green. Add a light smoke test (page mounts; a form validates). Commit per area.
- Behavior: match the backend's auth/role/entitlement gating; never expose secrets (integration tokens are masked by the API already).

## UI areas (build order — daily-value first)
1. **CRM core extensions** — custom fields manager (def CRUD), tags manager + lead tagging, segments builder (predicate UI), CSV import wizard (upload → map → commit). Surfaces on/near Leads.
2. **Memberships** — courses (modules/lessons editor + publish), enrollments/progress view, communities (posts/comments/members). Whole new nav section.
3. **Agency console** — sub-account (location) list/create/suspend, snapshots (capture/apply to location), rebilling (per-location plan + charges). Visible only when `workspace.kind === AGENCY`.
4. **Analytics dashboards** — funnel + source/business-type + rep-performance + **attribution** (first/last/linear) charts.
5. **Integrations & settings** — API keys + webhooks manager; SSO connection; Google Calendar connect/status; Slack; Social planner (compose/schedule/accounts); 2FA enrollment; roles & permissions editor (custom roles + the 14-perm catalog); compliance console (consent log + export/erasure); IVR/phone-tree builder.
6. **A/B experiments + survey builder**, **affiliate manager** UI.

Each numbered area = one (or a few) subagent task(s), built + gated + committed independently.

## Phase 3 Done
All capabilities reachable + usable in the UI, dark-mode-safe, gated. `lint+test+build` green. → Phase 4 e2e + deploy readiness.
