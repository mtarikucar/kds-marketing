//! The connection pool.

use std::str::FromStr;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

/// Upper bound on open connections per pool.
pub const MAX_CONNECTIONS: u32 = 10;

/// The `application_name` every connection reports to Postgres.
pub const APPLICATION_NAME: &str = "jeeta";

/// A pool for the database at `url` (`postgres://user:password@host:port/database`).
///
/// The role in `url` must be neither a superuser nor `BYPASSRLS`, or row-level security does not
/// isolate workspaces.
pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    connect_with(PgConnectOptions::from_str(url)?).await
}

/// A pool for `options`, with the same limits and `application_name` as [`connect`].
pub async fn connect_with(options: PgConnectOptions) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options.application_name(APPLICATION_NAME))
        .await
}
