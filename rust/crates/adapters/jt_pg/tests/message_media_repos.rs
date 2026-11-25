//! The chat media's repository contracts (`jt_testkit::message_media_contract`) against
//! PostgreSQL (migration `0055_message_media`), row-level security binding.

use std::sync::Arc;

use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;

#[tokio::test]
async fn record_fetch_purge() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::message_media_contract::record_fetch_purge(uow).await;
}

#[tokio::test]
async fn erasure_deletes_and_answers_the_files() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::message_media_contract::erasure_deletes_and_answers_the_files(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::message_media_contract::rows_are_workspace_scoped(uow).await;
}
