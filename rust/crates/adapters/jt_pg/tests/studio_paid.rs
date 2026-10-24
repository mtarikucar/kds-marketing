//! Atomic cap reservations run against PostgreSQL, not only the serializable fake.
#[tokio::test]
async fn concurrent_reservations_never_exceed_cap() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(&uow).await;
}

#[tokio::test]
async fn paid_liability_contract_checks_all_item_periods() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::liability_uses_each_item_period(&uow).await;
}
