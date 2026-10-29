//! The in-memory device command repository, with the constraints the `0017_device_bridge`
//! migration enforces (one command per id across workspaces, the phone a capability of the
//! command's workspace, the failure detail cut to what the table keeps, one device file per id
//! across workspaces) and the queue order (`seq`, one more than the highest stored). Row locks are
//! not modelled: a pick holds nothing, and races between bundles are tested on PostgreSQL.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::devices::{
    CommandStatus, DeviceCommandRepo, DeviceCommandRow, DeviceFile, ExpiredCommand, FailReason,
    Finish, Finished, MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand, cut_detail, failed_while_pending,
};
use jt_capability::CapabilityId;
use jt_tenancy::{ApiKeyId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::{MemBundle, MemState, exists, unique};
use super::tenant::MemTenant;

/// The workspaces' device commands, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemDevices {
    /// In their queue order.
    pub commands: Vec<DeviceCommandRow>,
    /// The files the bridges uploaded, each with its workspace, as recorded.
    pub files: Vec<(WorkspaceId, DeviceFile)>,
}

/// Whether `row` is due at `now`, as `jt_pg`'s pick selects it.
fn due(row: &DeviceCommandRow, now: OffsetDateTime, redeliver_before: OffsetDateTime) -> bool {
    let waiting = match row.status {
        CommandStatus::Queued => true,
        CommandStatus::Leased => row.leased_at.is_some_and(|at| at <= redeliver_before),
        _ => false,
    };
    waiting && row.expires_at > now
}

impl MemTenant {
    /// The workspace's commands `ids`, by `seq`, as they stand in this bundle.
    fn commands_in(&self, ids: &[Uuid]) -> Vec<DeviceCommandRow> {
        let ws = self.ws;
        let mut rows: Vec<DeviceCommandRow> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && ids.contains(&c.id))
            .cloned()
            .collect();
        rows.sort_by_key(|c| c.seq);
        rows
    }

    /// Applies `change` to the workspace's commands `ids` (in this bundle, and on commit); those
    /// rows as they then stand, by `seq`.
    fn change_commands(
        &mut self,
        ids: Vec<Uuid>,
        change: impl Fn(&mut DeviceCommandRow) + Send + Sync + 'static,
    ) -> Vec<DeviceCommandRow> {
        let ws = self.ws;
        let targets = ids.clone();
        self.tx.write(move |s: &mut MemState| {
            for c in s.devices.commands.iter_mut() {
                if c.workspace_id == ws && targets.contains(&c.id) {
                    change(c);
                }
            }
        });
        self.commands_in(&ids)
    }
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
                leased_by: None,
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

    async fn pick_due(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let ws = self.ws;
        let mut picked: Vec<DeviceCommandRow> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && caps.contains(&c.capability_id))
            .filter(|c| due(c, now, redeliver_before))
            .cloned()
            .collect();
        picked.sort_by_key(|c| c.seq);
        picked.truncate(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE) as usize);
        Ok(picked)
    }

    async fn mark_leased(
        &mut self,
        ids: &[Uuid],
        by: ApiKeyId,
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let pending: Vec<Uuid> = self
            .commands_in(ids)
            .into_iter()
            .filter(|c| matches!(c.status, CommandStatus::Queued | CommandStatus::Leased))
            .map(|c| c.id)
            .collect();
        Ok(self.change_commands(pending, move |c| {
            c.status = CommandStatus::Leased;
            c.leased_at = Some(now);
            c.leased_by = Some(by);
            c.attempts += 1;
        }))
    }

    async fn fail_pending(
        &mut self,
        ids: &[Uuid],
        reason: FailReason,
        detail: &str,
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let failing: Vec<Uuid> = self
            .commands_in(ids)
            .into_iter()
            .filter(|c| failed_while_pending(c.status, c.leased_at.is_some()).is_some())
            .map(|c| c.id)
            .collect();
        let detail = cut_detail(detail);
        Ok(self.change_commands(failing, move |c| {
            c.status = CommandStatus::Failed;
            c.result = None;
            c.reason = Some(reason);
            c.detail = Some(detail.clone());
            c.done_at = Some(now);
        }))
    }

    async fn finish(
        &mut self,
        by: ApiKeyId,
        holding: &[CapabilityId],
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<Finished, AppError> {
        let Some(current) = self
            .commands_in(&[id])
            .into_iter()
            .find(|c| c.leased_by == Some(by) || holding.contains(&c.capability_id))
        else {
            return Ok(Finished::Unknown);
        };
        let next = match outcome.status_after(current.status, current.leased_at.is_some()) {
            Ok(next) => next,
            Err(answer) => return Ok(answer),
        };
        let (result, reason, detail) = match outcome {
            Finish::Done { result } => (Some(result), None, None),
            Finish::Failed { reason, detail } => (None, Some(reason), Some(cut_detail(&detail))),
        };
        let mut changed = self.change_commands(vec![id], move |c| {
            c.status = next;
            c.result = result.clone();
            c.reason = reason;
            c.detail = detail.clone();
            c.done_at = Some(now);
        });
        Ok(changed
            .pop()
            .map_or(Finished::Unknown, |row| Finished::Applied(Box::new(row))))
    }

    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<ExpiredCommand>, AppError> {
        let ws = self.ws;
        let due: Vec<Uuid> = self
            .state()
            .devices
            .commands
            .iter()
            .filter(|c| {
                c.workspace_id == ws
                    && matches!(c.status, CommandStatus::Queued | CommandStatus::Leased)
                    && c.expires_at <= now
            })
            .map(|c| c.id)
            .collect();
        let expired = self.change_commands(due, move |c| {
            c.status = CommandStatus::Expired;
            c.done_at = Some(now);
        });
        Ok(expired
            .into_iter()
            .map(|c| ExpiredCommand {
                id: c.id,
                capability_id: c.capability_id,
                seq: c.seq,
                kind: c.command.kind().to_owned(),
                created_at: c.created_at,
                leased_at: c.leased_at,
            })
            .collect())
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError> {
        Ok(self.commands_in(&[id]).pop())
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

    async fn save_file(&mut self, file: DeviceFile) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            unique(
                !this
                    .state()
                    .devices
                    .files
                    .iter()
                    .any(|(_, f)| f.id == file.id),
                "the file id is already taken",
            )?;
            this.tx
                .write(move |s| s.devices.files.push((ws, file.clone())));
            Ok(())
        })
    }

    async fn files(&mut self, ids: &[Uuid]) -> Result<Vec<DeviceFile>, AppError> {
        let ws = self.ws;
        let mut files: Vec<DeviceFile> = self
            .state()
            .devices
            .files
            .iter()
            .filter(|(of, f)| *of == ws && ids.contains(&f.id))
            .map(|(_, f)| f.clone())
            .collect();
        files.sort_by_key(|f| f.id);
        Ok(files)
    }
}
