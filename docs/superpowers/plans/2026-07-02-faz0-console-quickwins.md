# Faz 0 — Console Quick Wins Implementation Plan

> **For agentic workers:** executed inline with TDD; steps tracked here. Part of the Jeeta UX overhaul (spec: `docs/superpowers/specs/2026-07-02-jeeta-ux-overhaul-design.md`).

**Goal:** Give the console a clear starting point and a fast escape hatch: a global command palette + header search, a global "+ Create", a role-aware dashboard reframe, and a base-dialog scroll fix — all frontend-only.

**Architecture:** A tiny zustand store holds command-palette open state; `MarketingLayout` mounts the palette + a global Cmd/Ctrl+K listener; `MarketingHeader` gets a search button (opens palette) and a "+ Create" dropdown. A single `quickActions.ts` defines create actions reused by both the palette and the header. The palette's navigation entries are derived from the gated `visibleNav(NAV_HUBS,…)` so it respects role/plan. The dashboard gains a role-aware hero and empty-state CTAs.

**Tech Stack:** React 18, TypeScript, react-router v6, @tanstack/react-query, zustand, react-i18next, Radix Dialog (already present), Tailwind + design-system primitives (`@/components/ui`), vitest + @testing-library/react.

## Global Constraints
- **Commits:** conventional-commit messages, NO Claude/AI trailer or co-author (user hard rule). Author = user.
- **i18n:** add new keys to `en` and `tr` marketing.json only (the two complete locales; ar/ru/uz are partial); every `t()` call passes an English inline fallback so partial locales degrade gracefully.
- **No new npm dependencies** (offline-safe): build the palette on the existing Radix `Dialog`.
- **Design system only:** use `@/components/ui` primitives + semantic tokens; no legacy `index.css` utilities, no raw hex/`bg-white`.
- **Preserve all routes/URLs.**
- **Green gate:** after every task, `npx tsc --noEmit` and `npm test` must pass.

---

## File Structure
- Modify `src/components/ui/Dialog.tsx` — base `DialogContent` gets max-height + internal scroll + small-screen inset. (Task D)
- Create `src/store/commandPaletteStore.ts` — zustand `{ open, setOpen, toggle }`. (Task A)
- Create `src/features/marketing/quickActions.ts` — `QuickAction[]` (label key + fallback, icon, `to`) + helper. (Task A/B)
- Create `src/features/marketing/components/CommandPalette.tsx` — accessible palette (search input + grouped, keyboard-navigable results: quick actions + gated nav destinations). (Task A)
- Create `src/features/marketing/hooks/useNavCommands.ts` — flattens `visibleNav(NAV_HUBS,…)` into command entries (label, path, hub, icon). (Task A)
- Modify `src/features/marketing/components/MarketingLayout.tsx` — mount `<CommandPalette/>` + global key listener. (Task A)
- Modify `src/features/marketing/components/MarketingHeader.tsx` — search button (opens palette, shows ⌘K) + "+ Create" dropdown. (Task B)
- Create `src/pages/marketing/dashboard/DashboardHero.tsx` — role-aware primary CTA / empty-first-run card. (Task C)
- Modify `src/pages/marketing/MarketingDashboardPage.tsx` — mount hero, reorder (NeedsAttention+Today above KPIs), demote PDFs into a "Guides" dropdown. (Task C)
- Add empty guards to `src/pages/marketing/dashboard/TodaySummary.tsx` + `MonthlyMetrics.tsx`. (Task C)
- i18n: `src/i18n/locales/{en,tr}/marketing.json` — `commandPalette.*`, `quickCreate.*`, `dashboard.hero.*`, `dashboard.guides*`.
- Tests: `CommandPalette.test.tsx`, `quickActions.test.ts`, `useNavCommands.test.ts`, `DashboardHero.test.tsx`, plus a Dialog scroll assertion.

---

## Task D: Base dialog scroll fix (do first — foundational, tiny)
**Files:** Modify `src/components/ui/Dialog.tsx:44`; Test `src/components/ui/Dialog.test.tsx` (create if absent).
- [ ] Write a failing test: render a `Dialog`/`DialogContent` with tall children; assert the content root carries `max-h`/`overflow-y-auto` classes (class-contract test, since jsdom has no layout).
- [ ] Implement: append `max-h-[calc(100vh-2rem)] overflow-y-auto max-w-[calc(100vw-2rem)]` to the `DialogContent` class list (keep centering + existing classes).
- [ ] Run test → pass. Typecheck + full test suite green.
- [ ] Commit `fix(ui): make dialogs scroll within the viewport so actions stay reachable`.

**Acceptance:** every modal is internally scrollable; footer/Save reachable at any viewport.

## Task A: Command palette + Cmd/Ctrl+K
**Files:** Create `commandPaletteStore.ts`, `quickActions.ts`, `useNavCommands.ts`, `CommandPalette.tsx`; Modify `MarketingLayout.tsx`; i18n keys; Tests.
**Interfaces:**
- `useCommandPaletteStore` → `{ open: boolean; setOpen(v:boolean):void; toggle():void }`.
- `buildNavCommands(opts:{isManager;has;isAgency}, t)` → `{ id; label; path; hubLabel; icon }[]` from `visibleNav(NAV_HUBS,opts)` (hub `path` or each child path; label via `t(labelKey,label)`).
- `QUICK_ACTIONS: QuickAction[]` where `QuickAction = { id; labelKey; label; icon; to }`.
- `<CommandPalette/>` — self-contained; reads store, entitlements (`useEntitlements`), profile (`useWorkspaceProfile`), `useNavigate`.
- [ ] Test `useNavCommands`: given a manager+entitled stub, returns entries incl. `/leads` and `/dashboard`; a REP stub excludes manager-only paths.
- [ ] Test `CommandPalette`: opens when store.open; typing filters entries (case-insensitive, matches label + hub); ArrowDown/ArrowUp move active row; Enter navigates (mock `useNavigate`) and closes; Escape closes.
- [ ] Implement store (zustand), `quickActions.ts`, `useNavCommands.ts`, `CommandPalette.tsx` (Radix `Dialog` shell, `Input`, listbox with `aria-activedescendant`, grouped "Quick actions" + "Go to"). Empty-query shows quick actions + all destinations; query filters. Fallback English strings on every `t()`.
- [ ] Mount in `MarketingLayout`: `<CommandPalette/>` + `useEffect` global `keydown` for `(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'` → `preventDefault(); toggle()`; ignore when target is an input/textarea/contenteditable unless palette already open.
- [ ] i18n: `commandPalette.placeholder`, `.quickActions`, `.goTo`, `.empty`, `.hint`; `quickCreate.lead/task/opportunity/company`.
- [ ] Typecheck + tests green. Commit `feat(nav): add global command palette (Cmd/Ctrl+K) for page-jump + quick actions`.

**Acceptance:** ⌘K/Ctrl+K opens; any gated destination reachable by typing; keyboard-only usable.

## Task B: Header search button + "+ Create" dropdown
**Files:** Modify `MarketingHeader.tsx`; reuse `quickActions.ts` + store; wire `?create=1` into Tasks/Opportunities/Companies pages (open their existing create modal); i18n.
**Interfaces:** Header consumes `useCommandPaletteStore().setOpen` and `QUICK_ACTIONS`.
- [ ] Add a search affordance left of the bell: a button showing a search icon + muted "Search…" + a `⌘K` kbd chip (hidden on xs); `onClick=setOpen(true)`. Mobile: icon-only.
- [ ] Add a primary "+ Create" `DropdownMenu` (Button with `Plus`): items from `QUICK_ACTIONS`, each `navigate(to)`.
- [ ] Wire `?create=1`: New Lead → `/leads/new` (exists); Task/Opportunity/Company → `/tasks|/opportunities|/companies?create=1`; in each of those 3 pages add a small effect: if `searchParams.get('create')` open the create modal once and strip the param. (Read each page's existing modal state before editing.)
- [ ] Typecheck + tests green. Commit `feat(nav): header global search + "+ Create" quick action`.

**Acceptance:** one obvious create entry from anywhere; search button opens palette.

## Task C: Role-aware dashboard reframe
**Files:** Create `DashboardHero.tsx`; Modify `MarketingDashboardPage.tsx`, `TodaySummary.tsx`, `MonthlyMetrics.tsx`; i18n; Test `DashboardHero.test.tsx`.
**Interfaces:** `<DashboardHero stats today isManager gettingStartedComplete onOpenGuides/>` decides: empty workspace (no leads) → "Add your first lead" EmptyState-style CTA; work waiting → "Review N items" (links to NeedsAttention targets); else → a concise role-aware greeting + primary action (REP: "Go to your leads"; manager mid-setup handled by GettingStarted).
- [ ] Test `DashboardHero`: totalLeads=0 → renders "add first lead" CTA to `/leads/new`; with today.overdueTasks>0 → renders "review" CTA; REP vs manager copy differs.
- [ ] Implement `DashboardHero` using `@/components/ui` (`Card`/`EmptyState`/`Button`), semantic tokens, `t(key,fallback)`.
- [ ] Reframe page: mount hero at top; keep `NeedsAttention`; move the Today summary above `KpiGrid`; move the two PDF `<a>`s into a compact "Guides" `DropdownMenu` (secondary) in the header actions; change subtitle to a task framing key.
- [ ] Add empty guards: `TodaySummary`/`MonthlyMetrics` render an `EmptyState` (or muted "no activity yet") instead of rows of zeros when all values are 0.
- [ ] i18n: `dashboard.hero.addFirstLead*`, `.reviewItems`, `.repGreeting`, `.goToLeads`, `.guides`, task-framed `dashboard.subtitle` (new key, keep old for compat).
- [ ] Typecheck + tests green. Commit `feat(dashboard): role-aware starting point, reorder work above metrics, demote guide PDFs`.

**Acceptance:** landing answers "what do I do now?" for both REP and manager; no wall-of-zeros on an empty workspace.

---

## Self-review (post-write)
- Spec coverage: Faz 0 bullets in spec §7.0 all mapped (palette+search → A; +Create → B; dashboard reframe → C; dialog fix → D). ✓
- Placeholders: none — each task names exact files + acceptance; code shown where non-obvious at implementation time.
- Type consistency: store/action/command interface names fixed above and reused across tasks. ✓
- Record search (spec mentions leads/companies/opportunities/tasks) is **deferred** from Faz 0 (needs a backend search contract); palette v1 is nav + quick actions. Tracked for a Faz 0.5 follow-up.
