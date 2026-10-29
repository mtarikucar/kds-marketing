//! The device command queue's contracts (`jt_testkit::devices_contract`) against PostgreSQL
//! (migration `0017_device_bridge`), row-level security binding; and what only PostgreSQL can
//! show: bundles racing for the same commands, and a stored value this version does not know.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::UnitOfWork;
use jt_app::ports::devices::{DEFAULT_EXPIRES_IN, FailReason, Finished, REDELIVER_AFTER};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::TestDb;
use jt_testkit::devices_contract::{at, done, enqueue, get, ids, lease, phone, tap};
use jt_testkit::fakes::FIXED_NOW;
use jt_testkit::inbox_contract::Fixture;

#[tokio::test]
async fn lease_returns_oldest_first() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::lease_returns_oldest_first(uow).await;
}

#[tokio::test]
async fn lease_skips_fresh_lease_and_redelivers_after_10s() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::lease_skips_fresh_lease_and_redelivers_after_10s(uow).await;
}

#[tokio::test]
async fn lease_never_returns_expired() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::lease_never_returns_expired(uow).await;
}

#[tokio::test]
async fn pick_due_does_not_mark() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::pick_due_does_not_mark(uow).await;
}

#[tokio::test]
async fn mark_leased_marks_only_still_pending() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::mark_leased_marks_only_still_pending(uow).await;
}

#[tokio::test]
async fn fail_pending_never_sets_leased_at_and_skips_finished() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::fail_pending_never_sets_leased_at_and_skips_finished(uow).await;
}

#[tokio::test]
async fn finish_is_idempotent() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::finish_is_idempotent(uow).await;
}

#[tokio::test]
async fn finish_unknown_id() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::finish_unknown_id(uow).await;
}

#[tokio::test]
async fn finish_for_another_bridges_command_is_unknown() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::finish_for_another_bridges_command_is_unknown(uow).await;
}

#[tokio::test]
async fn finish_replaces_expired_after_lease() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::finish_replaces_expired_after_lease(uow).await;
}

#[tokio::test]
async fn finish_refuses_result_for_never_leased() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::finish_refuses_result_for_never_leased(uow).await;
}

#[tokio::test]
async fn expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry(uow).await;
}

#[tokio::test]
async fn list_is_newest_first_and_bounded() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::list_is_newest_first_and_bounded(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::devices_contract::rows_are_workspace_scoped(uow).await;
}

/// Two polls open at once, each picking one command, are handed different ones: a command one
/// bundle picked is passed over by the other until that bundle ends.
#[tokio::test]
async fn concurrent_picks_take_different_commands() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, expires), tap(p, 2, expires)]).await;

    let now = at(1);
    let mut a = uow.tenant(f.ws).await.unwrap();
    let mut b = uow.tenant(f.ws).await.unwrap();
    let picked_a = a
        .device_commands()
        .pick_due(&[p], now, now - REDELIVER_AFTER, 1)
        .await
        .unwrap();
    let picked_b = b
        .device_commands()
        .pick_due(&[p], now, now - REDELIVER_AFTER, 1)
        .await
        .unwrap();
    assert_eq!(ids(&picked_a), vec![rows[0].id]);
    assert_eq!(ids(&picked_b), vec![rows[1].id]);
    for (t, picked) in [(&mut a, &picked_a), (&mut b, &picked_b)] {
        let marked = t
            .device_commands()
            .mark_leased(&ids(picked), now)
            .await
            .unwrap();
        assert_eq!(ids(&marked), ids(picked));
    }
    a.commit().await.unwrap();
    b.commit().await.unwrap();
    assert!(lease(&uow, f.ws, &[p], at(2), 10).await.is_empty());
}

/// Two results for one command, reported at once: the second waits for the first one's bundle,
/// then finds the result recorded.
#[tokio::test]
async fn racing_results_apply_once() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let id = enqueue(&uow, f.ws, vec![tap(p, 1, FIXED_NOW + DEFAULT_EXPIRES_IN)]).await[0].id;
    lease(&uow, f.ws, &[p], at(1), 10).await;

    let mut a = uow.tenant(f.ws).await.unwrap();
    let mut b = uow.tenant(f.ws).await.unwrap();
    let first = a
        .device_commands()
        .finish(&[p], id, done(), at(2))
        .await
        .unwrap();
    assert!(matches!(first, Finished::Applied(_)));
    let caps = [p];
    let answer = {
        let second = b.device_commands().finish(&caps, id, done(), at(3));
        tokio::pin!(second);
        assert!(
            tokio::time::timeout(StdDuration::from_millis(50), &mut second)
                .await
                .is_err()
        );
        a.commit().await.unwrap();
        second.await.unwrap()
    };
    assert_eq!(answer, Finished::Duplicate);
    b.commit().await.unwrap();
    assert_eq!(get(&uow, f.ws, id).await.unwrap().done_at, Some(at(2)));
}

/// The expiry sweep passes over a due command another bundle holds, without waiting for it; the
/// next sweep ends it.
#[tokio::test]
async fn expire_due_passes_over_a_held_command() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, at(5)), tap(p, 2, at(5))]).await;
    lease(&uow, f.ws, &[p], at(1), 10).await;

    // A bridge's results bundle holds the first command, then rolls back.
    let mut holder = uow.tenant(f.ws).await.unwrap();
    let held = holder
        .device_commands()
        .finish(&[p], rows[0].id, done(), at(6))
        .await
        .unwrap();
    assert!(matches!(held, Finished::Applied(_)));
    let mut sweep = uow.tenant(f.ws).await.unwrap();
    let swept = tokio::time::timeout(
        StdDuration::from_secs(5),
        sweep.device_commands().expire_due(at(10)),
    )
    .await
    .expect("the sweep does not wait for the held command")
    .unwrap();
    assert_eq!(
        swept.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![rows[1].id]
    );
    sweep.commit().await.unwrap();
    drop(holder);

    let mut sweep = uow.tenant(f.ws).await.unwrap();
    let swept = sweep.device_commands().expire_due(at(11)).await.unwrap();
    assert_eq!(
        swept.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![rows[0].id]
    );
    sweep.commit().await.unwrap();
}

/// A failure reason this version does not know (a newer server stored it) reads as `unknown`,
/// and the command stays readable.
#[tokio::test]
async fn an_unknown_stored_reason_reads_as_unknown() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let id = enqueue(&uow, f.ws, vec![tap(p, 1, FIXED_NOW + DEFAULT_EXPIRES_IN)]).await[0].id;
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.device_commands()
        .fail_pending(&[id], FailReason::DeviceOffline, "offline", at(1))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut tx = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    sqlx::query(
        "update device_commands set reason = 'from_a_newer_server'          where workspace_id = $1 and id = $2",
    )
    .bind(f.ws.as_uuid())
    .bind(id)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let row = get(&uow, f.ws, id).await.unwrap();
    assert_eq!(row.reason, Some(FailReason::Unknown));
    assert_eq!(row.detail.as_deref(), Some("offline"));
}
