# Staging release a621e9ae

Published to https://staging.jeetagrowth.com on 2026-11-11 at 10:23:35 UTC. This is a staging-only release.

- Source: `a621e9aefea62f4a546d50d6f43b16b5c80b5b1f` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42999006587 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/43003123880 — candidate checks and staging publication succeeded.
- Artifact ID: `13844609009`; archive SHA-256: `bcee7a603cc31d534a2c07018af28503f79e589c825dd1152491de3b6e93deb0`.
- Publication workflow revision: `6f5fbd56`; operator script SHA-256: `c72cd7fea338bba6b21a1b246954a0a48b967eb03108b20a378a9685752fd16f`.
- Previous staging revision: `4cafc3b671b08967ed6b58aae47c866f4c8b22bf`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-a621e9ae-staging-20261111T102317Z-Is4efF`.

Three fixes from the first run against Meta. On release 4cafc3b6 the owner connected their own Facebook Page and ad accounts to the staging demo workspace and gave a connected agent a key; the agent worked over MCP.

- A single-photo post left with Facebook's scheduler was taken by Facebook but answered without a post id, so Jeeta recorded an unknown outcome and could neither follow the post nor take it back. The post is now left in the two calls Meta documents: the photo uploaded unpublished and temporary, the post scheduled on the Page feed with it attached.
- An agent could not move a planned post: cancelling it left its content version scheduled for good, and a version could not be planned a second time at all. An agent's cancel of an untouched planned version now lets it wait for a time again; a person's cancel still ends it, and a post that was attempted is never offered again.
- A plan on an ad account whose connection may only read was refused as "not a usable ad account". The finding now names the missing permission, and the panel says what to allow when reconnecting.

The operator script is the one that published 4cafc3b6, with that release as staging's predecessor: migrations 1 to 40 with the candidate's checksums, backup, isolated restore, start of the candidate against the restored copy with jobs off and outside networking blocked, every table's row count unchanged. After the swap the installed artifact tree, schema 40 and readiness were verified; the serving binary is `/opt/jeeta/releases/a621e9aefea62f4a546d50d6f43b16b5c80b5b1f/jeeta`.

Validation after publication:

- From outside: all 35 published panel assets match the verified artifact; eight routes load the published page; readiness succeeds; without a session the API and the MCP endpoint answer 401; the production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e` and the public index hashes of yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.
- Signed in, as the connected agent, with the owner's real Page: a finished content version was given the Page and a time a day ahead; two minutes later the publish job left it with Facebook's scheduler (no failure record; the account's coming posts showed it held at the provider); the agent cancelled the slot and Jeeta took the post back at Facebook first, then retired the slot. Nothing was published on the Page.

Report: [public integrity](staging-a621e9ae-public.json).

What this release does not show. No ad campaign has been built at Meta: the sign-in's Facebook Login for Business configuration does not grant `ads_management`, so the plan is refused before any write and nothing has been spent; the approved campaign (100 TL) waits for its plan. The first run may have left a scheduled post on the owner's Page that Jeeta cannot follow (13 November, 14:00 Turkish time); the owner was asked to delete it by hand. The Page's scheduled list was not seen from Facebook's side. A text or link post and a post read after it went out have not been run against Meta. The panel was not looked at signed in during this verification.
