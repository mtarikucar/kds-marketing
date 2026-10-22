//! `consultation_entries`: the append-only log of how each strategy version was worked out. A
//! trigger refuses every update and delete; the actor is stored as in `ledger_entries`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{ConsultationRepo, MAX_CONSULTATION_PAGE};
use jt_strategy::{ConsultationEntry, ConsultationEntryId, ConsultationKind, StrategyVersionId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::strategy::ensure_version;
use super::{actor_columns, map_sqlx, stored, stored_actor};
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct EntryRecord {
    id: Uuid,
    version_id: Uuid,
    kind: String,
    section_key: Option<String>,
    text: String,
    actor_kind: String,
    actor_user_id: Option<Uuid>,
    agent_connection_id: Option<Uuid>,
    actor_component: Option<String>,
    at: OffsetDateTime,
}

impl EntryRecord {
    fn into_entry(self) -> Result<ConsultationEntry, AppError> {
        Ok(ConsultationEntry {
            id: ConsultationEntryId(self.id),
            version_id: StrategyVersionId(self.version_id),
            kind: stored(
                ConsultationKind::parse(&self.kind),
                "consultation_entries.kind",
            )?,
            section_key: self.section_key,
            text: self.text,
            actor: stored_actor(
                "consultation_entries",
                &self.actor_kind,
                self.actor_user_id,
                self.agent_connection_id,
                self.actor_component,
            )?,
            at: self.at,
        })
    }
}

#[async_trait]
impl ConsultationRepo for PgTenantRepos {
    async fn append(&mut self, entry: ConsultationEntry) -> Result<ConsultationEntryId, AppError> {
        let ws = self.workspace_id();
        ensure_version(self.tx.conn(), ws, entry.version_id).await?;
        let (actor_kind, actor_user_id, agent_connection_id, actor_component) =
            actor_columns(&entry.actor);
        let done = sqlx::query(
            "insert into consultation_entries (id, workspace_id, version_id, kind, section_key, \
             text, actor_kind, actor_user_id, agent_connection_id, actor_component, at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing",
        )
        .bind(entry.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(entry.version_id.as_uuid())
        .bind(entry.kind.key())
        .bind(&entry.section_key)
        .bind(&entry.text)
        .bind(actor_kind)
        .bind(actor_user_id)
        .bind(agent_connection_id)
        .bind(actor_component)
        .bind(entry.at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "append consultation entry"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the consultation entry id is already taken",
            ));
        }
        Ok(entry.id)
    }

    async fn list(
        &mut self,
        version_id: StrategyVersionId,
        limit: u32,
        before: Option<(OffsetDateTime, ConsultationEntryId)>,
    ) -> Result<Vec<ConsultationEntry>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<EntryRecord> = sqlx::query_as(
            "select id, version_id, kind, section_key, text, actor_kind, actor_user_id, \
             agent_connection_id, actor_component, at from consultation_entries \
             where workspace_id = $1 and version_id = $2 \
             and ($3::timestamptz is null or (at, id) < ($3::timestamptz, $4::uuid)) \
             order by at desc, id desc \
             limit $5",
        )
        .bind(ws.as_uuid())
        .bind(version_id.as_uuid())
        .bind(before.map(|(at, _)| at))
        .bind(before.map(|(_, id)| id.as_uuid()))
        .bind(i64::from(limit.clamp(1, MAX_CONSULTATION_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list consultation entries"))?;
        records.into_iter().map(EntryRecord::into_entry).collect()
    }

    async fn count(&mut self, version_id: StrategyVersionId) -> Result<i64, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select count(*) from consultation_entries where workspace_id = $1 and version_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(version_id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count consultation entries"))
    }
}
