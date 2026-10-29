//! `device_commands` (migration `0017_device_bridge`): the commands queued for a workspace's
//! phones. A command keeps the domain's encoding in `payload` (its kind beside it in `kind`) and
//! the actor that queued it in `requested_by`; its bridge's result is written on the same row,
//! `result` for a done command, `reason` and `detail` for a failed one. Commands are handed out in
//! their queue order (`seq`). `device_files`, of the same migration, records the files the bridges
//! upload.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::devices::{
    CommandStatus, DeviceCommandRepo, DeviceCommandRow, DeviceFile, ExpiredCommand, FailReason,
    Finish, Finished, MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand, cut_detail, failed_while_pending,
};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored};
use crate::uow::PgTenantRepos;

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
            reason: self.reason.map(|r| reason_from(&r)),
            detail: self.detail,
            requested_by: decode(self.requested_by)?,
            created_at: self.created_at,
            done_at: self.done_at,
        })
    }
}

/// A stored failure reason. One this version does not know (a newer server wrote it) reads as
/// [`FailReason::Unknown`], so that the command stays readable.
fn reason_from(key: &str) -> FailReason {
    FailReason::from_key(key).unwrap_or_else(|| {
        tracing::warn!(
            column = "device_commands.reason",
            key = %key,
            "reading an unknown stored failure reason as unknown"
        );
        FailReason::Unknown
    })
}

/// The columns an [`ExpiredRecord`] is read from: no payload.
const EXPIRED_COLUMNS: &str = "id, capability_id, seq, kind, created_at, leased_at";

#[derive(sqlx::FromRow)]
struct ExpiredRecord {
    id: Uuid,
    capability_id: Uuid,
    seq: i64,
    kind: String,
    created_at: OffsetDateTime,
    leased_at: Option<OffsetDateTime>,
}

/// A `device_files` row.
#[derive(sqlx::FromRow)]
struct FileRecord {
    id: Uuid,
    mime: String,
    size_bytes: i64,
    sha256: String,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
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

fn uuids(caps: &[CapabilityId]) -> Vec<Uuid> {
    caps.iter().map(|c| c.as_uuid()).collect()
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

    async fn pick_due(
        &mut self,
        caps: &[CapabilityId],
        now: OffsetDateTime,
        redeliver_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        if caps.is_empty() {
            return Ok(Vec::new());
        }
        let records: Vec<Record> = sqlx::query_as(&format!(
            "select {COLUMNS} from device_commands \
             where workspace_id = $1 and capability_id = any($2) \
             and status in ('queued', 'leased') \
             and (status = 'queued' or leased_at <= $4) \
             and expires_at > $3 \
             order by seq limit $5 for update skip locked"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(uuids(caps))
        .bind(now)
        .bind(redeliver_before)
        .bind(i64::from(limit.clamp(1, MAX_DEVICE_COMMAND_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "pick device commands"))?;
        in_queue_order(records)
    }

    async fn mark_leased(
        &mut self,
        ids: &[Uuid],
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let records: Vec<Record> = sqlx::query_as(&format!(
            "update device_commands set status = 'leased', leased_at = $3, \
             attempts = attempts + 1 \
             where workspace_id = $1 and id = any($2) and status in ('queued', 'leased') \
             returning {COLUMNS}"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(ids)
        .bind(now)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lease device commands"))?;
        in_queue_order(records)
    }

    async fn fail_pending(
        &mut self,
        ids: &[Uuid],
        reason: FailReason,
        detail: &str,
        now: OffsetDateTime,
    ) -> Result<Vec<DeviceCommandRow>, AppError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ws = self.workspace_id();
        let current: Vec<(Uuid, String, Option<OffsetDateTime>)> = sqlx::query_as(
            "select id, status, leased_at from device_commands \
             where workspace_id = $1 and id = any($2) for update",
        )
        .bind(ws.as_uuid())
        .bind(ids)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock device commands"))?;
        let mut failing = Vec::new();
        for (id, status, leased_at) in current {
            let status = stored(CommandStatus::from_key(&status), "device_commands.status")?;
            if failed_while_pending(status, leased_at.is_some()).is_some() {
                failing.push(id);
            }
        }
        if failing.is_empty() {
            return Ok(Vec::new());
        }
        let records: Vec<Record> = sqlx::query_as(&format!(
            "update device_commands set status = 'failed', result = null, reason = $3, \
             detail = $4, done_at = $5 where workspace_id = $1 and id = any($2) \
             returning {COLUMNS}"
        ))
        .bind(ws.as_uuid())
        .bind(failing)
        .bind(reason.key())
        .bind(cut_detail(detail))
        .bind(now)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "fail device commands"))?;
        in_queue_order(records)
    }

    async fn finish(
        &mut self,
        caps: &[CapabilityId],
        id: Uuid,
        outcome: Finish,
        now: OffsetDateTime,
    ) -> Result<Finished, AppError> {
        if caps.is_empty() {
            return Ok(Finished::Unknown);
        }
        let ws = self.workspace_id();
        let current: Option<(String, Option<OffsetDateTime>)> = sqlx::query_as(
            "select status, leased_at from device_commands \
             where workspace_id = $1 and id = $2 and capability_id = any($3) for update",
        )
        .bind(ws.as_uuid())
        .bind(id)
        .bind(uuids(caps))
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock device command"))?;
        let Some((status, leased_at)) = current else {
            return Ok(Finished::Unknown);
        };
        let status = stored(CommandStatus::from_key(&status), "device_commands.status")?;
        let next = match outcome.status_after(status, leased_at.is_some()) {
            Ok(next) => next,
            Err(answer) => return Ok(answer),
        };
        let (result, reason, detail) = match outcome {
            Finish::Done { result } => (Some(result), None, None),
            Finish::Failed { reason, detail } => {
                (None, Some(reason.key()), Some(cut_detail(&detail)))
            }
        };
        let record: Record = sqlx::query_as(&format!(
            "update device_commands set status = $3, result = $4, reason = $5, detail = $6, \
             done_at = $7 where workspace_id = $1 and id = $2 returning {COLUMNS}"
        ))
        .bind(ws.as_uuid())
        .bind(id)
        .bind(next.key())
        .bind(result)
        .bind(reason)
        .bind(detail)
        .bind(now)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "finish device command"))?;
        Ok(Finished::Applied(Box::new(record.into_row()?)))
    }

    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<ExpiredCommand>, AppError> {
        // The due rows are picked and locked once, in a materialized CTE: one that another bundle
        // holds (a bridge's results, a poll) is passed over, not waited for.
        let mut records: Vec<ExpiredRecord> = sqlx::query_as(&format!(
            "with due as materialized (select id from device_commands \
             where workspace_id = $1 and status in ('queued', 'leased') and expires_at <= $2 \
             for update skip locked) \
             update device_commands set status = 'expired', done_at = $2 \
             where workspace_id = $1 and id in (select id from due) \
             returning {EXPIRED_COLUMNS}"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(now)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "expire device commands"))?;
        records.sort_by_key(|r| r.seq);
        Ok(records
            .into_iter()
            .map(|r| ExpiredCommand {
                id: r.id,
                capability_id: CapabilityId(r.capability_id),
                seq: r.seq,
                kind: r.kind,
                created_at: r.created_at,
                leased_at: r.leased_at,
            })
            .collect())
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

    async fn save_file(&mut self, file: DeviceFile) -> Result<(), AppError> {
        let size = i64::try_from(file.size_bytes)
            .map_err(|_| AppError::internal("a device file's size does not fit the table"))?;
        let saved = sqlx::query(
            "insert into device_files (id, workspace_id, mime, size_bytes, sha256, created_at, \
             expires_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing",
        )
        .bind(file.id)
        .bind(self.workspace_id().as_uuid())
        .bind(&file.mime)
        .bind(size)
        .bind(&file.sha256)
        .bind(file.created_at)
        .bind(file.expires_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "record device file"))?;
        if saved.rows_affected() == 0 {
            return Err(AppError::conflict("the file id is already taken"));
        }
        Ok(())
    }

    async fn files(&mut self, ids: &[Uuid]) -> Result<Vec<DeviceFile>, AppError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let records: Vec<FileRecord> = sqlx::query_as(
            "select id, mime, size_bytes, sha256, created_at, expires_at from device_files \
             where workspace_id = $1 and id = any($2) order by id",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(ids)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read device files"))?;
        records
            .into_iter()
            .map(|r| {
                Ok(DeviceFile {
                    id: r.id,
                    mime: r.mime,
                    size_bytes: stored(
                        u64::try_from(r.size_bytes).ok(),
                        "device_files.size_bytes",
                    )?,
                    sha256: r.sha256,
                    created_at: r.created_at,
                    expires_at: r.expires_at,
                })
            })
            .collect()
    }
}
