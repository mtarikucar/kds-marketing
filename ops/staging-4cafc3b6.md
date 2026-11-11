# Staging release 4cafc3b6

Published to https://staging.jeetagrowth.com on 2026-11-11 at 06:59:33 UTC. This is a staging-only release.

- Source: `4cafc3b671b08967ed6b58aae47c866f4c8b22bf` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42973426662 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42976146272 — candidate checks and staging publication succeeded.
- Artifact ID: `13833869051`; archive SHA-256: `dcb689a5d16082463f0eeb9a49f57efa6e94b0c95ba6d302d44a8f48fa9c912c`.
- Publication workflow revision: `223ae31d`; operator script SHA-256: `f9a5a77518bd3bb88a0be725f434af2e873605c51f8ecfa59a93dc9032ca6191`.
- Previous staging revision: `fa2da400eefd1a0f13f048ca3b9c4e653a90718e`; database schema 40 before and after. The candidate carries no migration.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-4cafc3b6-staging-20261111T065910Z-EvIGEQ`.

A panel change; the server binary is byte for byte the one of fa2da400. Agents and their API keys are on one page: `/agents` lists each key with the agents that connected through it, "Ajan bağla" names the agent and issues its key with the ready command, "Erişimi kes" revokes the key, a key nobody has used yet says how to connect, and revoked keys sit apart. The separate API keys page and its navigation entry are gone: `/api-keys` redirects to `/agents`, and the connect links on the home and onboarding pages open the connect dialog. The rest of the difference from fa2da400 is documentation.

The operator script is the one that published fa2da400, with that release as staging's predecessor: migrations 1 to 40 with the candidate's checksums, backup of the database, the file store and the environment, isolated restore, start of the candidate against the restored copy with jobs off and outside networking blocked, every table's row count unchanged. After the swap the installed artifact tree, schema 40 and readiness were verified, and the serving binary is `/opt/jeeta/releases/4cafc3b671b08967ed6b58aae47c866f4c8b22bf/jeeta`.

Validation after publication, from outside:

- All 35 published panel assets match the verified artifact, and the published script bundle is the new one (it carries the connect dialog's link); eight routes load the published page, `/agents` and `/api-keys` among the routes that answer; readiness succeeds.
- Without a session the API and the MCP endpoint answer 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.

Report: [public integrity](staging-4cafc3b6-public.json).

What this release does not show. The page was tested before the release against fixtures (panel suite: 80 files, 661 tests) and looked at on a local server; on staging nothing was checked signed in, so the redirect, the menu and the connect dialog have not been seen there. No external message, post, ad or device action was performed during verification.
