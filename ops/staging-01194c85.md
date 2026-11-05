# Staging publication: 01194c85

User authorization: “staging e al” after the Jeeta Unslop design pass.

- Application candidate: `01194c8567db522d4fa9523b9b659a04023c58e5`
- CI build/run: https://github.com/mtarikucar/kds-marketing/actions/runs/42028623426
- Artifact ID: `13414952929`
- GitHub artifact digest: `sha256:5ec4a141e7e32a9c95dfce9245b7ac600621eb90d6fc01602e12a1fc8c432054`
- Inner release tar SHA-256: `cc0f136d3f2661ee044692abcd107d3140f09fae72a0f75ba0ac6bc4fb5e8de7`
- Publish run: https://github.com/mtarikucar/kds-marketing/actions/runs/42034561377
- Read-only access/procedure runs: `42029994772`, `42030182900`
- Pinned server staging-upgrade script: `120ff74c1b8ae34cc6f9a23328b5425f2c67818a4b9a3b32fd56a9c3b5935929`

The candidate's binary, all panel files, complete migration inventory and source revision were
verified against its manifest locally before transfer. Publication requires the complete candidate
Rust CI run to finish successfully. Existing applied migrations must retain their exact checksums. The only permitted additions
are the six reviewed migrations 20, 21, 22, 26, 27 and 28; they were rehearsed with the actual
candidate binary against an isolated restored staging database before publication.

Status: **published and externally verified**, 2026-11-05 13:19 UTC.

- Previous staging revision: `814b3c0e2983338ba863f1c0368e1b0218cc629d`, confirmed an ancestor of the candidate.
- Current staging revision: `01194c8567db522d4fa9523b9b659a04023c58e5`.
- Recovery set: `/var/backups/jeeta-staging/pre-01194c85-20261105T131841Z` (root-private database, files, configuration, manifests and verification logs).
- Isolated candidate boot succeeded with provider/bootstrap settings omitted, jobs/outreach disabled and external networking blocked. All 28 migration checksums matched; pre-existing table row counts were unchanged.
- The temporary verification database was dropped and its transient service stopped after success.
- Actual staging migrated to the verified 28-version inventory and returned HTTP 200 readiness internally and publicly.
- Production pointer remained `095221a121801bbd807967c576fdb53046b3b23e`; production was not deployed.
- Public verification matched all 24 served assets byte-for-byte with the candidate, checked five SPA routes and confirmed unauthenticated API requests return 401.
- Real browser checks at 1440px and 390px loaded IBM Plex Sans without overflow, broken images or page exceptions. Inbox, Studio and API-key routes correctly redirect unauthenticated visitors to login. Authenticated customer operations were not exercised on staging.

Evidence: [asset/health checks](staging-01194c85-public.json) and [browser checks](staging-01194c85-browser.json).

Runtime note: the new Studio planner can retire unsent legacy organic quota slots when existing
scheduled jobs resume; distribution can assign ownerless journeys. Outreach still requires its
explicit enable flag. The deployment preserves the existing staging runtime configuration.

