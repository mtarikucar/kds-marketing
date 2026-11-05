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
