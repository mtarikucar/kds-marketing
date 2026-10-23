//! `ledger_entries`: a workspace's append-only ledger.
//!
//! An `Actor` is stored in four columns: `actor_kind` (`human`, `agent` or `system`),
//! `actor_user_id` (human and agent), `agent_connection_id` (agent) and `actor_component`
//! (system).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{LedgerFilter, LedgerRepo, LedgerRow};
use jt_ledger::{Action, LedgerEntry, Subject};
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{actor_columns, map_sqlx, same_workspace, stored_actor};
use crate::uow::PgTenantRepos;

/// The most entries one `list` returns.
pub(crate) const MAX_LIST_LIMIT: u32 = 500;

#[derive(sqlx::FromRow)]
struct LedgerRecord {
    id: i64,
    workspace_id: Uuid,
    at: OffsetDateTime,
    actor_kind: String,
    actor_user_id: Option<Uuid>,
    agent_connection_id: Option<Uuid>,
    actor_component: Option<String>,
    action: String,
    subject_kind: Option<String>,
    subject_id: Option<String>,
    payload: serde_json::Value,
    strategy_version_id: Option<Uuid>,
}

impl LedgerRecord {
    fn into_row(self) -> Result<LedgerRow, AppError> {
        let actor = stored_actor(
            "ledger_entries",
            &self.actor_kind,
            self.actor_user_id,
            self.agent_connection_id,
            self.actor_component,
        )?;
        let action = Action::new(&self.action).map_err(|_| {
            AppError::internal("stored ledger_entries.action is not a valid action")
        })?;
        let subject = match (self.subject_kind, self.subject_id) {
            (Some(kind), Some(id)) => Some(Subject { kind, id }),
            _ => None,
        };
        Ok(LedgerRow {
            id: self.id,
            entry: LedgerEntry {
                workspace_id: WorkspaceId(self.workspace_id),
                at: self.at,
                actor,
                action,
                subject,
                payload: self.payload,
                strategy_version_id: self.strategy_version_id,
            },
        })
    }
}

/// `pattern` for `like .. escape '\'` matching every text that starts with `prefix` literally.
fn like_prefix(prefix: &str) -> String {
    let mut pattern = String::with_capacity(prefix.len() + 1);
    for c in prefix.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// Appends `entry` to `entry.workspace_id` and returns its sequence id.
///
/// Shared by the tenant bundle (after its workspace check) and by the platform and user bundles,
/// which write into the workspace the entry names; an unknown workspace is `NOT_FOUND`.
pub(crate) async fn insert(conn: &mut PgConnection, entry: &LedgerEntry) -> Result<i64, AppError> {
    let (actor_kind, actor_user_id, agent_connection_id, actor_component) =
        actor_columns(&entry.actor);
    let (subject_kind, subject_id) = match &entry.subject {
        Some(s) => (Some(s.kind.as_str()), Some(s.id.as_str())),
        None => (None, None),
    };
    sqlx::query_scalar(
        // archtest: platform-wide
        "insert into ledger_entries (workspace_id, at, actor_kind, actor_user_id, \
         agent_connection_id, actor_component, action, subject_kind, subject_id, payload, \
         strategy_version_id) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id",
    )
    .bind(entry.workspace_id.as_uuid())
    .bind(entry.at)
    .bind(actor_kind)
    .bind(actor_user_id)
    .bind(agent_connection_id)
    .bind(actor_component)
    .bind(entry.action.as_str())
    .bind(subject_kind)
    .bind(subject_id)
    .bind(&entry.payload)
    .bind(entry.strategy_version_id)
    .fetch_one(conn)
    .await
    .map_err(|e| map_sqlx(e, "append ledger entry"))
}

#[async_trait]
impl LedgerRepo for PgTenantRepos {
    async fn append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        same_workspace(self.workspace_id(), entry.workspace_id)?;
        insert(self.tx.conn(), &entry).await
    }

    /// Newest first. `limit` is clamped to `1..=MAX_LIST_LIMIT`; `action_prefix` matches
    /// literally (`_` and `%` are not wildcards); `agent_connection_id` keeps the entries made
    /// through that agent connection.
    async fn list(&mut self, filter: LedgerFilter) -> Result<Vec<LedgerRow>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<LedgerRecord> = sqlx::query_as(
            "select id, workspace_id, at, actor_kind, actor_user_id, agent_connection_id, \
             actor_component, action, subject_kind, subject_id, payload, strategy_version_id \
             from ledger_entries \
             where workspace_id = $1 \
             and ($2::text is null or action like $2 escape '\\') \
             and ($3::text is null or actor_kind = $3) \
             and ($4::bigint is null or id < $4) \
             and ($5::uuid is null or agent_connection_id = $5) \
             order by id desc \
             limit $6",
        )
        .bind(ws.as_uuid())
        .bind(filter.action_prefix.as_deref().map(like_prefix))
        .bind(filter.actor_kind)
        .bind(filter.before_id)
        .bind(filter.agent_connection_id.map(|id| id.as_uuid()))
        .bind(i64::from(filter.limit.clamp(1, MAX_LIST_LIMIT)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list ledger entries"))?;
        let mut rows = Vec::with_capacity(records.len());
        for record in records {
            let mut row = record.into_row()?;
            if let Some(person) = row
                .entry
                .payload
                .get("person_id")
                .and_then(serde_json::Value::as_str)
                .and_then(|p| p.parse::<jt_inbox::PersonId>().ok())
                && jt_app::ports::inbox::ErasureRepo::get(self, person)
                    .await?
                    .is_some()
            {
                jt_app::usecases::inbox::erasure::mask_personal(&mut row.entry.payload);
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// The action is a literal, as in the predicate of `ledger_entries_agent_connection_idx`
    /// (0004), so the planner proves the partial index applies under any plan, generic plans of
    /// the prepared statement included, and reads one index entry.
    async fn last_checkin_at(
        &mut self,
        connection_id: AgentConnectionId,
    ) -> Result<Option<OffsetDateTime>, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select at from ledger_entries \
             where workspace_id = $1 and agent_connection_id = $2 \
             and action = 'work.checkin' \
             order by id desc \
             limit 1",
        )
        .bind(ws.as_uuid())
        .bind(connection_id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find the last check-in"))
    }
}

#[cfg(test)]
mod tests {
    use jt_app::ports::CHECKIN_ACTION;

    use super::like_prefix;

    #[test]
    fn the_check_in_lookup_names_the_check_in_action() {
        // `last_checkin_at` writes the action as a literal, to match the partial index.
        assert_eq!(CHECKIN_ACTION, "work.checkin");
    }

    #[test]
    fn like_prefix_escapes_wildcards_and_the_escape_character() {
        assert_eq!(like_prefix("team."), "team.%");
        assert_eq!(like_prefix("a_b%c\\d"), "a\\_b\\%c\\\\d%");
        assert_eq!(like_prefix(""), "%");
    }
}
