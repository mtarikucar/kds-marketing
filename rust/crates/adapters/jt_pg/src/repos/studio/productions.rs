use super::{PgTenantRepos, decode, encode, map_sqlx, revision};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::material_productions::{ProductionRecord, ProductionRepo},
};
use serde_json::Value;
use uuid::Uuid;
#[async_trait]
impl ProductionRepo for PgTenantRepos {
    async fn get_production(&mut self, id: Uuid) -> Result<Option<ProductionRecord>, AppError> {
        self.studio_record("studio_material_productions", id).await
    }
    async fn list_productions(&mut self) -> Result<Vec<ProductionRecord>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_material_productions where workspace_id=$1 order by id desc",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list material productions"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn save_production(
        &mut self,
        row: ProductionRecord,
        expected: Option<u64>,
    ) -> Result<(), AppError> {
        let p = &row.production;
        if p.workspace_id != self.workspace_id() {
            return Err(AppError::internal("production workspace mismatch"));
        }
        if p.revision != expected.unwrap_or(0).saturating_add(1) {
            return Err(AppError::conflict("production revision changed"));
        }
        let count = if let Some(expected) = expected {
            sqlx::query("update studio_material_productions set data=$3,revision=$4 where workspace_id=$1 and id=$2 and revision=$5")
            .bind(p.workspace_id.0).bind(p.id).bind(encode(&row)?).bind(revision(p.revision)?).bind(revision(expected)?)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"update material production"))?.rows_affected()
        } else {
            sqlx::query("insert into studio_material_productions(workspace_id,id,revision,data) values($1,$2,$3,$4) on conflict do nothing")
            .bind(p.workspace_id.0).bind(p.id).bind(revision(p.revision)?).bind(encode(&row)?)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert material production"))?.rows_affected()
        };
        if count != 1 {
            return Err(AppError::conflict("production revision changed"));
        }
        Ok(())
    }
}
