//! `mail_files` (migration `0028_mail_files`): the records of email attachments. The table's
//! checks and composite foreign keys hold the rules of `jt_app::ports::mail_files`; a write that
//! breaks one, or names a capability, message or person of no row of the workspace, is
//! `INTERNAL`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::mail_files::{
    MAX_MAIL_FILE_PAGE, MailFileDirection, MailFileRepo, MailFileRow, MailFileState, SkipReason,
};
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::map_sqlx;
use crate::repos::stored;
use crate::uow::PgTenantRepos;

const COLUMNS: &str = "id, direction, state, skip_reason, capability_id, event_external_id, \
                       message_id, person_id, filename, declared_mime, size_bytes, sha256, \
                       created_at, expires_at, deleted_at";

/// The states whose rows stand for bytes the store holds.
const HOLDING: &str = "('stored', 'staged', 'attached')";

#[derive(sqlx::FromRow)]
struct Record {
    id: Uuid,
    direction: String,
    state: String,
    skip_reason: Option<String>,
    capability_id: Option<Uuid>,
    event_external_id: Option<String>,
    message_id: Option<Uuid>,
    person_id: Option<Uuid>,
    filename: String,
    declared_mime: String,
    size_bytes: i64,
    sha256: Option<String>,
    created_at: OffsetDateTime,
    expires_at: Option<OffsetDateTime>,
    deleted_at: Option<OffsetDateTime>,
}

impl Record {
    fn into_row(self) -> Result<MailFileRow, AppError> {
        Ok(MailFileRow {
            id: FileId(self.id),
            direction: stored(
                MailFileDirection::parse(&self.direction),
                "mail_files.direction",
            )?,
            state: stored(MailFileState::parse(&self.state), "mail_files.state")?,
            skip_reason: self
                .skip_reason
                .map(|r| stored(SkipReason::parse(&r), "mail_files.skip_reason"))
                .transpose()?,
            capability_id: self.capability_id.map(CapabilityId::from),
            event_external_id: self.event_external_id,
            message_id: self.message_id.map(MessageId::from),
            person_id: self.person_id.map(PersonId::from),
            filename: self.filename,
            declared_mime: self.declared_mime,
            size_bytes: stored(u64::try_from(self.size_bytes).ok(), "mail_files.size_bytes")?,
            sha256: self.sha256,
            created_at: self.created_at,
            expires_at: self.expires_at,
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
        Some("23503") => AppError::internal("mail_files references a row that does not exist"),
        Some("23514") => AppError::internal("invalid mail file row"),
        _ => map_sqlx(e, what),
    }
}

fn ids(of: &[FileId]) -> Vec<Uuid> {
    of.iter().map(|id| id.0).collect()
}

fn count(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl PgTenantRepos {
    async fn mail_one(&mut self, id: FileId, lock: bool) -> Result<Option<MailFileRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from mail_files where workspace_id = $1 and id = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id.0)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read mail file"))?;
        row.map(Record::into_row).transpose()
    }
}

/// The ids among the erased `rows` (each id with its state before the erasure) whose rows held
/// bytes.
fn erased(rows: Vec<(Uuid, String)>) -> Vec<FileId> {
    rows.into_iter()
        .filter(|(_, state)| MailFileState::parse(state).is_some_and(MailFileState::holds_bytes))
        .map(|(id, _)| FileId(id))
        .collect()
}

#[async_trait]
impl MailFileRepo for PgTenantRepos {
    async fn insert(&mut self, row: MailFileRow) -> Result<(), AppError> {
        let size = i64::try_from(row.size_bytes)
            .map_err(|_| AppError::internal("invalid mail file row"))?;
        sqlx::query(
            "insert into mail_files (workspace_id, id, direction, state, skip_reason, \
             capability_id, event_external_id, message_id, person_id, filename, declared_mime, \
             size_bytes, sha256, created_at, expires_at, deleted_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id.0)
        .bind(row.direction.key())
        .bind(row.state.key())
        .bind(row.skip_reason.map(SkipReason::key))
        .bind(row.capability_id.map(|c| c.as_uuid()))
        .bind(row.event_external_id.as_deref())
        .bind(row.message_id.map(|m| m.as_uuid()))
        .bind(row.person_id.map(|p| p.as_uuid()))
        .bind(&row.filename)
        .bind(&row.declared_mime)
        .bind(size)
        .bind(row.sha256.as_deref())
        .bind(row.created_at)
        .bind(row.expires_at)
        .bind(row.deleted_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| refused(e, "insert mail file"))?;
        Ok(())
    }

    async fn get(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError> {
        self.mail_one(id, false).await
    }

    async fn lock(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError> {
        self.mail_one(id, true).await
    }

    async fn link_event_to_message(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError> {
        let done = sqlx::query(
            "update mail_files set message_id = $4, person_id = $5 \
             where workspace_id = $1 and direction = 'inbound' and capability_id = $2 \
             and event_external_id = $3 and message_id is null",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(capability.as_uuid())
        .bind(event_external_id)
        .bind(message.as_uuid())
        .bind(person.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| refused(e, "link mail files"))?;
        Ok(count(done.rows_affected()))
    }

    async fn attach(
        &mut self,
        of: &[FileId],
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError> {
        let done = sqlx::query(
            "update mail_files set state = 'attached', message_id = $3, person_id = $4, \
             expires_at = null where workspace_id = $1 and id = any($2) and state = 'staged'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(ids(of))
        .bind(message.as_uuid())
        .bind(person.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| refused(e, "attach mail files"))?;
        Ok(count(done.rows_affected()))
    }

    async fn for_messages(&mut self, messages: &[MessageId]) -> Result<Vec<MailFileRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from mail_files where workspace_id = $1 and message_id = any($2) \
             order by created_at, id"
        );
        let messages: Vec<Uuid> = messages.iter().map(|m| m.as_uuid()).collect();
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(messages)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list mail files of messages"))?;
        rows.into_iter().map(Record::into_row).collect()
    }

    async fn due_for_purge(
        &mut self,
        inbound_before: OffsetDateTime,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MailFileRow>, AppError> {
        let sql = format!(
            "select {COLUMNS} from mail_files where workspace_id = $1 and \
             ((direction = 'inbound' and state = 'stored' and created_at <= $2) \
             or (state = 'staged' and expires_at <= $3)) \
             order by created_at, id limit $4"
        );
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(inbound_before)
            .bind(now)
            .bind(i64::from(limit.min(MAX_MAIL_FILE_PAGE)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list mail files due for purge"))?;
        rows.into_iter().map(Record::into_row).collect()
    }

    async fn mark_deleted(&mut self, of: &[FileId], at: OffsetDateTime) -> Result<u32, AppError> {
        let sql = format!(
            "update mail_files set state = 'deleted', deleted_at = $3 \
             where workspace_id = $1 and id = any($2) and state in {HOLDING}"
        );
        let done = sqlx::query(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(ids(of))
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| refused(e, "mark mail files deleted"))?;
        Ok(count(done.rows_affected()))
    }

    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        let sql = format!(
            "with recursive family(id) as ( \
                 select id from people where workspace_id = $1 and id = $2 \
                 union select p.id from people p join family f on p.merged_into = f.id \
                 where p.workspace_id = $1), \
             targets as ( \
                 select m.id, m.state from mail_files m where m.workspace_id = $1 and \
                 (m.person_id in (select id from family) or m.message_id in ( \
                     select ms.id from messages ms join conversations c \
                     on c.workspace_id = ms.workspace_id and c.id = ms.conversation_id \
                     where ms.workspace_id = $1 and c.person_id in (select id from family)))) \
             update mail_files m set filename = '', \
                 state = case when t.state in {HOLDING} then 'deleted' else m.state end, \
                 deleted_at = case when t.state in {HOLDING} then $3 else m.deleted_at end \
             from targets t where m.workspace_id = $1 and m.id = t.id \
             returning m.id, t.state"
        );
        let rows: Vec<(Uuid, String)> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(person.as_uuid())
            .bind(at)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| refused(e, "erase a person's mail files"))?;
        Ok(erased(rows))
    }

    async fn erase_event(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        let sql = format!(
            "with targets as ( \
                 select id, state from mail_files where workspace_id = $1 \
                 and direction = 'inbound' and capability_id = $2 and event_external_id = $3 \
                 and message_id is null) \
             update mail_files m set filename = '', \
                 state = case when t.state in {HOLDING} then 'deleted' else m.state end, \
                 deleted_at = case when t.state in {HOLDING} then $4 else m.deleted_at end \
             from targets t where m.workspace_id = $1 and m.id = t.id \
             returning m.id, t.state"
        );
        let rows: Vec<(Uuid, String)> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(capability.as_uuid())
            .bind(event_external_id)
            .bind(at)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| refused(e, "erase an email's mail files"))?;
        Ok(erased(rows))
    }

    async fn kept(&mut self, of: &[FileId]) -> Result<Vec<FileId>, AppError> {
        let sql = format!(
            "select id from mail_files where workspace_id = $1 and id = any($2) \
             and state in {HOLDING} order by id"
        );
        let found: Vec<Uuid> = sqlx::query_scalar(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(ids(of))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list kept mail files"))?;
        Ok(found.into_iter().map(FileId).collect())
    }

    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError> {
        let total: i64 = sqlx::query_scalar(
            "select coalesce(sum(size_bytes), 0)::bigint from mail_files where workspace_id = $1 \
             and direction = 'inbound' and sha256 is not null and created_at >= $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count inbound mail bytes"))?;
        Ok(u64::try_from(total).unwrap_or(0))
    }
}
