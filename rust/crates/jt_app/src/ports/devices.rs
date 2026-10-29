//! The commands queued for a workspace's phones (spec `2026-10-28-device-bridge-design.md` §5.1),
//! stored per tenant: an agent queues a command for a phone, the bridge that phone is plugged into
//! leases it, and the bridge's result is written on the command's own row. The command vocabulary
//! and its lifecycle live in `jt_devices` and are re-exported here, as the call records are from
//! `ports::calls`.
//!
//! A row carries the whole command and what it produced (typed text, shell arguments, screen
//! text): log its id, kind and status, never the row (`jt_devices`, "Logging").
pub use jt_devices::*;

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_ledger::Actor;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// The most commands one lease or one read of a phone's log returns.
pub const MAX_DEVICE_COMMAND_PAGE: u32 = 200;

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
    /// From this moment on the command is never leased, and [`DeviceCommandRepo::expire_due`]
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
    /// The line its bridge reported with the failure.
    pub detail: Option<String>,
    pub requested_by: Actor,
    pub created_at: OffsetDateTime,
    /// When it ended: set exactly when it is neither `queued` nor `leased`, and moved to the time
    /// of a late result that replaced how it ended.
    pub done_at: Option<OffsetDateTime>,
}

/// A bridge's result for a command.
#[derive(Clone, Debug, PartialEq)]
pub enum Finish {
    /// The command was carried out; `result` is what it produced.
    Done { result: Value },
    /// It was not. The stored `detail` is its first 300 characters (what the table keeps).
    Failed { reason: FailReason, detail: String },
}

impl Finish {
    /// The lifecycle event this result is.
    pub fn event(&self) -> LifecycleEvent {
        match self {
            Finish::Done { .. } => LifecycleEvent::Done,
            Finish::Failed { .. } => LifecycleEvent::Failed,
        }
    }

    /// What this result does to a command that stands at `current` and was leased at some point
    /// (`ever_leased`: its `leased_at` is set) or never: the status it moves the command to,
    /// through [`next_status`], or, as the error, how [`DeviceCommandRepo::finish`] answers when
    /// the result is not applied. A command no bridge was ever handed refuses any result, before
    /// its status is looked at.
    pub fn status_after(
        &self,
        current: CommandStatus,
        ever_leased: bool,
    ) -> Result<CommandStatus, FinishOutcome> {
        if !ever_leased {
            return Err(FinishOutcome::Unknown);
        }
        next_status(current, self.event(), ever_leased).map_err(|_| match current {
            CommandStatus::Done | CommandStatus::Failed => FinishOutcome::Duplicate,
            _ => FinishOutcome::Unknown,
        })
    }
}

/// What [`DeviceCommandRepo::finish`] did with a result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishOutcome {
    /// Written: a leased command is now `done` or `failed`, or a late result replaced the
    /// `expired` or `canceled` status of a command that was leased before it ended.
    Applied,
    /// The command is `done` or `failed` already: a recorded result is not replaced.
    Duplicate,
    /// No such command in the workspace, or one no bridge was ever handed (`queued`, or
    /// `expired` or `canceled` in the queue): nothing changes.
    Unknown,
}

/// The workspace's device commands. A command is queued once, leased to the bridge of its phone
/// (again when a lease went unanswered), and ends with its bridge's result, an expiry or a
/// cancellation. Rows are never deleted: they are kept like ledger history (spec §5.6).
#[async_trait]
pub trait DeviceCommandRepo: Send + Sync {
    /// Queues `row` as `queued`, after every command queued before it. A taken id (in any
    /// workspace) is `CONFLICT`; a phone that is not a capability of the workspace breaks a
    /// foreign key and is `INTERNAL`.
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError>;
    /// Leases to a bridge at most `limit` (clamped to `1..=MAX_DEVICE_COMMAND_PAGE`) of the
    /// commands of the phones `caps` that expire after `now` and are `queued`, or `leased` at or
    /// before `redeliver_before` (a lease that went unanswered; the caller passes
    /// `now - REDELIVER_AFTER`): oldest first (by `seq`), each marked `leased` at `now` with one
    /// more attempt. A command another bundle is leasing at that moment is passed over.
    async fn lease(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
    /// Applies a bridge's result for command `id`, received at `now`, as
    /// [`Finish::status_after`] decides: when it is applied, writes the new status, the result
    /// (`Done`) or the reason and detail (`Failed`), and `done_at` = `now`. A second result for
    /// the same command waits for the first one's bundle to end.
    async fn finish(
        &mut self,
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<FinishOutcome, AppError>;
    /// Ends as `expired` at `now` every command that is `queued` or `leased` and expires at or
    /// before `now`; the commands it ended, by `seq`.
    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<DeviceCommandRow>, AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError>;
    /// Phone `cap`'s most recent `limit` (clamped to `1..=MAX_DEVICE_COMMAND_PAGE`) commands,
    /// newest first (by `seq`).
    async fn list(
        &mut self,
        cap: CapabilityId,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError>;
}
