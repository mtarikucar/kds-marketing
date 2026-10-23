use super::{map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{
        connectors::{MailboxCursor, MailboxPosition},
        inbox::MailCursorRepo,
    },
};
use jt_capability::CapabilityId;
#[async_trait]
impl MailCursorRepo for PgTenantRepos {
    async fn get(&mut self, capability: CapabilityId) -> Result<MailboxCursor, AppError> {
        let rows:Vec<(String,i64,i64)>=sqlx::query_as("select mailbox,uidvalidity,last_uid from mail_cursors where workspace_id=$1 and capability_id=$2 order by mailbox")
            .bind(self.workspace_id().as_uuid()).bind(capability.as_uuid()).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"read mailbox cursor"))?;
        let mut cursor = MailboxCursor::default();
        for (name, validity, uid) in rows {
            cursor.mailboxes.insert(
                name,
                MailboxPosition {
                    uidvalidity: u32::try_from(validity)
                        .map_err(|_| AppError::internal("invalid UIDVALIDITY"))?,
                    last_uid: u32::try_from(uid).map_err(|_| AppError::internal("invalid UID"))?,
                },
            );
        }
        Ok(cursor)
    }
    async fn store(
        &mut self,
        capability: CapabilityId,
        cursor: MailboxCursor,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "capabilities", capability.as_uuid()).await?;
        for (name, position) in cursor.mailboxes {
            sqlx::query("insert into mail_cursors(workspace_id,capability_id,mailbox,uidvalidity,last_uid) values ($1,$2,$3,$4,$5) on conflict(workspace_id,capability_id,mailbox) do update set uidvalidity=excluded.uidvalidity,last_uid=excluded.last_uid")
                .bind(ws.as_uuid()).bind(capability.as_uuid()).bind(name).bind(i64::from(position.uidvalidity)).bind(i64::from(position.last_uid))
                .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"store mailbox cursor"))?;
        }
        Ok(())
    }
}
