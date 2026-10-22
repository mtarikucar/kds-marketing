//! Transactions scoped for row-level security. They are the only way adapters touch tenant
//! tables.
//!
//! Each one begins a transaction and sets, transaction-locally (`set_config(.., true)`), the
//! settings the RLS policies of migration 0001 read:
//!
//! - `app.workspace_id`: the tenant tables (and `workspaces`) show and accept only that
//!   workspace's rows;
//! - `app.platform = 'on'`: they show and accept every workspace's rows.
//!
//! With neither set, as on a plain pool connection, the tenant tables are empty and refuse
//! writes. Dropping a transaction without `commit` rolls it back.

use jt_tenancy::WorkspaceId;
use sqlx::{Acquire, PgConnection, Postgres, Transaction};

/// A transaction scoped to one workspace: tenant tables show and accept only its rows, and
/// `workspaces` shows only its own row.
pub struct TenantTx<'c> {
    tx: Transaction<'c, Postgres>,
    workspace_id: WorkspaceId,
}

impl<'c> TenantTx<'c> {
    /// Begins a transaction on `conn` (a `&PgPool` or a connection) scoped to `ws`.
    pub async fn begin<A>(conn: A, ws: WorkspaceId) -> Result<TenantTx<'c>, sqlx::Error>
    where
        A: Acquire<'c, Database = Postgres>,
    {
        let mut tx = conn.begin().await?;
        sqlx::query("select set_config('app.workspace_id', $1, true)")
            .bind(ws.to_string())
            .execute(&mut *tx)
            .await?;
        Ok(TenantTx {
            tx,
            workspace_id: ws,
        })
    }

    /// The workspace this transaction is scoped to.
    pub fn workspace_id(&self) -> WorkspaceId {
        self.workspace_id
    }

    /// The connection, for running queries inside the transaction.
    pub fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.tx.commit().await
    }

    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        self.tx.rollback().await
    }
}

/// A platform-wide transaction: tenant tables show and accept every workspace's rows.
///
/// For platform operators and for lookups that cannot know the workspace in advance (by API-key
/// hash, by invite-token hash).
pub struct PlatformTx<'c> {
    tx: Transaction<'c, Postgres>,
}

impl<'c> PlatformTx<'c> {
    /// Begins a platform-wide transaction on `conn` (a `&PgPool` or a connection).
    pub async fn begin<A>(conn: A) -> Result<PlatformTx<'c>, sqlx::Error>
    where
        A: Acquire<'c, Database = Postgres>,
    {
        Ok(PlatformTx {
            tx: begin_platform(conn).await?,
        })
    }

    /// The connection, for running queries inside the transaction.
    pub fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.tx.commit().await
    }

    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        self.tx.rollback().await
    }
}

/// A transaction over user-level data (`users`, `sessions`) and registration.
///
/// It runs with `app.platform = 'on'`, like [`PlatformTx`]: it is the trusted internal path for
/// users, sessions, creating a workspace, creating its system roles, inserting its owner
/// membership, reading a user's memberships across workspaces and appending the registration
/// ledger entry, all of which touch RLS-protected tables with no workspace in scope. Only the
/// `UserRepos` methods may use it; anything that acts within one workspace uses [`TenantTx`].
pub struct UserTx<'c> {
    tx: Transaction<'c, Postgres>,
}

impl<'c> UserTx<'c> {
    /// Begins a user-level transaction on `conn` (a `&PgPool` or a connection).
    pub async fn begin<A>(conn: A) -> Result<UserTx<'c>, sqlx::Error>
    where
        A: Acquire<'c, Database = Postgres>,
    {
        Ok(UserTx {
            tx: begin_platform(conn).await?,
        })
    }

    /// The connection, for running queries inside the transaction.
    pub fn conn(&mut self) -> &mut PgConnection {
        &mut self.tx
    }

    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.tx.commit().await
    }

    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        self.tx.rollback().await
    }
}

async fn begin_platform<'c, A>(conn: A) -> Result<Transaction<'c, Postgres>, sqlx::Error>
where
    A: Acquire<'c, Database = Postgres>,
{
    let mut tx = conn.begin().await?;
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
