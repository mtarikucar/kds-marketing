#[tokio::test]
async fn five_distinct_wrong_guesses_lock_challenge() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::five_distinct_wrong_guesses_lock_challenge(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn activation_expiry_at_72_hours() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::activation_expiry_at_72_hours(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn activation_binding_and_replay() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::activation_binding_and_replay(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn current_owner_can_redeem_after_ownership_change() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::current_owner_can_redeem_after_ownership_change(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn agent_cannot_activate_even_with_valid_code() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::agent_cannot_activate_even_with_valid_code(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn activate_suspend_resume_revoke_reconfirm_activate() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::activate_suspend_resume_revoke_reconfirm_activate(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn issuance_rejects_every_historical_digest() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::issuance_rejects_every_historical_digest(std::sync::Arc::new(
        uow,
    ))
    .await;
}

#[tokio::test]
async fn concurrent_wrong_guesses_stop_at_five() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::concurrent_wrong_guesses_stop_at_five(std::sync::Arc::new(
        uow,
    ))
    .await;
}

#[tokio::test]
async fn activation_consume_status_and_ledger_roll_back_together() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::activation_consume_status_and_ledger_roll_back_together(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn strategy_approval_and_existing_confirm_actions_need_no_code() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::strategy_approval_and_existing_confirm_actions_need_no_code(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn sql_audit_failure_rolls_back_redemption() {
    use jt_testkit::activation_contract::{challenge, confirmed, redeem};
    let db = jt_testkit::TestDb::new().await;
    let (w, code) = confirmed(std::sync::Arc::new(jt_pg::PgUnitOfWork::new(
        db.pool.clone(),
    )))
    .await;
    let before = challenge(&w).await;
    let entries = w.entries().await;
    sqlx::raw_sql("create function reject_activation_audit() returns trigger language plpgsql as $$ begin if new.action = 'billing.activated' then raise exception 'synthetic audit failure'; end if; return new; end $$; create trigger reject_activation_audit before insert on ledger_entries for each row execute function reject_activation_audit();").execute(&db.pool).await.unwrap();
    assert!(redeem(&w, &w.owner(), &code).await.is_err());
    assert_eq!(challenge(&w).await, before);
    assert_eq!(w.entries().await, entries);
    let status = jt_app::usecases::billing::status(&w.deps, &w.owner())
        .await
        .unwrap();
    assert_eq!(
        status.workspace_status,
        jt_tenancy::WorkspaceStatus::PendingPayment
    );
    assert!(status.entitlement.unwrap().activated_at.is_none());
    sqlx::query("drop trigger reject_activation_audit on ledger_entries")
        .execute(&db.pool)
        .await
        .unwrap();
    w.activate(&code).await;
}
#[tokio::test]
async fn membership_and_role_changes_wait_for_authorization_lock() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::membership_and_role_changes_wait_for_authorization_lock(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn absent_and_invalidated_challenges_change_nothing() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::absent_and_invalidated_challenges_change_nothing(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn stale_request_time_cannot_redeem_after_expiry() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::stale_request_time_cannot_redeem_after_expiry(
        std::sync::Arc::new(uow),
    )
    .await;
}
