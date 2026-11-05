//! The mail files' repository contracts (`jt_testkit::mail_files_contract`) against the
//! in-memory fake.

#[tokio::test]
async fn insert_link_attach_purge() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::mail_files_contract::insert_link_attach_purge(uow).await;
}

#[tokio::test]
async fn erasure_blanks_names_and_answers_the_files_to_delete() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::mail_files_contract::erasure_blanks_names_and_answers_the_files_to_delete(uow)
        .await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::mail_files_contract::rows_are_workspace_scoped(uow).await;
}
