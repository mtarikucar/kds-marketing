# Frontend Redesign — Phase 2: App Shell & Navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Re-skin the marketing app chrome (Sidebar, Header, Layout) into the Console design system — token-based, dark-mode-aware, Radix-powered dropdowns/dialogs, with ThemeToggle + LanguageSwitcher — while preserving every behavior (nav gating, notifications, change-password, logout, i18n, mobile drawer).

**Architecture:** These are *integration/refactor* tasks: the existing components are the behavior reference. Keep all data hooks (React Query queries/mutations), the `navigation.ts` gating, i18n, entitlements, and routes EXACTLY; change only presentation (hardcoded `gray/slate/white` → semantic tokens), swap hand-rolled dropdowns/modals for `@/components/ui` primitives, and add theme/language controls.

**Tech Stack:** existing React 18 + Router + Query + i18n; new `@/components/ui` library (DropdownMenu, Dialog, Field, Input, Button, Badge, Avatar, Sheet, ThemeToggle, LanguageSwitcher, Breadcrumbs).

**Reference spec:** `docs/superpowers/specs/2026-06-15-frontend-redesign-design.md`.

**Scope note (deviation from spec):** `PlatformLayout` moves to **Phase 5** (platform realm) to keep this phase focused on the primary marketing shell and lower-risk. Nav-item icons in `navigation.ts` stay Heroicons for now (global Heroicons→Lucide sweep is Phase 6); only the shells' own chrome icons switch to lucide-react.

**Global rules (every task):**
- Work in the worktree `/home/tarik/.config/superpowers/worktrees/kds-marketing-frontend-redesign`; branch MUST be `feat/frontend-redesign`; commits land there.
- Preserve all existing behavior, props, query keys, mutation endpoints, i18n keys, and route paths. No backend calls change.
- Replace hardcoded colors with tokens: `bg-gray-50`→`bg-background`, `bg-white`→`bg-surface`, `text-gray-900/slate-900`→`text-foreground`, `text-gray-500/slate-500`→`text-muted-foreground`, `border-gray-200/slate-200`→`border-border`, brand stays `primary`. Use `bg-surface-muted` for hover fills.
- After each task: `npm test && npm run -s build` green, then commit.

---

## Task 1: MarketingSidebar — Console re-skin

**File:** Modify `frontend/src/features/marketing/components/MarketingSidebar.tsx` (read it first — it renders `visibleNav(NAV_GROUPS, {isManager, has})` groups, collapsible Growth group, brand, user card, logout, `APP_VERSION`).

- [ ] **Step 1:** Keep ALL logic: `useTranslation('marketing')`, `useMarketingAuthStore` (user, logout), `useEntitlements` (has), `visibleNav`, the per-group `collapsed` state, `onNavigate` prop, NavLink paths, i18n keys, APP_VERSION footer. Only change classes + chrome icons.
- [ ] **Step 2:** Re-skin to tokens: `<aside class="flex h-screen w-64 flex-col border-e border-border bg-surface">`. Brand: keep the gradient badge but `from-primary to-primary-hover` + `text-primary-foreground`; title `font-display`. Group labels: `text-micro uppercase text-muted-foreground`. Collapsible chevron: lucide `ChevronDown`. NavLink active: `bg-primary/10 text-primary` + the left accent bar `bg-primary`; idle: `text-muted-foreground hover:bg-surface-muted hover:text-foreground`. Replace the Heroicons `ChevronDownIcon`/`ArrowRightOnRectangleIcon` with lucide `ChevronDown`/`LogOut`. (Keep `item.icon` for nav items as-is.)
- [ ] **Step 3:** User card: avatar bubble `bg-primary/10 text-primary` initials; name `text-foreground`, role `text-muted-foreground`. Logout button: `text-muted-foreground hover:bg-danger-subtle hover:text-danger`, lucide `LogOut`. Footer version `text-muted-foreground`.
- [ ] **Step 4:** Use logical props (`border-e`, `ms-`/`me-`) so RTL stays correct. Add `focus-visible:ring-2 focus-visible:ring-ring` to interactive controls.
- [ ] **Step 5:** Gate (`npm test && npm run -s build`) + commit: `feat(frontend/shell): MarketingSidebar — Console re-skin (tokens, dark mode, lucide chrome)`.

---

## Task 2: MarketingHeader — Console re-skin with primitives

**File:** Modify `frontend/src/features/marketing/components/MarketingHeader.tsx` (read it first — Breadcrumbs, notification bell + hand-rolled dropdown w/ unread-count query + list query + mark-all/mark-one mutations, profile dropdown, change-password modal + mutation, logout).

- [ ] **Step 1:** Keep ALL data logic verbatim: the two notification queries (`['marketing','notifications','unread-count']` refetch 30s, `['marketing','notifications']` enabled when open), `markAllReadMutation`, `markOneReadMutation`, `changePasswordMutation`, `handleLogout`, `formatTimeAgo`, the count/notificationList normalization. Keep using the existing `Breadcrumbs` (the feature one) for now.
- [ ] **Step 2:** Header shell → `bg-surface border-b border-border`. Right cluster order: **LanguageSwitcher**, **ThemeToggle**, notification bell, profile menu (import `LanguageSwitcher`, `ThemeToggle` from `@/components/ui`).
- [ ] **Step 3:** Notification bell → an `IconButton` (lucide `Bell`) with the unread `Badge` (tone danger, count) absolutely positioned. Wrap the dropdown in the `DropdownMenu` primitive (or `Popover` if richer layout needed): header row "Notifications" + "Mark all read" `Button variant=ghost size=sm`; list of notification items as `DropdownMenu.Item`s (or buttons) calling `handleNotificationClick`; unread dot `bg-primary`; empty → muted text. Tokens throughout. Keep the same query gating (load list when menu opens).
- [ ] **Step 4:** Profile → `DropdownMenu`: trigger is an avatar (`Avatar` initials) + name (`hidden sm:block`). Content: name/email block, a role `Badge` (`tone={isManager?'primary':'neutral'}`), `DropdownMenu.Item` "Change Password" → opens the dialog, `DropdownMenu.Item` "Logout" (danger styling) → `handleLogout`.
- [ ] **Step 5:** Change-password modal → the `Dialog` primitive with `DialogTitle`/`DialogDescription`; convert the form to **react-hook-form + zod** using `Field` + `Input` (type=password) for `currentPassword`/`newPassword` (zod: both required, newPassword min length per existing rules — if none, min 8). Submit calls `changePasswordMutation.mutate`; Cancel closes + resets. Confirm button uses `Button loading={changePasswordMutation.isPending}`.
- [ ] **Step 6:** Remove the old hand-rolled click-outside `<div className="fixed inset-0">` overlays (Radix handles dismissal). Keep `role`/aria via the primitives.
- [ ] **Step 7:** Gate + commit: `feat(frontend/shell): MarketingHeader — Console re-skin (DropdownMenu, Dialog+RHF, ThemeToggle, LanguageSwitcher)`.

---

## Task 3: MarketingLayout — Console re-skin + Sheet mobile drawer

**File:** Modify `frontend/src/features/marketing/components/MarketingLayout.tsx` (read it first — desktop sidebar, mobile slide-over sidebar, mobile hamburger, MarketingHeader, `<main>` with per-route ErrorBoundary, AskAiPanel).

- [ ] **Step 1:** Keep: desktop `<MarketingSidebar/>` (hidden below lg), `<MarketingHeader/>`, `<main>` per-route `<ErrorBoundary key={location.pathname}>` + `<Outlet/>`, and `<AskAiPanel/>`.
- [ ] **Step 2:** Root → `flex h-screen overflow-hidden bg-background`. `<main>` → `bg-background` (remove `bg-gray-50`). Mobile top bar → `bg-surface border-b border-border`; hamburger → `IconButton` lucide `Menu`.
- [ ] **Step 3:** Replace the hand-rolled mobile slide-over (`fixed -translate-x-full` + manual backdrop) with the `Sheet` primitive (`side="left"` in LTR — use a logical side; Sheet should respect RTL or pass `side` accordingly): `Sheet` open state from `sidebarOpen`; content renders `<MarketingSidebar onNavigate={() => setSidebarOpen(false)} />`. Keep `lg:hidden` for the trigger and Sheet; desktop keeps the static sidebar.
- [ ] **Step 4:** Gate + commit: `feat(frontend/shell): MarketingLayout — Console re-skin + Sheet mobile drawer`.

---

## Task 4: Shell smoke test

**File:** Create `frontend/src/features/marketing/components/MarketingShell.test.tsx`.

- [ ] **Step 1:** Render `MarketingSidebar` (inside `MemoryRouter` + i18n; set `useMarketingAuthStore.setState` with a MANAGER user) and assert: a known nav label (e.g. "Dashboard"/its i18n) is present, the user initials show, logout control present. Render `MarketingHeader` inside the required providers (MemoryRouter + QueryClientProvider + i18n) and assert it mounts and the ThemeToggle group (`role="group"` name "Theme") is present. Keep it a light smoke (behavior already covered by existing logic); the point is the new chrome mounts.
- [ ] **Step 2:** Gate + commit: `test(frontend/shell): smoke render for re-skinned sidebar + header`.

---

## Phase 2 Done — Definition of Done
- Sidebar/Header/Layout render in the Console system, dark-mode-aware, with ThemeToggle + LanguageSwitcher in the header.
- All behavior preserved: nav gating, notifications (count + list + mark read), change-password (now RHF+Zod), logout, i18n, mobile drawer (now Sheet).
- Pages render unchanged inside the new chrome. `test` + `build` green.
- **Next:** Phase 3 (core CRM pages) migrates page bodies to the system + DataTable/Field.
