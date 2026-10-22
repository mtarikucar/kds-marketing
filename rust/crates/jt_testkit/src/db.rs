//! Throwaway PostgreSQL databases for tests.
//!
//! `JEETA_TEST_DATABASE_URL` names an administrator connection (a superuser). It is used only to
//! create and drop each test's database and role: Postgres never applies row-level security to
//! superusers or `BYPASSRLS` roles, so the pool a test gets connects as a fresh ordinary role that
//! owns the database, and the RLS policies bind it exactly as they bind the application in
//! production.

use std::str::FromStr;

use jt_tenancy::{MembershipId, RoleId, SystemRole, UserId, WorkspaceId};
use sqlx::postgres::PgConnectOptions;
use sqlx::{Connection, Executor, PgConnection, PgPool};

/// The environment variable holding the administrator URL.
pub const TEST_DATABASE_URL_VAR: &str = "JEETA_TEST_DATABASE_URL";

/// A fresh database, migrated up, dropped (with its role) when this value is dropped.
pub struct TestDb {
    /// A pool connected as the database's own non-superuser role.
    pub pool: PgPool,
    app: PgConnectOptions,
    // Declared last so it drops after `pool`.
    cleanup: Cleanup,
}

impl TestDb {
    /// Creates database `jt_test_<12 hex>` owned by a new login role of the same name
    /// (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, random password), connects to it as
    /// that role and runs every migration.
    ///
    /// Panics when `JEETA_TEST_DATABASE_URL` is unset or the server refuses.
    pub async fn new() -> TestDb {
        let url = std::env::var(TEST_DATABASE_URL_VAR).unwrap_or_else(|_| {
            panic!("{TEST_DATABASE_URL_VAR} must name an admin Postgres URL (see rust/README.md)")
        });
        let admin = PgConnectOptions::from_str(&url)
            .unwrap_or_else(|e| panic!("{TEST_DATABASE_URL_VAR} is not a Postgres URL: {e}"));
        let name = format!("jt_test_{}", hex::encode(rand::random::<[u8; 6]>()));
        let password = hex::encode(rand::random::<[u8; 16]>());

        let mut conn = PgConnection::connect_with(&admin)
            .await
            .unwrap_or_else(|e| panic!("cannot connect with {TEST_DATABASE_URL_VAR}: {e}"));
        // Identifiers and password are generated hex, so formatting them in is safe.
        let cleanup = Cleanup {
            admin: admin.clone(),
            name: name.clone(),
        };
        conn.execute(
            format!(
                "create role {name} login password '{password}' \
                 nosuperuser nobypassrls nocreatedb nocreaterole"
            )
            .as_str(),
        )
        .await
        .unwrap_or_else(|e| panic!("cannot create role {name}: {e}"));
        conn.execute(format!("create database {name} owner {name} template template0").as_str())
            .await
            .unwrap_or_else(|e| panic!("cannot create database {name}: {e}"));
        conn.close().await.ok();

        let app = admin
            .clone()
            .username(&name)
            .password(&password)
            .database(&name);
        let pool = jt_pg::connect_with(app.clone())
            .await
            .unwrap_or_else(|e| panic!("cannot connect to {name} as {name}: {e}"));
        jt_pg::migrate_up(&pool)
            .await
            .unwrap_or_else(|e| panic!("migrations failed on {name}: {e}"));

        TestDb { pool, app, cleanup }
    }

    /// The database's (and its role's) name, `jt_test_<12 hex>`.
    pub fn name(&self) -> &str {
        &self.cleanup.name
    }

    /// Options for further connections as the database's own role.
    pub fn connect_options(&self) -> PgConnectOptions {
        self.app.clone()
    }

    /// Inserts an active workspace named `name`, its owner `owner+<user id>@test.local` (password
    /// hash `plain:test`, as `fakes::PlainHasher` writes it), the three system roles and the
    /// owner's active membership. Returns the workspace and the owner.
    pub async fn seed_workspace(&self, name: &str) -> (WorkspaceId, UserId) {
        let ws = WorkspaceId::new_v7();
        let user = UserId::new_v7();
        let mut tx = jt_pg::PlatformTx::begin(&self.pool).await.unwrap();

        sqlx::query(
            "insert into workspaces (id, name, slug, status) values ($1, $2, $3, 'active')",
        )
        .bind(ws.as_uuid())
        .bind(name)
        .bind(format!("{name}-{}", ws.as_uuid().simple()))
        .execute(tx.conn())
        .await
        .unwrap();
        sqlx::query(
            "insert into users (id, email, password_hash, display_name) \
             values ($1, $2, 'plain:test', $3)",
        )
        .bind(user.as_uuid())
        .bind(format!("owner+{user}@test.local"))
        .bind(format!("Owner of {name}"))
        .execute(tx.conn())
        .await
        .unwrap();

        let mut owner_role = None;
        for (role, label) in [
            (SystemRole::Owner, "Owner"),
            (SystemRole::Manager, "Manager"),
            (SystemRole::Rep, "Rep"),
        ] {
            let id = RoleId::new_v7();
            let permissions: Vec<&str> = role.permissions().iter().map(|p| p.key()).collect();
            sqlx::query(
                "insert into roles (id, workspace_id, key, name, permissions, is_system) \
                 values ($1, $2, $3, $4, $5, true)",
            )
            .bind(id.as_uuid())
            .bind(ws.as_uuid())
            .bind(role.key())
            .bind(label)
            .bind(permissions)
            .execute(tx.conn())
            .await
            .unwrap();
            if role == SystemRole::Owner {
                owner_role = Some(id);
            }
        }

        sqlx::query(
            "insert into memberships (id, workspace_id, user_id, role_id, status) \
             values ($1, $2, $3, $4, 'active')",
        )
        .bind(MembershipId::new_v7().as_uuid())
        .bind(ws.as_uuid())
        .bind(user.as_uuid())
        .bind(owner_role.expect("owner role inserted").as_uuid())
        .execute(tx.conn())
        .await
        .unwrap();

        tx.commit().await.unwrap();
        (ws, user)
    }
}

/// Drops a test database and its role, also when `TestDb::new` fails halfway.
struct Cleanup {
    admin: PgConnectOptions,
    name: String,
}

impl Drop for Cleanup {
    /// Best effort: drops the database (terminating its connections) and the role, each only if
    /// it exists. Runs on its own thread and runtime, because the test's runtime may already be
    /// shutting down.
    fn drop(&mut self) {
        let admin = self.admin.clone();
        let name = self.name.clone();
        let dropped = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            runtime.block_on(async {
                let mut conn = PgConnection::connect_with(&admin)
                    .await
                    .map_err(|e| e.to_string())?;
                conn.execute(format!("drop database if exists {name} with (force)").as_str())
                    .await
                    .map_err(|e| e.to_string())?;
                conn.execute(format!("drop role if exists {name}").as_str())
                    .await
                    .map_err(|e| e.to_string())?;
                conn.close().await.ok();
                Ok::<(), String>(())
            })
        })
        .join();
        match dropped {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("warning: could not drop test database {}: {e}", self.name),
            Err(_) => eprintln!("warning: dropping test database {} panicked", self.name),
        }
    }
}
