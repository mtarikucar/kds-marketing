use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{NoteRepo, TaskQueue, TaskRepo},
};
use jt_inbox::{JourneyId, Note, Task, TaskId, TaskStatus};
#[async_trait]
impl TaskRepo for PgTenantRepos {
    async fn get(&mut self, id: TaskId) -> Result<Option<Task>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(t) from tasks t where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid()),
            self,
            Task
        )
    }
    async fn query(
        &mut self,
        queue: TaskQueue,
        assignee: Option<jt_tenancy::UserId>,
        now: time::OffsetDateTime,
    ) -> Result<Vec<Task>, AppError> {
        let queue = match queue {
            TaskQueue::Due24h => "due_24h",
            TaskQueue::Overdue => "overdue",
            TaskQueue::All => "all",
        };
        many!(sqlx::query_scalar("select to_jsonb(t) from tasks t where workspace_id=$1 and status='open' and ($2::uuid is null or assignee=$2) and ($3='all' or ($3='overdue' and due_at<$4) or ($3='due_24h' and due_at between $4 and $4+interval '24 hours')) order by due_at,id").bind(self.workspace_id().as_uuid()).bind(assignee.map(|v|v.as_uuid())).bind(queue).bind(now),self,Task)
    }
    async fn insert(&mut self, row: Task) -> Result<(), AppError> {
        let parent = row.journey_id;
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "journeys", row.journey_id.as_uuid()).await?;
        inserted(sqlx::query("insert into tasks select * from jsonb_populate_record(null::tasks,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert task"))?)?;
        super::touch_journey(self, parent).await
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Task>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(t) from tasks t where workspace_id=$1 and journey_id=$2 order by due_at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()),self,Task)
    }
    async fn set_status(&mut self, id: TaskId, status: TaskStatus) -> Result<(), AppError> {
        let parent = TaskRepo::get(self, id)
            .await?
            .ok_or_else(|| AppError::not_found("no such task"))?
            .journey_id;
        changed(
            sqlx::query("update tasks set status=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid())
                .bind(value!(status).as_str())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set task status"))?,
        )?;
        super::touch_journey(self, parent).await
    }
}
#[async_trait]
impl NoteRepo for PgTenantRepos {
    async fn insert(&mut self, row: Note) -> Result<(), AppError> {
        let parent = row.journey_id;
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "journeys", row.journey_id.as_uuid()).await?;
        inserted(sqlx::query("insert into notes select * from jsonb_populate_record(null::notes,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert note"))?)?;
        super::touch_journey(self, parent).await
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Note>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(n) from notes n where workspace_id=$1 and journey_id=$2 order by at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()),self,Note)
    }
}
