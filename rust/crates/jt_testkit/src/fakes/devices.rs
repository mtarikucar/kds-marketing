//! The in-memory device command repository, with the constraints the `0017_device_bridge`
//! migration enforces (one command per id across workspaces, the phone a capability of the
//! command's workspace, the failure detail cut to what the table keeps) and the queue order
//! (`seq`, one more than the highest stored).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::devices::{
    CommandStatus, DeviceCommandRepo, DeviceCommandRow, Finish, FinishOutcome,
    MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand,
};
use jt_capability::CapabilityId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::{MemBundle, exists, unique};
use super::tenant::MemTenant;

/// The longest failure detail the table keeps.
const MAX_DETAIL_CHARS: usize = 300;

/// The workspaces' device commands, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemDevices {
    /// In their queue order.
    pub commands: Vec<DeviceCommandRow>,
}

/// Whether `row` can be leased at `now`, as `jt_pg`'s lease selects it.
fn leasable(row: &DeviceCommandRow, now: OffsetDateTime, redeliver_before: OffsetDateTime) -> bool {
    let waiting = match row.status {
        CommandStatus::Queued => true,
        CommandStatus::Leased => row.leased_at.is_some_and(|at| at <= redeliver_before),
        _ => false,
    };
    waiting && row.expires_at > now
}

#[async_trait]
impl DeviceCommandRepo for MemTenant {
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            unique(
                !state.devices.commands.iter().any(|c| c.id == row.id),
                "the command id is already taken",
            )?;
            exists(
                state.capabilities.iter().any(|c| {
                    c.capability.workspace_id == ws && c.capability.id == row.capability_id
                }),
                "device_commands.capability_id",
            )?;
            let seq = state
                .devices
                .commands
                .iter()
                .map(|c| c.seq)
                .max()
                .unwrap_or(0)
                + 1;
            let stored = DeviceCommandRow {
                id: row.id,
                workspace_id: ws,
                capability_id: row.capability_id,
                seq,
                command: row.command,
                status: CommandStatus::Queued,
                attempts: 0,
                leased_at: None,
                expires_at: row.expires_at,
                result: None,
                reason: None,
                detail: None,
                requested_by: row.requested_by,
                created_at: row.created_at,
                done_at: None,
            };
            let pushed = stored.clone();
            this.tx
                .write(move |s| s.devices.commands.push(pushed.clone()));
            Ok(stored)
        })
    }

    async fn lease(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let ws = self.ws;
        let mut leased: Vec<DeviceCommandRow> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && caps.contains(&c.capability_id))
            .filter(|c| leasable(c, now, redeliver_before))
            .cloned()
            .collect();
        leased.sort_by_key(|c| c.seq);
        leased.truncate(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE) as usize);
        for c in &mut leased {
            c.status = CommandStatus::Leased;
            c.leased_at = Some(now);
            c.attempts += 1;
        }
        let ids: Vec<Uuid> = leased.iter().map(|c| c.id).collect();
        self.tx.write(move |s| {
            for c in s.devices.commands.iter_mut() {
                if c.workspace_id == ws && ids.contains(&c.id) {
                    c.status = CommandStatus::Leased;
                    c.leased_at = Some(now);
                    c.attempts += 1;
                }
            }
        });
        Ok(leased)
    }

    async fn finish(
        &mut self,
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<FinishOutcome, AppError> {
        let ws = self.ws;
        let Some(current) = self
            .state()
            .devices
            .commands
            .iter()
            .find(|c| c.workspace_id == ws && c.id == id)
        else {
            return Ok(FinishOutcome::Unknown);
        };
        let next = match outcome.status_after(current.status, current.leased_at.is_some()) {
            Ok(next) => next,
            Err(answer) => return Ok(answer),
        };
        let (result, reason, detail) = match outcome {
            Finish::Done { result } => (Some(result), None, None),
            Finish::Failed { reason, detail } => (
                None,
                Some(reason),
                Some(detail.chars().take(MAX_DETAIL_CHARS).collect::<String>()),
            ),
        };
        self.tx.write(move |s| {
            for c in s.devices.commands.iter_mut() {
                if c.workspace_id == ws && c.id == id {
                    c.status = next;
                    c.result = result.clone();
                    c.reason = reason;
                    c.detail = detail.clone();
                    c.done_at = Some(now);
                }
            }
        });
        Ok(FinishOutcome::Applied)
    }

    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<DeviceCommandRow>, AppError> {
        let ws = self.ws;
        let mut expired: Vec<DeviceCommandRow> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| {
                c.workspace_id == ws
                    && matches!(c.status, CommandStatus::Queued | CommandStatus::Leased)
                    && c.expires_at <= now
            })
            .cloned()
            .collect();
        expired.sort_by_key(|c| c.seq);
        for c in &mut expired {
            c.status = CommandStatus::Expired;
            c.done_at = Some(now);
        }
        let ids: Vec<Uuid> = expired.iter().map(|c| c.id).collect();
        self.tx.write(move |s| {
            for c in s.devices.commands.iter_mut() {
                if c.workspace_id == ws && ids.contains(&c.id) {
                    c.status = CommandStatus::Expired;
                    c.done_at = Some(now);
                }
            }
        });
        Ok(expired)
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .devices
            .commands
            .iter()
            .find(|c| c.workspace_id == ws && c.id == id)
            .cloned())
    }

    async fn list(
        &mut self,
        cap: CapabilityId,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<DeviceCommandRow> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && c.capability_id == cap)
            .cloned()
            .collect();
        rows.sort_by_key(|c| std::cmp::Reverse(c.seq));
        rows.truncate(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE) as usize);
        Ok(rows)
    }
}
