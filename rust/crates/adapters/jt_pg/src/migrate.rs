//! Schema migrations: reversible `<NNNN>_<name>.up.sql` / `.down.sql` pairs in `rust/migrations`,
//! embedded at build time.

use sqlx::PgPool;
use sqlx::migrate::{MigrateError, Migrator};

static MIGRATOR: Migrator = sqlx::migrate!("../../../migrations");

/// Every migration, in version order.
pub fn migrator() -> &'static Migrator {
    &MIGRATOR
}

/// Applies every migration not yet applied.
pub async fn migrate_up(pool: &PgPool) -> Result<(), MigrateError> {
    MIGRATOR.run(pool).await
}

/// Reverts every applied migration, newest first, with its `.down.sql`. A no-op when nothing is
/// applied.
pub async fn migrate_down_all(pool: &PgPool) -> Result<(), MigrateError> {
    MIGRATOR.undo(pool, 0).await
}
