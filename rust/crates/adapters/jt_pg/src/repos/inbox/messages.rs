use super::{changed, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MAX_INBOX_PAGE, MessageRepo},
};
use jt_inbox::{ConversationId, IdentityId, Message, MessageId, MsgStatus};
#[async_trait]
impl MessageRepo for PgTenantRepos {
    async fn recent(&mut self, id: ConversationId, limit: u32) -> Result<Vec<Message>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(m) from (select * from messages where workspace_id=$1 and conversation_id=$2 order by at desc,id desc limit $3) m order by at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(i64::from(limit.clamp(1,500))),self,Message)
    }

    async fn record_inbound_sender(
        &mut self,
        message: MessageId,
        sender: IdentityId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let target: Option<(uuid::Uuid, Option<uuid::Uuid>)> = sqlx::query_as("select m.conversation_id,m.sender_identity_id from messages m join conversations c on (c.id,c.workspace_id)=(m.conversation_id,m.workspace_id) join identities i on i.workspace_id=c.workspace_id and i.person_id=c.person_id where m.workspace_id=$1 and m.id=$2 and i.id=$3 and i.active and m.direction='inbound' and i.channel=case c.kind_key when 'sms_line' then 'phone' when 'netgsm_pbx' then 'phone' when 'mailbox' then 'email' when 'whatsapp_cloud' then 'phone' when 'instagram_dm' then 'instagram_dm' when 'messenger' then 'messenger' else c.kind_key end")
            .bind(ws.as_uuid()).bind(message.as_uuid()).bind(sender.as_uuid()).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"validate inbound sender"))?;
        let (conversation, existing) =
            target.ok_or_else(|| AppError::not_found("no matching inbound sender"))?;
        if existing.is_some_and(|id| id != sender.as_uuid()) {
            return Err(AppError::conflict("inbound sender is immutable"));
        }
        let stored = sqlx::query("update messages set sender_identity_id=$3 where workspace_id=$1 and id=$2 and (sender_identity_id is null or sender_identity_id=$3)")
            .bind(ws.as_uuid())
            .bind(message.as_uuid())
            .bind(sender.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "store inbound sender"))?;
        if stored.rows_affected() != 1 {
            return Err(AppError::conflict("inbound sender is immutable"));
        }
        sqlx::query("update conversations c set last_inbound_identity_id=(select m.sender_identity_id from messages m where m.workspace_id=c.workspace_id and m.conversation_id=c.id and m.direction='inbound' and m.at=c.last_inbound_at order by m.id desc limit 1) where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid()).bind(conversation).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"bind latest inbound sender"))?;
        Ok(())
    }

    async fn get(&mut self, id: MessageId) -> Result<Option<Message>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(m) from messages m where workspace_id=$1 and id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Message
        )
    }
    async fn page(
        &mut self,
        conversation: ConversationId,
        after: Option<(time::OffsetDateTime, MessageId)>,
        limit: u32,
    ) -> Result<Vec<Message>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(m) from messages m where workspace_id=$1 and conversation_id=$2 and ($3::timestamptz is null or (at,id)>($3,$4)) order by at,id limit $5").bind(self.workspace_id().as_uuid()).bind(conversation.as_uuid()).bind(after.map(|v|v.0)).bind(after.map(|v|v.1.as_uuid())).bind(i64::from(limit.clamp(1,MAX_INBOX_PAGE))),self,Message)
    }
    async fn insert_if_new(&mut self, row: Message) -> Result<Option<MessageId>, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "conversations",
            row.conversation_id.as_uuid(),
        )
        .await?;
        let done=sqlx::query("insert into messages select * from jsonb_populate_record(null::messages,$1) where workspace_id=$2 on conflict do nothing").bind(value!(&row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert message"))?;
        if done.rows_affected() == 1 {
            super::touch_conversation(self, row.conversation_id).await?;
            return Ok(Some(row.id));
        }
        let replay: bool=sqlx::query_scalar("select exists(select 1 from messages where workspace_id=$1 and conversation_id=$2 and external_id=$3)").bind(ws.as_uuid()).bind(row.conversation_id.as_uuid()).bind(row.external_id).fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find duplicate message"))?;
        if replay {
            Ok(None)
        } else {
            Err(AppError::conflict("message id is already taken"))
        }
    }
    async fn list(&mut self, id: ConversationId, limit: u32) -> Result<Vec<Message>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(m) from messages m where workspace_id=$1 and conversation_id=$2 order by at,id limit $3").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(i64::from(limit.clamp(1,MAX_INBOX_PAGE))),self,Message)
    }
    async fn set_status(
        &mut self,
        id: MessageId,
        status: MsgStatus,
        external_id: Option<String>,
        cost_minor: Option<i64>,
    ) -> Result<(), AppError> {
        let parent: Option<uuid::Uuid> = sqlx::query_scalar(
            "select conversation_id from messages where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "message parent"))?;
        changed(sqlx::query("update messages set status=$3,external_id=coalesce($4,external_id),cost_minor=coalesce($5,cost_minor) where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(value!(status)).bind(external_id).bind(cost_minor).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"set message status"))?)?;
        if let Some(parent) = parent {
            super::touch_conversation(self, parent.into()).await?;
        }
        Ok(())
    }
}
