//! The commands queued for a workspace's phones (spec `2026-10-28-device-bridge-design.md` §5.1),
//! stored per tenant: an agent queues a command for a phone, the bridge that phone is plugged into
//! leases it, and the bridge's result is written on the command's own row. The command vocabulary
//! and its lifecycle live in `jt_devices` and are re-exported here, as the call records are from
//! `ports::calls`.
//!
//! A row carries the whole command and what it produced (typed text, shell arguments, screen
//! text): log its id, kind and status, never the row (`jt_devices`, "Logging").
pub use jt_devices::*;

/// The longest failure detail a command keeps: the bound the protocol puts on a bridge's detail,
/// and the table's check.
pub use jt_device_protocol::MAX_DETAIL_CHARS;

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_ledger::Actor;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// The most commands one pick or one read of a phone's log returns.
pub const MAX_DEVICE_COMMAND_PAGE: u32 = 200;

/// `detail`'s first [`MAX_DETAIL_CHARS`] characters: what a failed command keeps of it.
pub fn cut_detail(detail: &str) -> String {
    detail.chars().take(MAX_DETAIL_CHARS).collect()
}

/// A command to queue for a phone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewDeviceCommand {
    pub id: Uuid,
    /// The phone, a capability of the bundle's workspace.
    pub capability_id: CapabilityId,
    pub command: DeviceCommand,
    /// Who queued it.
    pub requested_by: Actor,
    pub created_at: OffsetDateTime,
    /// From this moment on the command is never picked, and [`DeviceCommandRepo::expire_due`]
    /// ends it if it is still `queued` or `leased`.
    pub expires_at: OffsetDateTime,
}

/// A stored command.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceCommandRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    /// Its place in the queue: commands are handed out in the order they were queued in.
    pub seq: i64,
    pub command: DeviceCommand,
    pub status: CommandStatus,
    /// How many times it was leased.
    pub attempts: u32,
    /// When it was last leased; `None` while no bridge was ever handed it.
    pub leased_at: Option<OffsetDateTime>,
    pub expires_at: OffsetDateTime,
    /// What a `done` command produced, as its bridge reported it.
    pub result: Option<Value>,
    /// Why a `failed` command failed.
    pub reason: Option<FailReason>,
    /// The line reported with the failure, at most [`MAX_DETAIL_CHARS`] characters.
    pub detail: Option<String>,
    pub requested_by: Actor,
    pub created_at: OffsetDateTime,
    /// When it ended: set exactly when it is neither `queued` nor `leased`, and moved to the time
    /// of a late result that replaced how it ended.
    pub done_at: Option<OffsetDateTime>,
}

/// A command [`DeviceCommandRepo::expire_due`] ended, read from its columns only (its payload is
/// not decoded, so a command this version cannot read does not stop the sweep).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpiredCommand {
    pub id: Uuid,
    pub capability_id: CapabilityId,
    pub seq: i64,
    /// The command's kind, as stored.
    pub kind: String,
    pub created_at: OffsetDateTime,
    /// When it was last leased; `None` when it expired in the queue.
    pub leased_at: Option<OffsetDateTime>,
}

/// A bridge's result for a command.
#[derive(Clone, Debug, PartialEq)]
pub enum Finish {
    /// The command was carried out; `result` is what it produced.
    Done { result: Value },
    /// It was not. Only the first [`MAX_DETAIL_CHARS`] characters of `detail` are stored.
    Failed { reason: FailReason, detail: String },
}

impl Finish {
    /// A failure, its detail cut to [`MAX_DETAIL_CHARS`] characters.
    pub fn failed(reason: FailReason, detail: &str) -> Finish {
        Finish::Failed {
            reason,
            detail: cut_detail(detail),
        }
    }

    /// The lifecycle event this result is.
    pub fn event(&self) -> LifecycleEvent {
        match self {
            Finish::Done { .. } => LifecycleEvent::Done,
            Finish::Failed { .. } => LifecycleEvent::Failed,
        }
    }

    /// What this result does to a command that stands at `current` and was leased at some point
    /// (`ever_leased`: its `leased_at` is set) or never: the status it moves the command to,
    /// through [`next_status`], or, as the error, [`Finished::Duplicate`] or
    /// [`Finished::Unknown`], as [`DeviceCommandRepo::finish`] answers when the result is not
    /// applied. A command no bridge was ever handed refuses any result, before its status is
    /// looked at.
    pub fn status_after(
        &self,
        current: CommandStatus,
        ever_leased: bool,
    ) -> Result<CommandStatus, Finished> {
        if !ever_leased {
            return Err(Finished::Unknown);
        }
        next_status(current, self.event(), ever_leased).map_err(|_| match current {
            CommandStatus::Done | CommandStatus::Failed => Finished::Duplicate,
            _ => Finished::Unknown,
        })
    }
}

/// What [`DeviceCommandRepo::finish`] did with a result.
#[derive(Clone, Debug, PartialEq)]
pub enum Finished {
    /// Written: a leased command is now `done` or `failed`, or a late result replaced the
    /// `expired` or `canceled` status of a command that was leased before it ended. The row as it
    /// now stands.
    Applied(Box<DeviceCommandRow>),
    /// The command is `done` or `failed` already: a recorded result is not replaced.
    Duplicate,
    /// No such command among the bridge's phones, or one no bridge was ever handed (`queued`,
    /// or `expired` or `canceled` in the queue): nothing changes.
    Unknown,
}

/// The status a server-decided failure moves a command at `current` to: `Failed` while the
/// command is pending (`queued` or `leased`), through [`next_status`]; `None` once it ended.
pub fn failed_while_pending(current: CommandStatus, ever_leased: bool) -> Option<CommandStatus> {
    match current {
        CommandStatus::Queued | CommandStatus::Leased => {
            next_status(current, LifecycleEvent::Failed, ever_leased).ok()
        }
        _ => None,
    }
}

/// The workspace's device commands. A command is queued once, leased to the bridge of its phone
/// (again when a lease went unanswered), and ends with its bridge's result, a failure the server
/// decides, or an expiry. Rows are never deleted: they are kept like ledger history (spec §5.6).
///
/// A bridge's poll takes three calls in one bundle: [`pick_due`](DeviceCommandRepo::pick_due),
/// then [`mark_leased`](DeviceCommandRepo::mark_leased) for the commands it hands out and
/// [`fail_pending`](DeviceCommandRepo::fail_pending) for those it refuses, so a refused command
/// is never marked leased.
#[async_trait]
pub trait DeviceCommandRepo: Send + Sync {
    /// Queues `row` as `queued`, after every command queued before it. A taken id (in any
    /// workspace) is `CONFLICT`; a phone that is not a capability of the workspace breaks a
    /// foreign key and is `INTERNAL`.
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError>;
    /// At most `limit` (clamped to `1..=MAX_DEVICE_COMMAND_PAGE`) of the commands of the phones
    /// `caps` that expire after `now` and are `queued`, or `leased` at or before
    /// `redeliver_before` (a lease that went unanswered; the caller passes
    /// `now - REDELIVER_AFTER`), oldest first (by `seq`). Nothing is marked: each is locked until
    /// the bundle ends, and a command another bundle holds is passed over.
    async fn pick_due(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
    /// Marks the commands `ids` that are still `queued` or `leased` as `leased` at `now`, each
    /// with one more attempt; those rows, by `seq`. Other ids are passed over.
    async fn mark_leased(
        &mut self,
        ids: &[Uuid],
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
    /// Fails, at `now`, the commands `ids` that are still `queued` or `leased`
    /// ([`failed_while_pending`]): a failure the server decides, not a bridge's result. Their
    /// lease time and attempts stay as they were, and their detail is cut to
    /// [`MAX_DETAIL_CHARS`] characters. Those rows, by `seq`; ended, unknown and other
    /// workspaces' ids are passed over.
    async fn fail_pending(
        &mut self,
        ids: &[Uuid],
        reason: FailReason,
        detail: &str,
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
    /// Applies a bridge's result for its command `id` (of one of its phones `caps`), received at
    /// `now`, as [`Finish::status_after`] decides: when it is applied, writes the new status, the
    /// result (`Done`) or the reason and detail (`Failed`), and `done_at` = `now`. A second
    /// result for the same command waits for the first one's bundle to end.
    async fn finish(
        &mut self,
        caps: &[CapabilityId],
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<Finished, AppError>;
    /// Ends as `expired` at `now` the commands that are `queued` or `leased` and expire at or
    /// before `now`; those commands, by `seq`. A command another bundle holds is passed over (the
    /// next sweep ends it), so a sweep never waits for a bridge's results.
    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<ExpiredCommand>, AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError>;
    /// Phone `cap`'s most recent `limit` (clamped to `1..=MAX_DEVICE_COMMAND_PAGE`) commands,
    /// newest first (by `seq`).
    async fn list(
        &mut self,
        cap: CapabilityId,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_while_pending_fails_only_a_pending_command() {
        // Over every status, leased or not: only a queued or leased command is failed by the
        // server; one that ended stays as it ended.
        for &status in CommandStatus::ALL {
            for ever_leased in [false, true] {
                let expected = matches!(status, CommandStatus::Queued | CommandStatus::Leased)
                    .then_some(CommandStatus::Failed);
                assert_eq!(
                    failed_while_pending(status, ever_leased),
                    expected,
                    "{status:?}, ever leased: {ever_leased}"
                );
            }
        }
        // Above all a command that expired, or was canceled, after a lease: a bridge's late
        // result may still replace how it ended, a failure the server decides never does.
        for ended in [CommandStatus::Expired, CommandStatus::Canceled] {
            let late = Finish::failed(FailReason::AdbError, "late");
            assert_eq!(late.status_after(ended, true), Ok(CommandStatus::Failed));
            assert_eq!(failed_while_pending(ended, true), None, "{ended:?}");
        }
    }
}
