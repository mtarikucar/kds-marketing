//! The scheduler's job locks: Postgres session-level advisory locks.
//!
//! A lock is keyed by `hashtext(name)` and taken with `pg_try_advisory_lock`, which never waits:
//! `true` grants it, `false` means another session holds it. An advisory lock belongs to the
//! session that took it, so each granted lock keeps its own connection checked out of the pool
//! for as long as the guard lives, and is given back with `pg_advisory_unlock` on that same
//! connection. If the session ends first (the process dies, the connection breaks), Postgres frees
//! the lock by itself.
//!
//! The connections come from the pool [`PgJobLock`] is given. The server gives it a small pool
//! of its own ([`PgJobLock::with_own_pool`]), so that a lock held while a job runs never takes a
//! connection the panel and the jobs themselves need.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{JobGuard, JobLock};
use sqlx::pool::PoolConnection;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgConnection, PgPool, Postgres};

use crate::repos::map_sqlx;

/// The `application_name` of the connections of [`PgJobLock::with_own_pool`], so that the
/// sessions holding job locks are told apart in `pg_stat_activity` and `pg_locks`.
pub const JOB_LOCK_APPLICATION_NAME: &str = "jeeta-jobs";

/// Job locks over a pool of connections, one connection per held lock.
#[derive(Clone, Debug)]
pub struct PgJobLock {
    pool: PgPool,
}

impl PgJobLock {
    /// Locks whose connections come from `pool`.
    pub fn new(pool: PgPool) -> PgJobLock {
        PgJobLock { pool }
    }

    /// Locks over a pool of their own, of at most `max_connections` connections (one per lock
    /// held at once: the number of jobs), opened lazily with `pool`'s connection options and
    /// the application name [`JOB_LOCK_APPLICATION_NAME`]. No connection is opened before the
    /// first lock is asked for.
    pub fn with_own_pool(pool: &PgPool, max_connections: u32) -> PgJobLock {
        let options = (*pool.connect_options())
            .clone()
            .application_name(JOB_LOCK_APPLICATION_NAME);
        let own = PgPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(0)
            .connect_lazy_with(options);
        PgJobLock { pool: own }
    }
}

#[async_trait]
impl JobLock for PgJobLock {
    async fn try_acquire(&self, name: &str) -> Result<Option<Box<dyn JobGuard>>, AppError> {
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| map_sqlx(e, "open a job lock connection"))?;
        let granted: bool = sqlx::query_scalar("select pg_try_advisory_lock(hashtext($1))")
            .bind(name)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| map_sqlx(e, "take a job lock"))?;
        if !granted {
            // Held by another session: the connection goes back to the pool, holding nothing.
            return Ok(None);
        }
        Ok(Some(Box::new(PgJobGuard {
            conn: Some(conn),
            name: name.to_owned(),
        })))
    }
}

/// A granted job lock and the connection whose session holds it.
struct PgJobGuard {
    /// `None` once the lock was given back.
    conn: Option<PoolConnection<Postgres>>,
    name: String,
}

/// Gives back lock `name` on `conn`; `Ok(false)` when this session did not hold it.
async fn unlock(conn: &mut PgConnection, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("select pg_advisory_unlock(hashtext($1))")
        .bind(name)
        .fetch_one(conn)
        .await
}

#[async_trait]
impl JobGuard for PgJobGuard {
    async fn release(mut self: Box<Self>) -> Result<(), AppError> {
        let Some(mut conn) = self.conn.take() else {
            return Ok(());
        };
        match unlock(&mut conn, &self.name).await {
            Ok(true) => Ok(()),
            // The session did not hold it after all, or could not answer: close the connection
            // instead of handing a session of unknown state back to the pool. Ending the session
            // frees whatever advisory lock it still holds.
            Ok(false) => {
                conn.close_on_drop();
                Err(AppError::internal("the job lock was not held"))
            }
            Err(e) => {
                conn.close_on_drop();
                Err(map_sqlx(e, "give back a job lock"))
            }
        }
    }
}

/// A guard dropped without [`JobGuard::release`] (its run panicked, its task was aborted): the
/// unlock cannot run inside `drop`, which is synchronous, so it is spawned onto the runtime and
/// the connection returns to the pool once the lock is given back (or is closed if that fails).
/// With no runtime left (the process is ending), the connection is detached from the pool and
/// dropped, which ends its session, and Postgres frees the lock.
impl Drop for PgJobGuard {
    fn drop(&mut self) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let name = std::mem::take(&mut self.name);
                runtime.spawn(async move {
                    if !matches!(unlock(&mut conn, &name).await, Ok(true)) {
                        conn.close_on_drop();
                    }
                });
            }
            Err(_) => drop(conn.detach()),
        }
    }
}
