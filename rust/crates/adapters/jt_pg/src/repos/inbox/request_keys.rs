use super::map_sqlx;
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::RequestKeyRepo};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
#[async_trait]
impl RequestKeyRepo for PgTenantRepos {
    async fn get(&mut self, key: &str, now: OffsetDateTime) -> Result<Option<Value>, AppError> {
        sqlx::query_scalar(
            "select response from request_keys where workspace_id=$1 and key=$2 and at>$3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(key)
        .bind(now - Duration::hours(24))
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read request key"))
    }
    async fn store(
        &mut self,
        key: &str,
        response: Value,
        now: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done=sqlx::query("insert into request_keys (workspace_id,key,response,at) values ($1,$2,$3,$4) on conflict (workspace_id,key) do update set response=excluded.response,at=excluded.at where request_keys.at <= $5")
            .bind(self.workspace_id().as_uuid()).bind(key).bind(response).bind(now).bind(now-Duration::hours(24))
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"store request key"))?;
        Ok(done.rows_affected() == 1)
    }
}
