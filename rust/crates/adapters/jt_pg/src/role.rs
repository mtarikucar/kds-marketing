//! The database role the application connects as.
//!
//! Postgres never applies row-level security to a superuser or to a role with `BYPASSRLS`, not
//! even under `FORCE ROW LEVEL SECURITY`: connected as one, the application would see and write
//! every workspace's rows. The binary therefore asks [`role_bypasses_rls`] at boot and refuses
//! to start when it is true, unless explicitly told otherwise for local development.

use sqlx::PgPool;

/// Whether the role the pool connects as (`current_user`) is a superuser or has `BYPASSRLS`, so
/// that row-level security does not bind it.
pub async fn role_bypasses_rls(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("select rolsuper or rolbypassrls from pg_roles where rolname = current_user")
        .fetch_one(pool)
        .await
}

/// The name of the role the pool connects as (`current_user`).
pub async fn current_role(pool: &PgPool) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("select current_user::text")
        .fetch_one(pool)
        .await
}
