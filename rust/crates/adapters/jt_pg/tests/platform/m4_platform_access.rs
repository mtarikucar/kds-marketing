#[tokio::test]
async fn operator_reset_revokes_all_sessions() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_access_contract::operator_reset_revokes_all_sessions(std::sync::Arc::new(
        uow,
    ))
    .await;
}
#[tokio::test]
async fn sole_operator_bootstrap_reset_changes_password() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_access_contract::sole_operator_bootstrap_reset_changes_password(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn bootstrap_reset_rejects_zero_multiple_or_wrong_operator() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_access_contract::bootstrap_reset_rejects_zero_multiple_or_wrong_operator(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn reset_and_inflight_login_serialize() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_access_contract::reset_and_inflight_login_serialize(std::sync::Arc::new(
        uow,
    ))
    .await;
}

#[tokio::test]
async fn recovery_lock_serializes_operator_insert() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::platform_access_contract::recovery_lock_serializes_operator_insert(
        std::sync::Arc::new(uow),
    )
    .await;
}
