use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MergeRepo, MergeRow},
};
use jt_inbox::{MergeId, PersonId};
use time::OffsetDateTime;
#[async_trait]
impl MergeRepo for PgTenantRepos {
    async fn insert(&mut self, row: MergeRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "people", row.source_id.as_uuid()).await?;
        reference(self.tx.conn(), ws, "people", row.target_id.as_uuid()).await?;
        inserted(sqlx::query("insert into merges select * from jsonb_populate_record(null::merges,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert merge"))?)
    }
    async fn get(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(m) from merges m where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid()),
            self,
            MergeRow
        )
    }
    async fn lock(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(m) from merges m where workspace_id=$1 and id=$2 for update"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            MergeRow
        )
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<MergeRow>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(m) from merges m where workspace_id=$1 and (source_id=$2 or target_id=$2) order by at,id").bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,MergeRow)
    }
    async fn mark_undone(&mut self, id: MergeId, at: OffsetDateTime) -> Result<(), AppError> {
        changed(
            sqlx::query(
                "update merges set status='undone',undone_at=$3 where workspace_id=$1 and id=$2",
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "undo merge"))?,
        )
    }
}
