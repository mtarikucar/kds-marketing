//! What the scheduled jobs do with the phones' commands and files (spec
//! `2026-10-28-device-bridge-design.md` §5.6), each in a workspace, as the system: ending the
//! commands past their time limit ([`expire_commands`], the `device_command_expiry` job, every
//! minute) and deleting the device files past their retention ([`purge_files`], the
//! `device_file_purge` job, hourly). The phones' health (marking unreachable a phone no bridge
//! listed for ten minutes) is the bridge kernel's, run by the `device_bridge_health` job.
//!
//! **Commands are never deleted.** A command row is kept like ledger history; only how it ended
//! changes. One that no bridge took within its time limit, or whose bridge took it and never
//! answered, ends `expired`, and `devices.command.finished` is written for it (`status:
//! "expired"`, `reason`, `duration_ms` and `result_sha256` `null`, `leased_by` the key id of the
//! bridge last handed it, `null` for none). A leased command may still have run: its bridge's
//! result, when it comes, replaces `expired` and writes a second `devices.command.finished` with
//! what the result says (the ledger keeps what happened, in order).
//!
//! **Files.** A device file whose retention ended (`expires_at`, [`super::bridge::FILE_RETENTION`]
//! after its upload) is deleted from the file store, then its record. Deleting is idempotent: a
//! file whose bytes are gone already, or a purge that stopped between the two, is finished on
//! the next run, since the record stays until its bytes are gone. A result that names a purged
//! file keeps naming it; its `file_url` is `null` from then on.
//!
//! **Logging.** `tracing` carries the ids, kinds and counts only: never a command's arguments, a
//! result or a file's bytes.

use jt_studio::FileId;
use uuid::Uuid;

use super::bridge::{Ended, write_finished};
use super::signal_key;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::devices::{CommandStatus, MAX_DEVICE_COMMAND_PAGE};
use crate::usecases::Deps;
use crate::usecases::capabilities::version_in_force;

/// How many device files one read of [`purge_files`] takes; it reads again while a read finds
/// that many.
pub const FILE_PURGE_PAGE: u32 = MAX_DEVICE_COMMAND_PAGE;

/// Ends as `expired`, in the workspace of `ctx` and at `ctx.now`, every command still `queued` or
/// `leased` whose time limit has passed (a command another transaction holds, a bridge's result
/// being applied, is left to the next run), writing `devices.command.finished` for each, in one
/// transaction (see the module docs); then wakes what waits on the workspace's phones. How many
/// it ended.
pub async fn expire_commands(deps: &Deps, ctx: &Ctx) -> Result<u64, AppError> {
    let ws = ctx.workspace_id;
    let mut r = deps.uow.tenant(ws).await?;
    let expired = r.device_commands().expire_due(ctx.now).await?;
    if expired.is_empty() {
        return Ok(0);
    }
    let in_force = version_in_force(r.as_mut()).await?;
    for command in &expired {
        let ended = Ended {
            id: command.id,
            kind: &command.kind,
            status: CommandStatus::Expired,
            reason: None,
            duration_ms: None,
            leased_by: command.leased_by,
            result: None,
        };
        write_finished(r.as_mut(), ctx, in_force, ended).await?;
    }
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ws));
    for command in &expired {
        tracing::info!(
            workspace_id = %ws,
            command_id = %command.id,
            kind = command.kind.as_str(),
            leased = command.leased_at.is_some(),
            "device command expired"
        );
    }
    Ok(expired.len() as u64)
}

/// What one [`purge_files`] did in a workspace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FilesPurged {
    /// The device files found past their retention.
    pub due: u64,
    /// Those deleted, bytes and record.
    pub purged: u64,
    /// Those whose record was gone by the time it was deleted.
    pub gone: u64,
    /// Those that could not be deleted (each logged); the next run tries them again.
    pub failed: u64,
}

/// Deletes, in the workspace of `ctx`, every device file whose retention ended at or before
/// `ctx.now`: its bytes from the file store, then its record, each file in a step of its own
/// (see the module docs). A file that fails is logged with its id and the error's code and
/// counted; the purge stops reading at the end of a page that had one, so a file that keeps
/// failing is tried once a run. An error reading which files are due is the whole purge's.
pub async fn purge_files(deps: &Deps, ctx: &Ctx) -> Result<FilesPurged, AppError> {
    let ws = ctx.workspace_id;
    let mut out = FilesPurged::default();
    loop {
        let due = {
            let mut r = deps.uow.tenant(ws).await?;
            r.device_commands()
                .expired_files(ctx.now, FILE_PURGE_PAGE)
                .await?
        };
        let mut page_failed = false;
        for file in &due {
            out.due += 1;
            match purge_file(deps, ctx, file.id).await {
                Ok(true) => out.purged += 1,
                Ok(false) => out.gone += 1,
                Err(e) => {
                    out.failed += 1;
                    page_failed = true;
                    tracing::warn!(
                        workspace_id = %ws,
                        file_id = %file.id,
                        code = e.code.as_str(),
                        "a device file could not be purged"
                    );
                }
            }
        }
        if page_failed || (due.len() as u64) < u64::from(FILE_PURGE_PAGE) {
            return Ok(out);
        }
    }
}

/// Deletes device file `id` of the workspace of `ctx`: its bytes (none is no error), then its
/// record, in a transaction of its own; whether the record was there to delete.
async fn purge_file(deps: &Deps, ctx: &Ctx, id: Uuid) -> Result<bool, AppError> {
    let ws = ctx.workspace_id;
    deps.files.delete(ws, FileId(id)).await?;
    let mut r = deps.uow.tenant(ws).await?;
    let deleted = r.device_commands().delete_file(id).await?;
    r.commit().await?;
    if deleted {
        tracing::debug!(workspace_id = %ws, file_id = %id, "device file purged");
    }
    Ok(deleted)
}
