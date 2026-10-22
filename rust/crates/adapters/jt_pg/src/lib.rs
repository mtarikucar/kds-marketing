//! PostgreSQL adapter: pool, row-level-security scoped transactions, repositories, migrations.
//!
//! Tenant tables are reached only through the transactions in [`tx`]: [`TenantTx`] for one
//! workspace, [`PlatformTx`] for platform-wide work and [`UserTx`] for user-level data and
//! registration. Row-level security is forced on every tenant table, but Postgres never applies
//! it to superusers or `BYPASSRLS` roles, so the application must connect as an ordinary role.

mod migrate;
mod pool;
pub mod tx;

pub use migrate::{migrate_down_all, migrate_up, migrator};
pub use pool::{APPLICATION_NAME, MAX_CONNECTIONS, connect, connect_with};
pub use tx::{PlatformTx, TenantTx, UserTx};
