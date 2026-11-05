# Jeeta panel workbench

Jeeta's Rust panel now treats customer correspondence, daily work and configuration as different
kinds of screens. Inbox uses a joined queue/correspondence/follow-up layout; Studio uses a daily
work sheet; prospects, capabilities and campaigns use ledgers and working briefs. Shared type,
spacing, neutral surfaces and navigation connect them without giving every section the same card.

The latest pass applies [Unslop by Damir Sokolovsky (@heydamir)](https://github.com/heydamir/unslop),
CC BY 4.0. See [the audit, direction and nine-pass report](unslop.md) for the design decisions.
The owner's logo and mascot remain; IBM Plex Sans is self-hosted with its OFL included in releases.
[Asset provenance and licenses](brand-assets.md) describe the files.

The screenshots below use a disposable local Rust workspace or synthetic API fixtures. They
contain no production customer data. Desktop width is 1440px; mobile width is 390px.

![Customer conversation](inbox.png)
![Home work list](home.png)
![Growth studio](studio.png)
![Mobile conversation](inbox-mobile.png)
![Account screen](login.png)
![Setup checklist](onboarding.png)
![Prospect ledger](prospects.png)

## Functional evidence

Current validation: **64 suites / 446 tests**, TypeScript and the production build pass.
The build retains its existing large-chunk advisory.

The prior [screen and state inventory](audits/coverage.md) covers the 38 page/fallback patterns,
platform redirect, nested tabs and conditional states. Its [recorded results](audits/results.json)
contain 693 historical module/viewport executions, not 693 distinct screens. They document
loading/error recovery, permission variants, long content, mobile overflow, keyboard behavior and
forms. Those counts belong to the previous review; current visual evidence is the refreshed gallery.

The [browser fixtures](../../../rust/panel/design-review/README.md) reproduce synthetic states.
They complement component tests and do not test live message delivery, payments, providers or
telephony. Real provider credentials are not present in the development workspace.

This work targets the modern Rust product intended for staging/yeni. The legacy Node frontend and
live site are unchanged. See [release and promotion instructions](../../operations/jeeta-panel-release.md).
