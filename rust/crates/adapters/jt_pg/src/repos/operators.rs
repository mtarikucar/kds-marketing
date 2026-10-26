//! `platform_operators` and `platform_sessions`, reached through the platform bundle. Not tenant
//! tables.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{OperatorRepo, OperatorRow, PlatformSessionRepo, PlatformSessionRow};
use jt_tenancy::{Email, OperatorId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored_email};
use crate::uow::PgPlatformRepos;

#[derive(sqlx::FromRow)]
struct OperatorRecord {
    id: Uuid,
    email: String,
    password_hash: String,
    created_at: OffsetDateTime,
}

impl OperatorRecord {
    fn into_row(self) -> Result<OperatorRow, AppError> {
        Ok(OperatorRow {
            id: OperatorId(self.id),
            email: stored_email(&self.email, "platform_operators.email")?,
            password_hash: self.password_hash,
            created_at: self.created_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct PlatformSessionRecord {
    id: Uuid,
    operator_id: Uuid,
    token_hash: String,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
}

impl From<PlatformSessionRecord> for PlatformSessionRow {
    fn from(r: PlatformSessionRecord) -> PlatformSessionRow {
        PlatformSessionRow {
            id: r.id,
            operator_id: OperatorId(r.operator_id),
            token_hash: r.token_hash,
            created_at: r.created_at,
            expires_at: r.expires_at,
        }
    }
}

#[async_trait]
impl OperatorRepo for PgPlatformRepos {
    async fn lock_all(&mut self) -> Result<Vec<OperatorRow>, AppError> {
        // Prevent a concurrent insert from changing the sole-operator predicate.
        sqlx::query("lock table platform_operators in share row exclusive mode")
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "lock operators"))?;
        let rows: Vec<OperatorRecord> = sqlx::query_as("select id,email,password_hash,created_at from platform_operators order by id for update")
            .fetch_all(self.tx.conn()).await.map_err(|e| map_sqlx(e,"lock operators"))?;
        rows.into_iter().map(OperatorRecord::into_row).collect()
    }
    async fn set_password(&mut self, id: OperatorId, password_hash: &str) -> Result<(), AppError> {
        let done = sqlx::query("update platform_operators set password_hash=$2 where id=$1")
            .bind(id.as_uuid())
            .bind(password_hash)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "set operator password"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("operator"));
        }
        Ok(())
    }
    async fn count(&mut self) -> Result<i64, AppError> {
        sqlx::query_scalar("select count(*) from platform_operators")
            .fetch_one(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "count operators"))
    }

    async fn insert(&mut self, row: OperatorRow) -> Result<(), AppError> {
        let done = sqlx::query(
            "insert into platform_operators (id, email, password_hash, created_at) \
             values ($1, $2, $3, $4) on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(row.email.as_str())
        .bind(&row.password_hash)
        .bind(row.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert operator"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("operator email is already registered"));
        }
        Ok(())
    }

    async fn find_by_email(&mut self, email: &Email) -> Result<Option<OperatorRow>, AppError> {
        let record: Option<OperatorRecord> = sqlx::query_as(
            "select id, email, password_hash, created_at from platform_operators \
             where lower(email) = lower($1) for update",
        )
        .bind(email.as_str())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find operator by email"))?;
        record.map(OperatorRecord::into_row).transpose()
    }
}

#[async_trait]
impl PlatformSessionRepo for PgPlatformRepos {
    async fn revoke_all(&mut self, operator: OperatorId) -> Result<(), AppError> {
        sqlx::query("delete from platform_sessions where operator_id=$1")
            .bind(operator.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "revoke operator sessions"))?;
        Ok(())
    }
    async fn insert(&mut self, row: PlatformSessionRow) -> Result<(), AppError> {
        let done = sqlx::query(
            "insert into platform_sessions (id, operator_id, token_hash, created_at, expires_at) \
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(row.id)
        .bind(row.operator_id.as_uuid())
        .bind(&row.token_hash)
        .bind(row.created_at)
        .bind(row.expires_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert platform session"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "platform session token is already taken",
            ));
        }
        Ok(())
    }

    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<PlatformSessionRow>, AppError> {
        let record: Option<PlatformSessionRecord> = sqlx::query_as(
            "select id, operator_id, token_hash, created_at, expires_at from platform_sessions \
             where token_hash = $1",
        )
        .bind(token_hash)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find platform session"))?;
        Ok(record.map(PlatformSessionRow::from))
    }
}
