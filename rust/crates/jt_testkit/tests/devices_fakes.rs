//! The device command queue's contracts (`jt_testkit::devices_contract`) against the in-memory
//! fake.

#[tokio::test]
async fn lease_returns_oldest_first() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::lease_returns_oldest_first(uow).await;
}

#[tokio::test]
async fn lease_skips_fresh_lease_and_redelivers_after_10s() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::lease_skips_fresh_lease_and_redelivers_after_10s(uow).await;
}

#[tokio::test]
async fn lease_never_returns_expired() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::lease_never_returns_expired(uow).await;
}

#[tokio::test]
async fn pick_due_does_not_mark() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::pick_due_does_not_mark(uow).await;
}

#[tokio::test]
async fn mark_leased_marks_only_still_pending() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::mark_leased_marks_only_still_pending(uow).await;
}

#[tokio::test]
async fn fail_pending_never_sets_leased_at_and_skips_finished() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::fail_pending_never_sets_leased_at_and_skips_finished(uow).await;
}

#[tokio::test]
async fn fail_pending_passes_over_a_command_that_expired_after_its_lease() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::fail_pending_passes_over_a_command_that_expired_after_its_lease(
        uow,
    )
    .await;
}

#[tokio::test]
async fn finish_is_idempotent() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::finish_is_idempotent(uow).await;
}

#[tokio::test]
async fn finish_unknown_id() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::finish_unknown_id(uow).await;
}

#[tokio::test]
async fn finish_for_another_bridges_command_is_unknown() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::finish_for_another_bridges_command_is_unknown(uow).await;
}

#[tokio::test]
async fn finish_replaces_expired_after_lease() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::finish_replaces_expired_after_lease(uow).await;
}

#[tokio::test]
async fn finish_refuses_result_for_never_leased() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::finish_refuses_result_for_never_leased(uow).await;
}

#[tokio::test]
async fn expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry(uow).await;
}

#[tokio::test]
async fn list_is_newest_first_and_bounded() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::list_is_newest_first_and_bounded(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::rows_are_workspace_scoped(uow).await;
}

#[tokio::test]
async fn device_files_are_recorded_once_and_found_in_their_workspace() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::devices_contract::device_files_are_recorded_once_and_found_in_their_workspace(uow)
        .await;
}
