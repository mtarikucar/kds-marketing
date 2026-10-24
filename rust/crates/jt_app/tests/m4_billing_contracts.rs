//! Fake/Pg parity contracts.
#[tokio::test]
async fn request_key_unique_per_workspace() {
    jt_testkit::billing_contract::request_key_unique_per_workspace(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn paid_and_grandfathered_provenance_constraints() {
    jt_testkit::billing_contract::paid_and_grandfathered_provenance_constraints(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn one_open_grant_preserves_closed_history() {
    jt_testkit::billing_contract::one_open_grant_preserves_closed_history(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn workspace_status_reason_actor_is_atomic() {
    jt_testkit::billing_contract::workspace_status_reason_actor_is_atomic(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn activation_challenge_attempts_replay_and_reissue() {
    jt_testkit::billing_contract::activation_challenge_attempts_replay_and_reissue(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn stable_reference_and_masked_debug() {
    jt_testkit::billing_contract::stable_reference_and_masked_debug(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn workspace_lock_serializes_grants_and_references() {
    jt_testkit::billing_contract::workspace_lock_serializes_grants_and_references(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
#[tokio::test]
async fn challenge_expiry_and_tenant_references_are_enforced() {
    jt_testkit::billing_contract::challenge_expiry_and_tenant_references_are_enforced(
        &jt_testkit::fakes::InMemoryUow::new(),
    )
    .await;
}
