//! The chat media's repository contracts (`jt_testkit::message_media_contract`) against the
//! in-memory fake.

#[tokio::test]
async fn record_fetch_purge() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::message_media_contract::record_fetch_purge(uow).await;
}

#[tokio::test]
async fn erasure_deletes_and_answers_the_files() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::message_media_contract::erasure_deletes_and_answers_the_files(uow).await;
}

#[tokio::test]
async fn rows_are_workspace_scoped() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::message_media_contract::rows_are_workspace_scoped(uow).await;
}
