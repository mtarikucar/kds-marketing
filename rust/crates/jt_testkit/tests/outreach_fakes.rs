//! Outreach's repository contracts (`jt_testkit::outreach_contract`) against the in-memory fake.

fn uow() -> std::sync::Arc<jt_testkit::fakes::InMemoryUow> {
    std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new())
}

#[tokio::test]
async fn templates_round_trip_and_are_revision_checked() {
    jt_testkit::outreach_contract::templates_round_trip_and_are_revision_checked(uow()).await;
}

#[tokio::test]
async fn campaigns_round_trip_and_are_revision_checked() {
    jt_testkit::outreach_contract::campaigns_round_trip_and_are_revision_checked(uow()).await;
}

#[tokio::test]
async fn one_active_enrollment_per_person() {
    jt_testkit::outreach_contract::one_active_enrollment_per_person(uow()).await;
}

#[tokio::test]
async fn due_skips_locked_and_future() {
    jt_testkit::outreach_contract::due_skips_locked_and_future(uow()).await;
}

#[tokio::test]
async fn advance_completes_after_last() {
    jt_testkit::outreach_contract::advance_completes_after_last(uow()).await;
}

#[tokio::test]
async fn stop_all_for_stops_only_active() {
    jt_testkit::outreach_contract::stop_all_for_stops_only_active(uow()).await;
}

#[tokio::test]
async fn send_outcome_written_once_per_transition() {
    jt_testkit::outreach_contract::send_outcome_written_once_per_transition(uow()).await;
}

#[tokio::test]
async fn counts_by_window() {
    jt_testkit::outreach_contract::counts_by_window(uow()).await;
}

#[tokio::test]
async fn domain_counts_by_mailbox() {
    jt_testkit::outreach_contract::domain_counts_by_mailbox(uow()).await;
}

#[tokio::test]
async fn report_groups_by_step() {
    jt_testkit::outreach_contract::report_groups_by_step(uow()).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    jt_testkit::outreach_contract::rows_are_workspace_scoped(uow()).await;
}
