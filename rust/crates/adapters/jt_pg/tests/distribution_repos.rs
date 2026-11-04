//! Lead distribution's repository contracts (`jt_testkit::distribution_contract`) against
//! PostgreSQL (migration `0025_distribution`), row-level security binding; and what only
//! PostgreSQL shows: the assignment log's trigger.

use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_inbox::Cause;
use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;
use jt_testkit::distribution_contract::{decision, journey};
use jt_testkit::inbox_contract::Fixture;

#[tokio::test]
async fn one_live_assignment_per_journey() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::one_live_assignment_per_journey(uow).await;
}

#[tokio::test]
async fn supersede_then_insert_in_one_bundle() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::supersede_then_insert_in_one_bundle(uow).await;
}

#[tokio::test]
async fn touch_marks_only_the_owner_once() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::touch_marks_only_the_owner_once(uow).await;
}

#[tokio::test]
async fn due_sla_lists_unacted_past_due() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::due_sla_lists_unacted_past_due(uow).await;
}

#[tokio::test]
async fn ownerless_open_excludes_closed_and_owned() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::ownerless_open_excludes_closed_and_owned(uow).await;
}

#[tokio::test]
async fn rules_replace_all_keeps_positions_unique() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::rules_replace_all_keeps_positions_unique(uow).await;
}

#[tokio::test]
async fn rep_profile_default_when_absent() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::rep_profile_default_when_absent(uow).await;
}

#[tokio::test]
async fn recipient_kind_round_trips() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::distribution_contract::recipient_kind_round_trips(uow).await;
}

/// The log is append-only: only `acted_at` and `superseded_at` are written, once each, and a row
/// goes only with its journey.
#[tokio::test]
async fn assignment_rows_refuse_other_updates_and_deletes() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let j = journey(&f, None).await;
    let row = decision(j, Some(f.user), Cause::Default, 0);
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.assignments().insert(&row).await.unwrap();
    t.commit().await.unwrap();

    let refused = |sql: &'static str| {
        let pool = db.pool.clone();
        async move {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("select set_config('app.platform', 'on', true)")
                .execute(&mut *tx)
                .await
                .unwrap();
            let err = sqlx::query(sql)
                .execute(&mut *tx)
                .await
                .expect_err(sql)
                .to_string();
            assert!(err.contains("journey_assignments"), "{sql}: {err}");
        }
    };
    refused("update journey_assignments set cause = 'manual'").await;
    refused("update journey_assignments set user_id = null").await;
    refused("update journey_assignments set assigned_at = assigned_at + interval '1 minute'").await;
    refused("delete from journey_assignments").await;

    // acted_at and superseded_at are written once each.
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("update journey_assignments set acted_at = now(), superseded_at = now()")
        .execute(&mut *tx)
        .await
        .unwrap();
    let err = sqlx::query("update journey_assignments set acted_at = now() + interval '1 day'")
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("journey_assignments"), "{err}");
    drop(tx);

    // Deleting the journey takes its decisions with it (the v1 import's rollback).
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("delete from journeys where id = $1")
        .bind(j.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    let left: i64 =
        sqlx::query_scalar("select count(*) from journey_assignments where journey_id = $1")
            .bind(j.as_uuid())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(left, 0);
}
