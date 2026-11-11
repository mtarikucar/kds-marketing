# Staging release fa2da400

Published to https://staging.jeetagrowth.com on 2026-11-11 at 06:14:10 UTC. This is a staging-only release.

- Source: `fa2da400eefd1a0f13f048ca3b9c4e653a90718e` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42967783601 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42970899428 — candidate checks and staging publication succeeded.
- Artifact ID: `13832286858`; archive SHA-256: `7cc6f51b3a6bbe845895e650cd06a8dab3c3965dc9dbbaee7a70918bcafe4459`.
- Publication workflow revision: `2772600a`; operator script SHA-256: `7adcb433e7dd53b8abb78fcd7d458115c2646dfcc4389dbe746ebfb51b09f053`.
- Previous staging revision: `d0e0f893f2a6cfa2bb763735b303df41c89f24c7`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-fa2da400-staging-20261111T061355Z-0yH6W5`.

One change to the server. With the ad calls on Marketing API v27.0 (release d0e0f893), the v26.0 and v27.0 changelogs were read against every field the campaign builder sends. Nothing breaks, but one default would have changed what runs: from v27.0 Meta may add a Product showcase to a creative that says nothing about it, when the ad account has a catalog. The ad that runs is the one that was planned and checked, so every creative Jeeta builds now declines it (`degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status = OPT_OUT`). The rest of the difference from d0e0f893 is documentation.

The operator script is the one that published d0e0f893, with that release as staging's predecessor. It checked that the database holds exactly migrations 1 to 40 with the candidate's checksums, backed up the database, the file store and the environment, restored the recovery copy on its own, and started the candidate against that copy with jobs off and outside networking blocked; every table kept its row count and the migration records stayed as they were. After the swap the installed artifact tree, schema 40 and readiness were verified, and the serving binary is `/opt/jeeta/releases/fa2da400eefd1a0f13f048ca3b9c4e653a90718e/jeeta`.

Validation after publication, from outside:

- All 35 published panel assets match the verified artifact (the panel is identical to d0e0f893's and 7891020b's); eight routes load the published page; readiness succeeds.
- Without a session the API and the MCP endpoint answer 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.

Report: [public integrity](staging-fa2da400-public.json).

What this release does not show. The decline has been tested against the in-process Graph mock only, in the shape Meta's v27.0 changelog gives; no call has been made to Meta. Nothing was checked signed in on staging. Everything the records of 7891020b and d0e0f893 say they do not show still holds: the first real ad campaign is the owner's, on their own ad account, with a small budget and their explicit approval at that moment. No external message, post, ad or device action was performed during verification.
