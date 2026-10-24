#[tokio::test]
async fn request_key_payload_mismatch_conflicts() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::request_key_payload_mismatch_conflicts(&uow).await;
}

#[tokio::test]
async fn studio_transaction_rollback_preserves_unstarted_claim() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::studio_transaction_rollback_preserves_unstarted_claim(&uow).await;
}

#[tokio::test]
async fn arm_identity_survives_version_change() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::arm_identity_survives_version_change(&uow).await;
}

#[tokio::test]
async fn concurrent_claim_has_one_owner() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::concurrent_claim_has_one_owner(&uow).await;
}

#[tokio::test]
async fn measurement_and_learning_dedupe() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::measurement_and_learning_dedupe(&uow).await;
}

#[tokio::test]
async fn files_trends_moves_and_retirement_round_trip() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::files_trends_moves_and_retirement_round_trip(&uow).await;
}

#[tokio::test]
async fn accepted_publish_response_lost_never_blindly_retries() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::accepted_publish_response_lost_never_blindly_retries(&uow).await;
}

#[tokio::test]
async fn budget_price_and_hypothesis_fields_round_trip() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::budget_price_and_hypothesis_fields_round_trip(&uow).await;
}

#[tokio::test]
async fn preopened_claim_uses_current_strategy() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::preopened_claim_uses_current_strategy(&uow).await;
}

#[tokio::test]
async fn reservations_are_atomic_and_settlement_is_idempotent() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(&uow).await;
}

#[tokio::test]
async fn preopened_reservation_reads_current_cap() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::preopened_reservation_reads_current_cap(&uow).await;
}

#[tokio::test]
async fn agent_inherits_issuer_scope_rep_has_no_studio_grants() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::agent_inherits_issuer_scope_rep_has_no_studio_grants(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn controls_approval_and_transition_are_atomic() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::studio_contract::controls_approval_and_transition_are_atomic(&uow).await;
}
