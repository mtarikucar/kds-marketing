//! The prospect pool's repository contracts (`jt_testkit::prospects_contract`) against
//! PostgreSQL (migration `0020_prospects`), row-level security binding; and what only PostgreSQL
//! can show: two bundles racing for one phone, and the pool lock serialising two writers.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::UnitOfWork;
use jt_app::ports::prospects::Inserted;
use jt_pg::PgUnitOfWork;
use jt_prospects::derive_keys;
use jt_testkit::TestDb;
use jt_testkit::inbox_contract::Fixture;
use jt_testkit::prospects_contract::{at, input, prospect};

#[tokio::test]
async fn insert_then_get_round_trips_every_field() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::insert_then_get_round_trips_every_field(uow).await;
}

#[tokio::test]
async fn hard_key_duplicate_is_reported_with_its_owner() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::hard_key_duplicate_is_reported_with_its_owner(uow).await;
}

#[tokio::test]
async fn soft_keys_never_conflict() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::soft_keys_never_conflict(uow).await;
}

#[tokio::test]
async fn update_is_revision_checked() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::update_is_revision_checked(uow).await;
}

#[tokio::test]
async fn update_replaces_keys() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::update_replaces_keys(uow).await;
}

#[tokio::test]
async fn record_score_sets_latest_in_the_same_call() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::record_score_sets_latest_in_the_same_call(uow).await;
}

#[tokio::test]
async fn list_filters_and_cursor() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::list_filters_and_cursor(uow).await;
}

#[tokio::test]
async fn delete_returns_keys_and_cascades_scores() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::delete_returns_keys_and_cascades_scores(uow).await;
}

#[tokio::test]
async fn due_for_purge_respects_time() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::due_for_purge_respects_time(uow).await;
}

#[tokio::test]
async fn status_promotion_and_counts() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::status_promotion_and_counts(uow).await;
}

#[tokio::test]
async fn research_tasks_round_trip_and_one_standing_per_entry() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::research_tasks_round_trip_and_one_standing_per_entry(uow).await;
}

#[tokio::test]
async fn blocklist_dnc_upgrades_rejected() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::blocklist_dnc_upgrades_rejected(uow).await;
}

#[tokio::test]
async fn blocklist_expired_rejected_is_ignored() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::blocklist_expired_rejected_is_ignored(uow).await;
}

#[tokio::test]
async fn lift_refuses_erased() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::lift_refuses_erased(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::rows_are_workspace_scoped(uow).await;
}

#[tokio::test]
async fn leads_policy_merges_defaults_key_by_key() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::prospects_contract::leads_policy_merges_defaults_key_by_key(uow).await;
}

/// Two bundles insert prospects with one phone at once, neither holding the pool lock: the
/// `prospect_keys_hard` index lets one through; the other answers `DuplicateKey` and leaves no
/// prospect behind.
#[tokio::test]
async fn concurrent_inserts_with_one_phone_create_one_prospect() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let a = prospect(f.ws, f.user, input("Bir Kafe", "0500 000 00 00"), at(0));
    let b = prospect(f.ws, f.user, input("İki Kafe", "0500 000 00 00"), at(1));
    let mut first = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        first
            .prospects()
            .insert(&a, &derive_keys(&a))
            .await
            .unwrap(),
        Inserted::Ok
    );
    // The second insert waits on the first's uncommitted key.
    let racing = {
        let uow = uow.clone();
        let b = b.clone();
        tokio::spawn(async move {
            let mut second = uow.tenant(b.workspace_id).await.unwrap();
            let out = second
                .prospects()
                .insert(&b, &derive_keys(&b))
                .await
                .unwrap();
            second.commit().await.unwrap();
            out
        })
    };
    tokio::time::sleep(StdDuration::from_millis(300)).await;
    assert!(
        !racing.is_finished(),
        "the second insert waits for the first"
    );
    first.commit().await.unwrap();
    assert_eq!(
        racing.await.unwrap(),
        Inserted::DuplicateKey {
            kind: jt_prospects::KeyKind::Phone,
            prospect_id: a.id
        }
    );
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(t.prospects().get(a.id).await.unwrap().is_some());
    assert_eq!(t.prospects().get(b.id).await.unwrap(), None);
    assert!(t.prospects().keys_of(b.id).await.unwrap().is_empty());
}

/// A bundle holding the pool lock makes a second one wait at its own `lock_pool` until it
/// commits; another workspace's pool is not held up.
#[tokio::test]
async fn pool_lock_serialises_two_bundles() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let mut holder = uow.tenant(f.ws).await.unwrap();
    holder.prospects().lock_pool().await.unwrap();
    let mut other_ws = uow.tenant(f.other).await.unwrap();
    tokio::time::timeout(StdDuration::from_secs(5), other_ws.prospects().lock_pool())
        .await
        .expect("another workspace's pool is free")
        .unwrap();
    other_ws.commit().await.unwrap();
    let waiter = {
        let uow = uow.clone();
        let ws = f.ws;
        tokio::spawn(async move {
            let mut t = uow.tenant(ws).await.unwrap();
            t.prospects().lock_pool().await.unwrap();
            t.commit().await.unwrap();
        })
    };
    tokio::time::sleep(StdDuration::from_millis(300)).await;
    assert!(
        !waiter.is_finished(),
        "the second bundle waits for the pool"
    );
    holder.commit().await.unwrap();
    tokio::time::timeout(StdDuration::from_secs(5), waiter)
        .await
        .expect("the second bundle gets the pool once the first commits")
        .unwrap();
}
