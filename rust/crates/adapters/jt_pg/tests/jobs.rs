//! What the scheduler relies on in Postgres: the advisory job locks (one runner per job across
//! instances, a dropped guard gives its lock back) and the probe log's 30-day retention (the
//! purge and the trigger that refuses everything else).

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::{JobLock, ProbeRun, ProbeRunId, UnitOfWork};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_pg::{JOB_LOCK_APPLICATION_NAME, PgJobLock, PgUnitOfWork, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use serde_json::json;
use sqlx::postgres::{PgPoolOptions, PgSslMode};
use time::{Duration, OffsetDateTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const PROBE_ALL: &str = "jeeta.jobs.probe_all";

/// How many advisory locks are held now in this test's database (`pg_locks` covers the whole
/// server, where other tests' migrations take advisory locks of their own).
async fn advisory_locks(db: &TestDb) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_locks where locktype = 'advisory' and granted \
         and database = (select oid from pg_database where datname = current_database())",
    )
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
         where l.locktype = 'advisory' and l.granted and a.datname = current_database()",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(names, [JOB_LOCK_APPLICATION_NAME]);
    holder.release().await.unwrap();
}

/// A TCP proxy in front of the test database that can hold back what the database sends: while
/// it holds, a query the client sent has run, but its answer has not arrived, which is where a
/// call cancelled mid-await leaves a session lock behind. What the client sends always goes
/// through, and when the client closes its end, the proxy closes the database's.
struct Proxy {
    port: u16,
    hold: Arc<watch::Sender<bool>>,
}

impl Proxy {
    async fn start(upstream: (String, u16)) -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = Arc::new(watch::channel(false).0);
        let held = Arc::clone(&hold);
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let server = TcpStream::connect(upstream.clone()).await.unwrap();
                let (mut from_client, mut to_client) = client.into_split();
                let (mut from_server, mut to_server) = server.into_split();
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut from_client, &mut to_server).await;
                    let _ = to_server.shutdown().await;
                });
                let mut gate = held.subscribe();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16 * 1024];
                    loop {
                        let n = match from_server.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        loop {
                            let holding = *gate.borrow_and_update();
                            if !holding {
                                break;
                            }
                            if gate.changed().await.is_err() {
                                return;
                            }
                        }
                        if to_client.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    let _ = to_client.shutdown().await;
                });
            }
        });
        Proxy { port, hold }
    }

    /// Holds back (`true`) or passes on (`false`) what the database sends.
    fn hold(&self, on: bool) {
        self.hold.send_replace(on);
    }
}

/// A lock acquisition cancelled after Postgres granted the lock but before its answer arrived
/// (the task aborted mid-await, before any guard exists) must not leave the lock with a session
/// that goes back to the pool: the connection is closed instead, its session ends, and another
/// instance's fresh pool takes the lock.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_acquisition_cancelled_mid_answer_leaves_no_lock_behind() {
    let db = TestDb::new().await;
    let options = (*db.pool.connect_options()).clone();
    let upstream = (options.get_host().to_owned(), options.get_port());
    let proxy = Proxy::start(upstream).await;
    // No ping when the connection is taken from the pool: the ping's answer would be held too.
    let through_proxy = PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .test_before_acquire(false)
        .connect_lazy_with(
            options
                .host("127.0.0.1")
                .port(proxy.port)
                .ssl_mode(PgSslMode::Disable),
        );
    // Before the answers are held: the connection is open, its statements prepared (sqlx waits
    // for a statement's description before it runs it the first time) by a lock taken and given
    // back once, and it is back idle in the pool (its release ping answered).
    let lock = PgJobLock::new(through_proxy.clone());
    let warm = lock
        .try_acquire("jeeta.jobs.warm_up")
        .await
        .unwrap()
        .expect("granted");
    warm.release().await.unwrap();
    for _ in 0..500 {
        if through_proxy.num_idle() == 1 {
            break;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    assert_eq!(through_proxy.num_idle(), 1);
    assert_eq!(advisory_locks(&db).await, 0);

    proxy.hold(true);
    let acquiring =
        tokio::spawn(async move { lock.try_acquire(PROBE_ALL).await.map(|g| g.is_some()) });
    // Postgres grants the lock; its answer is held back, so the acquisition is still awaiting.
    let mut granted = false;
    for _ in 0..500 {
        if advisory_locks(&db).await == 1 {
            granted = true;
            break;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    assert!(granted, "the lock was never granted");
    acquiring.abort();
    assert!(acquiring.await.unwrap_err().is_cancelled());
    // The answers flow again: a connection that went back to the pool would now be idle there,
    // its session still holding the lock.
    proxy.hold(false);

    // Another instance takes the lock: the cancelled session is gone.
    let other = PgJobLock::with_own_pool(&db.pool, 1);
    assert!(
        eventually_granted(&other, PROBE_ALL).await,
        "the cancelled acquisition left its lock behind"
    );
    assert_eq!(advisory_locks(&db).await, 0);
    through_proxy.close().await;
}

/// The first release on a connection prepares its unlock statement before executing it. Hold
/// that preparation's answer so release is awaiting while Postgres still holds the lock, then
/// cancel: returning the connection to the pool here would strand the lock without a guard.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_cancelled_mid_await_does_not_leak_the_session_lock() {
    let db = TestDb::new().await;
    let options = (*db.pool.connect_options()).clone();
    let proxy = Proxy::start((options.get_host().to_owned(), options.get_port())).await;
    let through_proxy = PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .test_before_acquire(false)
        .connect_lazy_with(
            options
                .host("127.0.0.1")
                .port(proxy.port)
                .ssl_mode(PgSslMode::Disable),
        );
    let lock = PgJobLock::new(through_proxy.clone());
    let guard = lock.try_acquire(PROBE_ALL).await.unwrap().expect("granted");
    let holder: i32 = sqlx::query_scalar(
        "select pid from pg_locks where locktype = 'advisory' and granted \
         and database = (select oid from pg_database where datname = current_database())",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();

    // Do not warm up release: its first preparation must await the held response before the
    // unlock can execute. Holding an already executed unlock's answer would not test a leak.
    proxy.hold(true);
    let releasing = tokio::spawn(async move { guard.release().await });
    let mut preparing = false;
    for _ in 0..500 {
        preparing = sqlx::query_scalar(
            "select exists(select 1 from pg_stat_activity \
             where pid = $1 and query = 'select pg_advisory_unlock(hashtext($1))')",
        )
        .bind(holder)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        if preparing {
            break;
        }
        tokio::time::sleep(StdDuration::from_millis(10)).await;
    }
    assert!(preparing, "release never reached its unlock preparation");
    assert!(!releasing.is_finished(), "release must still be awaiting");
    assert_eq!(advisory_locks(&db).await, 1, "unlock has not executed");
    releasing.abort();
    assert!(releasing.await.unwrap_err().is_cancelled());
    proxy.hold(false);

    // Keep the original pool alive: closing it here would hide a leaked session lock.
    let other = PgJobLock::with_own_pool(&db.pool, 1);
    assert!(
        eventually_granted(&other, PROBE_ALL).await,
        "the cancelled release left its lock behind"
    );
    assert_eq!(advisory_locks(&db).await, 0);
    let holder_alive: bool =
        sqlx::query_scalar("select exists(select 1 from pg_stat_activity where pid = $1)")
            .bind(holder)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(!holder_alive, "the unsettled lock session must be closed");
    through_proxy.close().await;
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

#[tokio::test]
async fn workspaces_with_verified_lists_only_workspaces_holding_a_verified_sealed_kind() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let (_c, _) = db.seed_workspace("c").await;
    // (workspace, kind, external id, status, sealed)
    for (ws, kind, external_id, status, sealed) in [
        (a, "sms_line", "A1", StoredStatus::Verified, true),
        (b, "sms_line", "B1", StoredStatus::Declared, true),
        (b, "sms_line", "B2", StoredStatus::Verified, false),
        (b, "sms_line", "B3", StoredStatus::Retired, true),
        (b, "facebook_page", "page-b", StoredStatus::Verified, true),
    ] {
        let mut c = Capability::new(
            CapabilityId::new_v7(),
            ws,
            NewCapability {
                kind_key: kind.into(),
                name: external_id.into(),
                external_id: Some(external_id.into()),
                ..NewCapability::default()
            },
            OffsetDateTime::now_utc(),
        )
        .unwrap();
        c.status = status;
        let mut t = uow.tenant(ws).await.unwrap();
        t.capabilities()
            .insert(c, sealed.then(|| b"sealed".to_vec()))
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.workspaces_with_verified(&["sms_line"]).await.unwrap(),
        [a]
    );
    let mut both = vec![a, b];
    both.sort();
    assert_eq!(
        p.workspaces_with_verified(&["sms_line", "facebook_page"])
            .await
            .unwrap(),
        both
    );
    assert!(p.workspaces_with_verified(&["x"]).await.unwrap().is_empty());
}

#[tokio::test]
async fn outbound_job_stub_accepts_capability_scope_and_rejects_foreign_workspace() {
    use jt_app::error::ErrorCode;
    use jt_app::ports::connectors::{DeliveryState, DeliveryStatus};
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("outbound-scope").await;
    let other = WorkspaceId::new_v7();
    for capability_id in [CapabilityId::new_v7(), CapabilityId::new_v7()] {
        let mut t = uow.tenant(ws).await.unwrap();
        assert!(
            t.outbound_jobs()
                .pending_job_ids(ws, capability_id, 50)
                .await
                .unwrap()
                .is_empty()
        );
        t.outbound_jobs()
            .record_status(
                ws,
                capability_id,
                vec![DeliveryStatus {
                    job_id: "unstored".into(),
                    recipient: "phone".into(),
                    status: DeliveryState::Delivered,
                    at: None,
                    raw_code: "1".into(),
                }],
            )
            .await
            .unwrap();
        assert!(
            t.outbound_jobs()
                .pending_job_ids(ws, capability_id, 50)
                .await
                .unwrap()
                .is_empty()
        );
        t.commit().await.unwrap();
        let mut t = uow.tenant(ws).await.unwrap();
        assert_eq!(
            t.outbound_jobs()
                .pending_job_ids(other, capability_id, 50)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Internal
        );
        drop(t);
        let mut t = uow.tenant(ws).await.unwrap();
        assert_eq!(
            t.outbound_jobs()
                .record_status(other, capability_id, vec![])
                .await
                .unwrap_err()
                .code,
            ErrorCode::Internal
        );
    }
}

#[tokio::test]
async fn iys_snapshot_refreshes_after_list_and_holds_the_row_lock() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("iys-snapshot").await;
    let (other, _) = db.seed_workspace("iys-foreign").await;
    let id = capability(&uow, ws).await;
    let now = OffsetDateTime::now_utc();
    let mut writer = uow.tenant(ws).await.unwrap();
    let mut cap = writer.capabilities().lock(id).await.unwrap().unwrap();
    cap.connector_public = json!({"iys":{"brand_code":"old-brand"}});
    writer.capabilities().update(cap).await.unwrap();
    writer
        .capabilities()
        .set_sealed(id, Some(b"old-sms".to_vec()), now)
        .await
        .unwrap();
    writer
        .capabilities()
        .set_iys_sealed(id, Some(b"old-iys".to_vec()), now)
        .await
        .unwrap();
    writer.commit().await.unwrap();

    let mut reader = uow.tenant(ws).await.unwrap();
    let listed = reader
        .capabilities()
        .list(Default::default())
        .await
        .unwrap();
    assert_eq!(listed[0].connector_public["iys"]["brand_code"], "old-brand");
    // An attach commits between discovery and credential reading on READ COMMITTED.
    let mut writer = uow.tenant(ws).await.unwrap();
    let mut cap = writer.capabilities().lock(id).await.unwrap().unwrap();
    cap.connector_public = json!({"iys":{"brand_code":"new-brand"}});
    writer.capabilities().update(cap).await.unwrap();
    writer
        .capabilities()
        .set_sealed(id, Some(b"new-sms".to_vec()), now)
        .await
        .unwrap();
    writer
        .capabilities()
        .set_iys_sealed(id, Some(b"new-iys".to_vec()), now)
        .await
        .unwrap();
    writer.commit().await.unwrap();
    let snapshot = reader
        .capabilities()
        .lock_iys_snapshot(id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        snapshot.capability.connector_public["iys"]["brand_code"],
        "new-brand"
    );
    assert_eq!(snapshot.sms_sealed.as_deref(), Some(b"new-sms".as_slice()));
    assert_eq!(snapshot.iys_sealed.as_deref(), Some(b"new-iys".as_slice()));
    let mut foreign = uow.tenant(other).await.unwrap();
    assert!(
        foreign
            .capabilities()
            .lock_iys_snapshot(id)
            .await
            .unwrap()
            .is_none()
    );
    drop(foreign);

    // The snapshot protects both slots until its transaction ends.
    let mut competing = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("set local lock_timeout = '100ms'")
        .execute(competing.conn())
        .await
        .unwrap();
    let error =
        sqlx::query("update capabilities set iys_sealed = $3 where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .bind(b"racing-iys".as_slice())
            .execute(competing.conn())
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    drop(competing);
    reader.commit().await.unwrap();
    let mut writer = uow.tenant(ws).await.unwrap();
    writer
        .capabilities()
        .set_iys_sealed(id, Some(b"after-release".to_vec()), now)
        .await
        .unwrap();
    writer.commit().await.unwrap();
}

#[tokio::test]
async fn mail_send_and_probe_do_not_nest_tenant_connections() {
    use jt_app::{
        ctx::Ctx,
        usecases::{connector, inbox::replies},
    };
    use jt_connector::{Credential, ProbeResult, Provider};
    use jt_inbox::{Identity, IdentityChannel, IdentityId};
    use jt_ledger::Actor;
    use jt_testkit::{
        fakes::{FIXED_NOW, ScriptedConnector, ScriptedRegistry},
        inbox_contract::Fixture,
    };
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("mail-one-connection").await;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(StdDuration::from_millis(200))
        .connect_with(db.connect_options())
        .await
        .unwrap();
    let uow = Arc::new(PgUnitOfWork::new(pool));
    let f = Fixture {
        uow: uow.clone(),
        ws,
        other: ws,
        user,
    };
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let mail = Arc::new(ScriptedConnector::new(Provider::Mail));
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(mail.clone()));
    let person = f.insert_person("Recipient").await;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "mailbox".into(),
            name: "Mail".into(),
            external_id: Some("support@example.com".into()),
            connector_public: json!({"hosts":["smtp.example.com", "imap.example.com"]}),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let credential = Credential::Mailbox {
        smtp_host: "smtp.example.com".into(),
        smtp_port: 465,
        imap_host: "imap.example.com".into(),
        imap_port: 993,
        username: "support@example.com".into(),
        password: "secret".into(),
        from_address: "support@example.com".into(),
        tls: jt_connector::MailTls::Implicit,
    };
    let sealed = deps
        .seal
        .seal(ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut conversation = f.conversation(person.id, cap.id);
    conversation.kind_key = "mailbox".into();
    let mut r = uow.tenant(ws).await.unwrap();
    r.capabilities()
        .insert(cap.clone(), Some(sealed))
        .await
        .unwrap();
    r.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: ws,
            person_id: person.id,
            channel: IdentityChannel::Email,
            value_normalized: "recipient@example.com".into(),
            value_display: "recipient@example.com".into(),
            active: true,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.strategy()
        .insert(jt_strategy::StrategyVersion {
            id: jt_strategy::StrategyVersionId::new_v7(),
            workspace_id: ws,
            number: 1,
            status: jt_strategy::VersionStatus::Approved,
            sections: Default::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(user),
            archived_at: None,
        })
        .await
        .unwrap();
    r.conversations()
        .upsert_on_inbound(conversation.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    mail.push_mail(Ok(jt_app::ports::connectors::SendReceipt {
        provider_id: "accepted".into(),
        cost_minor: None,
    }));
    let result = replies::reply(
        &deps,
        &ctx,
        conversation.id,
        serde_json::from_value(json!({"text":"Hello", "intent":"reply"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result.state, "sent");
    mail.push_probe(ProbeResult::success(
        1,
        json!({"account_id":"support@example.com"}),
    ));
    connector::probe(&deps, &ctx, cap.id).await.unwrap();
}

#[tokio::test]
async fn iys_provisioning_takes_inbox_lock_before_capability_lock() {
    use jt_inbox::{Channel, Consent, ConsentId, ConsentKind, ConsentSource, SyncState};
    use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("iys-lock-order").await;
    let pool = PgPoolOptions::new()
        .connect_with(db.connect_options().application_name("iys-lock-order"))
        .await
        .unwrap();
    let uow = Arc::new(PgUnitOfWork::new(pool));
    let f = Fixture {
        uow: uow.clone(),
        ws,
        other: ws,
        user,
    };
    let person = f.insert_person("Recipient").await;
    let cap = f.capability().await;
    let mut r = uow.tenant(ws).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: person.id,
            channel: Channel::Sms,
            kind: ConsentKind::Withdrawn,
            source: ConsentSource::Customer,
            at: FIXED_NOW,
            sync_state: SyncState::Pending,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut sender = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("select pg_advisory_xact_lock(hashtextextended('inbox:' || $1::text, 0))")
        .bind(ws.as_uuid())
        .execute(sender.conn())
        .await
        .unwrap();
    let deps = jt_testkit::fakes::deps(uow);
    let sync =
        tokio::spawn(async move { jt_app::usecases::jobs::run_iys_sync(&deps, FIXED_NOW).await });
    // Wait until sync reaches the workspace lock, without relying on task scheduling timing.
    tokio::time::timeout(StdDuration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("select exists(select 1 from pg_stat_activity where application_name = 'iys-lock-order' and wait_event = 'advisory')")
                .fetch_one(&db.pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(StdDuration::from_millis(10)).await;
        }
    }).await.unwrap();
    // A conversation insert takes this FK key-share lock while holding the inbox lock.
    sqlx::query("set local lock_timeout = '200ms'")
        .execute(sender.conn())
        .await
        .unwrap();
    let key_share =
        sqlx::query("select 1 from capabilities where workspace_id = $1 and id = $2 for key share")
            .bind(ws.as_uuid())
            .bind(cap.as_uuid())
            .execute(sender.conn())
            .await;
    drop(sender);
    let report = sync.await.unwrap();
    assert!(
        key_share.is_ok(),
        "sync held the capability while waiting for the inbox: {key_share:?}"
    );
    assert_eq!(report.failed, 0);
}
