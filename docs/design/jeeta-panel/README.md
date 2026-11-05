# Jeeta panel refinement

The Rust panel is the current staging/yeni product. This change targets its shared visual system,
public account screens, navigation, home and the working product surfaces.
The legacy Node frontend is unchanged.

The existing navy, blue and orange identity stays. Light surfaces, tighter type hierarchy, quieter
cards and grouped navigation reduce competing containers. The home page puts actionable work
before workspace metadata; permissions remain available in a disclosure. Strategy and agent controls
share a secondary column. Public account screens explain the product beside a focused form.

The inbox separates the queue, customer conversation and journey. Calls gain direction filters;
prospects and campaigns distinguish an empty workspace from an empty filtered result, with a clear
recovery action. Studio uses a wider Today section beside the plan, with evidence and history below.
Strategy, materials and posts use document sections and focused forms instead of repeated cards.
Setup is a numbered checklist with a second mascot pose. Team, billing, connectors, budgets, logs
and platform administration share quieter tables, forms and empty states.

Guidance: [frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md).
Screenshots below use a real local Rust API and a disposable development workspace; they contain no
production data. Desktop: 1440 × 1000; mobile: 390px. Local registration, login and navigation were
verified, along with Turkish/English locale parity and dark/light layout. People, conversations,
strategy and budget examples are synthetic local fixtures. Jobs and external integrations remain
disabled in this development workspace.

![Account screen](login.png)
![Home](home.png)
![Mobile home](home-mobile.png)
![Setup checklist](onboarding.png)
![Customer conversation](inbox.png)
![Mobile conversation](inbox-mobile.png)
![Growth studio](studio.png)
![Prospects empty state](prospects.png)

For promotion, see [the staging/yeni release instructions](../../operations/jeeta-panel-release.md).

## Owner-supplied brand direction

The owner supplied the official rising-J logo and voxel mascot. The placeholder initial is now the
actual logo, including the browser icon. A newly generated welcoming mascot pose anchors the
account screen; responsive transparent WebP assets are 55/98 KB. A small original SVG appears only
when the pending queue is empty. The setup mascot adds a second generated pose (39 KB); nine original
SVG scenes cover meaningful empty states across the product. These are integrated brand assets,
not mockups or screenshots of UI.

Verification: all 62 panel suites / 418 tests pass, as do TypeScript and the production build.
The release packager's 17 regression tests pass, and its generated-panel inventory accepts the
rebuilt output. Brand documentation lives here rather than under public assets, so Vite does not
copy Markdown into the release package.

Browser checks covered 27 routes at 1440px and 390px against the local Rust API. No page errors,
broken visible images or server errors were observed. The three wide table pages were rechecked
after fixing their mobile overflow: ledger, budget and distribution now measure 390px document
width, with horizontal scrolling inside their table containers. Account, home, setup, conversation
and studio screenshots were visually reviewed; setup, inbox and studio were also checked in dark
mode. Asset details: [brand-assets.md](brand-assets.md).
