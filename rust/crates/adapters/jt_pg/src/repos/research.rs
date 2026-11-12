//! `research_tasks` (migration `0020_prospects`): the briefs agents fill the pool from. `kind`,
//! `brief`, `claim` and `created_by` keep the domain's encoding as JSON; one open standing task
//! per ICP entry and strategy version is the partial unique index `research_tasks_one_standing`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::prospects::{
    ListCursor, MAX_PROSPECT_PAGE, Page, ResearchTaskQuery, ResearchTaskRepo,
};
use jt_prospects::{Claim, ResearchTask, ResearchTaskId, TaskStatus};
use jt_strategy::StrategyVersionId;
use jt_tenancy::WorkspaceId;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

/// The columns a [`Record`] is read from.
const COLUMNS: &str = "workspace_id, id, kind, strategy_version_id, brief, rubric_digest, \
                       daily_cap, status, claim, created_by, created_at, closed_at, close_note";

#[derive(sqlx::FromRow)]
struct Record {
    workspace_id: Uuid,
    id: Uuid,
    kind: Value,
    strategy_version_id: Uuid,
    brief: Value,
    rubric_digest: String,
    daily_cap: i32,
    status: String,
    claim: Option<Value>,
    created_by: Value,
    created_at: OffsetDateTime,
    closed_at: Option<OffsetDateTime>,
    close_note: String,
}

fn decode<T: DeserializeOwned>(v: Value, column: &str) -> Result<T, AppError> {
    serde_json::from_value(v).map_err(|_| AppError::internal(format!("invalid stored {column}")))
}

fn encode<T: Serialize>(v: &T, what: &str) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| AppError::internal(format!("cannot encode {what}")))
}

impl Record {
    fn into_task(self) -> Result<ResearchTask, AppError> {
        Ok(ResearchTask {
            id: ResearchTaskId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            kind: decode(self.kind, "research_tasks.kind")?,
            strategy_version_id: StrategyVersionId(self.strategy_version_id),
            brief: decode(self.brief, "research_tasks.brief")?,
            rubric_digest: self.rubric_digest,
            daily_cap: stored(
                u16::try_from(self.daily_cap).ok(),
                "research_tasks.daily_cap",
            )?,
            status: stored(TaskStatus::parse(&self.status), "research_tasks.status")?,
            claim: self
                .claim
                .map(|c| decode::<Claim>(c, "research_tasks.claim"))
                .transpose()?,
            created_by: decode(self.created_by, "research_tasks.created_by")?,
            created_at: self.created_at,
            closed_at: self.closed_at,
            close_note: self.close_note,
        })
    }
}

impl PgTenantRepos {
    async fn one_task(
        &mut self,
        id: ResearchTaskId,
        lock: bool,
    ) -> Result<Option<ResearchTask>, AppError> {
        let sql = format!(
            "select {COLUMNS} from research_tasks where workspace_id = $1 and id = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read research task"))?;
        row.map(Record::into_task).transpose()
    }
}

#[async_trait]
impl ResearchTaskRepo for PgTenantRepos {
    async fn insert(&mut self, t: &ResearchTask) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, t.workspace_id)?;
        let version: bool = sqlx::query_scalar(
            "select exists(select 1 from strategy_versions where workspace_id = $1 and id = $2)",
        )
        .bind(ws.as_uuid())
        .bind(t.strategy_version_id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read strategy version"))?;
        if !version {
            return Err(AppError::not_found("no such strategy version"));
        }
        let inserted = sqlx::query(
            "insert into research_tasks (workspace_id, id, kind, strategy_version_id, brief, \
             rubric_digest, daily_cap, status, claim, created_by, created_at, closed_at, \
             close_note) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(t.id.as_uuid())
        .bind(encode(&t.kind, "task kind")?)
        .bind(t.strategy_version_id.as_uuid())
        .bind(encode(&t.brief, "task brief")?)
        .bind(&t.rubric_digest)
        .bind(i32::from(t.daily_cap))
        .bind(t.status.key())
        .bind(
            t.claim
                .as_ref()
                .map(|c| encode(c, "task claim"))
                .transpose()?,
        )
        .bind(encode(&t.created_by, "task recorder")?)
        .bind(t.created_at)
        .bind(t.closed_at)
        .bind(&t.close_note)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert research task"))?;
        if inserted.rows_affected() == 1 {
            return Ok(true);
        }
        let taken: bool = sqlx::query_scalar(
            "select exists(select 1 from research_tasks where workspace_id = $1 and id = $2)",
        )
        .bind(ws.as_uuid())
        .bind(t.id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read research task"))?;
        if taken {
            Err(AppError::conflict("the research task id is already taken"))
        } else {
            Ok(false)
        }
    }

    async fn get(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError> {
        self.one_task(id, false).await
    }

    async fn lock(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError> {
        self.one_task(id, true).await
    }

    async fn list(&mut self, q: &ResearchTaskQuery) -> Result<Page<ResearchTask>, AppError> {
        let limit = q.limit.clamp(1, MAX_PROSPECT_PAGE);
        let sql = format!(
            "select {COLUMNS} from research_tasks where workspace_id = $1 \
             and ($2::text is null or status = $2) \
             and ($3::timestamptz is null or (created_at, id) < ($3, $4)) \
             order by created_at desc, id desc limit $5"
        );
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(q.status.map(|s| s.key()))
            .bind(q.after.map(|c| c.created_at))
            .bind(q.after.map(|c| c.id))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list research tasks"))?;
        let mut items = rows
            .into_iter()
            .map(Record::into_task)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|t| ListCursor {
                created_at: t.created_at,
                id: t.id.as_uuid(),
            })
        } else {
            None
        };
        Ok(Page { items, next })
    }

    async fn open_standing(
        &mut self,
        version: StrategyVersionId,
    ) -> Result<Vec<ResearchTask>, AppError> {
        let sql = format!(
            "select {COLUMNS} from research_tasks where workspace_id = $1 \
             and strategy_version_id = $2 and status = 'open' and kind->>'type' = 'standing' \
             order by created_at, id"
        );
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(version.as_uuid())
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list open standing tasks"))?;
        rows.into_iter().map(Record::into_task).collect()
    }

    async fn set_status(
        &mut self,
        id: ResearchTaskId,
        status: TaskStatus,
        at: OffsetDateTime,
        note: &str,
    ) -> Result<(), AppError> {
        let open = status == TaskStatus::Open;
        let done = sqlx::query(
            "update research_tasks set status = $3, closed_at = $4, close_note = $5 \
             where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(status.key())
        .bind((!open).then_some(at))
        .bind(if open { "" } else { note })
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set research task status"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such research task"));
        }
        Ok(())
    }

    async fn set_claim(
        &mut self,
        id: ResearchTaskId,
        claim: Option<&Claim>,
    ) -> Result<(), AppError> {
        let done =
            sqlx::query("update research_tasks set claim = $3 where workspace_id = $1 and id = $2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid())
                .bind(claim.map(|c| encode(c, "task claim")).transpose()?)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set research task claim"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such research task"));
        }
        Ok(())
    }
}
