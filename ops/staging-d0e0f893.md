# Staging release d0e0f893

Published to https://staging.jeetagrowth.com on 2026-11-11 at 05:31:53 UTC. This is a staging-only release.

- Source: `d0e0f893f2a6cfa2bb763735b303df41c89f24c7` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42962669127 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42966232377 — candidate checks and staging publication succeeded.
- Artifact ID: `13830391323`; archive SHA-256: `6de99ec629f3235ce7d6e525aa45006b20123d037ce0c4558b331a2f03bef3be`.
- Publication workflow revision: `c8c777d8`; operator script SHA-256: `57d114b8bb2794f77ecea879cf903ab7be5a3c91fdfc09f534e3f551450af9da`.
- Previous staging revision: `7891020bb3f88c4db0b52185213d26465d6db1ac`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-d0e0f893-staging-20261111T053129Z-Iy6HBb`.

One change to the server, found while preparing the first real ad campaign on staging. The Meta adapter sent every call on its default Graph version `v19.0`, which Meta no longer serves; Meta's Marketing API versioning page says a call on such a version "may fail or be upgraded to the next available version". The ad calls of release 7891020b were written against Marketing API v27.0. Calls on an ad account and on what belongs to one (its campaigns, ad sets, ads, creatives, previews, insights, lead forms; listing and probing ad accounts) now go out on `v27.0`, or on a newer version when `JEETA_META_GRAPH_VERSION` names one. Every other Meta call (posting, messages, comments, Page and Instagram metrics) is unchanged. The rest of the difference from 7891020b is documentation.

The operator script is the one that published 7891020b without what was specific to migrations 33 to 40. Before anything was stopped it checked that the database holds exactly migrations 1 to 40 with the candidate's checksums and that the candidate would apply none. It then backed up the database, the file store and the environment, restored the recovery copy on its own, and started the candidate against that copy with jobs off and outside networking blocked. On the restored copy every table kept its row count through the candidate's start, the migration records stayed as they were, and the two tenant tables of the module split force row-level security. After the swap the installed artifact tree, schema 40 and readiness were verified. A release without a migration leaves no trace in the database, so the script also says which binary serves: `/opt/jeeta/releases/d0e0f893f2a6cfa2bb763735b303df41c89f24c7/jeeta`.

Validation after publication, from outside:

- All 35 published panel assets match the verified artifact (the panel is identical to 7891020b's); eight routes load the published page; readiness succeeds.
- Without a session the API and the MCP endpoint answer 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.

Report: [public integrity](staging-d0e0f893-public.json).

What this release does not show. The version change has been tested against the in-process Graph mock only; no call has been made to Meta, on this version or any other. Nothing was checked signed in on staging. Everything release 7891020b's record says it does not show still holds: the first real ad campaign is the owner's, on their own ad account, with a small budget and their explicit approval at that moment; leaving a ready post with Facebook's own scheduler is off by default; a strategy approved before 7891020b posts nothing until it is submitted again. No external message, post, ad or device action was performed during verification.
