#[tokio::test]
async fn confirmation_never_activates() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::confirmation_never_activates(std::sync::Arc::new(uow))
        .await;
}

#[tokio::test]
async fn concurrent_confirmation_creates_one_grant() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::concurrent_confirmation_creates_one_grant(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn confirmation_retry_after_suspend_does_not_reactivate() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::confirmation_retry_after_suspend_does_not_reactivate(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reconfirm_same_payment_preserves_history() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::reconfirm_same_payment_preserves_history(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn revoke_pending_challenge_invalidates_code() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::revoke_pending_challenge_invalidates_code(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reason_required_and_repeated_transition_is_noop() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::reason_required_and_repeated_transition_is_noop(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn resume_preserves_paid_and_grandfathered_entitlement() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::resume_preserves_paid_and_grandfathered_entitlement(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn wrong_workspace_payment_is_not_found() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::wrong_workspace_payment_is_not_found(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reissue_invalidates_old_code_and_resets_attempts() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::reissue_invalidates_old_code_and_resets_attempts(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn confirmation_failure_rolls_back_every_effect() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::confirmation_failure_rolls_back_every_effect(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn first_confirmation_and_reissue_require_pending_and_matching_grant() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_payment_contract::first_confirmation_and_reissue_require_pending_and_matching_grant(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn activation_suspend_revoke_serialize() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::activation_suspend_revoke_serialize(std::sync::Arc::new(uow))
        .await;
}

#[tokio::test]
async fn payment_list_retains_revoked_history() {
    jt_testkit::platform_payment_contract::payment_list_retains_revoked_history(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}
