//! `capabilities`: what the workspace can act through.
//!
//! `policy`, `evidence` and `connector_public` are the JSON of `jt_capability::Policy`,
//! `Evidence` and the public connector fields (read tolerantly: a missing field reads as its
//! default); `reach` and `status` hold their keys. The sealed credentials sit in
//! `connector_sealed`, which only `insert`, `set_sealed` and `read_sealed` touch: every read of a
//! capability selects `connector_sealed is not null` instead of the bytes. The budget item ids
//! come from `capability_budget_links`, in the same statement. The partial unique index
//! `capabilities_live_external_account` keeps one live capability per external account.
//! `declared_by_connection` is written once, by `insert`: `update` leaves it as declared.
//! [`by_external`] is the one platform-wide read: the connected capability (sealed credentials,
//! verified or unreachable, verified at least once) of any workspace that holds an external
//! account, where an inbound
//! event for that account is routed; the partial index `capabilities_connected_account_idx` of
//! migration 0005 serves it.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{CapabilityFilter, CapabilityRepo};
use jt_capability::{
    BudgetItemId, Capability, CapabilityId, Evidence, Policy, Reach, StoredStatus, kinds_in_group,
};
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, same_workspace, stored};
use crate::tx::PlatformTx;
use crate::uow::PgTenantRepos;

/// The partial unique index that keeps one live capability per external account.
const LIVE_EXTERNAL_ACCOUNT: &str = "capabilities_live_external_account";

/// The columns every read selects, with the sealed blob reduced to whether there is one and the
/// budget links gathered in id order. `c` is the capabilities table.
const COLUMNS: &str = "c.id, c.workspace_id, c.kind_key, c.key_detail, c.name, c.description, \
     c.reach, c.status, c.external_id, c.connector_public, \
     c.connector_sealed is not null as has_sealed_config, c.last_verified_at, c.evidence, \
     c.policy, c.strategy_version_id, c.declared_by_connection, c.created_at, c.updated_at, \
     array(select l.budget_item_id from capability_budget_links l \
     where l.workspace_id = c.workspace_id and l.capability_id = c.id \
     order by l.budget_item_id) as budget_item_ids";

#[derive(sqlx::FromRow)]
struct CapabilityRecord {
    id: Uuid,
    workspace_id: Uuid,
    kind_key: String,
    key_detail: Option<String>,
    name: String,
    description: String,
    reach: String,
    status: String,
    external_id: Option<String>,
    connector_public: serde_json::Value,
    has_sealed_config: bool,
    last_verified_at: Option<OffsetDateTime>,
    evidence: Option<serde_json::Value>,
    policy: serde_json::Value,
    strategy_version_id: Option<Uuid>,
    declared_by_connection: Option<Uuid>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    budget_item_ids: Vec<Uuid>,
}

impl CapabilityRecord {
    fn into_capability(self) -> Result<Capability, AppError> {
        let policy: Policy = serde_json::from_value(self.policy)
            .map_err(|_| AppError::internal("stored capability policy cannot be read"))?;
        let evidence: Option<Evidence> = self
            .evidence
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| AppError::internal("stored capability evidence cannot be read"))?;
        Ok(Capability {
            id: CapabilityId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            kind_key: self.kind_key,
            key_detail: self.key_detail,
            name: self.name,
            description: self.description,
            reach: stored(Reach::parse(&self.reach), "capabilities.reach")?,
            status: stored(StoredStatus::parse(&self.status), "capabilities.status")?,
            external_id: self.external_id,
            connector_public: self.connector_public,
            has_sealed_config: self.has_sealed_config,
            last_verified_at: self.last_verified_at,
            evidence,
            policy,
            budget_item_ids: self.budget_item_ids.into_iter().map(BudgetItemId).collect(),
            strategy_version_id: self.strategy_version_id,
            declared_by_connection: self.declared_by_connection.map(AgentConnectionId),
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// The JSON stored for `policy`.
fn policy_json(policy: &Policy) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(policy)
        .map_err(|e| AppError::internal(format!("a capability policy cannot be stored: {e}")))
}

/// The JSON stored for `evidence`.
fn evidence_json(evidence: Option<&Evidence>) -> Result<Option<serde_json::Value>, AppError> {
    evidence
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| AppError::internal(format!("capability evidence cannot be stored: {e}")))
}

/// `CONFLICT` for a write the partial unique index refused, else as [`map_sqlx`].
fn map_write(err: sqlx::Error, what: &str) -> AppError {
    let constraint = err.as_database_error().and_then(|d| d.constraint());
    if constraint == Some(LIVE_EXTERNAL_ACCOUNT) {
        AppError::conflict("a live capability of this kind already holds the same external account")
    } else {
        map_sqlx(err, what)
    }
}

/// The connected capability (sealed credentials present, stored status `verified` or
/// `unreachable`, verified at least once) of any workspace whose kind is one of `kind_keys` and
/// whose external account is `external_id`, verified ones first, then the most recently created;
/// see
/// `PlatformRepos::capability_by_external`. The predicate is the one of the partial index
/// `capabilities_connected_account_idx`, so the index serves it.
pub(crate) async fn by_external(
    tx: &mut PlatformTx<'_>,
    kind_keys: &[&str],
    external_id: &str,
) -> Result<Option<Capability>, AppError> {
    let record: Option<CapabilityRecord> = sqlx::query_as(&format!(
        // archtest: platform-wide
        "select {COLUMNS} from capabilities c \
         where c.kind_key = any($1) and c.external_id = $2 \
         and c.status in ('verified', 'unreachable') and c.connector_sealed is not null \
         and c.last_verified_at is not null \
         order by (c.status = 'verified') desc, c.created_at desc, c.id desc limit 1"
    ))
    .bind(kind_keys.to_vec())
    .bind(external_id)
    .fetch_optional(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "find capability by external account"))?;
    record.map(CapabilityRecord::into_capability).transpose()
}

/// `NOT_FOUND` unless capability `id` belongs to workspace `ws`. Writes that hang a row off a
/// capability check it first: the composite foreign key `(capability_id, workspace_id)` would
/// refuse another workspace's capability too, but as a violation that aborts the transaction and
/// reads as `INTERNAL`.
pub(crate) async fn ensure_capability(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: CapabilityId,
) -> Result<(), AppError> {
    let found: Option<i32> =
        sqlx::query_scalar("select 1 from capabilities where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(conn)
            .await
            .map_err(|e| map_sqlx(e, "find capability"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such capability"))
}

#[async_trait]
impl CapabilityRepo for PgTenantRepos {
    /// `on conflict do nothing` covers the id and the partial unique index, so a refused
    /// capability leaves the transaction usable.
    async fn insert(
        &mut self,
        capability: Capability,
        sealed: Option<Vec<u8>>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, capability.workspace_id)?;
        let c = capability;
        let done = sqlx::query(
            "insert into capabilities (id, workspace_id, kind_key, key_detail, name, \
             description, reach, status, external_id, connector_public, connector_sealed, \
             last_verified_at, evidence, policy, strategy_version_id, declared_by_connection, \
             created_at, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, \
             $18) \
             on conflict do nothing",
        )
        .bind(c.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&c.kind_key)
        .bind(&c.key_detail)
        .bind(&c.name)
        .bind(&c.description)
        .bind(c.reach.key())
        .bind(c.status.key())
        .bind(&c.external_id)
        .bind(&c.connector_public)
        .bind(sealed)
        .bind(c.last_verified_at)
        .bind(evidence_json(c.evidence.as_ref())?)
        .bind(policy_json(&c.policy)?)
        .bind(c.strategy_version_id)
        .bind(c.declared_by_connection.map(|id| id.as_uuid()))
        .bind(c.created_at)
        .bind(c.updated_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert capability"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the capability id is taken, or a live capability of this kind already holds \
                 the same external account",
            ));
        }
        Ok(())
    }

    async fn find(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        let ws = self.workspace_id();
        let record: Option<CapabilityRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from capabilities c where c.workspace_id = $1 and c.id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find capability"))?;
        record.map(CapabilityRecord::into_capability).transpose()
    }

    /// Locks the row, then reads the capability in a statement of its own: after waiting for
    /// another transaction, a `select .. for update` re-reads the locked row but evaluates the
    /// rest of the statement (the budget links) on its older snapshot, while a new statement sees
    /// everything committed meanwhile.
    async fn lock(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        let ws = self.workspace_id();
        let locked: Option<i32> = sqlx::query_scalar(
            "select 1 from capabilities where workspace_id = $1 and id = $2 for update",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock capability"))?;
        if locked.is_none() {
            return Ok(None);
        }
        CapabilityRepo::find(self, id).await
    }

    async fn list(&mut self, filter: CapabilityFilter) -> Result<Vec<Capability>, AppError> {
        let ws = self.workspace_id();
        let group_kinds: Option<Vec<&str>> = filter
            .group
            .map(|g| kinds_in_group(g).map(|k| k.key).collect());
        let records: Vec<CapabilityRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from capabilities c where c.workspace_id = $1 \
             and ($2::text[] is null or c.kind_key = any($2)) \
             and ($3::text is null or c.kind_key = $3) \
             and ($4::text is null or c.status = $4) \
             and ($5::uuid is null or exists (select 1 from capability_group_members m \
             where m.workspace_id = c.workspace_id and m.group_id = $5 \
             and m.capability_id = c.id)) \
             order by c.created_at, c.id"
        ))
        .bind(ws.as_uuid())
        .bind(group_kinds)
        .bind(filter.kind)
        .bind(filter.status.map(|s| s.key()))
        .bind(filter.group_id.map(|g| g.as_uuid()))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list capabilities"))?;
        records
            .into_iter()
            .map(CapabilityRecord::into_capability)
            .collect()
    }

    async fn update(&mut self, capability: Capability) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, capability.workspace_id)?;
        let c = capability;
        let done = sqlx::query(
            "update capabilities set key_detail = $3, name = $4, description = $5, reach = $6, \
             status = $7, external_id = $8, connector_public = $9, last_verified_at = $10, \
             evidence = $11, policy = $12, strategy_version_id = $13, updated_at = $14 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(c.id.as_uuid())
        .bind(&c.key_detail)
        .bind(&c.name)
        .bind(&c.description)
        .bind(c.reach.key())
        .bind(c.status.key())
        .bind(&c.external_id)
        .bind(&c.connector_public)
        .bind(c.last_verified_at)
        .bind(evidence_json(c.evidence.as_ref())?)
        .bind(policy_json(&c.policy)?)
        .bind(c.strategy_version_id)
        .bind(c.updated_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_write(e, "change capability"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such capability"));
        }
        Ok(())
    }

    async fn set_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update capabilities set connector_sealed = $3, updated_at = $4 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(sealed)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set sealed connector config"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such capability"));
        }
        Ok(())
    }

    async fn read_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError> {
        let ws = self.workspace_id();
        let row: Option<Option<Vec<u8>>> = sqlx::query_scalar(
            "select connector_sealed from capabilities where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read sealed connector config"))?;
        row.ok_or_else(|| AppError::not_found("no such capability"))
    }

    async fn set_status(
        &mut self,
        id: CapabilityId,
        status: StoredStatus,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update capabilities set status = $3, updated_at = $4 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(status.key())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_write(e, "set capability status"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such capability"));
        }
        Ok(())
    }

    async fn kinds_in_use(&mut self) -> Result<BTreeSet<String>, AppError> {
        let ws = self.workspace_id();
        let kinds: Vec<String> = sqlx::query_scalar(
            "select distinct kind_key from capabilities \
             where workspace_id = $1 and status <> 'retired'",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list capability kinds in use"))?;
        Ok(kinds.into_iter().collect())
    }
}
