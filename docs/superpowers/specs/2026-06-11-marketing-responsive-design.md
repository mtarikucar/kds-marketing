# Marketing console — responsive design pass

**Date:** 2026-06-11
**Branch:** `feat/responsive-pass`
**Scope:** the entire kds-marketing **frontend** (all marketing pages). The POS/kds app is out of scope.
**Targets:** phone (~390px) and tablet (~820px); desktop (≥1024px) layouts stay as-is.

## Goal

Make every marketing-console page usable on phone and tablet. "Pay more attention to responsiveness" — close the gaps left by the desktop-first GoHighLevel-parity pages and re-polish the few older pages that still slip.

## Current state (baseline)

The console is already ~80% responsive:

- **App shell is done** — `MarketingLayout` already has a `lg:hidden` slide-in sidebar drawer + hamburger and a `hidden lg:block` desktop sidebar; `MarketingHeader` adapts. No shell work needed.
- **Reference patterns already exist in-repo** (copy these, don't invent):
  - **Responsive table:** `LeadsPage` — `overflow-x-auto` wrapper + `hidden sm:table-cell`/`hidden lg:table-cell` column-hiding.
  - **Responsive modal:** `CommissionDetailModal` — `items-end sm:items-center` (bottom-sheet on phone), `max-h-[92vh] overflow-y-auto` body.
  - **Responsive form:** `CreateLeadPage` — every grid is `grid-cols-1 sm:grid-cols-N`.
- Most older pages, dashboards, auth pages, AI-config pages (Agent Studio, Knowledge Base, Channels, Sites, Reviews, Branding) are already fine.

## The gaps (grouped by recurring anti-pattern)

| # | Anti-pattern | Pages | Fix |
|---|---|---|---|
| **A** | Side-by-side `flex` panes, fixed-width columns, no breakpoint | **InboxPage** (3-pane), **VoicePage** (2-pane) | Mobile master-detail drill-down (see below) |
| **B** | `<table>` not wrapped / no column-hiding | **ReportsPage** (×4 tables), **TargetsPage** | Copy `LeadsPage` table pattern |
| **C** | bare `grid-cols-2/3` (no `sm:`) | **LeadDetailPage** (offer form, convert modal, offer summary), **CalendarPage** day modal | `grid-cols-1 sm:grid-cols-N` |
| **D** | no-wrap rows of inline controls + fixed-width inputs | **InvoicesPage** line items (`w-20`/`w-28`), **CampaignsPage** filter rows, **BookingSettingsPage** time rows, `ClickToDialButton` (`w-44`) | `flex-wrap` / stack < `sm` |
| **E** | `absolute w-64` popovers, no edge collision handling | `AssignCell` (`left-0`), `BulkActionToolbar` (`right-0`) | Constrain width / flip near viewport edge |
| **F** | 7-col month grid won't shrink | **CalendarPage** | Mobile agenda/list view under `md`; keep grid `md+` |

## Master-detail design (Inbox + Voice) — chosen pattern: drill-down

Single source of truth: a `selectedId` already exists in both pages. Drive panes off a `lg` breakpoint check (CSS-first; a small `useMediaQuery('(min-width:1024px)')` only where conditional rendering is cleaner than CSS show/hide).

- **Desktop (≥1024px / `lg`):** unchanged — all panes side-by-side.
- **Tablet (640–1023px, `sm` to `<lg`):** list + thread side-by-side; lead-context pane becomes a toggle (button in the thread header opens it as a right-side sheet).
- **Phone (<640px, `<sm`):**
  - No selection → conversation/call **list fills the width**.
  - Selection → **thread/transcript fills the width**, with a **‹ back** affordance in its header that clears `selectedId` (returns to the list).
  - Lead-context (Inbox) opens as a **bottom sheet** from a `[👤 context]` button in the thread header (reuse the `CommissionDetailModal` bottom-sheet pattern).
  - Composer (Inbox) stays pinned at the bottom of the thread view.

No backend or data-flow change — purely which pane is visible at a given width.

## Conventions established by this pass

1. Never ship a bare multi-column `grid-cols-N`; always `grid-cols-1 sm:grid-cols-N` (or `md:`).
2. Every `<table>` lives in an `overflow-x-auto` wrapper; non-essential columns get `hidden sm:table-cell`/`hidden md:table-cell`.
3. Rows of >2 inline controls wrap (`flex-wrap`) or stack (`flex-col sm:flex-row`) below `sm`.
4. Modals/inline-modals use the bottom-sheet-on-phone pattern (`items-end sm:items-center` + capped height + scroll).

## Out of scope (YAGNI)

- No new shared component library / big refactor — copy the existing reference patterns inline. (A tiny `useMediaQuery` hook is the only new shared utility, and only if needed for Inbox/Voice.)
- No functional/behavioral changes, no palette changes, no POS app.
- Custom domains / vanity routes unrelated.

## Verification

- **Playwright** screenshots at **390px (phone)** and **820px (tablet)** for the high-risk pages: Inbox, Voice, Calendar, Reports, LeadDetail, Invoices — confirm no horizontal overflow, panes drill down correctly, tables scroll, controls wrap.
- `npm run build` green (TypeScript + Vite).
- Spot-check a representative already-good page (LeadsPage) didn't regress.

## Release

Frontend-only change. Ships as the next tag (`v2.10.0`) → existing tag-triggered CI → prod, **once the user authorizes the deploy** (same gate as the parity rollout). No env or migration changes.
