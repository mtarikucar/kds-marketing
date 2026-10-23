//! `users`: user accounts, reached through the user bundle. Not a tenant table.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{UserRepo, UserRow};
use jt_tenancy::{Email, UserId};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored_email};
use crate::uow::PgUserRepos;

#[derive(sqlx::FromRow)]
struct UserRecord {
    id: Uuid,
    email: String,
    password_hash: String,
    display_name: String,
    created_at: OffsetDateTime,
}

impl UserRecord {
    fn into_row(self) -> Result<UserRow, AppError> {
        Ok(UserRow {
            id: UserId(self.id),
            email: stored_email(&self.email, "users.email")?,
            password_hash: self.password_hash,
            display_name: self.display_name,
            created_at: self.created_at,
        })
    }
}

#[async_trait]
impl UserRepo for PgUserRepos {
    async fn find_by_email(&mut self, email: &Email) -> Result<Option<UserRow>, AppError> {
        let record: Option<UserRecord> = sqlx::query_as(
            "select id, email, password_hash, display_name, created_at \
             from users where lower(email) = lower($1)",
        )
        .bind(email.as_str())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find user by email"))?;
        record.map(UserRecord::into_row).transpose()
    }

    async fn find_by_id(&mut self, id: UserId) -> Result<Option<UserRow>, AppError> {
        let record: Option<UserRecord> = sqlx::query_as(
            "select id, email, password_hash, display_name, created_at from users where id = $1",
        )
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find user"))?;
        record.map(UserRecord::into_row).transpose()
    }

    async fn insert(&mut self, row: UserRow) -> Result<(), AppError> {
        let done = sqlx::query(
            "insert into users (id, email, password_hash, display_name, created_at) \
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(row.id.as_uuid())
        .bind(row.email.as_str())
        .bind(&row.password_hash)
        .bind(&row.display_name)
        .bind(row.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert user"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("email is already registered"));
        }
        Ok(())
    }
}
