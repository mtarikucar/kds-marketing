//! Public poll cursors (0019): where a polled surface's next poll starts, one per capability.

use super::{map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::PublicCursorRepo};
use jt_capability::CapabilityId;
use serde_json::Value;
use time::OffsetDateTime;

#[async_trait]
impl PublicCursorRepo for PgTenantRepos {
    async fn get(&mut self, capability: CapabilityId) -> Result<Option<Value>, AppError> {
        sqlx::query_scalar(
            "select cursor from public_cursors where workspace_id=$1 and capability_id=$2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(capability.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read public cursor"))
    }
    async fn store(
        &mut self,
        capability: CapabilityId,
        cursor: Value,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        if !cursor.is_object() {
            return Err(AppError::internal("a public cursor is a JSON object"));
        }
        reference(self.tx.conn(), ws, "capabilities", capability.as_uuid()).await?;
        sqlx::query(
            "insert into public_cursors (workspace_id,capability_id,cursor,updated_at) \
             values ($1,$2,$3,$4) on conflict (workspace_id,capability_id) \
             do update set cursor=excluded.cursor,updated_at=excluded.updated_at",
        )
        .bind(ws.as_uuid())
        .bind(capability.as_uuid())
        .bind(cursor)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store public cursor"))?;
        Ok(())
    }
}
