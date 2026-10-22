//! PostgreSQL adapter: pool, row-level-security scoped transactions, repositories, migrations.
//!
//! Tenant tables are reached only through the transactions in [`tx`]: [`TenantTx`] for one
//! workspace, [`PlatformTx`] for platform-wide work and [`UserTx`] for user-level data and
//! registration. [`PgUnitOfWork`] opens the repo bundles of [`uow`] on them; their SQL lives in
//! [`repos`]. [`PgStrategyGate`] answers the strategy gate from `strategy_versions`.
//! Row-level security is forced on every tenant table, but Postgres never applies
//! it to superusers or `BYPASSRLS` roles, so the application must connect as an ordinary role
//! ([`role_bypasses_rls`] tells which it is).

mod migrate;
mod pool;
pub mod repos;
mod role;
mod strategy_gate;
pub mod tx;
pub mod uow;

pub use migrate::{migrate_down_all, migrate_up, migrator};
pub use pool::{APPLICATION_NAME, MAX_CONNECTIONS, connect, connect_with};
pub use repos::map_sqlx;
pub use role::{current_role, role_bypasses_rls};
pub use strategy_gate::PgStrategyGate;
pub use tx::{PlatformTx, TenantTx, UserTx};
pub use uow::{PgPlatformRepos, PgTenantRepos, PgUnitOfWork, PgUserRepos};
