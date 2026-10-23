#[tokio::test]
async fn merge_snapshot_restores_conversation_collisions() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::merge_snapshot_restores_conversation_collisions(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}
#[tokio::test]
async fn undo_restores_active_identities() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::undo_restores_active_identities(std::sync::Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}
#[tokio::test]
async fn keeper_first_touch_preserved() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::keeper_first_touch_preserved(std::sync::Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}
#[tokio::test]
async fn undo_requires_confirm() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::undo_requires_confirm(std::sync::Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}
#[tokio::test]
async fn undo_refuses_after_thirty_days_or_aggregate_edit() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::undo_refuses_after_thirty_days_or_aggregate_edit(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}
#[tokio::test]
async fn merge_permissions_tenant_refusal_and_replays() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::merge_permissions_tenant_refusal_and_replays(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}
#[tokio::test]
async fn later_merge_cannot_erase_an_earlier_edit_guard() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::later_merge_cannot_erase_an_earlier_edit_guard(
        std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    )
    .await;
}
#[tokio::test]
async fn merge_and_undo_late_failures_roll_back() {
    let db = jt_testkit::TestDb::new().await;
    jt_testkit::inbox_merge_contract::merge_and_undo_late_failures_roll_back(std::sync::Arc::new(
        jt_pg::PgUnitOfWork::new(db.pool.clone()),
    ))
    .await;
}
