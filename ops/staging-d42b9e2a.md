# Staging publication: d42b9e2a

Authorization: the owner requested “Staging e al” after the editorial imagery pass.

- Application candidate: `d42b9e2aa1e719e9741ed5b2f055e0d47fca1952`
- Source CI: https://github.com/mtarikucar/kds-marketing/actions/runs/42111782176
- Artifact: `13454853462`, `jeeta-release-d42b9e2aa1e719e9741ed5b2f055e0d47fca1952`
- GitHub artifact digest: `sha256:dfd37cd0548ac4f3768bf50697ab7e0fbe89b63be71f9fe966292bc7e800543f`
- Inner archive SHA-256: `78ceab792f7ff13a8eab11d9c890882856c1729fa710adf11e40c9c67c566a1f`
- Required predecessor: `01194c8567db522d4fa9523b9b659a04023c58e5`
- Pinned existing server staging-upgrade script: `120ff74c1b8ae34cc6f9a23328b5425f2c67818a4b9a3b32fd56a9c3b5935929`

Only `rust/panel/{src,public}` and design documentation changed between these application revisions. All 28 migration entries match the previous release exactly. The complete package was inspected locally: clean source revision, binary hash, 35 panel asset hashes, migration up/down checksums and eight new editorial image variants.

Publication is gated on successful completion of the exact source push CI run. The staging-only script verifies the installed revision, unchanged migration inventory and staging configuration selectors. It retains a database/files/configuration recovery set, restores the database into an isolated temporary database and boots the candidate there with jobs and external networking disabled. It then calls the existing pinned staging upgrader. The production release pointer must remain unchanged.

If publication fails after the swap, automated return to the intact previous release is allowed only after confirming the database migration inventory still exactly matches the pre-publication inventory. No database rollback or account modification is part of this UI release.

External checks and the publication outcome will be appended after the run.

## Publication result

Published successfully at **2026-11-05 21:45:57 UTC**.

- Publication run: https://github.com/mtarikucar/kds-marketing/actions/runs/42112652523 — success.
- Exact source CI completed successfully before publication.
- Installed staging revision: `d42b9e2aa1e719e9741ed5b2f055e0d47fca1952`.
- Recovery set: `/var/backups/jeeta-staging/pre-d42b9e2a-20261105T214538Z`.
- Isolated restore/candidate boot passed. All 28 migration checksums and pre-existing table row counts remained unchanged.
- Production pointer stayed at `095221a121801bbd807967c576fdb53046b3b23e`.
- Public readiness passed. All 35 served assets matched the candidate byte-for-byte; five SPA routes returned the application; unauthenticated API access returned401.
- Both production sites' login index hashes remained unchanged across this publication.

Public evidence: [asset and readiness report](staging-d42b9e2a-public.json).

Authenticated browser verification used the previously authorized staging demo account. Eight views (strategy, studio, material upload, capabilities, prospects, research tasks, calls, inbox) passed at1440px and390px: **16 captures**, no runtime exceptions, failed API responses, broken images or document overflow. Responsive editorial image sources loaded correctly. Business mutations were blocked by the verification harness; only sign-in was allowed. No account or strategy modifications were made. Studio desktop and capabilities mobile screenshots were also inspected visually.

Browser evidence: [authenticated review](staging-d42b9e2a-browser.json). Screenshots remain in the private session directory `/workspace/kds-runtime/staging-d42b9e2a/`.
