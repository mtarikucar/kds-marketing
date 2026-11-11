# Staging release a00fe6cc

Published to https://staging.jeetagrowth.com on 2026-11-11 at 12:50:30 UTC. This is a staging-only release.

- Source: `a00fe6cc48a51ef024fbf6bd8827b3750d7daad2` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/43019503206 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/43023684571 — candidate checks and staging publication succeeded.
- Artifact ID: `13854652505`; archive SHA-256: `66a5be790503c371f89f88a50df100a1e6edaa7083cb18bdb61e6f708b6609a6`.
- Publication workflow revision: `31940d2a`; operator script SHA-256: `5d0c7e80b4c485a2ede47c772e98ea95b2d8ff220e66b31e1f8815041868c3be`.
- Previous staging revision: `a621e9aefea62f4a546d50d6f43b16b5c80b5b1f`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-a00fe6cc-staging-20261111T125012Z-49FGFp`.

A panel change, and a comment in the server. The ad management page's status line now says when the connected ad account may only be read: a sign-in that leaves `ads_management` out connects an ad account that reads and cannot build, the page looked ready and every plan was refused. The line links to the connections. This is what the first real run met on this installation.

The operator script is the one that published a621e9ae, with that release as staging's predecessor; its checks are those of the earlier releases without a migration. The serving binary after the swap is `/opt/jeeta/releases/a00fe6cc48a51ef024fbf6bd8827b3750d7daad2/jeeta`.

Validation after publication, from outside: all 35 published panel assets match the verified artifact and the published script bundle carries the new line; eight routes load the published page; readiness succeeds; without a session the API answers 401; the production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e` and the public index hashes of yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.

Report: [public integrity](staging-a00fe6cc-public.json).

What this release does not show. The line was tested against fixtures; it was not looked at signed in on staging. The state the first real run left is unchanged: no ad campaign has been built at Meta, the approved campaign waits for its plan, and the connection still lacks `ads_management`.
