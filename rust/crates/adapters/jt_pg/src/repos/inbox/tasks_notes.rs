use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{NoteRepo, TaskRepo},
};
use jt_inbox::{JourneyId, Note, Task, TaskId, TaskStatus};
#[async_trait]
impl TaskRepo for PgTenantRepos {
    async fn insert(&mut self, row: Task) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "journeys", row.journey_id.as_uuid()).await?;
        inserted(sqlx::query("insert into tasks select * from jsonb_populate_record(null::tasks,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert task"))?)
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Task>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(t) from tasks t where workspace_id=$1 and journey_id=$2 order by due_at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()),self,Task)
    }
    async fn set_status(&mut self, id: TaskId, status: TaskStatus) -> Result<(), AppError> {
        changed(
            sqlx::query("update tasks set status=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid())
                .bind(value!(status).as_str())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set task status"))?,
        )
    }
}
#[async_trait]
impl NoteRepo for PgTenantRepos {
    async fn insert(&mut self, row: Note) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "journeys", row.journey_id.as_uuid()).await?;
        inserted(sqlx::query("insert into notes select * from jsonb_populate_record(null::notes,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert note"))?)
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Note>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(n) from notes n where workspace_id=$1 and journey_id=$2 order by at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()),self,Note)
    }
}
