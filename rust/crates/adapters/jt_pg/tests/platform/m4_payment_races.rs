#[tokio::test]
async fn confirmation_never_activates() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::confirmation_never_activates(std::sync::Arc::new(uow))
        .await;
}

#[tokio::test]
async fn concurrent_confirmation_creates_one_grant() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::concurrent_confirmation_creates_one_grant(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn confirmation_retry_after_suspend_does_not_reactivate() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::confirmation_retry_after_suspend_does_not_reactivate(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reconfirm_same_payment_preserves_history() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::reconfirm_same_payment_preserves_history(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn revoke_pending_challenge_invalidates_code() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::revoke_pending_challenge_invalidates_code(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reason_required_and_repeated_transition_is_noop() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::reason_required_and_repeated_transition_is_noop(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn resume_preserves_paid_and_grandfathered_entitlement() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::resume_preserves_paid_and_grandfathered_entitlement(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn wrong_workspace_payment_is_not_found() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::wrong_workspace_payment_is_not_found(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reissue_invalidates_old_code_and_resets_attempts() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::reissue_invalidates_old_code_and_resets_attempts(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn confirmation_failure_rolls_back_every_effect() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::confirmation_failure_rolls_back_every_effect(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn first_confirmation_and_reissue_require_pending_and_matching_grant() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_payment_contract::first_confirmation_and_reissue_require_pending_and_matching_grant(std::sync::Arc::new(uow)).await;
}

#[tokio::test]
async fn ledger_failure_rolls_back_confirmation_reissue_and_revoke() {
    use jt_app::usecases::platform_payments as ops;
    use jt_pg::PlatformTx;
    use jt_testkit::platform_payment_contract::World;
    let db = jt_testkit::TestDb::new().await;
    let w = World::new(std::sync::Arc::new(jt_pg::PgUnitOfWork::new(
        db.pool.clone(),
    )))
    .await;
    // A real SQL failure at the last write, after grant/code/status effects have run.
    sqlx::raw_sql("create function reject_billing_audit() returns trigger language plpgsql as $$ begin if new.action like 'billing.%' then raise exception 'synthetic audit failure'; end if; return new; end $$; create trigger reject_billing_audit before insert on ledger_entries for each row execute function reject_billing_audit();").execute(&db.pool).await.unwrap();
    assert!(
        ops::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
            .await
            .is_err()
    );
    let mut r = w.deps.uow.platform().await.unwrap();
    assert!(r.entitlement_get(w.f.ws).await.unwrap().is_none());
    assert!(
        r.activation_code_lock_current_by_workspace(w.f.ws)
            .await
            .unwrap()
            .is_none()
    );
    drop(r);
    sqlx::query("alter table ledger_entries disable trigger reject_billing_audit")
        .execute(&db.pool)
        .await
        .unwrap();
    let first = ops::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    let old = first.activation.unwrap();
    sqlx::query("alter table ledger_entries enable trigger reject_billing_audit")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        ops::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
            .await
            .is_err()
    );
    let mut r = w.deps.uow.platform().await.unwrap();
    let current = r
        .activation_code_lock_current_by_workspace(w.f.ws)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.id, old.id);
    assert!(current.invalidated_at.is_none());
    drop(r);
    sqlx::query("alter table ledger_entries disable trigger reject_billing_audit")
        .execute(&db.pool)
        .await
        .unwrap();
    w.activate(&old.code).await;
    sqlx::query("alter table ledger_entries enable trigger reject_billing_audit")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        ops::revoke_activation(&w.deps, &w.ctx, w.f.ws, "refund")
            .await
            .is_err()
    );
    let mut r = w.deps.uow.platform().await.unwrap();
    assert_eq!(
        r.workspace_get(w.f.ws).await.unwrap().unwrap().status,
        jt_tenancy::WorkspaceStatus::Active
    );
    assert_eq!(
        r.entitlement_get(w.f.ws).await.unwrap().unwrap().id,
        first.entitlement.id
    );
    assert!(
        r.activation_code_lock_current_by_workspace(w.f.ws)
            .await
            .unwrap()
            .unwrap()
            .invalidated_at
            .is_none()
    );
    drop(r);
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let counts:(i64,i64,i64)=sqlx::query_as("select (select count(*) from workspace_entitlements where workspace_id=$1), (select count(*) from activation_codes where workspace_id=$1), (select count(*) from payment_notifications where workspace_id=$1)").bind(w.f.ws.0).fetch_one(tx.conn()).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    drop(tx);
    assert_eq!(w.entries().await.len(), 3);
}

#[tokio::test]
async fn activation_suspend_revoke_serialize() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::activation_contract::activation_suspend_revoke_serialize(std::sync::Arc::new(uow))
        .await;
}

#[tokio::test]
async fn payment_list_retains_revoked_history() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::platform_payment_contract::payment_list_retains_revoked_history(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}
