# Staging release afe69bd4

Published to https://staging.jeetagrowth.com on 2026-11-10 at 09:44:30 UTC. This is a staging-only release.

- Source: `afe69bd490dd0555e403b6c2e165d8684839a87a` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42790342595 — all nine jobs passed, including 4,016 Rust workspace tests and 526 panel tests.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42790984350 — candidate checks and staging publication succeeded.
- Artifact ID: `13751363542`; archive SHA-256: `2a2f137cc4a2850c3861d537fdaee976513eb8f1a4ed7a597dc7a7854b1259e0`.
- Publication workflow revision: `9f55abf5889513a99335de0caca3627137c213fe`; operator script SHA-256: `487b99f4fbd1340616f8493ecc4f6eea7e4bd459053139eb89b64bd8ac4baeca`.
- Previous staging revision: `e7b495a08443a67876947fabaf4a61a2dfee551b`; database schema advanced from 31 to 32.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-afe69bd4-staging-20261110T094405Z-M3PjLf`.

The home screen is now an agent hub, and the sidebar follows installed work modules. Inbox and Strategy remain required. Other modules can be added or removed through the blueprint catalog. Custom disciplines use portable declarative blueprints, with an editable brief, agent assignments, workflow descriptions, and capability bindings. The ability inventory supports services, phones, computers, peripherals, and custom records. Existing operational work remains under **İşler ve onaylar**.

Migration 32 adds a tenant-isolated module registry. Existing workspaces retain their previous modules; new workspaces begin with Inbox and Strategy. Required modules are protected server-side, stale configuration writes are rejected, and HTTP/MCP use the same workspace and permission boundaries. Catalog, gate, and schema test contracts include the new module tools and table; CI now completes all workspace test suites before reporting failures.

Before publication, the operator backed up the database, FileStore, and environment; independently restored the recovery copy; and booted the candidate against it with jobs disabled and external networking blocked. The rehearsal preserved original table counts, verified migration checksums and forced row-level security on all four relevant tables, and checked the legacy registry seed. The complete installed artifact tree, schema 32, and readiness were verified after publication.

Validation after publication:

- Existing demo sign-in succeeded. All seven legacy modules remain installed, and the API rejects removal of Inbox and Strategy.
- Created a custom blueprint in the browser, registered a temporary scoped MCP client, and persisted its assignment together with an inert custom ability and brief.
- Confirmed stale-write rejection, unknown-binding rejection, and authenticated MCP reads of the assigned module.
- Exported a portable blueprint without workspace assignments; removed and reinstalled it while preserving its configuration and ability record.
- Removed the test module, retired the inert ability, revoked the temporary API key, and confirmed immediate 401 rejection afterward. Historical blueprint, agent, and retired ability records remain; no active test key or installed test module remains.
- All nine functional scenarios passed. Thirty rendered general views at 1440 and 390 pixels, plus mobile navigation, passed with no runtime exceptions, API failures, unexpected business writes, horizontal overflow, or broken images. Representative desktop hub/catalog and mobile settings captures were visually inspected after loading completed.
- All 35 published panel assets match the verified artifact; eight public routes load, readiness succeeds, and unauthenticated API access returns 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their pre-release values.

Reports: [browser](staging-afe69bd4-browser.json), [module workflow](staging-afe69bd4-functional.json), [public integrity](staging-afe69bd4-public.json).

Blueprint installation and assignment describe work; they do not execute code, grant permissions, issue credentials, start agents, or implement unsupported integrations. Removing a module preserves data, bindings, and existing jobs/schedules. Agent last-contact records do not guarantee a live worker. This release does not enable a persistent model worker or verify automatic model inference. No external messages, real device actions, or social publications were performed during verification.
