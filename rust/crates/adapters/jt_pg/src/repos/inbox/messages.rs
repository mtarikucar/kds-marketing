use super::{changed, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MAX_INBOX_PAGE, MessageRepo},
};
use jt_inbox::{ConversationId, Message, MessageId, MsgStatus};
#[async_trait]
impl MessageRepo for PgTenantRepos {
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
        changed(sqlx::query("update messages set status=$3,external_id=coalesce($4,external_id),cost_minor=coalesce($5,cost_minor) where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(value!(status)).bind(external_id).bind(cost_minor).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"set message status"))?)
    }
}
