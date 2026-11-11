# Staging release f7be8eb1

Published to https://staging.jeetagrowth.com on 2026-11-11 at 13:51:07 UTC. This is a staging-only release.

- Source: `f7be8eb1beefc92c713c6f807c89ff1192945fad` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/43028457851 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/43032721420 — candidate checks and staging publication succeeded.
- Artifact ID: `13859447413`; archive SHA-256: `f8b43cbda48c2f43b598078f937e67a162575ff9ca1faaed152dbd4ae048f140`.
- Publication workflow revision: `d0203321`; operator script SHA-256: `7e7003a280b4bb9be0bbf97dbfd11567f7551e308ad962b949e3753a3cf5d347`.
- Previous staging revision: `a00fe6cc48a51ef024fbf6bd8827b3750d7daad2`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-f7be8eb1-staging-20261111T135044Z-sTdygI`.

The account view now reads what the platform's own scheduler holds for the account (a Facebook Page's scheduled posts) and marks the posts Jeeta did not leave there; the panel warns on the account's page and the connected agent's tool carries the same list. The first real hand-over had ended with an unknown outcome, and neither the agent nor Jeeta could see whether Facebook had scheduled the post; the owner could not find it in Meta Business Suite either.

The operator script is the one that published a00fe6cc, with that release as staging's predecessor; its checks are those of the earlier releases without a migration. The serving binary after the swap is `/opt/jeeta/releases/f7be8eb1beefc92c713c6f807c89ff1192945fad/jeeta`.

Validation after publication:

- From outside: all 35 published panel assets match the verified artifact; eight routes load the published page; readiness succeeds; without a session the API answers 401; the production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e` and the public index hashes of yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.
- Signed in, as the connected agent: the account view of the owner's real Page answered with the platform's list. It holds one post that Jeeta does not know: the one the first hand-over left, scheduled for 13 November 2026, 11:00 UTC. So the read works against Meta, and the first hand-over did schedule a post. The owner was told and given its address to delete it; Jeeta does not delete a post it does not hold.

Report: [public integrity](staging-f7be8eb1-public.json).

What this release does not show. The post on the Page had not been deleted when this record was written. The panel's warning was not looked at signed in. No ad campaign has been built at Meta; the connection still lacks `ads_management`.
