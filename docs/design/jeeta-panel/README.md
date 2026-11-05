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
