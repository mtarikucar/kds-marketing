# Jeeta — End-to-End UX/UI Overhaul (Design Spec)

**Date:** 2026-07-02
**Status:** DRAFT — pending owner review
**Scope:** End-to-end — public landing → registration/onboarding → authenticated console → mobile
**Author:** design brainstorm (grounded in an 8-dimension automated UX audit of `frontend/src`)

---

## 1. Problem statement

The owner's words: *"When I enter the site I don't know what to do — everything feels like it's everywhere."*

The product is a GoHighLevel-parity, multi-tenant marketing/CRM SaaS (React + Vite + Tailwind + react-router + react-i18next). An 8-dimension audit of the frontend produced a clear diagnosis:

> **The system is not built badly — nothing focuses or reduces the surface for the person actually using it.**

The single most important finding: the person most affected is the **OWNER on a full plan** (the complainant). Menu visibility is reduced by only two axes — **role** and **plan**. An OWNER passes every role check; a full plan passes every feature check. So the owner is shown the *maximal possible* version of the app: **~15 hubs, ~50 manager pages, all at once, with zero personalization or progressive reveal**. That is the mechanical cause of "everything everywhere."

## 2. Goals / non-goals / success criteria

**Goals**
- Make the first 10 seconds after login answer "what do I do now?" — a clear, role-aware starting point.
- Cut the *default* visible surface to a focused core (~6–8 destinations) without removing capability.
- Give a fast escape hatch to any page/record (command palette + global search) so breadth stops requiring spatial memory.
- Make the console feel like **one app**: consistent loading/error/empty/filter patterns and one design vocabulary.
- Make first-run (register → activation) guided rather than a wall of zeros — for both managers **and** reps.
- Make the landing page clearly say what Jeeta is, for whom, with one obvious conversion path.
- Make the whole thing usable on a phone (reachable Save buttons, scannable lists, quick-create).

**Non-goals**
- Removing features or capabilities. Progressive disclosure hides until relevant; it never deletes.
- Changing existing route URLs where avoidable (deep links + muscle memory must keep working). URL/area realignment is scoped and deliberate where it happens (Faz 2).
- A visual rebrand. We consolidate onto the *existing* design system; we don't repaint it.
- Backend/API redesign beyond the small additions progressive disclosure and search require.

**Success criteria (how we'll know it worked)**
- A brand-new OWNER's default sidebar shows ≤ 8 primary destinations (today: ~15).
- Any destination/record reachable in ≤ 2 keystrokes via Cmd/Ctrl+K.
- Every list page shares one loading, one error+retry, one empty-state, one filter pattern.
- A REP landing on an empty workspace sees a "here's your day / start here" card, never a wall of zeros.
- Post-register, the user is guided to 2–3 first wins (import contacts, connect a channel, invite team).
- Core create actions (lead, task, appointment, call) reachable in 1 tap from anywhere, on desktop and mobile.
- Every modal's Save button is reachable at any viewport / with the keyboard open.

## 3. Design principles (north stars)

1. **Start focused, reveal on demand.** The default view is the daily core. Everything else is one deliberate click/keystroke away, not permanently on screen.
2. **Role- and state-aware.** What you see depends on who you are and what your workspace has actually set up — not the union of everything your plan *could* do.
3. **One way to do a thing.** One PageHeader, one EmptyState, one loading pattern, one "primary" color, one styling vocabulary. Duplicates are deleted, not tolerated.
4. **Type, don't hunt.** Cmd/Ctrl+K is the primary navigation muscle for a 70-page app.
5. **Task framing over metric framing.** "What needs you" before "performance at a glance."
6. **Preserve the good bones.** The design system, hub IA skeleton, gating engine, and deep-linking are strong — we build on them.

## 4. Root-cause analysis (audit synthesis)

| # | Root cause | Severity | Evidence |
|---|-----------|----------|----------|
| 1 | **No progressive disclosure.** ~half of ~75 pages are advanced/niche; ~30 modules carry no plan key, so they show to every manager regardless of plan or setup. No "activate on use" dimension. | High | `navigation.ts:80-97` (only 15 feature keys), `:281-301` (gating = role∧plan only), `App.tsx:202-269` (61 manager routes behind one guard) |
| 2 | **No escape hatch.** 70+ pages, zero command palette / Cmd+K / global search. The only way to a page is to guess its hub and scan sub-tabs. | High | `MarketingHeader.tsx:159-274` (no search); grep `cmdk|command palette|global search` = 0 |
| 3 | **No starting point.** Loudest dashboard CTAs are two Turkish PDF downloads; KPIs (vanity) sit above the day's work; REPs get no onboarding; empty workspace = wall of zeros. | High | `MarketingDashboardPage.tsx:66-136`; `KpiGrid.tsx:33-114`; `GettingStarted.tsx:45` (manager-gated) |
| 4 | **Navigation taxonomy scatter.** 14 top-level hubs (2× the ~7 cognitive limit); AI split 3 ways; Reporting has 4 near-synonyms; `/settings/*` URLs don't match the Settings area; Settings is a flat 17-item grab-bag. | High/Med | `navigation.ts:131-271`; `:137,147-149,235-236` (settings-URL scatter); `:252-268` (17 items) |
| 5 | **Cross-page inconsistency.** Two parallel component libraries (one is dead code with different prop APIs); loading/error/filter/empty reinvented per page; `ReportsPage`/`PerformancePage` hardcoded English in a bilingual product. | High | dead `features/marketing/components` PageHeader/EmptyState/StatsCard (0 consumers); `QueryStateBoundary` 0 consumers; ~40 `useQuery` pages ignore `isError` |
| 6 | **Design-system erosion.** Legacy CSS layer from a prior product (QR-menu/kitchen-display, `.card-elevated`/`.glass`) hardcodes white/slate and ignores dark mode; "primary" resolves to two colors; light scrollbars in dark mode; dead `--radius` token. | High/Med | `index.css:406-668`; `tailwind.config.js:50-65` (fixed `primary-50..950`); `index.css:113-131` (scrollbars) |
| 7 | **Onboarding gap.** Register → straight to `/dashboard`, no welcome/tour; onboarding state only in localStorage (not cross-device, not reopenable); primary help is downloadable PDFs. | Med | `RegisterWorkspacePage.tsx:66-80`; `GettingStarted.tsx:18-33,100-103` |
| 8 | **Mobile/interaction friction.** Base `DialogContent` has no max-height/scroll → Save clips off-screen (only 10/89 dialogs fix it themselves); no global quick-create; "Book appointment" is an in-app dead end; tables side-scroll on phones; triple chrome bars; collapsed-rail flag leaks into the mobile drawer. | High/Med | `Dialog.tsx:41-51`; `AppointmentsPage.tsx:110-136`; `DataTable.tsx:82`; `MarketingLayout.tsx:43-50` |

## 5. What we preserve (do NOT rewrite)

- **A real design system**: semantic CSS-variable tokens with light/dark values (`index.css:5-88`), ~50 cva-based primitives, a living kitchen-sink QA page. This is the consolidation target, not a rewrite target.
- **A hub IA with a single source of truth** (`NAV_HUBS` in `navigation.ts`) feeding the rail, sub-nav, settings sidebar, and breadcrumbs.
- **A sound gating engine** (`visibleNav`/`childVisible`) — pure, unit-tested. We extend it with an activation axis rather than replacing it.
- **Excellent deep-linking**: every page/record has a real URL; list filters persist in query params.
- **Good patterns already present but under-used**: `NeedsAttention` (actionable deep links), `GettingStarted` (setup checklist), `EmptyState` with CTA slot, `FilterBar`, `QueryStateBoundary`.

## 6. Decisions (locked with owner) & open questions

**Locked (owner-approved 2026-07-02):**
- **Scope:** end-to-end (landing + registration/onboarding + console + mobile).
- **Feature load:** smart progressive disclosure (role + plan + setup/activation state).
- **Dashboard:** role-aware (REP "your day" vs manager/owner summary + control).
- **Direction & sequencing:** approved — start with focus (Faz 0–1), then IA coherence (Faz 2), with consistency/design-system work (Faz 3–4) woven as the foundation.

**Open (to confirm during each phase's plan):**
- How opinionated the *default* module set is (the "core" for a fresh workspace) — start from the CORE list in §7.1 and refine.
- Whether Faz 2 does a wholesale 14→~7 hub re-bucket or only targeted consolidation of proven synonyms/scatter (spec recommends targeted; progressive disclosure already shrinks the default view).
- Landing: refresh the existing one-page structure vs. a deeper redesign (pending the landing audit; see §7.7).

## 7. The program (workstreams / phases)

The console is the core and carries the most detail; landing, onboarding, and mobile are first-class parts of the end-to-end program. **Each workstream below becomes its own implementation plan** (see §9 decomposition). Effort/impact are from the audit.

### 7.0 Faz 0 — Foundations & quick wins (directly attacks the complaint)
Goal: within days, give the app a starting point and an escape hatch.
- **Command palette (Cmd/Ctrl+K) + header search field.** Index `NAV_HUBS` (reusing `visibleNav` gating) for instant page-jump; add record search (leads/companies/opportunities/tasks) as a second section. Mouse-first entry in `MarketingHeader`. *[M · high]*
- **Global "+ Create" quick action** in the header: lead / task / appointment / note-call, from anywhere. *[M · high]*
- **Dashboard reframe (role-aware v1):** one primary role-aware CTA hero (empty REP → "Add your first lead"; mid-setup manager → "Finish setup"; work waiting → "Review N items"); move `NeedsAttention` + Today above the KPI grid; demote the two PDF buttons into Help; replace zero-walls with `EmptyState` CTAs; add empty guards to `TodaySummary`/`MonthlyMetrics`; give REPs a "your day" block. *[S–M · high]*
- **Base dialog fix:** bake `max-h-[90vh] + overflow-y-auto` into `DialogContent` so every modal scrolls and Save is always reachable. *[S · high]*

### 7.1 Faz 1 — Progressive disclosure (the core fix)
Goal: the default view is the daily core; everything else reveals on demand.
- **Add an activation/setup-state axis** to `NavVisibilityOpts` + `childVisible`/`visibleNav`: hide niche modules (Memberships, Voice/IVR, Custom Objects, Experiments/Surveys, Affiliates, Trigger Links, Agency) until the workspace turns them on or has ≥1 record. *[L · high]*
- **Assign a plan/module key** to the ~30 currently-ungated manager modules so plan tier actually prunes them; expand the `FeatureKey` union beyond 15. *[M · high]*
- **Three-tier sidebar:** CORE pinned + a collapsed "Advanced / More" section + per-user **favorites/pinning** and a menu-density preference. Default visible ≈ 6–8. *[M · high]*
- **"Add features / Explore" catalog page** where an owner opts modules in (in-app feature catalog). *[part of L]*

*Proposed CORE (fresh-workspace default, to refine): Dashboard, Inbox, Contacts (Leads/Companies), Calendar, Sales (Opportunities), Tasks, Reports, Settings, Help. Everything else starts under Advanced/on-activation.*

### 7.2 Faz 2 — IA & taxonomy coherence
Goal: where things live is predictable; URL = breadcrumb = location.
- **Consolidate proven synonyms/scatter:** Reporting's 4 pages (Reports/Ads/Performance/Analytics) → one Reporting surface with internal tabs; a single **AI home** (studio + agents + knowledge); consolidate **Voice** (voice + IVR + telephony/voice-ai settings); merge **Business & Branding + Brand Kit** into one Brand entry.
- **Realign `/settings/*`** so URL, breadcrumb, and visual area agree (move stray settings pages into Settings or give them non-settings URLs).
- **Sub-group the 17-item Settings** into labeled sections (Workspace, Team & Roles, Data model, Integrations, Developer, Billing, Security) with a Developer opt-in.
- **Distinguish section-hubs from single-page hubs** in the rail (expand affordance); **record-name breadcrumbs** on detail pages (e.g. "Contacts › Leads › Acme Corp") instead of a generic "Detail".
- (Optional, owner's call) wholesale 14→~7 hub re-bucket.

### 7.3 Faz 3 — Consistency foundation (feels like one app)
Goal: one set of building blocks, used everywhere.
- **Delete the dead duplicate library** (`features/marketing` PageHeader/EmptyState/StatsCard; remove from barrel) → one canonical `@/components/ui` set.
- **`ListPageShell` scaffold** (PageHeader + FilterBar + query-state boundary + EmptyState + Pagination); migrate list pages (opportunities, appointments, campaigns, products, invoices, orderForms, coupons) onto it.
- **Standardize loading/error/empty**: promote `QueryStateBoundary` into `@/components/ui` (or bake `isError`+Retry into `DataTable`); one skeleton pattern; adopt the shared `FilterBar` everywhere.
- **Localize** `ReportsPage` + `PerformancePage` to stop the TR→EN flip mid-navigation.

### 7.4 Faz 4 — Design-system polish
Goal: one visual vocabulary; dark mode is airtight.
- **Remove the legacy `index.css` utility layer** (`.card-elevated`, `.glass`, `.surface-muted` class, `.text-heading`, `.card-hover`, `.gradient-accent`, `.icon-container*`, QR-menu/kitchen-display/fly-to-cart/badge-bounce). Replace call sites with primitives/token utilities.
- **Resolve the split "primary"**: make the numeric ramp theme-aware or forbid `primary-50..950` in console code; repoint the ~10 files using fixed `primary-600/500` and legacy `ring-primary-500` to semantic `bg-primary`/`ring-ring`.
- **Tokenize scrollbars** for dark mode; make **`--radius` a real token**; consolidate **motion** to one source; add a **lint/CI guard** against raw hex / `bg-white` / off-palette utilities and sweep the ~42 raw `<button>`/18 raw `<input>` toward primitives.

### 7.5 Faz 5 — Onboarding & first-run
Goal: a guided, recoverable, cross-device first-run for every role.
- **Post-register welcome/activation** (modal or `/welcome`): "workspace ready", 2–3 fastest wins (import contacts, connect a channel, invite team), plan expectations — instead of dropping into zeros.
- **REP first-run**: a role-appropriate "here's your day" orientation, not the manager dashboard minus tiles.
- **Server-side onboarding state** + a **reopenable** "Getting started" entry; expand the checklist (Import contacts → existing `/settings/import`; Invite team); keep users in-context (side panel / return-to-checklist).
- **Guided tour / coach marks** through the hub nav and 3–4 core pages.
- **Wire Help into empty states** and checklist steps; surface Help beyond a single bottom-of-sidebar item; reduce reliance on PDFs (and localize/remove the hardcoded Turkish guide PDFs).

### 7.6 Faz 6 — Mobile & interaction depth
Goal: usable in the field on a phone.
- **Responsive card/stacked layout** for `DataTable` below `md` (label:value rows) so leads/appointments are scannable, not side-scrolled.
- **Collapse mobile chrome**: fold the hamburger into `MarketingHeader` (drop the hamburger-only bar); force the drawer to render **expanded/labelled** regardless of the persisted desktop-collapsed flag.
- **"Book appointment" in-app entry** on `AppointmentsPage`; first-class **"Log call"** quick action on a lead (prefilled `type=CALL`, tied to the webphone) instead of the generic Add-Activity modal.
- **Audit modal-on-modal** pages (companies, automations, installations) → prefer a stepper or side Sheet that preserves context.
- (The base dialog scroll fix ships in Faz 0.)

### 7.7 Landing / public site (end-to-end scope)
Goal: a visitor understands what Jeeta is, for whom, with one obvious next step and real reasons to trust it.
Current state (landing audit): `LandingPage` → Hero → FeatureGrid → HowItWorks → Highlights → FAQ → FinalCta → Footer. **Strong bones**: excellent bilingual parity (132 `landing.*` keys in both `tr` and `en`, verified), clean mobile adaptation (hamburger nav, stacking grids), a clean heading outline + skip-link, and a light palette whose `primary-600` (`#4f46e5`) exactly matches the console's light `--primary`, so signup → app feels continuous. The gaps are conversion and discoverability, not structure.
Highest-impact fixes:
- **Add real social proof + a "who it's for" line.** The page has *zero* third-party trust (no logos, testimonials, ratings, or credible metrics) — the single biggest missing conversion lever. Add a proof band (logos + 2–3 testimonials + one metric) between Highlights and FAQ, and an audience clause in the hero/badge ("for SMBs, sales teams & agencies"). *[M · high]*
- **Fix SEO/meta.** `index.html` serves a hardcoded **Turkish** `meta description` + all `og:*` under `<html lang="en">`, with no per-locale head management (only `document.title` is set in JS), no JSON-LD, no canonical/og:url/hreflang, and a tiny-icon OG image. Add locale-aware `<head>` (react-helmet-async or prerender) so description/OG follow TR/EN and match `lang`; add JSON-LD (`Organization` + `SoftwareApplication`), canonical/og:url/hreflang, and a proper 1200×630 OG card. *[M · high, cheap reach]*
- **Cut hero→signup friction + tame FeatureGrid.** The sole primary CTA drops users straight into a 6-required-field register form, contradicting the "set up in minutes / no credit card" promise. Reduce step 1 to email/workspace (defer the rest into onboarding — ties directly into Faz 5) or add social sign-up, and add a lighter secondary path (pricing anchor or "Book a demo"). Lead with 3–4 benefit pillars and collapse the 16-item FeatureGrid behind a "See all modules" disclosure so the landing stops mirroring the console's "everything everywhere." *[M · high]*
- **Lower-priority polish:** sharpen the h1 toward an outcome; echo one Highlights deep-dive above the dense grid; keep a compact primary CTA in the mobile bar; link GDPR/KVKK to a trust page.
> Isolated surface — will be planned/executed as its own sub-project (can run in parallel with console phases). The signup-friction fix is shared with Faz 5.

## 8. Sequencing & rationale

Faz 0 first because it attacks the actual complaint (starting point + escape hatch) at low risk and high visibility. Faz 1 is the structural core (the reduction lever the product lacks). Faz 2 makes *where things live* predictable. Faz 3–4 are the consistency/visual foundation that make it feel like one app — woven in as capacity allows (some Faz 3 cleanup, e.g. deleting the dead component library, can land alongside Faz 0). Faz 5–6 and Landing complete the end-to-end journey. Order can be adjusted per owner priority; Faz 0 → Faz 1 is the recommended spine.

## 9. Decomposition (each workstream → its own plan)

This program is too large for a single implementation plan. This spec is the decomposition. Each Faz gets its own `docs/superpowers/plans/…` implementation plan and its own build/review cycle, in this default order: **Faz 0 → Faz 1 → Faz 2 → Faz 3 → Faz 4 → Faz 5 → Faz 6 → Landing** (Faz 3's dead-code deletion may be pulled forward alongside Faz 0). Landing may be audited and planned in parallel since it's an isolated surface.

## 10. Risks & mitigations

- **Hiding a feature a user needs** (progressive disclosure). → Always pair with Cmd/Ctrl+K (reaches everything) + the "Add features / Explore" catalog; never gate on state without an un-hide path.
- **Route/area realignment breaks deep links** (Faz 2). → Keep old URLs as redirects; change presentation before URLs; do URL moves in one deliberate, tested batch.
- **Consolidation churn / re-learning** (Faz 2/3). → Prefer targeted consolidation of proven synonyms over wholesale re-bucketing unless the owner opts in; ship behind the same single-source-of-truth `NAV_HUBS`.
- **Design-system cleanup regressions** (Faz 4). → Lean on the kitchen-sink QA page; lint guard prevents backsliding; migrate call sites incrementally.
- **Scope sprawl** (end-to-end). → Strict per-phase plans, each independently shippable and reviewable.

## 11. Validation

Each phase's plan defines its own tests. Program-level: re-run the 8-dimension UX audit after Faz 1 and Faz 2 to confirm the default-visible count, findability, and consistency metrics in §2 actually moved; manual walkthroughs on desktop + phone for the core create flows.
