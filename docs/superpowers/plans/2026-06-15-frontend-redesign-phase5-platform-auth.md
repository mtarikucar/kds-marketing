# Frontend Redesign — Phase 5: Platform Realm + Auth/Widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Migrate the platform (superadmin) realm and the public auth/widget pages onto the Console design system, and give the platform realm a proper shared `PlatformLayout`.

**Migration contract:** same as Phase 3 (`docs/superpowers/plans/2026-06-15-frontend-redesign-phase3-core-crm-pages.md` → "## Migration contract"): preserve all queries/mutations/routes/i18n/auth; Console primitives + tokens + RHF+Zod forms; dark-mode-safe; lucide icons; split files >~300 lines; update `App.tsx` + delete old files (no orphans); per-task gate green then commit.

**Worktree:** `/home/tarik/.config/superpowers/worktrees/kds-marketing-frontend-redesign`; branch `feat/frontend-redesign`.

**Realm note:** the platform realm uses `usePlatformAuthStore` + `platformApi` and `PlatformProtectedRoute` (verify the exact guard name in `App.tsx`). Keep that separation intact. The marketing `ThemeProvider` is app-wide, so platform pages already get dark mode tokens.

## Tasks

### Task 1: PlatformLayout + platform pages
Create `frontend/src/features/platform/components/PlatformLayout.tsx` — a slim shell (top bar with brand + operator menu + ThemeToggle + logout via `usePlatformAuthStore`, a simple side or top nav linking the platform routes, `<Outlet/>` + per-route `ErrorBoundary`). Wrap the platform routes in `App.tsx` with it (an `<Outlet/>`-based layout route, mirroring how marketing routes nest under `MarketingLayout`). Then re-skin the platform pages to Console primitives:
- `src/pages/platform/PlatformWorkspacesPage.tsx` (list + search/status filters + status mutation) → `PageHeader`+`DataTable`+`FilterBar`+`Badge`+`ConfirmDialog`.
- `src/pages/platform/PlatformWorkspaceDetailPage.tsx` → `Card`/`Tabs`/`Table`.
- `src/pages/platform/ManualPaymentsPage.tsx` → `DataTable`+approve `Dialog`/`ConfirmDialog`.
- `src/pages/platform/PlatformRoutinesPage.tsx` (~364 lines — split if needed) → `Card`/`DataTable`+config `Dialog` (RHF+Zod).
PRESERVE all `platformApi` queries/mutations (keys+endpoints), the platform auth/guard, and i18n. Commit: `feat(frontend/platform): PlatformLayout + platform pages — Console migration`.

### Task 2: Auth pages — Marketing login, Platform login, Register workspace
- `src/pages/marketing/MarketingLoginPage.tsx`, `src/pages/platform/PlatformLoginPage.tsx`, `src/pages/marketing/RegisterWorkspacePage.tsx`.
Re-skin to a centered Console auth card (`Card` on `bg-background`, brand, `Field`+`Input`, `Button loading`), convert the manual `useState` forms to **RHF+Zod**. PRESERVE the exact login/register mutations (endpoints, token storage via the auth stores, navigate-on-success, error handling), the referral-capture hook on register, and i18n keys. Commit: `feat(frontend/pages): auth pages (login/register) — Console migration (RHF)`.

### Task 3: Widget chat page
- `src/pages/marketing/WidgetChatPage.tsx` (embedded chat widget, iframed by `widget.js` — standalone, no app chrome).
Re-skin to tokens + Console look, BUT keep it self-contained and lightweight (it's embedded on third-party sites): preserve its conversation/send queries+mutations, the embed params parsing, and standalone layout. It should look clean in BOTH light and dark (respect the host or default to light — keep current behavior; do not force `.dark`). Commit: `feat(frontend/pages): Widget chat — Console re-skin`.

## Phase 5 Done — Definition of Done
- Platform realm has a shared `PlatformLayout`; all platform pages + auth/widget pages render in Console, dark-mode-aware (widget per its embed context); platform/marketing auth separation + all queries/mutations preserved.
- `test` + `build` green. **Next:** Phase 6 (hardening: route lazy-loading, typed API layer, a11y audit, Heroicons removal, Playwright E2E, bundle).
