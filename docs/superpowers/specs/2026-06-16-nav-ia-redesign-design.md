# Navigation / IA Redesign — GoHighLevel-style hubs — Design Spec

**Date:** 2026-06-16
**Status:** approved by user ("yap böyle").

## Problem
After the GHL-parity program the console has **~47 nav items in 6 flat groups** (Growth has 16, Settings has 15). Everything sits side-by-side with no sub-structure → overwhelming and undiscoverable. The user wants a **much better UX that resembles GoHighLevel's**.

## Goal
Restructure the **information architecture** into GHL's pattern: a **lean primary sidebar of ~13 hubs**, each hub a small group of related pages shown as a **secondary sub-nav**, with **Settings as a separate area**. Keep every existing page, route URL, and backend contract — this is a navigation/IA change, not a page rewrite.

## Approved IA (hub → children)
Primary sidebar (each is a hub; children are the existing pages):

| Hub | icon | children (existing routes) |
|---|---|---|
| Dashboard | Home | `/dashboard` (no children) |
| Conversations | MessagesSquare | Inbox `/inbox` · Channels `/channels` |
| Contacts | Users | Leads `/leads` · Segments `/settings/segments` · Tags `/settings/tags` · Import `/settings/import` |
| Calendar | Calendar | Calendar `/calendar` · Booking `/booking` |
| Sales | DollarSign | Offers `/offers` · Calls `/calls` · Commissions `/commissions` · Installations `/installations` |
| Tasks | ClipboardList | `/tasks` (no children) |
| Marketing | Megaphone | Campaigns `/campaigns` · Social Planner `/social` · Reviews `/reviews` · Affiliates `/affiliates` |
| Sites | Globe | Sites/Funnels `/sites` · Forms (part of `/sites`) · Surveys `/surveys` · A/B Experiments `/experiments` |
| Automation | Zap | Workflows `/automations` · AI Agents `/ai/agents` · Knowledge `/ai/knowledge` |
| Memberships | GraduationCap | Courses `/memberships/courses` · Communities `/memberships/communities` |
| Voice | Mic | Voice `/voice` · Phone Tree `/voice/ivr` |
| Reporting | PieChart | Reports `/reports` · Performance `/performance` · Analytics `/analytics` |
| Payments | Banknote | Invoices `/invoices` · Billing `/billing` |
| Agency *(agency workspaces only)* | Building2 | Sub-accounts `/agency/locations` · Snapshots `/agency/snapshots` · Rebilling `/agency/rebilling` |

**Settings** (separate area, gear icon pinned at sidebar bottom) — its own secondary sidebar:
Business & Branding `/branding` · Team `/users` · Roles & permissions `/settings/roles` · Targets `/targets` · Custom Fields `/settings/custom-fields` · Connections `/settings/connections` · API Keys `/settings/api-keys` · Webhooks `/settings/webhooks` · Compliance `/settings/compliance` · Two-factor `/settings/two-factor` · Research `/research`.

(Notes: Tags/Segments/Import live under **Contacts** for daily use; Custom Fields stays in **Settings** as config. Dashboard/Tasks are single-page hubs — no sub-nav. Attribution is a tab inside Analytics already, so Reporting lists Analytics.)

## Model (`features/marketing/navigation.ts`)
Restructure to a **two-level** model — preserve all gating:
```ts
interface NavChild { path; labelKey; label; icon?; feature?: FeatureKey; managerOnly?: boolean }
interface NavHub {
  id; labelKey; label; icon; path?;          // path = where clicking the hub lands (a single-page hub) 
  children?: NavChild[];                      // sub-nav items
  feature?: FeatureKey; managerOnly?; agencyOnly?;
  area?: 'main' | 'settings';                 // settings hub renders in the separate area
}
export const NAV_HUBS: NavHub[]
```
- `visibleNav(hubs, opts)` → filter agencyOnly hubs (non-agency), filter each hub's children by role+entitlement, drop hubs left with no visible children (and no own `path`). Same gating semantics as today (unit-tested).
- The **active hub** is computed from the current pathname: the hub that owns the matched child path (longest-prefix match). A child can be reached by URL directly; the shell highlights its hub + shows the hub's sub-nav.
- **URLs are unchanged.** No route renamed; no page edited. Only the nav data + the shell rendering change.

## Shell rendering (`features/marketing/components/`)
- **Primary sidebar** (`MarketingSidebar`): renders the `area:'main'` hubs as icon+label items (active = the hub owning the current path), **collapsible to an icon-rail** (toggle persisted), brand at top, user card + a **gear (Settings)** pinned at the bottom. Mobile: a `Sheet` drawer (already exists).
- **Secondary sub-nav** (`HubSubNav`, new): given the active hub, render its visible children. For main hubs (≤~6 children) → a **horizontal tab strip** under the `PageHeader`. Hidden when the active hub has no children (Dashboard/Tasks). Tokens, dark-mode, RTL-safe, lucide.
- **Settings area** (`SettingsLayout`, new): when the path is one of the Settings children, the page renders inside a layout with a **secondary vertical sidebar** listing the Settings children (GHL settings pattern) + a back-to-app affordance. Reached via the gear.
- `MarketingLayout` composes: primary sidebar + (header + sub-nav + `<Outlet/>`), or the Settings layout for settings paths.

## Non-goals (YAGNI)
- No page rewrites, no route-URL changes, no backend changes, no new features.
- Not changing the Console design system; reuse `@/components/ui` (`Tabs`/segmented for the sub-nav, etc.).

## Testing
- `navigation.test.ts`: rewrite the existing invariants for the hub model — gating per child preserved (REP sees only allowed, manager sees manager items, agency hub hidden for non-agency, entitlement-gated children hidden), empty hubs dropped, active-hub resolution by path.
- Smoke: sidebar renders the hubs; the active hub's sub-nav renders its children; Settings layout renders its secondary sidebar.
- Gate: `npm run lint && npm test && npm run build` green.
