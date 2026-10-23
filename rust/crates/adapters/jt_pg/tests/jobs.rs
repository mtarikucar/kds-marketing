//! What the scheduler relies on in Postgres: the advisory job locks (one runner per job across
//! instances, a dropped guard gives its lock back) and the probe log's 30-day retention (the
//! purge and the trigger that refuses everything else).

use std::time::Duration as StdDuration;

use jt_app::ports::{JobLock, ProbeRun, ProbeRunId, UnitOfWork};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_pg::{JOB_LOCK_APPLICATION_NAME, PgJobLock, PgUnitOfWork, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use serde_json::json;
use time::{Duration, OffsetDateTime};

const PROBE_ALL: &str = "jeeta.jobs.probe_all";

/// How many advisory locks the database holds now, by any session.
async fn advisory_locks(db: &TestDb) -> i64 {
    sqlx::query_scalar("select count(*) from pg_locks where locktype = 'advisory' and granted")
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// Waits (up to two seconds) until `lock` grants `name`, as a dropped guard gives it back in
/// the background.
async fn eventually_granted(lock: &PgJobLock, name: &str) -> bool {
    for _ in 0..200 {
        if let Some(guard) = lock.try_acquire(name).await.unwrap() {
            guard.release().await.unwrap();
            return true;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn second_runner_skips_while_first_holds() {
    let db = TestDb::new().await;
    // Two instances of the server: each its own lock manager over its own pool.
    let first = PgJobLock::with_own_pool(&db.pool, 4);
    let second = PgJobLock::with_own_pool(&db.pool, 4);

    let held = first
        .try_acquire(PROBE_ALL)
        .await
        .unwrap()
        .expect("granted");
    assert_eq!(advisory_locks(&db).await, 1);
    // The second runner skips while the first holds it, again and again: never waits.
    for _ in 0..3 {
        assert!(second.try_acquire(PROBE_ALL).await.unwrap().is_none());
    }
    // Nor can the first instance take it twice (each lock is its own session).
    assert!(first.try_acquire(PROBE_ALL).await.unwrap().is_none());
    // Another job's lock is free.
    let other = second
        .try_acquire("jeeta.jobs.refresh_tokens")
        .await
        .unwrap()
        .expect("another job's lock is granted");
    assert_eq!(advisory_locks(&db).await, 2);

    // Released, the lock goes to whoever asks next, and nothing is left held.
    held.release().await.unwrap();
    other.release().await.unwrap();
    assert_eq!(advisory_locks(&db).await, 0);
    let taken = second
        .try_acquire(PROBE_ALL)
        .await
        .unwrap()
        .expect("granted");
    assert!(first.try_acquire(PROBE_ALL).await.unwrap().is_none());
    taken.release().await.unwrap();

    // A guard dropped without a release (its run panicked) gives the lock back by itself.
    let dropped = first
        .try_acquire(PROBE_ALL)
        .await
        .unwrap()
        .expect("granted");
    drop(dropped);
    assert!(eventually_granted(&second, PROBE_ALL).await);

    // The lock sessions are told apart from the server's own.
    let holder = first
        .try_acquire(PROBE_ALL)
        .await
        .unwrap()
        .expect("granted");
    let names: Vec<String> = sqlx::query_scalar(
        "select a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid \
         where l.locktype = 'advisory' and l.granted",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(names, [JOB_LOCK_APPLICATION_NAME]);
    holder.release().await.unwrap();
}

/// A capability of `ws` to hang probe runs off.
async fn capability(uow: &PgUnitOfWork, ws: WorkspaceId) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "Hat".into(),
            external_id: Some("ACME".into()),
            ..NewCapability::default()
        },
        OffsetDateTime::now_utc(),
    )
    .unwrap();
    let id = c.id;
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c, None).await.unwrap();
    t.commit().await.unwrap();
    id
}

fn run(ws: WorkspaceId, capability: CapabilityId, at: OffsetDateTime) -> ProbeRun {
    ProbeRun {
        id: ProbeRunId::new_v7(),
        workspace_id: ws,
        capability_id: capability,
        at,
        ok: true,
        error_kind: None,
        latency_ms: 10,
        facts: json!({}),
    }
}

#[tokio::test]
async fn purge_probe_runs_keeps_thirty_days_and_trigger_refuses_young_deletes() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let line = capability(&uow, a).await;
    let theirs = capability(&uow, b).await;
    // The database's clock: the trigger measures age with it.
    let now: OffsetDateTime = sqlx::query_scalar("select now()")
        .fetch_one(&db.pool)
        .await
        .unwrap();

    let old = run(a, line, now - Duration::days(40));
    let edge = run(a, line, now - Duration::days(29));
    let young = run(a, line, now - Duration::hours(1));
    let other_old = run(b, theirs, now - Duration::days(40));
    for r in [&old, &edge, &young] {
        let mut t = uow.tenant(a).await.unwrap();
        t.probe_runs().append(r.clone()).await.unwrap();
        t.commit().await.unwrap();
    }
    let mut t = uow.tenant(b).await.unwrap();
    t.probe_runs().append(other_old.clone()).await.unwrap();
    t.commit().await.unwrap();

    // The daily purge removes the workspace's runs older than 30 days, and only its own.
    let mut t = uow.tenant(a).await.unwrap();
    let removed = t
        .probe_runs()
        .purge_before(now - Duration::days(30))
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(removed, 1);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.probe_runs().list(line, 10).await.unwrap(),
        vec![young.clone(), edge.clone()]
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.probe_runs().list(theirs, 10).await.unwrap(),
        vec![other_old.clone()]
    );
    drop(t);

    // A cutoff ahead of the database's clock leaves the young runs alone instead of failing.
    let mut t = uow.tenant(a).await.unwrap();
    let removed = t
        .probe_runs()
        .purge_before(now + Duration::days(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(removed, 0);

    // By hand, the trigger refuses to delete a run younger than 30 days, and to change any run,
    // even an old one.
    for (statement, id) in [
        (
            "delete from probe_runs where workspace_id = $1 and id = $2",
            young.id,
        ),
        (
            "delete from probe_runs where workspace_id = $1 and id = $2",
            edge.id,
        ),
        (
            "update probe_runs set ok = false where workspace_id = $1 and id = $2",
            young.id,
        ),
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .bind(id.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("append-only"),
            "{statement}: {err}"
        );
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    let err = sqlx::query("update probe_runs set ok = false where workspace_id = $1 and id = $2")
        .bind(b.as_uuid())
        .bind(other_old.id.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");
    tx.rollback().await.unwrap();
    // An old run may be deleted by hand too: the retention, not the purge, is the rule.
    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    let done = sqlx::query("delete from probe_runs where workspace_id = $1 and id = $2")
        .bind(b.as_uuid())
        .bind(other_old.id.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap();
    assert_eq!(done.rows_affected(), 1);
    tx.rollback().await.unwrap();
}
