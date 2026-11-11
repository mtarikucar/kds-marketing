# Staging release d66152a4

Published to https://staging.jeetagrowth.com on 2026-11-11 at 14:40:00 UTC. This is a staging-only release.

- Source: `d66152a4f7834c73e524cf492fac2cfb7fa8ac56` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/43035937224 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/43040502892 — candidate checks and staging publication succeeded.
- Artifact ID: `13862524630`; archive SHA-256: `7de3a11806f90788d52dbc32403a69bb199ab0ac9129cee47b98f4dde88eeaf6`.
- Publication workflow revision: `8f835d9a`; operator script SHA-256: `df396cdd9d153523a9b5bdb013471cc886e56917a3f18ef63904060d00104768`.
- Previous staging revision: `f7be8eb1beefc92c713c6f807c89ff1192945fad`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-d66152a4-staging-20261111T143937Z-k7PbQU`.

One change to the server. A hand-over to a platform's own scheduler that never learnt whether the post was taken may leave a post there that nothing follows. Once its slot no longer goes out and its time is still ahead, the recovery job now looks the post up in the platform's scheduler by what Jeeta sent (the same account, the same time, the same text) and takes back an exact, single match. No other post there is touched.

The operator script is the one that published f7be8eb1, with that release as staging's predecessor; its checks are those of the earlier releases without a migration. The serving binary after the swap is `/opt/jeeta/releases/d66152a4f7834c73e524cf492fac2cfb7fa8ac56/jeeta`.

Validation after publication:

- From outside: all 35 published panel assets match the verified artifact (the panel is identical to f7be8eb1's); eight routes load the published page; readiness succeeds; without a session the API answers 401; the production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e` and the public index hashes of yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.
- Signed in, as the connected agent, on the owner's real Page: release f7be8eb1 had shown one post in Facebook's scheduler that Jeeta did not know, left by the first hand-over (13 November 2026, 11:00 UTC) and still due although its slot had been cancelled. Within a minute of this release the recovery job took it back: the ledger carries `studio.publish.withdrawn` with the reason `unknown_hand_over` for that slot, and the account view's list of what the platform holds no longer contains a post Jeeta does not know. Nothing was published on the Page.

Report: [public integrity](staging-d66152a4-public.json).

What this release does not show. That the post is gone was read through Jeeta (the platform's own list), not seen on Meta's screens. No ad campaign has been built at Meta; the connection still lacks `ads_management`, and the approved campaign waits for its plan.
