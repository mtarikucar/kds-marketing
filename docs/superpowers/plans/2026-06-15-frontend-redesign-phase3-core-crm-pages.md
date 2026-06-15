# Frontend Redesign — Phase 3: Core CRM Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Migrate the daily-driver CRM pages — Dashboard, Leads (list, detail, create/edit), Tasks, Calendar, Offers — onto the Console design system (tokens, dark mode, `@/components/ui` primitives, DataTable, RHF+Zod forms), preserving all data behavior and routes.

**Architecture:** Page-by-page *re-skin/refactor*. Each existing page is the behavior reference. Keep all React Query queries/mutations (query keys + endpoints), routes, URL-filter params, i18n, entitlement gating. Change presentation to tokens + primitives; convert manual `useState` forms to RHF+Zod; split files >~350 lines into focused subcomponents under a per-page folder.

**Reference:** spec `docs/superpowers/specs/2026-06-15-frontend-redesign-design.md`; Phase-1 library in `@/components/ui`.

## Migration contract (apply to EVERY page task)

- **Worktree:** `/home/tarik/.config/superpowers/worktrees/kds-marketing-frontend-redesign`; branch MUST be `feat/frontend-redesign`.
- **Preserve verbatim:** every `useQuery`/`useMutation` (query keys, endpoints, invalidations, `enabled`/`refetchInterval`), all route paths + params, URL search-param filter logic, i18n keys, role/entitlement gating, toasts.
- **Apply Console primitives** from `@/components/ui`:
  - Page wrapper: `PageHeader` (title, description, breadcrumbs?, actions).
  - Panels → `Card`/`CardHeader`/`CardContent`; KPIs → `StatCard`; alerts → `Callout`.
  - Tabular lists → `DataTable` (TanStack) or `Table` primitives; pagination → `Pagination`.
  - Filters/search row → `FilterBar`; selects → `Select`/`Combobox`; status pills → `Badge`/`LeadStatusBadge`.
  - Loading → `Skeleton`/`QueryStateBoundary`; empty → `EmptyState`.
  - Overlays → `Dialog`/`Sheet`/`Popover`/`DropdownMenu`; confirmations → `ConfirmDialog`.
  - **Forms → react-hook-form + zod** via `Field`+`Input`/`Textarea`/`Select`/`Checkbox`/`Switch`/`DatePicker`. Replace ALL manual `useState` form state on these pages.
- **Tokens, not hardcoded colors** (`bg-white`→`bg-surface`, `gray/slate-*`→`foreground`/`muted-foreground`/`border`/`surface-muted`); dark-mode-safe; logical props for RTL. Icons touched → lucide-react.
- **Split large files:** put extracted pieces in `src/pages/marketing/<page>/` (e.g. `LeadDetail/` with `ActivityTab.tsx`, `OffersTab.tsx`) or reuse `features/marketing/components/`. Keep each file focused (<~300 lines).
- **Per task gate:** `npm test && npm run -s build` green, then commit. Add/keep a light render smoke test where a page gains a new form (assert it mounts + validation fires) — full coverage is Phase 6.

## Tasks (one page-area per task, in order)

### Task 1: Dashboard (`src/pages/marketing/MarketingDashboardPage.tsx`)
KPI cards → `StatCard` (today/leads/conversion etc.); lead-status breakdown → `Card` + `Badge`/bars; top-performers (manager-only, gated) → `Card`+`Table`; unread-convos + getting-started/needs-attention sections keep their queries. Wrap in `PageHeader`. Keep all `['marketing','dashboard',...]`, `['marketing','billing','summary']`, conversations `refetchInterval` queries and the entitlement gating. Commit: `feat(frontend/pages): Dashboard — Console migration`.

### Task 2: Leads list (`src/pages/marketing/LeadsPage.tsx`)
The lead table → `DataTable` with sortable columns + row click → `/leads/:id`; the multi-filter bar (status/source/businessType/assignmentStatus + search, URL-driven) → `FilterBar` + `Select`s, preserving the exact query-param keys and the `['marketing','leads',{...}]` query; bulk-action toolbar keeps its mutations (reuse/adapt `BulkActionToolbar`); pagination → `Pagination`. Empty/loading via `EmptyState`/`Skeleton`. Commit: `feat(frontend/pages): Leads list — Console migration (DataTable, FilterBar)`.

### Task 3: Lead detail (`src/pages/marketing/LeadDetailPage.tsx`, 743 lines — SPLIT)
Split into `src/pages/marketing/LeadDetail/`: `LeadDetailPage.tsx` (shell + header + summary), `ActivityTimelineTab`, `OffersTab`, `TasksTab`, `ContactInfo` (reuse `ActivityTimeline` feature comp). Use `Tabs`, `Card`, `Badge`, `Dialog`/`Sheet` for the add-activity/offer/task forms (RHF+Zod). Preserve every activity/offer/task query+mutation + the lead query. `PageHeader` with the lead name + status badge + actions. Commit: `feat(frontend/pages): Lead detail — Console migration + file split`.

### Task 4: Create/Edit lead (`src/pages/marketing/CreateLeadPage.tsx`)
Already RHF+Zod — re-skin its fields to `Field`+`Input`/`Select`/`Textarea`, wrap in `Card`+`PageHeader`, keep the upsert mutation + the create-vs-edit (`/leads/new` vs `/leads/:id/edit`) logic + the existing `leadSchema`. Commit: `feat(frontend/pages): Create/Edit lead — Console form primitives`.

### Task 5: Tasks (`src/pages/marketing/TasksPage.tsx` — manual form → RHF)
List → `DataTable`/`Table` + `Badge` (status/type); filter row → `FilterBar`+`Select`; the inline create/update form → `Dialog`+RHF+Zod (`taskSchema`); preserve task queries/mutations + filters. Commit: `feat(frontend/pages): Tasks — Console migration (RHF form)`.

### Task 6: Calendar (`src/pages/marketing/CalendarPage.tsx`)
Re-skin the calendar/agenda UI to tokens + `Card`; event detail/create → `Dialog`/`Popover`+RHF; preserve the task/activity scheduling queries + the agenda/month logic. Commit: `feat(frontend/pages): Calendar — Console migration`.

### Task 7: Offers (`src/pages/marketing/OffersPage.tsx`, 580 lines, manual form → RHF — SPLIT if needed)
List → `DataTable`/`Card` + status `Badge`; inline create/edit → `Dialog`+RHF+Zod (`offerSchema`); filters → `FilterBar`; preserve offer queries/mutations + status transitions. Commit: `feat(frontend/pages): Offers — Console migration (DataTable, RHF form)`.

## Phase 3 Done — Definition of Done
- All 7 core page-areas render in Console, dark-mode-aware, with primitives + RHF forms; behavior/routes/queries preserved; large files split.
- `test` + `build` green throughout. **Next:** Phase 4 (remaining marketing pages).
