# Frontend Redesign — Design Spec

**Date:** 2026-06-15
**Status:** approved-by-controller (autonomous goal — user delegated all decisions; review gate waived)
**Scope owner:** decisions in this doc are controller-made per the `/goal` "tüm kısımları kendin tamamla".

## Goal

Completely redesign the `kds-marketing` frontend into an **original, modern B2B
SaaS / CRM dashboard** — a cohesive design system, accessible component library,
dark mode, and an architecture that satisfies the full engineering-principles
checklist (SOLID, DRY, KISS, YAGNI, SoC, composition, typed API layer, RBAC,
testing, code-splitting, a11y, responsive). The redesign is **visual +
structural + quality**, not a product-feature or backend change.

## Hard constraints (non-negotiable)

- **Live production system** (`marketing.hummytummy.com`). All work on the
  `feat/frontend-redesign` branch. **No production deploy** until the user
  explicitly signs off — the redesign is outward-facing and must not auto-ship.
- **Preserve all behavior**: every route, the two auth realms (marketing tenant
  vs platform superadmin), JWT + single-flight refresh, RBAC (OWNER>MANAGER>REP),
  entitlement gating, i18n (en/ar/ru/tr/uz) **including RTL**, and every API
  contract stay exactly as they are. No backend edits.
- **Stay green at every commit**: `tsc --noEmit`, `vite build`, and `vitest` must
  pass before each commit. The app must run after every phase.
- **No regressions in bundle health**: route-level code-splitting must land so the
  redesign does not inflate the initial bundle.

## Current-state baseline (from exploration)

Already solid: feature-based layout (`features/marketing`, `features/platform`),
TanStack Query v5 (30s stale, global `QueryCache.onError`→Sonner), Zustand auth
(sessionStorage, per-tab isolation, in-memory access token), Axios with
single-flight refresh, RHF+Zod (partial), strict TS, Vite manual chunks, i18n.

Gaps the redesign fixes:
1. **Design inconsistency** — `gray-*` vs `slate-*` vs `primary` mixed; ~30 pages
   carry ad-hoc inline Tailwind instead of shared components. UI kit is only 5
   atoms (Button/Card/Badge/Skeleton/Spinner).
2. **No dark mode**; `Outfit` heading font referenced but never loaded.
3. **A11y holes** — modals lack `role="dialog"`/`aria-modal`/focus-trap; form
   inputs missing `htmlFor`/`id` pairing; no skip link; ad-hoc dropdowns.
4. **No route-level lazy loading** — every page statically imported.
5. **Form inconsistency** — RHF+Zod in some pages, manual `useState`+`zod.parse`
   in others (Offers, Tasks, Login, Register).
6. **No typed API layer** — raw `axios` calls inline in components.
7. **Near-zero FE tests** — 2 pure-logic unit tests; no component/integration/E2E.

## Design language (original — "Console" system)

A confident, calm, information-dense CRM aesthetic. Distinctive via an **iris**
brand accent + **warm amber** secondary, true dark mode, and a geometric display
face. All values are CSS variables; light + dark are first-class.

### Color tokens (semantic; pinned hex → become CSS vars)

**Light**
| token | value | use |
|---|---|---|
| `--background` | `#FBFBFC` | app canvas |
| `--surface` | `#FFFFFF` | cards/panels |
| `--surface-muted` | `#F4F5F7` | subtle fills, table headers |
| `--surface-raised` | `#FFFFFF` | popovers/modals (+ shadow) |
| `--border` | `#E7E8EC` | hairlines |
| `--border-strong` | `#D5D7DE` | inputs, dividers |
| `--foreground` | `#14151A` | primary text |
| `--muted-foreground` | `#5B5E68` | secondary text |
| `--primary` | `#4F46E5` | brand (iris-600) |
| `--primary-hover` | `#4338CA` | brand hover |
| `--primary-foreground` | `#FFFFFF` | text on brand |
| `--accent` | `#F59E0B` | warm highlights (amber) |
| `--ring` | `#4F46E5` | focus ring |
| success `#059669` / warn `#D97706` / danger `#E11D48` / info `#0284C7` | + `-subtle` bg + `-foreground` for each |

**Dark**
| token | value |
|---|---|
| `--background` | `#0B0C11` |
| `--surface` | `#12131A` |
| `--surface-muted` | `#171922` |
| `--surface-raised` | `#1B1D27` |
| `--border` | `#262936` |
| `--border-strong` | `#343847` |
| `--foreground` | `#ECEDF1` |
| `--muted-foreground` | `#9498A6` |
| `--primary` | `#6E68F2` (lifted iris) |
| `--primary-hover` | `#837CF6` |
| `--accent` | `#FBBF24` |
| success `#10B981` / warn `#F59E0B` / danger `#FB7185` / info `#38BDF8` (lifted) |

Categorical data-viz ramp (charts/badges): iris, emerald, amber, rose, sky,
violet, teal, slate — defined as `--chart-1..8`.

### Typography

- **Body/UI:** Inter (variable, `font-display: swap`), default **15px** (CRM
  density). Tabular numbers (`font-feature-settings: "tnum"`) for tables/money.
- **Display/headings:** **Outfit** (geometric), loaded properly (fixes the gap).
- **Scale (rem / px / weight):** display 2.25/36/700 · h1 1.75/28/700 ·
  h2 1.375/22/650 · h3 1.125/18/600 · body-lg 1.0625/17 · body 0.9375/15 ·
  sm 0.875/14 · caption 0.8125/13 · micro 0.75/12 (uppercase label, +0.04em).

### Spacing / radius / elevation / motion

- 4px base scale. Page padding `p-4` mobile / `p-6` desktop; content `max-w-[1440px]`.
- Radius: `--radius` 10px; sm 6 · md 8 · lg 10 · xl 14 · 2xl 20 · full.
- Elevation: 5-step subtle layered shadows; dark mode uses lower alpha + ring.
- Motion tokens: fast 120ms · base 180ms · slow 240ms; standard easing
  `cubic-bezier(.2,.8,.2,1)`; **honor `prefers-reduced-motion`**.

### Iconography

Standardize on **Lucide** (1.5px stroke, consistent). Migrate Heroicons usages to
Lucide during page migration; remove `@heroicons/react` in Phase 6.

### Theming mechanics

`.dark` class on `<html>`; a `useThemeStore` (Zustand, persisted in
**localStorage**, not sessionStorage — theme is a device preference) with
`system | light | dark` and a `matchMedia` listener for `system`. Theme toggle in
the header. RTL (`dir`) already handled by i18n; all new components are
logical-property / RTL-safe.

## Component library (Radix-based, `components/ui/`)

**Decision:** build on **Radix UI primitives** (unstyled + accessible) styled with
Tailwind, variants via **class-variance-authority (cva)**. This is the single
highest-leverage choice: it delivers Accessibility (focus management, ARIA,
keyboard, dismissables) and Reusable Components/Composition without reinventing
a11y. Data grids use **@tanstack/react-table** (headless) for the CRM lists.

New deps: `@radix-ui/react-{dialog,dropdown-menu,popover,tooltip,tabs,select,checkbox,switch,radio-group,accordion,scroll-area,separator,label,avatar,slot}`,
`class-variance-authority`, `@tanstack/react-table`, `react-day-picker` (date
picker), `next-themes`-style logic done in-house (no Next). Keep `clsx`,
`tailwind-merge`, `sonner`, `lucide-react`. **Drop** `@heroicons/react` (Phase 6).

Inventory (each: typed props, cva variants, a11y, dark-mode, RTL, test):

- **Primitives:** Button, IconButton, Link, Kbd, Spinner, Skeleton, Separator,
  ScrollArea, VisuallyHidden, Avatar/AvatarGroup.
- **Forms:** Field (label+control+hint+error wrapper, RHF-aware), Input, Textarea,
  Select, Combobox, Checkbox, RadioGroup, Switch, Slider, DatePicker, FormError —
  all wired for `react-hook-form` + Zod.
- **Overlays:** Dialog/Modal, Sheet/Drawer, Popover, DropdownMenu, Tooltip,
  ConfirmDialog (composed), Toast (themed Sonner).
- **Containers:** Card (+Header/Title/Content/Footer), Tabs, Accordion, Callout/Alert,
  Badge, Tag, SegmentedControl, Progress, StatCard/KPICard.
- **Data:** DataTable (sortable/paginated/empty/loading, @tanstack/react-table),
  Pagination, EmptyState, Table primitives.
- **App primitives:** PageHeader (title/desc/breadcrumbs/actions), FilterBar,
  Breadcrumbs, ThemeToggle, LanguageSwitcher.

Out of scope (YAGNI): command palette, context menus, charts library swap,
realtime presence, per-tenant theming beyond existing branding.

## Architecture standards (maps the principles checklist)

- **SoC / Component Architecture / Composition:** pages stay thin (routing +
  composition); logic lives in feature hooks; UI in primitives. Split files >~300
  lines (LeadDetail 743, Installations 594, Offers 580…) into focused units.
- **API Layer + DTO/Model:** per-feature typed service modules
  (`features/<f>/api/*.ts`) returning typed models; Zod schemas validate at the
  transport seam; React Query hooks (`features/<f>/queries/*`) wrap services. No
  raw axios in components.
- **Server vs Client state:** React Query = server; Zustand = auth + theme + UI
  shell prefs only. No server data in Zustand.
- **Forms:** **all** forms on RHF + Zod via `<Field>`; delete manual `useState`
  forms (Offers, Tasks, Login, Register).
- **Routing / Protected Routes:** keep guards; add **route-level lazy loading**
  (`React.lazy` + `<Suspense>` with skeleton) → Code Splitting / Bundle Size.
- **Error/Loading/Empty states:** standardize via `QueryStateBoundary`,
  `EmptyState`, `Skeleton`; error boundary per route retained.
- **Memoization / re-render:** memoize table rows/cells, stable callbacks, split
  contexts; only where measured to matter (KISS — no premature memo).
- **Security / JWT / RBAC:** unchanged logic, surfaced via `<RoleGate>` /
  `<FeatureGate>` components for declarative gating in UI.
- **TypeScript:** strict stays; shared types in `features/<f>/types`, DTOs vs
  domain models separated where they diverge.
- **Testing:** Vitest + jsdom + @testing-library/react + user-event. Component
  tests for every UI primitive (variants, roles, keyboard); integration tests for
  guard + one form happy/error + a filtered list; **Playwright** smoke E2E
  (login→dashboard→navigate→theme toggle) in Phase 6.
- **CI/CD:** extend the frontend CI job to run the new tests + (optional)
  Playwright; jsdom env added to vitest config.

## Decomposition (6 phases, each = its own plan → subagent-driven build)

1. **Design System Foundation** — deps, tokens (light+dark CSS vars), tailwind
   config rewrite, theme store + toggle, fonts, full `components/ui` library + cva
   + tests. No page changes (additive). _Gate: build green, primitives tested._
2. **App Shell & Navigation** — Sidebar (collapsible rail + mobile drawer),
   Header (breadcrumbs, notifications, theme/lang/user menus), MarketingLayout,
   new PlatformLayout, PageHeader/FilterBar adoption. Pages render unchanged
   inside new chrome.
3. **Core CRM pages** — Dashboard, Leads (list+detail+create/edit), Tasks,
   Calendar, Offers — migrated to the system + DataTable/Field; manual forms →
   RHF+Zod; large files split.
4. **Remaining marketing pages** — Users, Targets, Performance, Reports, Calls,
   Commissions, Installations, Billing/Invoices, and growth/settings (Channels,
   Agents, Knowledge, Automations, Campaigns, Sites, Booking, Reviews, Voice,
   Research, Branding, Inbox).
5. **Platform realm + auth/widget** — PlatformLayout adoption across platform
   pages; redesign Login/Register/Platform-login/Widget.
6. **Architecture & quality hardening** — route lazy-loading everywhere, typed API
   layer sweep, a11y audit (axe), remove Heroicons, bundle check, integration +
   Playwright E2E, CI wiring, perf memoization pass.

## Migration strategy

Additive-first: Phases 1–2 introduce the system without breaking pages; Phases
3–5 migrate area-by-area, each area its own commit, app green throughout; Phase 6
hardens. Every page keeps its route, data, and behavior — only presentation,
forms-plumbing, and structure change. Each phase ends with `tsc && build && test`
green and a conventional commit. **Deploy is held for explicit user sign-off.**

## Testing strategy (summary)

- Unit/component: all `components/ui` primitives.
- Integration: protected-route guard; one RHF+Zod form (happy + server-error);
  one DataTable filter flow.
- E2E (Playwright, Phase 6): login → dashboard → navigate → dark-mode toggle.
- Keep existing pure-logic tests (`navigation`, `money`).

## Out of scope (YAGNI)

Backend/API changes; new product features; new languages; command palette;
charting-lib swap; realtime; auth-mechanism changes; CMS/per-tenant theming
beyond current branding. These are explicitly deferred.
