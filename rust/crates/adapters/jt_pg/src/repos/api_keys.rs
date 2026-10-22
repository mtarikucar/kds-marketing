//! `api_keys`: a workspace's API keys, plus the platform-wide lookup by key hash. Scopes are
//! stored as `text[]` of `Permission::key()`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{ApiKeyRepo, ApiKeyRow, ApiKeyStatus};
use jt_tenancy::{ApiKeyId, UserId, WorkspaceId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, permission_keys, permissions_from, same_workspace, stored};
use crate::tx::PlatformTx;
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct ApiKeyRecord {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    prefix: String,
    key_hash: String,
    scopes: Vec<String>,
    issued_by: Uuid,
    status: String,
    created_at: OffsetDateTime,
    last_used_at: Option<OffsetDateTime>,
    revoked_at: Option<OffsetDateTime>,
}

impl ApiKeyRecord {
    fn into_row(self) -> Result<ApiKeyRow, AppError> {
        Ok(ApiKeyRow {
            id: ApiKeyId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            name: self.name,
            prefix: self.prefix,
            key_hash: self.key_hash,
            scopes: permissions_from(self.scopes, "api_keys.scopes"),
            issued_by: UserId(self.issued_by),
            status: stored(ApiKeyStatus::parse(&self.status), "api_keys.status")?,
            created_at: self.created_at,
            last_used_at: self.last_used_at,
            revoked_at: self.revoked_at,
        })
    }
}

/// The API key with this hash, in whichever workspace it belongs to.
pub(crate) async fn find_by_hash(
    tx: &mut PlatformTx<'_>,
    key_hash: &str,
) -> Result<Option<ApiKeyRow>, AppError> {
    let record: Option<ApiKeyRecord> = sqlx::query_as(
        // archtest: platform-wide
        "select id, workspace_id, name, prefix, key_hash, scopes, issued_by, status, created_at, \
         last_used_at, revoked_at from api_keys where key_hash = $1",
    )
    .bind(key_hash)
    .fetch_optional(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "find API key by hash"))?;
    record.map(ApiKeyRecord::into_row).transpose()
}

#[async_trait]
impl ApiKeyRepo for PgTenantRepos {
    async fn insert(&mut self, row: ApiKeyRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        let done = sqlx::query(
            "insert into api_keys (id, workspace_id, name, prefix, key_hash, scopes, issued_by, \
             status, created_at, last_used_at, revoked_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&row.name)
        .bind(&row.prefix)
        .bind(&row.key_hash)
        .bind(permission_keys(&row.scopes))
        .bind(row.issued_by.as_uuid())
        .bind(row.status.key())
        .bind(row.created_at)
        .bind(row.last_used_at)
        .bind(row.revoked_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert API key"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("API key is already taken"));
        }
        Ok(())
    }

    async fn list(&mut self) -> Result<Vec<ApiKeyRow>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<ApiKeyRecord> = sqlx::query_as(
            "select id, workspace_id, name, prefix, key_hash, scopes, issued_by, status, \
             created_at, last_used_at, revoked_at from api_keys \
             where workspace_id = $1 order by created_at, id",
        )
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list API keys"))?;
        records.into_iter().map(ApiKeyRecord::into_row).collect()
    }

    async fn revoke(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update api_keys set status = 'revoked', revoked_at = $3 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "revoke API key"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such API key"));
        }
        Ok(())
    }

    async fn revoke_all_for_user(
        &mut self,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<Vec<ApiKeyId>, AppError> {
        let ws = self.workspace_id();
        let mut ids: Vec<Uuid> = sqlx::query_scalar(
            "update api_keys set status = 'revoked', revoked_at = $3 \
             where workspace_id = $1 and issued_by = $2 and status = 'active' returning id",
        )
        .bind(ws.as_uuid())
        .bind(user_id.as_uuid())
        .bind(at)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "revoke a user's API keys"))?;
        ids.sort();
        Ok(ids.into_iter().map(ApiKeyId).collect())
    }

    async fn touch_last_used(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        sqlx::query("update api_keys set last_used_at = $3 where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "touch API key"))?;
        Ok(())
    }
}
