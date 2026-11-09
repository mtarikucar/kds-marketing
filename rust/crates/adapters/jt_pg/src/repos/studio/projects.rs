use super::{PgTenantRepos, decode, encode, map_sqlx, revision};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::production_projects::{ProductionProject, ProjectRepo},
};
use serde_json::Value;
use uuid::Uuid;
#[async_trait]
impl ProjectRepo for PgTenantRepos {
    async fn get_project(&mut self, id: Uuid) -> Result<Option<ProductionProject>, AppError> {
        self.studio_record("studio_production_projects", id).await
    }
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar("select data from studio_production_projects where workspace_id=$1 and archived=$2 and ($3::uuid is null or id<$3) order by id desc limit 101")
            .bind(self.workspace_id().0).bind(archived).bind(before).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"list production projects"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn save_project(
        &mut self,
        p: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError> {
        if p.workspace_id != self.workspace_id() {
            return Err(AppError::internal("project workspace mismatch"));
        }
        if p.revision != expected.unwrap_or(0).saturating_add(1) {
            return Err(AppError::conflict("project revision changed"));
        }
        let count = if let Some(expected) = expected {
            sqlx::query("update studio_production_projects set data=$3,revision=$4,archived=$5 where workspace_id=$1 and id=$2 and revision=$6")
            .bind(p.workspace_id.0).bind(p.id).bind(encode(&p)?).bind(revision(p.revision)?).bind(p.archived).bind(revision(expected)?)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"update production project"))?.rows_affected()
        } else {
            sqlx::query("insert into studio_production_projects(workspace_id,id,revision,archived,data) values($1,$2,$3,$4,$5) on conflict do nothing")
            .bind(p.workspace_id.0).bind(p.id).bind(revision(p.revision)?).bind(p.archived).bind(encode(&p)?)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert production project"))?.rows_affected()
        };
        if count != 1 {
            return Err(AppError::conflict("project revision changed"));
        }
        Ok(())
    }
}
