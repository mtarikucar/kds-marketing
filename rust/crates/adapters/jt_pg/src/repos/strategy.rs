//! `strategy_versions`: the numbered versions of a workspace's strategy.
//!
//! `sections` is the JSON of `jt_strategy::Sections` (read tolerantly: a missing field reads as
//! its default). The creator, a `jt_ledger::Actor`, is stored by shape: a human sets only
//! `created_by_user`, an agent `created_by_user` (its issuer) and `created_by_connection`, the
//! system only `created_by_component`. The partial unique indexes `strategy_versions_one_draft`
//! and `strategy_versions_one_approved` keep one draft and one approved version per workspace.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::StrategyRepo;
use jt_ledger::Actor;
use jt_strategy::{Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{actor_columns, map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

/// The partial unique index that keeps one approved version per workspace.
const ONE_APPROVED: &str = "strategy_versions_one_approved";

#[derive(sqlx::FromRow)]
struct VersionRecord {
    id: Uuid,
    workspace_id: Uuid,
    number: i32,
    status: String,
    sections: serde_json::Value,
    created_at: OffsetDateTime,
    created_by_user: Option<Uuid>,
    created_by_connection: Option<Uuid>,
    created_by_component: Option<String>,
    submitted_at: Option<OffsetDateTime>,
    approved_at: Option<OffsetDateTime>,
    approved_by: Option<Uuid>,
    archived_at: Option<OffsetDateTime>,
}

impl VersionRecord {
    fn into_version(self) -> Result<StrategyVersion, AppError> {
        let created_by = match (
            self.created_by_user,
            self.created_by_connection,
            self.created_by_component,
        ) {
            (Some(user), None, None) => Actor::Human {
                user_id: UserId(user),
            },
            (Some(user), Some(connection), None) => Actor::Agent {
                connection_id: AgentConnectionId(connection),
                user_id: UserId(user),
            },
            (None, None, Some(component)) => Actor::System { component },
            _ => {
                return Err(AppError::internal(
                    "stored strategy_versions creator is incomplete",
                ));
            }
        };
        let sections: Sections = serde_json::from_value(self.sections)
            .map_err(|_| AppError::internal("stored strategy_versions.sections cannot be read"))?;
        Ok(StrategyVersion {
            id: StrategyVersionId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            number: self.number,
            status: stored(
                VersionStatus::parse(&self.status),
                "strategy_versions.status",
            )?,
            sections,
            created_at: self.created_at,
            created_by,
            submitted_at: self.submitted_at,
            approved_at: self.approved_at,
            approved_by: self.approved_by.map(UserId),
            archived_at: self.archived_at,
        })
    }
}

/// The JSON stored for `sections`.
fn sections_json(sections: &Sections) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(sections)
        .map_err(|e| AppError::internal(format!("strategy sections cannot be stored: {e}")))
}

/// The version `id` of workspace `ws`.
async fn find_in(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: StrategyVersionId,
) -> Result<Option<StrategyVersion>, AppError> {
    let record: Option<VersionRecord> = sqlx::query_as(
        "select id, workspace_id, number, status, sections, created_at, created_by_user, \
         created_by_connection, created_by_component, submitted_at, approved_at, approved_by, \
         archived_at from strategy_versions where workspace_id = $1 and id = $2",
    )
    .bind(ws.as_uuid())
    .bind(id.as_uuid())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "find strategy version"))?;
    record.map(VersionRecord::into_version).transpose()
}

/// `NOT_FOUND` unless version `id` belongs to workspace `ws`. Writes that hang a row off a
/// version check it first: the composite foreign key `(version_id, workspace_id)` would refuse
/// another workspace's version too, but as a violation that aborts the transaction and reads as
/// `INTERNAL`.
pub(crate) async fn ensure_version(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: StrategyVersionId,
) -> Result<(), AppError> {
    let found: Option<i32> =
        sqlx::query_scalar("select 1 from strategy_versions where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(conn)
            .await
            .map_err(|e| map_sqlx(e, "find strategy version"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such strategy version"))
}

/// The workspace's version in `status` (at most one, for `draft` and `approved`).
async fn find_by_status(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    status: VersionStatus,
) -> Result<Option<StrategyVersion>, AppError> {
    let record: Option<VersionRecord> = sqlx::query_as(
        "select id, workspace_id, number, status, sections, created_at, created_by_user, \
         created_by_connection, created_by_component, submitted_at, approved_at, approved_by, \
         archived_at from strategy_versions where workspace_id = $1 and status = $2",
    )
    .bind(ws.as_uuid())
    .bind(status.key())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "find strategy version by status"))?;
    record.map(VersionRecord::into_version).transpose()
}

/// After an update of a draft-only column changed no row: `NOT_FOUND` for an unknown version,
/// `CONFLICT` for one that is not a draft.
async fn not_a_draft(conn: &mut PgConnection, ws: WorkspaceId, id: StrategyVersionId) -> AppError {
    let status: Result<Option<String>, AppError> = sqlx::query_scalar(
        "select status from strategy_versions where workspace_id = $1 and id = $2",
    )
    .bind(ws.as_uuid())
    .bind(id.as_uuid())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "find strategy version"));
    match status {
        Ok(None) => AppError::not_found("no such strategy version"),
        Ok(Some(_)) => AppError::conflict("the strategy version is not a draft"),
        Err(e) => e,
    }
}

#[async_trait]
impl StrategyRepo for PgTenantRepos {
    async fn lock_execution_frame(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        // Serialize frame users without blocking the KEY SHARE locks taken by workspace
        // foreign keys (notably ledger inserts). Callers needing the draft lock take it first.
        sqlx::query("select id from workspaces where id = $1 for no key update")
            .bind(ws.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "lock strategy execution frame"))?;
        self.current_approved().await
    }

    /// `on conflict do nothing` covers the id, the number and both partial indexes, so a refused
    /// version leaves the transaction usable; a concurrent transaction holding a conflicting row
    /// is waited for, and loses only if it commits.
    async fn insert(&mut self, version: StrategyVersion) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, version.workspace_id)?;
        let (_, user, connection, component) = actor_columns(&version.created_by);
        let done = sqlx::query(
            "insert into strategy_versions (id, workspace_id, number, status, sections, \
             created_at, created_by_user, created_by_connection, created_by_component, \
             submitted_at, approved_at, approved_by, archived_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             on conflict do nothing",
        )
        .bind(version.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(version.number)
        .bind(version.status.key())
        .bind(sections_json(&version.sections)?)
        .bind(version.created_at)
        .bind(user)
        .bind(connection)
        .bind(component)
        .bind(version.submitted_at)
        .bind(version.approved_at)
        .bind(version.approved_by.map(|u| u.as_uuid()))
        .bind(version.archived_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert strategy version"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the strategy version id or number is taken, or the workspace already has a \
                 version in that status",
            ));
        }
        Ok(())
    }

    async fn find(&mut self, id: StrategyVersionId) -> Result<Option<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        find_in(self.tx.conn(), ws, id).await
    }

    async fn current_approved(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        find_by_status(self.tx.conn(), ws, VersionStatus::Approved).await
    }

    async fn current_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        find_by_status(self.tx.conn(), ws, VersionStatus::Draft).await
    }

    /// `for update` holds the row lock until the bundle's transaction ends. A locker that waited
    /// re-reads the row as committed and drops it if it is no longer a draft.
    async fn lock_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        // Serialize first-draft creation too, before frame/control locks. A row lock alone
        // cannot protect two concurrent suggestions when there is no draft yet.
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('strategy-draft:' || $1::uuid::text, 0))")
            .bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"lock draft creation"))?;
        let record: Option<VersionRecord> = sqlx::query_as(
            "select id, workspace_id, number, status, sections, created_at, created_by_user, \
             created_by_connection, created_by_component, submitted_at, approved_at, \
             approved_by, archived_at from strategy_versions \
             where workspace_id = $1 and status = 'draft' for update",
        )
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock the strategy draft"))?;
        record.map(VersionRecord::into_version).transpose()
    }

    async fn list(&mut self) -> Result<Vec<StrategyVersion>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<VersionRecord> = sqlx::query_as(
            "select id, workspace_id, number, status, sections, created_at, created_by_user, \
             created_by_connection, created_by_component, submitted_at, approved_at, \
             approved_by, archived_at from strategy_versions \
             where workspace_id = $1 order by number desc",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list strategy versions"))?;
        records
            .into_iter()
            .map(VersionRecord::into_version)
            .collect()
    }

    async fn update_sections(
        &mut self,
        id: StrategyVersionId,
        sections: Sections,
        _at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update strategy_versions set sections = $3 \
             where workspace_id = $1 and id = $2 and status = 'draft'",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(sections_json(&sections)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update strategy sections"))?;
        if done.rows_affected() == 0 {
            return Err(not_a_draft(self.tx.conn(), ws, id).await);
        }
        Ok(())
    }

    async fn set_submitted(
        &mut self,
        id: StrategyVersionId,
        at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update strategy_versions set submitted_at = $3 \
             where workspace_id = $1 and id = $2 and status = 'draft'",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set strategy submission"))?;
        if done.rows_affected() == 0 {
            return Err(not_a_draft(self.tx.conn(), ws, id).await);
        }
        Ok(())
    }

    /// Each move names the statuses it starts from in its `where`, so an update that waited for
    /// a concurrent transaction re-checks them against the committed row and changes nothing if
    /// that transaction moved it first.
    async fn set_status(
        &mut self,
        id: StrategyVersionId,
        status: VersionStatus,
        at: OffsetDateTime,
        by: Option<UserId>,
    ) -> Result<u64, AppError> {
        let ws = self.workspace_id();
        let done = match status {
            VersionStatus::Draft => {
                return Err(AppError::internal(
                    "a strategy version never returns to draft",
                ));
            }
            VersionStatus::Approved => sqlx::query(
                "update strategy_versions set status = 'approved', approved_at = $3, \
                 approved_by = $4 where workspace_id = $1 and id = $2 and status = 'draft'",
            )
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .bind(by.map(|u| u.as_uuid()))
            .execute(self.tx.conn())
            .await
            .map_err(|e| {
                let constraint = e.as_database_error().and_then(|d| d.constraint());
                if constraint == Some(ONE_APPROVED) {
                    AppError::conflict("the workspace already has an approved strategy version")
                } else {
                    map_sqlx(e, "approve strategy version")
                }
            })?,
            VersionStatus::Archived => sqlx::query(
                "update strategy_versions set status = 'archived', archived_at = $3 \
                 where workspace_id = $1 and id = $2 and status in ('draft', 'approved')",
            )
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "archive strategy version"))?,
        };
        Ok(done.rows_affected())
    }

    async fn next_number(&mut self) -> Result<i32, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select coalesce(max(number), 0) + 1 from strategy_versions where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "next strategy version number"))
    }
}
