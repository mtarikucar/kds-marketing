# Jeeta panel release: staging → yeni

The current Rust panel lives in `rust/panel/`. The older `frontend/` and
`.github/workflows/deploy.yml` belong to the Node stack at `jeetagrowth.com`.
Pushing a `v*.*.*` tag or dispatching **Release Deploy** updates that older stack;
neither action promotes the Rust panel to staging or yeni.

## Build and verification

The **Rust** workflow runs for changes under `rust/**` or its own workflow file:
pushes to `main`, `feat/**` and `design/**`, and pull requests. It checks the
backend and panel, builds a complete production candidate, and uploads
`jeeta-release-<full SHA>` containing `jeeta-release.tar`. It does not publish or
deploy. Artifacts expire after 14 days; preserve the selected candidate and its
checksums before expiry.

Use one reviewed commit and its successful Rust run. Record the full commit SHA,
run URL, artifact ID/digest, archive checksum and package `manifest.json`.
Confirm `source_revision`, binary/panel checksums and migration inventory match
the selected candidate. Promote that same complete archive after staging passes;
the panel and binary are released together. Follow [deployment.md](deployment.md)
for the package format, production build boundaries and schema compatibility.

## Existing delivery path

The repository records these service assignments in
[tiktok.md](tiktok.md#2-environment):

| Environment | Host | Service | Environment file |
| --- | --- | --- | --- |
| Staging | `staging.jeetagrowth.com` | `jeeta-staging.service` | `/etc/jeeta-staging/jeeta.env` |
| Production Rust | `yeni.jeetagrowth.com` | `jeeta.service` | `/etc/jeeta/jeeta.env` |

The [voice release plan](../superpowers/plans/2026-10-29-voice-sidecar-free-path-plan.md#task-e1-owner-ok-release-the-core-changes-staging-then-prod)
documents the existing server-local sequence below. These scripts are outside
this repository; inspect their current behavior and the installed revision before
using them. The commands run on the deployment server after the verified archive
has been transferred there. Replace `<sha8>` with the candidate's short SHA.

1. Prepare a verified staging recovery set as required by
   [deployment.md](deployment.md#upgrade-and-rollback). The existing plan records
   the database backup and upgrade commands:

   ```sh
   STAMP=$(date +%Y%m%d%H%M)
   sudo -u postgres pg_dump -p 5437 -Fc jeeta > /var/backups/jeeta-staging/pre-<sha8>-$STAMP.dump
   ls -l /var/backups/jeeta-staging/pre-<sha8>-$STAMP.dump
   /root/staging-upgrade.sh /root/jeeta-release-<sha8>.tar
   curl -fsS http://127.0.0.1:8091/readyz
   journalctl -u jeeta-staging --since "-5 min" -p warning --no-pager | head
   ```

2. Verify staging in the browser: sign-in, navigation, changed pages, forms,
   responsive layouts, keyboard access and existing dark/light themes. Record
   the candidate SHA and results. A readiness response alone does not verify the
   panel or its interactions. Review the candidate's migrations even when the
   intended change is visual.
3. After staging validation and the release authorization, use the same archive
   for yeni. The existing plan records that the production script takes a backup,
   checks compatibility, swaps the release and checks readiness:

   ```sh
   /root/upgrade.sh /root/jeeta-release-<sha8>.tar
   curl -fsS http://127.0.0.1:8090/readyz
   ```

   Confirm the installed SHA, public panel/API behavior and relevant service logs.

## Limits and recovery

There is no Rust deployment or staging-to-yeni promotion job in GitHub Actions.
The host assignments and commands above are repository documentation, not proof
of a host's current installed revision or script contents. Deployment access,
archive transfer, runtime configuration and execution remain server operations.
Do not print service environment files or place credentials in release artifacts.

Retain the previous complete release and matching recovery set. Follow
[deployment.md](deployment.md#upgrade-and-rollback) if an upgrade fails: an old
binary must not run against a newer schema. A symlink-only rollback is allowed
only while the database still matches the prior release's schema; otherwise use
the documented recovery process and preserve newer runtime data. Switching
`jeetagrowth.com` from the old stack to Rust is a separate
[v1 cutover](v1-cutover.md).
