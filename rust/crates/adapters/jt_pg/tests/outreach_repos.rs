//! Outreach's repository contracts (`jt_testkit::outreach_contract`) against PostgreSQL
//! (migration `0026_outreach`), row-level security binding; and what only PostgreSQL shows: two
//! dispatchers never pick one enrollment (`for update skip locked`).

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_outreach::EnrollmentId;
use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;
use jt_testkit::outreach_contract::{at, enrollment, running, world};

fn pg(db: &TestDb) -> Arc<PgUnitOfWork> {
    Arc::new(PgUnitOfWork::new(db.pool.clone()))
}

#[tokio::test]
async fn templates_round_trip_and_are_revision_checked() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::templates_round_trip_and_are_revision_checked(pg(&db)).await;
}

#[tokio::test]
async fn campaigns_round_trip_and_are_revision_checked() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::campaigns_round_trip_and_are_revision_checked(pg(&db)).await;
}

#[tokio::test]
async fn one_active_enrollment_per_person() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::one_active_enrollment_per_person(pg(&db)).await;
}

#[tokio::test]
async fn due_skips_locked_and_future() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::due_skips_locked_and_future(pg(&db)).await;
}

#[tokio::test]
async fn advance_completes_after_last() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::advance_completes_after_last(pg(&db)).await;
}

#[tokio::test]
async fn stop_all_for_stops_only_active() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::stop_all_for_stops_only_active(pg(&db)).await;
}

#[tokio::test]
async fn send_outcome_written_once_per_transition() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::send_outcome_written_once_per_transition(pg(&db)).await;
}

#[tokio::test]
async fn counts_by_window() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::counts_by_window(pg(&db)).await;
}

#[tokio::test]
async fn mailbox_send_days_are_local_days() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::mailbox_send_days_are_local_days(pg(&db)).await;
}

#[tokio::test]
async fn domain_counts_by_mailbox() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::domain_counts_by_mailbox(pg(&db)).await;
}

#[tokio::test]
async fn report_groups_by_step() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::report_groups_by_step(pg(&db)).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let db = TestDb::new().await;
    jt_testkit::outreach_contract::rows_are_workspace_scoped(pg(&db)).await;
}

/// Two dispatchers' bundles open at once take disjoint due enrollments; a committed bundle's
/// rows are free again.
#[tokio::test]
async fn concurrent_due_picks_never_overlap() {
    let db = TestDb::new().await;
    let uow: Arc<dyn UnitOfWork> = pg(&db);
    let w = world(uow.clone()).await;
    let campaign = running(&w, 0).await;
    let mut rows = vec![];
    for i in 0..6 {
        let person = w.f.insert_person("Örnek Kafe").await.id;
        rows.push(enrollment(campaign.id, person, i - 10));
    }
    let mut t = uow.tenant(w.f.ws).await.unwrap();
    let report = t.outreach_enrollments().insert_many(&rows).await.unwrap();
    assert_eq!(report.inserted.len(), 6);
    t.commit().await.unwrap();

    let ids = |rows: &[jt_app::ports::outreach::EnrollmentRow]| -> BTreeSet<EnrollmentId> {
        rows.iter().map(|e| e.id).collect()
    };
    let mut first = uow.tenant(w.f.ws).await.unwrap();
    let a = ids(&first
        .outreach_enrollments()
        .due(campaign.id, at(0), 4)
        .await
        .unwrap());
    let mut second = uow.tenant(w.f.ws).await.unwrap();
    let b = ids(&second
        .outreach_enrollments()
        .due(campaign.id, at(0), 4)
        .await
        .unwrap());
    assert_eq!(a.len(), 4);
    assert_eq!(b.len(), 2, "the first bundle's rows are skipped");
    assert!(a.is_disjoint(&b));
    // The oldest due go to the first bundle.
    let oldest: BTreeSet<EnrollmentId> = rows[..4].iter().map(|e| e.id).collect();
    assert_eq!(a, oldest);
    drop(second);
    first.commit().await.unwrap();

    let mut third = uow.tenant(w.f.ws).await.unwrap();
    let all = third
        .outreach_enrollments()
        .due(campaign.id, at(0), 10)
        .await
        .unwrap();
    assert_eq!(all.len(), 6);
}
