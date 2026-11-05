# Work organized by purpose

This iteration changes the workflows of Calls, Capabilities, Strategy and Growth Studio. It follows the owner's request for functional improvements, more classification and less scrolling. It adapts [Unslop by Damir Sokolovsky](https://github.com/heydamir/unslop/blob/main/skills/unslop/SKILL.md), CC BY 4.0, while keeping Jeeta's existing typography and restrained navy/graphite palette.

## Decisions

The previous screens exposed almost every setting at once. A capability could occupy several hundred pixels before the next account appeared; call policies followed the entire call history; strategy sections and Studio work views accumulated vertically. The new composition puts the current task first and makes supporting information selectable.

- Capabilities: six purpose categories plus All, covering every existing kind group. Connections, account groups and technical settings are separate tabs. Search and attention/status filters combine with purpose and type. Each page contains up to eight compact account rows; details expand in place. Existing connect/reconnect/probe actions stay directly accessible. Purpose-specific links preselect an existing connector kind; unsupported integrations are not presented as ready to connect. Technical hooks are fetched only when their authorized tab opens. The device purpose retains heartbeat refresh; pairing setup opens deliberately.
- Calls: open calls and ended calls awaiting an outcome form distinct queues. Search matches the masked number, extension and summary, and combines with direction. Ten rows per page limit list height; counts explicitly refer to loaded records. Call settings occupy a separate authorized tab and retain a draft after first opening. The settings API is not read before that tab opens.
- Strategy: Brand and audience, Goals and plan, Hypotheses, and Consultation show one category at a time. The server's first missing field opens its category and appropriate editor, respecting read-only permissions. Unsaved inputs survive category changes; saves are explicit.
- Studio: Today, Plan, Learned and Ledger show one work view at a time, with a compact strategy aside. The selected view can be linked using the `section` query parameter. Selecting a planned item opens its editor in Today. Filters reset together, invalid date intervals cannot issue overview requests, and planned items are ordered by time.

This UI work does not change server APIs, existing strategies, credentials, connected providers or external messages. New connector buttons continue through the existing connection and authorization flows.

## Evidence

The initial full panel run passed 454 of 465 tests. The remaining 11 phone tests assumed expanded details and a permanently visible type filter; their interaction setup was updated without removing polling, permission, command, one-time credential display, signed-URL or stale-data assertions. All 11 then passed. The final focused run passed 119 tests in nine files, including localization parity and all four changed page flows. TypeScript and the production Vite build passed; Vite retains its existing large-chunk advisory.

Synthetic browser checks cover 1440px and 390px viewports, purpose filtering, details, connector links, call queues and pagination, strategy editing, Studio view navigation, and keyboard navigation. No runtime errors or horizontal overflow remained in the reviewed states. These are fixture-based checks, not evidence that every external provider integration works.

The example strategy draft's default height fell from 2407 to 1173px on desktop and from 3153 to 1613px on mobile. Compact capabilities show seven sample accounts in roughly 1082px on desktop and 1525px on mobile. Heights depend on content and expanded details.

Review gallery: `/workspace/jeeta-is-akisi-onizleme/index.html`. This iteration is prepared in the working branch; it has not been deployed to staging or production.
