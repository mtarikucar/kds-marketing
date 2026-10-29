//! `device_commands` (migration `0017_device_bridge`): the commands queued for a workspace's
//! phones. A command keeps the domain's encoding in `payload` (its kind beside it in `kind`) and
//! the actor that queued it in `requested_by`; its bridge's result is written on the same row,
//! `result` for a done command, `reason` and `detail` for a failed one. Commands are handed out in
//! their queue order (`seq`).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::devices::{
    CommandStatus, DeviceCommandRepo, DeviceCommandRow, FailReason, Finish, FinishOutcome,
    MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand,
};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored};
use crate::uow::PgTenantRepos;

/// The longest failure detail the table keeps.
const MAX_DETAIL_CHARS: usize = 300;

/// The columns a [`Record`] is read from.
const COLUMNS: &str = "id, workspace_id, capability_id, seq, payload, status, attempts, \
                       leased_at, expires_at, result, reason, detail, requested_by, created_at, \
                       done_at";

#[derive(sqlx::FromRow)]
struct Record {
    id: Uuid,
    workspace_id: Uuid,
    capability_id: Uuid,
    seq: i64,
    payload: Value,
    status: String,
    attempts: i32,
    leased_at: Option<OffsetDateTime>,
    expires_at: OffsetDateTime,
    result: Option<Value>,
    reason: Option<String>,
    detail: Option<String>,
    requested_by: Value,
    created_at: OffsetDateTime,
    done_at: Option<OffsetDateTime>,
}

impl Record {
    fn into_row(self) -> Result<DeviceCommandRow, AppError> {
        Ok(DeviceCommandRow {
            id: self.id,
            workspace_id: WorkspaceId(self.workspace_id),
            capability_id: CapabilityId(self.capability_id),
            seq: self.seq,
            command: decode(self.payload)?,
            status: stored(
                CommandStatus::from_key(&self.status),
                "device_commands.status",
            )?,
            attempts: stored(
                u32::try_from(self.attempts).ok(),
                "device_commands.attempts",
            )?,
            leased_at: self.leased_at,
            expires_at: self.expires_at,
            result: self.result,
            reason: self
                .reason
                .map(|r| stored(FailReason::from_key(&r), "device_commands.reason"))
                .transpose()?,
            detail: self.detail,
            requested_by: decode(self.requested_by)?,
            created_at: self.created_at,
            done_at: self.done_at,
        })
    }
}

fn encode<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|_| AppError::internal("cannot encode a device command record"))
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, AppError> {
    serde_json::from_value(value)
        .map_err(|_| AppError::internal("invalid stored device command record"))
}

/// The rows of `records`, in queue order: `update … returning` has none of its own.
fn in_queue_order(records: Vec<Record>) -> Result<Vec<DeviceCommandRow>, AppError> {
    let mut rows = records
        .into_iter()
        .map(Record::into_row)
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by_key(|r| r.seq);
    Ok(rows)
}

#[async_trait]
impl DeviceCommandRepo for PgTenantRepos {
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError> {
        let record: Option<Record> = sqlx::query_as(&format!(
            "insert into device_commands (id, workspace_id, capability_id, kind, payload, \
             status, attempts, expires_at, requested_by, created_at) \
             values ($1, $2, $3, $4, $5, 'queued', 0, $6, $7, $8) on conflict do nothing \
             returning {COLUMNS}"
        ))
        .bind(row.id)
        .bind(self.workspace_id().as_uuid())
        .bind(row.capability_id.as_uuid())
        .bind(row.command.kind())
        .bind(encode(&row.command)?)
        .bind(row.expires_at)
        .bind(encode(&row.requested_by)?)
        .bind(row.created_at)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "queue device command"))?;
        record
            .ok_or_else(|| AppError::conflict("the command id is already taken"))?
            .into_row()
    }

    async fn lease(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        if caps.is_empty() {
            return Ok(Vec::new());
        }
        let caps: Vec<Uuid> = caps.iter().map(|c| c.as_uuid()).collect();
        let records: Vec<Record> = sqlx::query_as(&format!(
            "update device_commands c set status = 'leased', leased_at = $3, \
             attempts = c.attempts + 1 \
             from (select q.id as picked from device_commands q \
             where q.workspace_id = $1 and q.capability_id = any($2) \
             and q.status in ('queued', 'leased') \
             and (q.status = 'queued' or q.leased_at <= $4) \
             and q.expires_at > $3 \
             order by q.seq limit $5 for update of q skip locked) p \
             where c.workspace_id = $1 and c.id = p.picked \
             returning {COLUMNS}"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(caps)
        .bind(now)
        .bind(redeliver_before)
        .bind(i64::from(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lease device commands"))?;
        in_queue_order(records)
    }

    async fn finish(
        &mut self,
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<FinishOutcome, AppError> {
        let ws = self.workspace_id();
        let current: Option<(String, Option<OffsetDateTime>)> = sqlx::query_as(
            "select status, leased_at from device_commands \
             where workspace_id = $1 and id = $2 for update",
        )
        .bind(ws.as_uuid())
        .bind(id)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock device command"))?;
        let Some((status, leased_at)) = current else {
            return Ok(FinishOutcome::Unknown);
        };
        let status = stored(CommandStatus::from_key(&status), "device_commands.status")?;
        let next = match outcome.status_after(status, leased_at.is_some()) {
            Ok(next) => next,
            Err(answer) => return Ok(answer),
        };
        let (result, reason, detail) = match outcome {
            Finish::Done { result } => (Some(result), None, None),
            Finish::Failed { reason, detail } => (
                None,
                Some(reason.key()),
                Some(detail.chars().take(MAX_DETAIL_CHARS).collect::<String>()),
            ),
        };
        sqlx::query(
            "update device_commands set status = $3, result = $4, reason = $5, detail = $6, \
             done_at = $7 where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id)
        .bind(next.key())
        .bind(result)
        .bind(reason)
        .bind(detail)
        .bind(now)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "finish device command"))?;
        Ok(FinishOutcome::Applied)
    }

    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<DeviceCommandRow>, AppError> {
        let records: Vec<Record> = sqlx::query_as(&format!(
            "update device_commands set status = 'expired', done_at = $2 \
             where workspace_id = $1 and status in ('queued', 'leased') and expires_at <= $2 \
             returning {COLUMNS}"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(now)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "expire device commands"))?;
        in_queue_order(records)
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError> {
        let record: Option<Record> = sqlx::query_as(&format!(
            "select {COLUMNS} from device_commands where workspace_id = $1 and id = $2"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(id)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "get device command"))?;
        record.map(Record::into_row).transpose()
    }

    async fn list(
        &mut self,
        cap: CapabilityId,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        let records: Vec<Record> = sqlx::query_as(&format!(
            "select {COLUMNS} from device_commands where workspace_id = $1 \
             and capability_id = $2 order by seq desc limit $3"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(cap.as_uuid())
        .bind(i64::from(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list device commands"))?;
        records.into_iter().map(Record::into_row).collect()
    }
}
