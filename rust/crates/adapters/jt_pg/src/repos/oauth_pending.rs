//! `oauth_pending`: OAuth flows between their start and the owner's choice of assets.
//!
//! `provider` holds its key, `assets_public` a JSON array. The state hash is unique across every
//! workspace (a plain unique index, which row-level security does not hide), so an insert that
//! clashes with another workspace's flow is skipped like any other clash. The sealed columns are
//! opaque bytes sealed for the row's workspace. A reconnection's capability references the
//! capability together with the workspace (a composite foreign key); `insert` checks first that
//! it is this workspace's, so another workspace's capability is `NOT_FOUND` before the key would
//! refuse it.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::connectors::OAuthCallback;
use jt_app::ports::{OAuthPendingId, OAuthPendingRepo, OAuthPendingRow};
use jt_capability::CapabilityId;
use jt_connector::Provider;
use jt_tenancy::{UserId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::capabilities::ensure_capability;
use super::{map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

const COLUMNS: &str = "id, workspace_id, provider, kind_key, app, state_hash, started_by, \
                       capability_id, pkce_verifier_sealed, assets_sealed, assets_public, \
                       expires_at, created_at";

#[derive(sqlx::FromRow)]
struct PendingRecord {
    id: Uuid,
    workspace_id: Uuid,
    provider: String,
    kind_key: String,
    app: String,
    state_hash: String,
    started_by: Uuid,
    capability_id: Option<Uuid>,
    pkce_verifier_sealed: Option<Vec<u8>>,
    assets_sealed: Option<Vec<u8>>,
    assets_public: serde_json::Value,
    expires_at: OffsetDateTime,
    created_at: OffsetDateTime,
}

impl PendingRecord {
    fn into_row(self) -> Result<OAuthPendingRow, AppError> {
        Ok(OAuthPendingRow {
            id: OAuthPendingId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            provider: stored(Provider::parse(&self.provider), "oauth_pending.provider")?,
            kind_key: self.kind_key,
            app: stored(OAuthCallback::parse(&self.app), "oauth_pending.app")?,
            state_hash: self.state_hash,
            started_by: UserId(self.started_by),
            capability_id: self.capability_id.map(CapabilityId),
            pkce_verifier_sealed: self.pkce_verifier_sealed,
            assets_sealed: self.assets_sealed,
            assets_public: self.assets_public,
            expires_at: self.expires_at,
            created_at: self.created_at,
        })
    }
}

#[async_trait]
impl OAuthPendingRepo for PgTenantRepos {
    /// `on conflict do nothing` covers the id and the state hash, so a refused flow leaves the
    /// transaction usable; an unknown starter still aborts it (`NOT_FOUND`).
    async fn insert(&mut self, row: OAuthPendingRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        if let Some(capability) = row.capability_id {
            ensure_capability(self.tx.conn(), ws, capability).await?;
        }
        let done = sqlx::query(
            "insert into oauth_pending (id, workspace_id, provider, kind_key, app, state_hash, \
             started_by, capability_id, pkce_verifier_sealed, assets_sealed, assets_public, \
             expires_at, created_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(row.provider.key())
        .bind(&row.kind_key)
        .bind(row.app.key())
        .bind(&row.state_hash)
        .bind(row.started_by.as_uuid())
        .bind(row.capability_id.map(|c| c.as_uuid()))
        .bind(&row.pkce_verifier_sealed)
        .bind(&row.assets_sealed)
        .bind(&row.assets_public)
        .bind(row.expires_at)
        .bind(row.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert pending oauth flow"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the pending oauth flow id or its state is already taken",
            ));
        }
        Ok(())
    }

    async fn find_by_state_hash(
        &mut self,
        state_hash: &str,
    ) -> Result<Option<OAuthPendingRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<PendingRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from oauth_pending where workspace_id = $1 and state_hash = $2"
        ))
        .bind(ws.as_uuid())
        .bind(state_hash)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find pending oauth flow"))?;
        record.map(PendingRecord::into_row).transpose()
    }

    async fn lock(&mut self, id: OAuthPendingId) -> Result<Option<OAuthPendingRow>, AppError> {
        let ws = self.workspace_id();
        let record: Option<PendingRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from oauth_pending where workspace_id = $1 and id = $2 for update"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock pending oauth flow"))?;
        record.map(PendingRecord::into_row).transpose()
    }

    async fn set_assets(
        &mut self,
        id: OAuthPendingId,
        sealed: Vec<u8>,
        public: serde_json::Value,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update oauth_pending set assets_sealed = $3, assets_public = $4 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(sealed)
        .bind(public)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set pending oauth assets"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such pending oauth flow"));
        }
        Ok(())
    }

    async fn delete(&mut self, id: OAuthPendingId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query("delete from oauth_pending where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "delete pending oauth flow"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such pending oauth flow"));
        }
        Ok(())
    }

    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.workspace_id();
        let done =
            sqlx::query("delete from oauth_pending where workspace_id = $1 and expires_at < $2")
                .bind(ws.as_uuid())
                .bind(now)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "purge expired oauth flows"))?;
        Ok(done.rows_affected())
    }
}
