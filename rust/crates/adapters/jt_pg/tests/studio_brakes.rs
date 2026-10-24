#[tokio::test]
async fn controls_approval_and_transition_are_atomic() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::controls_approval_and_transition_are_atomic(&uow).await;
}
