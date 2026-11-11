# Staging release 7891020b

Published to https://staging.jeetagrowth.com on 2026-11-11 at 04:33:03 UTC. This is a staging-only release.

- Source: `7891020bb3f88c4db0b52185213d26465d6db1ac` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42957581297 — all nine jobs passed, including 4,357 Rust tests and 655 panel tests.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42959866235 — candidate checks and staging publication succeeded.
- Artifact ID: `13828310895`; archive SHA-256: `22726f19af1630b576de6a2ba25acc79e80d73198799fa04963ab3b1821a711c`.
- Publication workflow revision: `16fe6aca47927ca13bd693cd723d14d826cb4418`; operator script SHA-256: `57515fa07dbf0e0a253c5eb1f6ff8415dc6294814618dd5d6071b207b89417ae`.
- Previous staging revision: `afe69bd490dd0555e403b6c2e165d8684839a87a`; database schema advanced from 32 to 40.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-7891020b-staging-20261111T043238Z-A80AI6`.

The single growth studio module is now three: content creation, social media management and ad management, over a shared materials library. Agents do the work. A connected agent takes a production area, makes its own visual and delivers a content package the server checks before accepting; a finished version is given an account and a time; an ad campaign is opened by a person or proposed by an agent, planned by an agent and built in the connected ad account, created paused and then activated. Nobody approves content or a post. What limits spend is money: a general ad budget, each module's spend on the budget page and stop switches that refuse a module's spend at one gate. The home page, the inbox and the prospect pool are redesigned, and commissions are removed.

Migrations 33 to 40: 33 drops the three commission tables; 34 replaces the growth studio registry entry with the four modules that take its place; 35 splits the studio permissions by module; 36 to 40 add production areas, social accounts, the move of lane approval to connections, the general ad budget and ad campaigns. Every migration has its `down`. The `down` of 33 rebuilds the commission tables empty; it does not bring rows back.

Before publication the operator script counted the rows of the three commission tables and refuses to go on unless they are empty. They were: `0|0|0`, so migration 33 removed no record. It then backed up the database, the file store and the environment, restored the recovery copy on its own, and booted the candidate against that copy with jobs off and outside networking blocked. On the restored copy it counted the commission rows again after the service stopped, compared every other table's row count with the original, checked the migration checksums, forced row-level security on the two new tenant tables, that the commission tables and the growth studio entry are gone, that every workspace kept its module registry with the split carried over, and that no old studio permission is left. The installed artifact tree, schema 40 and readiness were verified after the swap.

Validation after publication, from outside:

- All 35 published panel assets match the verified artifact; eight routes load the published page; readiness succeeds.
- Without a session the API answers 401, on the routes that existed and on the new ones for ad campaigns and social accounts, and the MCP endpoint answers 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their pre-release values.

Report: [public integrity](staging-7891020b-public.json).

What this release does not show. Nothing was checked signed in on staging for this release: no existing account was used and none was created. The panel was reviewed before the release against fixtures (23 scenarios at 1440 and 390 pixels) and the server against a local database, not on staging. The calls to Meta follow Meta's documented shapes and have been tested against a scripted provider and an in-process Graph mock; none has been run against Meta. The first real ad campaign is the owner's, on their own ad account, with a small budget and their explicit approval at that moment. Leaving a ready post with Facebook's own scheduler is a workspace setting that is off by default. A strategy approved before this release posts nothing until it is submitted again, because the posting cadence is written at submission. A workspace without a verified message channel sees the inbox locked. Sending a first message from the prospect pool reaches a real e-mail or SMS provider and was not tried against one before the release; the first real send should be watched. No external message, post, ad or device action was performed during verification.
