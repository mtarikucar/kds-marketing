#[tokio::test]
async fn five_distinct_wrong_guesses_lock_challenge() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::five_distinct_wrong_guesses_lock_challenge(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn activation_expiry_at_72_hours() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::activation_expiry_at_72_hours(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn activation_binding_and_replay() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::activation_binding_and_replay(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn current_owner_can_redeem_after_ownership_change() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::current_owner_can_redeem_after_ownership_change(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn agent_cannot_activate_even_with_valid_code() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::agent_cannot_activate_even_with_valid_code(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn activate_suspend_resume_revoke_reconfirm_activate() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::activate_suspend_resume_revoke_reconfirm_activate(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn issuance_rejects_every_historical_digest() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::issuance_rejects_every_historical_digest(std::sync::Arc::new(
        uow,
    ))
    .await;
}

#[tokio::test]
async fn concurrent_wrong_guesses_stop_at_five() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::concurrent_wrong_guesses_stop_at_five(std::sync::Arc::new(
        uow,
    ))
    .await;
}

#[tokio::test]
async fn activation_consume_status_and_ledger_roll_back_together() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::activation_consume_status_and_ledger_roll_back_together(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn strategy_approval_and_existing_confirm_actions_need_no_code() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::strategy_approval_and_existing_confirm_actions_need_no_code(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn membership_and_role_changes_wait_for_authorization_lock() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::membership_and_role_changes_wait_for_authorization_lock(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn absent_and_invalidated_challenges_change_nothing() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::absent_and_invalidated_challenges_change_nothing(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn stale_request_time_cannot_redeem_after_expiry() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::activation_contract::stale_request_time_cannot_redeem_after_expiry(
        std::sync::Arc::new(uow),
    )
    .await;
}
