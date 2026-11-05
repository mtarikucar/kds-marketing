# Jeeta panel refinement

The Rust panel is the current staging/yeni product. This change targets its shared visual system,
public account screens, navigation and home; other feature pages inherit the shared styles.
The legacy Node frontend is unchanged.

The existing navy, blue and orange identity stays. Light surfaces, tighter type hierarchy, quieter
cards and grouped navigation reduce competing containers. The home page puts actionable work
before workspace metadata; permissions remain available in a disclosure. Strategy and agent controls
share a secondary column. Public account screens explain the product beside a focused form.

Guidance: [frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md).
Screenshots below use a real local Rust API and a disposable development workspace; they contain no
production data. Desktop: 1440 × 1000; mobile: 390px. Local registration, login and navigation were
verified, along with Turkish/English locale parity and dark/light layout.

![Account screen](login.png)
![Home](home.png)
![Mobile home](home-mobile.png)

For promotion, see [the staging/yeni release instructions](../../operations/jeeta-panel-release.md).

## Owner-supplied brand direction

The owner supplied the official rising-J logo and voxel mascot. The placeholder initial is now the
actual logo, including the browser icon. A newly generated welcoming mascot pose anchors the
account screen; responsive transparent WebP assets are 55/98 KB. A small original SVG appears only
when the pending queue is empty. These are integrated brand assets, not mockups or screenshots of UI.

After this asset pass, all 29 focused home, shell, authentication and locale tests passed. The real
local Rust API sign-in and navigation smoke also passed. Asset details: `rust/panel/public/brand/README.md`.
