use super::{map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{LOST_REASON_DEFAULTS, LostReasonRepo, LostReasonRow},
};
use jt_tenancy::WorkspaceId;
use sqlx::PgConnection;

pub(crate) async fn initialize(conn: &mut PgConnection, ws: WorkspaceId) -> Result<(), AppError> {
    for (key, label) in LOST_REASON_DEFAULTS {
        sqlx::query("insert into lost_reasons (workspace_id,key,label,active,seeded) values ($1,$2,$3,true,true) on conflict do nothing")
            .bind(ws.as_uuid()).bind(key).bind(label).execute(&mut *conn).await.map_err(|e| map_sqlx(e,"initialize lost reasons"))?;
    }
    Ok(())
}
#[async_trait]
impl LostReasonRepo for PgTenantRepos {
    async fn initialize(&mut self) -> Result<(), AppError> {
        let ws = self.workspace_id();
        initialize(self.tx.conn(), ws).await
    }
    async fn list(&mut self) -> Result<Vec<LostReasonRow>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(r) from lost_reasons r where workspace_id=$1 order by key"
            )
            .bind(self.workspace_id().as_uuid()),
            self,
            LostReasonRow
        )
    }
    async fn set(&mut self, row: LostReasonRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        sqlx::query("insert into lost_reasons (workspace_id,key,label,active,seeded) values ($1,$2,$3,$4,$5) on conflict (workspace_id,key) do update set label=excluded.label,active=excluded.active")
            .bind(ws.as_uuid()).bind(row.key).bind(row.label).bind(row.active).bind(row.seeded).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"set lost reason"))?;
        Ok(())
    }
}
