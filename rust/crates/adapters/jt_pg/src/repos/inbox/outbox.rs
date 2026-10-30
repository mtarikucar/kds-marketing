use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MAX_INBOX_PAGE, OutboxRepo, OutboxRow},
};
use jt_capability::CapabilityId;
use jt_inbox::MessageId;
use time::OffsetDateTime;
use uuid::Uuid;
#[async_trait]
impl OutboxRepo for PgTenantRepos {
    async fn insert(&mut self, row: OutboxRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "conversations",
            row.conversation_id.as_uuid(),
        )
        .await?;
        reference(self.tx.conn(), ws, "messages", row.message_id.as_uuid()).await?;
        reference(
            self.tx.conn(),
            ws,
            "capabilities",
            row.capability_id.as_uuid(),
        )
        .await?;
        inserted(sqlx::query("insert into outbox select * from jsonb_populate_record(null::outbox,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"store outbound intent"))?)
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(o) from outbox o where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id),
            self,
            OutboxRow
        )
    }
    async fn lock(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(o) from outbox o where workspace_id=$1 and id=$2 for update"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id),
            self,
            OutboxRow
        )
    }
    async fn list_pending(
        &mut self,
        state: &str,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<OutboxRow>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(o) from outbox o where workspace_id=$1 and state=$2 and updated_at<$3 order by updated_at,id limit $4").bind(self.workspace_id().as_uuid()).bind(state).bind(before).bind(i64::from(limit.clamp(1,MAX_INBOX_PAGE))),self,OutboxRow)
    }
    async fn update(&mut self, row: OutboxRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        changed(sqlx::query("update outbox set state=$3,attempts=$4,last_error=$5,fence_snapshot=$6,updated_at=$7 where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid()).bind(row.id).bind(row.state).bind(i64::from(row.attempts)).bind(row.last_error).bind(row.fence_snapshot).bind(row.updated_at).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"save outbound result"))?)
    }
    async fn failure_reasons(
        &mut self,
        messages: &[MessageId],
    ) -> Result<Vec<(MessageId, String)>, AppError> {
        if messages.is_empty() {
            return Ok(vec![]);
        }
        let ids: Vec<Uuid> = messages.iter().map(|m| m.as_uuid()).collect();
        let rows: Vec<(Uuid, String)> = sqlx::query_as("select message_id, last_error from outbox where workspace_id=$1 and message_id=any($2) and state in ('failed','unknown') and last_error is not null")
            .bind(self.workspace_id().as_uuid()).bind(&ids).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"read outbound failure reasons"))?;
        Ok(rows
            .into_iter()
            .map(|(id, reason)| (MessageId::from(id), reason))
            .collect())
    }
    async fn agent_public_replies_since(
        &mut self,
        capability: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from outbox where workspace_id=$1 and capability_id=$2 \
             and created_at>=$3 and state<>'refused' \
             and intent#>>'{public,visibility}'='public' \
             and intent#>>'{public,drafted_by,kind}'='agent'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(capability.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count agent public replies"))?;
        u32::try_from(n).map_err(|_| AppError::internal("agent public reply count overflows"))
    }
}
