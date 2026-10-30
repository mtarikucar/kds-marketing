//! Public items (0019): comments and marketplace questions. `answer` is the item's
//! `AnswerState` as JSON; its generated `answer_state` column is read by the indexes and never
//! written here.

use super::{changed, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MAX_INBOX_PAGE, PublicItemRepo},
};
use jt_capability::CapabilityId;
use jt_inbox::{ConversationId, PublicItem, PublicItemId};
use time::OffsetDateTime;
use uuid::Uuid;

/// The columns an insert writes: every column but the generated `answer_state`.
const COLUMNS: &str = "workspace_id,id,capability_id,conversation_id,message_id,subject_id,kind,\
    external_id,parent_external_id,root_external_id,created_at,deadline,private_reply_until,answer,\
    moderation,private_reply_message_id,agent_replied,checked_at,updated_at";

/// The workspace's message and subject references of `item`, each `NOT_FOUND` when missing.
async fn references(r: &mut PgTenantRepos, item: &PublicItem) -> Result<(), AppError> {
    let ws = r.workspace_id();
    reference(r.tx.conn(), ws, "messages", item.message_id.as_uuid()).await?;
    if let Some(subject) = item.subject_id {
        reference(r.tx.conn(), ws, "public_subjects", subject.as_uuid()).await?;
    }
    if let Some(private) = item.private_reply_message_id {
        reference(r.tx.conn(), ws, "messages", private.as_uuid()).await?;
    }
    Ok(())
}

fn page(limit: u32) -> i64 {
    i64::from(limit.clamp(1, MAX_INBOX_PAGE))
}

#[async_trait]
impl PublicItemRepo for PgTenantRepos {
    async fn insert(&mut self, item: PublicItem) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, item.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "capabilities",
            item.capability_id.as_uuid(),
        )
        .await?;
        reference(
            self.tx.conn(),
            ws,
            "conversations",
            item.conversation_id.as_uuid(),
        )
        .await?;
        references(self, &item).await?;
        let done = sqlx::query(&format!(
            "insert into public_items ({COLUMNS}) select {COLUMNS} from \
             jsonb_populate_record(null::public_items,$1) where workspace_id=$2 \
             on conflict (workspace_id,capability_id,external_id) do nothing"
        ))
        .bind(value!(&item))
        .bind(ws.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert public item"))?;
        Ok(done.rows_affected() == 1)
    }
    async fn get(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 and id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            PublicItem
        )
    }
    async fn lock(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 and id=$2 for update"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            PublicItem
        )
    }
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicItem>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 \
                 and capability_id=$2 and external_id=$3"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(capability.as_uuid())
            .bind(external_id),
            self,
            PublicItem
        )
    }
    async fn update(&mut self, item: PublicItem) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, item.workspace_id)?;
        references(self, &item).await?;
        changed(
            sqlx::query(
                "update public_items set message_id=$3,subject_id=$4,deadline=$5,\
                 private_reply_until=$6,answer=$7,moderation=$8,private_reply_message_id=$9,\
                 agent_replied=$10,checked_at=$11,updated_at=$12 where workspace_id=$1 and id=$2",
            )
            .bind(ws.as_uuid())
            .bind(item.id.as_uuid())
            .bind(item.message_id.as_uuid())
            .bind(item.subject_id.map(|s| s.as_uuid()))
            .bind(item.deadline)
            .bind(item.private_reply_until)
            .bind(value!(&item.answer))
            .bind(item.moderation.key())
            .bind(item.private_reply_message_id.map(|m| m.as_uuid()))
            .bind(item.agent_replied)
            .bind(item.checked_at)
            .bind(item.updated_at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "update public item"))?,
        )
    }
    async fn for_conversation(
        &mut self,
        conversation: ConversationId,
    ) -> Result<Vec<PublicItem>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 \
                 and conversation_id=$2 order by created_at,id"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(conversation.as_uuid()),
            self,
            PublicItem
        )
    }
    async fn thread(
        &mut self,
        capability: CapabilityId,
        root_external_id: &str,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 \
                 and capability_id=$2 and root_external_id=$3 order by created_at,id limit $4"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(capability.as_uuid())
            .bind(root_external_id)
            .bind(page(limit)),
            self,
            PublicItem
        )
    }
    async fn due_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 \
                 and deadline is not null and deadline<$2 \
                 and answer_state in ('awaiting','rejected','pending') \
                 order by deadline,id limit $3"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(before)
            .bind(page(limit)),
            self,
            PublicItem
        )
    }
    async fn to_reconcile(
        &mut self,
        capability: CapabilityId,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(i) from public_items i where workspace_id=$1 \
                 and capability_id=$2 and answer_state in ('awaiting','rejected','pending') \
                 order by checked_at nulls first,id limit $3"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(capability.as_uuid())
            .bind(page(limit)),
            self,
            PublicItem
        )
    }
    async fn mark_checked(
        &mut self,
        ids: &[PublicItemId],
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        if ids.is_empty() {
            return Ok(());
        }
        let ids: Vec<Uuid> = ids.iter().map(|id| id.as_uuid()).collect();
        sqlx::query("update public_items set checked_at=$3 where workspace_id=$1 and id=any($2)")
            .bind(self.workspace_id().as_uuid())
            .bind(&ids)
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "mark public items checked"))?;
        Ok(())
    }
    async fn agent_public_replies_since(
        &mut self,
        capability: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from public_items i join messages m \
             on m.workspace_id=i.workspace_id and m.id=(i.answer->>'message_id')::uuid \
             where i.workspace_id=$1 and i.capability_id=$2 and i.agent_replied and m.at>=$3",
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
