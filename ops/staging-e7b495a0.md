# Staging release e7b495a0

Published to https://staging.jeetagrowth.com on 2026-11-09 at 14:00:16 UTC. This is a staging-only release.

- Source: `e7b495a08443a67876947fabaf4a61a2dfee551b` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42627138204 (all nine jobs passed, including 509 panel tests and 17 production worker tests).
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/42628317915 (candidate checks and staging publication succeeded).
- Artifact ID: `13678634241`; archive SHA-256: `efcaeab551bf8f23d425268cfd1fdcc6fe7f35a5f326210e46feb0337df5bd26`.
- Publication workflow revision: `539e124e51e4f28e4e2d889790d63c6ae476a025`; reviewed operator script SHA-256: `ff945a68c04d919b146013c281262f178d1d44461832de80e4119f9dbb7e59da`.
- Previous staging revision: `19093007ceec63c4e47a459e8b2019d9c515ebe8`; database schema advanced from 30 to 31.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-e7b495a0-staging-20261109T140003Z-unUuA5`.

The release adds production projects under **Büyüme stüdyosu → Üretim alanları**. Each project brings its brief, materials, missing-material requests, production jobs, and publication outputs together in four focused tabs. Delivered materials attach to their project, source/brief revisions invalidate stale work, archive cancels owned pending jobs, and outputs can enter the existing publication-slot workflow with its strategy/channel/material checks. HTTP and MCP expose the same tenant-scoped operations. MCP dependencies also include the current security patches.

Before switching staging, the operator backed up the database, FileStore, and environment; independently restored the recovery copy; and booted the candidate against that copy with jobs disabled. The rehearsal preserved original table counts, verified migration checksums and forced row-level security, and applied migration 31. Publication verified the complete installed artifact tree and readiness.

Validation after publication:

- Existing demo account sign-in succeeded.
- Uploaded a synthetic, explicitly non-shareable fixture and verified signed preview byte integrity.
- Verified project creation idempotency, missing-material request delivery, source attachment, rejection of stale writes, and a real pending edit request without duplicate replay.
- Created a temporary scoped API key, read the project over authenticated MCP, revoked the key, and verified immediate rejection of subsequent access.
- Saved a publication output target in the browser without scheduling or sending an external post.
- Archived the test project, verified cancellation of its pending production request, and erased the uploaded fixture. The archived project remains as an audit record; there are no active test jobs or test API keys.
- Eight project views and 22 general application views at 1440 and 390 pixels passed. No runtime exceptions, unexpected business writes during navigation, API failures, horizontal overflow, or broken images were detected. Call settings checks waited for the scenario form to load. Representative desktop and mobile project captures were also visually inspected.
- All 35 published panel assets match the verified artifact; six public routes load, readiness succeeds, and unauthenticated API access returns 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; public index hashes for yeni.jeetagrowth.com and jeetagrowth.com match their pre-release values.

Reports: [browser](staging-e7b495a0-browser.json), [production workflow](staging-e7b495a0-functional.json), [public integrity](staging-e7b495a0-public.json).

This is the first production-workspace slice, not a complete autonomous media operation. The packaged worker supports static image analysis and bounded single-image cropping; video editing, unrestricted image editing, and poster generation require additional worker capabilities. No persistent model worker was installed or enabled. The local Codex authentication needs renewal, so automatic model processing is not active and real model inference was not verified. No external social publication was performed during verification.
