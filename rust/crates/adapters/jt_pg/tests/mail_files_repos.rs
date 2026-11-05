//! The mail files' repository contracts (`jt_testkit::mail_files_contract`) against PostgreSQL
//! (migration `0028_mail_files`), row-level security binding.

use std::sync::Arc;

use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;

#[tokio::test]
async fn insert_link_attach_purge() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::mail_files_contract::insert_link_attach_purge(uow).await;
}

#[tokio::test]
async fn erasure_blanks_names_and_answers_the_files_to_delete() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::mail_files_contract::erasure_blanks_names_and_answers_the_files_to_delete(uow)
        .await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    jt_testkit::mail_files_contract::rows_are_workspace_scoped(uow).await;
}
