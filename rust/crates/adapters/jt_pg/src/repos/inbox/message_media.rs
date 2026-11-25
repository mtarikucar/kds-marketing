//! `message_media` (migration `0055_message_media`): the images and documents of chat messages.
//! The table's checks and composite foreign keys hold the rules of
//! `jt_app::ports::message_media`; a write that breaks one, or names a message or capability of no
//! row of the workspace, is `INTERNAL`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::message_media::{
    ErasedFiles, MAX_MEDIA_PAGE, MediaDirection, MediaKind, MediaReason, MediaSource, MediaState,
    MessageMediaRepo, MessageMediaRow, media_row_valid,
};
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::map_sqlx;
use crate::repos::stored;
use crate::uow::PgTenantRepos;

const COLUMNS: &str = "id, message_id, position, capability_id, direction, kind, source, \
                       material_id, file_id, provider_media_id, declared_mime, mime, filename, \
                       size_bytes, sha256, width, height, state, reason, attempts, \
                       next_attempt_at, created_at, stored_at, deleted_at";

#[derive(sqlx::FromRow)]
struct Record {
    id: Uuid,
    message_id: Uuid,
    position: i16,
    capability_id: Uuid,
    direction: String,
    kind: String,
    source: String,
    material_id: Option<Uuid>,
    file_id: Option<Uuid>,
    provider_media_id: Option<String>,
    declared_mime: String,
    mime: Option<String>,
    filename: String,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    state: String,
    reason: Option<String>,
    attempts: i32,
    next_attempt_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    stored_at: Option<OffsetDateTime>,
    deleted_at: Option<OffsetDateTime>,
}

impl Record {
    fn into_row(self) -> Result<MessageMediaRow, AppError> {
        let positive = |v: Option<i32>, column: &str| {
            v.map(|v| stored(u32::try_from(v).ok(), column)).transpose()
        };
        Ok(MessageMediaRow {
            id: self.id,
            message_id: MessageId::from(self.message_id),
            position: stored(u8::try_from(self.position).ok(), "message_media.position")?,
            capability_id: CapabilityId::from(self.capability_id),
            direction: stored(
                MediaDirection::parse(&self.direction),
                "message_media.direction",
            )?,
            kind: stored(MediaKind::parse(&self.kind), "message_media.kind")?,
            source: stored(MediaSource::parse(&self.source), "message_media.source")?,
            material_id: self.material_id,
            file_id: self.file_id.map(FileId),
            provider_media_id: self.provider_media_id,
            declared_mime: self.declared_mime,
            mime: self.mime,
            filename: self.filename,
            size_bytes: self
                .size_bytes
                .map(|s| stored(u64::try_from(s).ok(), "message_media.size_bytes"))
                .transpose()?,
            sha256: self.sha256,
            width: positive(self.width, "message_media.width")?,
            height: positive(self.height, "message_media.height")?,
            state: stored(MediaState::parse(&self.state), "message_media.state")?,
            reason: self
                .reason
                .map(|r| stored(MediaReason::parse(&r), "message_media.reason"))
                .transpose()?,
            attempts: stored(u32::try_from(self.attempts).ok(), "message_media.attempts")?,
            next_attempt_at: self.next_attempt_at,
            created_at: self.created_at,
            stored_at: self.stored_at,
            deleted_at: self.deleted_at,
        })
    }
}

/// `INTERNAL` for a write a check or a foreign key refused (the rules of the module docs); any
/// other failure as `map_sqlx` maps it.
fn refused(e: sqlx::Error, what: &str) -> AppError {
    let code = e
        .as_database_error()
        .and_then(|d| d.code())
        .map(|c| c.into_owned());
    match code.as_deref() {
        Some("23503") => AppError::internal("message_media references a row that does not exist"),
        Some("23514") => AppError::internal("invalid message media row"),
        _ => map_sqlx(e, what),
    }
}

fn invalid() -> AppError {
    AppError::internal("invalid message media row")
}

fn size(row: &MessageMediaRow) -> Result<Option<i64>, AppError> {
    row.size_bytes
        .map(|s| i64::try_from(s).map_err(|_| invalid()))
        .transpose()
}

fn pixels(v: Option<u32>) -> Result<Option<i32>, AppError> {
    v.map(|v| i32::try_from(v).map_err(|_| invalid()))
        .transpose()
}

impl PgTenantRepos {
    async fn media_one(
        &mut self,
        id: Uuid,
        lock: bool,
    ) -> Result<Option<MessageMediaRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from message_media where workspace_id = $1 and id = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read message media"))?;
        row.map(Record::into_row).transpose()
    }
}

#[async_trait]
impl MessageMediaRepo for PgTenantRepos {
    async fn insert_if_new(&mut self, row: &MessageMediaRow) -> Result<bool, AppError> {
        if !media_row_valid(row) {
            return Err(invalid());
        }
        let done = sqlx::query(
            "insert into message_media (workspace_id, id, message_id, position, capability_id, \
             direction, kind, source, material_id, file_id, provider_media_id, declared_mime, \
             mime, filename, size_bytes, sha256, width, height, state, reason, attempts, \
             next_attempt_at, created_at, stored_at, deleted_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, \
             $17, $18, $19, $20, $21, $22, $23, $24, $25) \
             on conflict (workspace_id, message_id, position) do nothing",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id)
        .bind(row.message_id.as_uuid())
        .bind(i16::from(row.position))
        .bind(row.capability_id.as_uuid())
        .bind(row.direction.key())
        .bind(row.kind.key())
        .bind(row.source.key())
        .bind(row.material_id)
        .bind(row.file_id.map(|f| f.0))
        .bind(row.provider_media_id.as_deref())
        .bind(&row.declared_mime)
        .bind(row.mime.as_deref())
        .bind(&row.filename)
        .bind(size(row)?)
        .bind(row.sha256.as_deref())
        .bind(pixels(row.width)?)
        .bind(pixels(row.height)?)
        .bind(row.state.key())
        .bind(row.reason.map(MediaReason::key))
        .bind(i32::try_from(row.attempts).map_err(|_| invalid())?)
        .bind(row.next_attempt_at)
        .bind(row.created_at)
        .bind(row.stored_at)
        .bind(row.deleted_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| {
            let code = e
                .as_database_error()
                .and_then(|d| d.code())
                .map(|c| c.into_owned());
            if code.as_deref() == Some("23505") {
                AppError::conflict("message media id is already taken")
            } else {
                refused(e, "insert message media")
            }
        })?;
        Ok(done.rows_affected() == 1)
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError> {
        self.media_one(id, false).await
    }

    async fn lock(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError> {
        self.media_one(id, true).await
    }

    async fn save(&mut self, row: &MessageMediaRow) -> Result<(), AppError> {
        if !media_row_valid(row) {
            return Err(invalid());
        }
        let done = sqlx::query(
            "update message_media set file_id = $3, provider_media_id = $4, declared_mime = $5, \
             mime = $6, filename = $7, size_bytes = $8, sha256 = $9, width = $10, height = $11, \
             state = $12, reason = $13, attempts = $14, next_attempt_at = $15, stored_at = $16, \
             deleted_at = $17 where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id)
        .bind(row.file_id.map(|f| f.0))
        .bind(row.provider_media_id.as_deref())
        .bind(&row.declared_mime)
        .bind(row.mime.as_deref())
        .bind(&row.filename)
        .bind(size(row)?)
        .bind(row.sha256.as_deref())
        .bind(pixels(row.width)?)
        .bind(pixels(row.height)?)
        .bind(row.state.key())
        .bind(row.reason.map(MediaReason::key))
        .bind(i32::try_from(row.attempts).map_err(|_| invalid())?)
        .bind(row.next_attempt_at)
        .bind(row.stored_at)
        .bind(row.deleted_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| refused(e, "save message media"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such message media"));
        }
        Ok(())
    }

    async fn for_messages(
        &mut self,
        messages: &[MessageId],
    ) -> Result<Vec<MessageMediaRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from message_media where workspace_id = $1 and message_id = any($2) \
             order by message_id, position"
        );
        let messages: Vec<Uuid> = messages.iter().map(|m| m.as_uuid()).collect();
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(messages)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list message media of messages"))?;
        rows.into_iter().map(Record::into_row).collect()
    }

    async fn due(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar(
            "select id from message_media where workspace_id = $1 and state = 'pending' \
             and (next_attempt_at is null or next_attempt_at <= $2) \
             order by created_at, id limit $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(now)
        .bind(i64::from(limit.min(MAX_MEDIA_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list due message media"))
    }

    async fn due_for_purge(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MessageMediaRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from message_media where workspace_id = $1 and state = 'stored' \
             and direction = 'inbound' and stored_at <= $2 order by stored_at, id limit $3"
        );
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(before)
            .bind(i64::from(limit.min(MAX_MEDIA_PAGE)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list message media due for purge"))?;
        rows.into_iter().map(Record::into_row).collect()
    }

    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError> {
        let total: i64 = sqlx::query_scalar(
            "select coalesce(sum(size_bytes), 0)::bigint from message_media \
             where workspace_id = $1 and direction = 'inbound' and stored_at >= $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count inbound message media bytes"))?;
        Ok(u64::try_from(total).unwrap_or(0))
    }

    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<ErasedFiles, AppError> {
        let rows: Vec<(Option<Uuid>, String, String, bool)> = sqlx::query_as(
            "with recursive family(id) as ( \
                 select id from people where workspace_id = $1 and id = $2 \
                 union select p.id from people p join family f on p.merged_into = f.id \
                 where p.workspace_id = $1), \
             targets as ( \
                 select mm.id, mm.file_id, mm.state, mm.source from message_media mm \
                 where mm.workspace_id = $1 and mm.message_id in ( \
                     select ms.id from messages ms join conversations c \
                     on c.workspace_id = ms.workspace_id and c.id = ms.conversation_id \
                     where ms.workspace_id = $1 and c.person_id in (select id from family))) \
             update message_media mm set filename = '', provider_media_id = null, \
                 state = case when t.state = 'deleted' then mm.state else 'deleted' end, \
                 reason = case when t.state = 'deleted' then mm.reason else 'erased' end, \
                 deleted_at = case when t.state = 'deleted' then mm.deleted_at else $3 end, \
                 file_id = case when t.state = 'deleted' then mm.file_id else null end, \
                 mime = case when t.state = 'deleted' then mm.mime else null end, \
                 sha256 = case when t.state = 'deleted' then mm.sha256 else null end, \
                 stored_at = case when t.state = 'deleted' then mm.stored_at else null end, \
                 next_attempt_at = null \
             from targets t where mm.workspace_id = $1 and mm.id = t.id \
             returning t.file_id, t.state, t.source, exists (                  select 1 from message_media o where o.workspace_id = $1                  and o.file_id = t.file_id and o.state = 'stored'                  and o.id not in (select id from targets))",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(person.as_uuid())
        .bind(at)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| refused(e, "erase a person's message media"))?;
        let mut out = ErasedFiles::default();
        for (file, state, source, shared) in rows {
            let Some(file) = file.map(FileId).filter(|_| state == "stored") else {
                continue;
            };
            match source.as_str() {
                "provider" => out.customer.push(file),
                "upload" if !shared && !out.uploads.contains(&file) => out.uploads.push(file),
                _ => {}
            }
        }
        Ok(out)
    }

    async fn kept(&mut self, of: &[FileId]) -> Result<Vec<FileId>, AppError> {
        let ids: Vec<Uuid> = of.iter().map(|f| f.0).collect();
        let found: Vec<Uuid> = sqlx::query_scalar(
            "select distinct file_id from message_media where workspace_id = $1 \
             and file_id = any($2) and state = 'stored' order by file_id",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(ids)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list kept message media"))?;
        Ok(found.into_iter().map(FileId).collect())
    }
}
