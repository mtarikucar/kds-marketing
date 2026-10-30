//! The prospect pool's repository contracts (`jt_testkit::prospects_contract`) against the
//! in-memory fake.

#[tokio::test]
async fn insert_then_get_round_trips_every_field() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::insert_then_get_round_trips_every_field(uow).await;
}

#[tokio::test]
async fn hard_key_duplicate_is_reported_with_its_owner() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::hard_key_duplicate_is_reported_with_its_owner(uow).await;
}

#[tokio::test]
async fn soft_keys_never_conflict() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::soft_keys_never_conflict(uow).await;
}

#[tokio::test]
async fn update_is_revision_checked() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::update_is_revision_checked(uow).await;
}

#[tokio::test]
async fn update_replaces_keys() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::update_replaces_keys(uow).await;
}

#[tokio::test]
async fn record_score_sets_latest_in_the_same_call() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::record_score_sets_latest_in_the_same_call(uow).await;
}

#[tokio::test]
async fn list_filters_and_cursor() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::list_filters_and_cursor(uow).await;
}

#[tokio::test]
async fn delete_returns_keys_and_cascades_scores() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::delete_returns_keys_and_cascades_scores(uow).await;
}

#[tokio::test]
async fn due_for_purge_respects_time() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::due_for_purge_respects_time(uow).await;
}

#[tokio::test]
async fn status_promotion_and_counts() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::status_promotion_and_counts(uow).await;
}

#[tokio::test]
async fn research_tasks_round_trip_and_one_standing_per_entry() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::research_tasks_round_trip_and_one_standing_per_entry(uow).await;
}

#[tokio::test]
async fn blocklist_dnc_upgrades_rejected() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::blocklist_dnc_upgrades_rejected(uow).await;
}

#[tokio::test]
async fn blocklist_expired_rejected_is_ignored() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::blocklist_expired_rejected_is_ignored(uow).await;
}

#[tokio::test]
async fn lift_refuses_erased() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::lift_refuses_erased(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::rows_are_workspace_scoped(uow).await;
}

#[tokio::test]
async fn leads_policy_merges_defaults_key_by_key() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::prospects_contract::leads_policy_merges_defaults_key_by_key(uow).await;
}
