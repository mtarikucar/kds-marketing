#[tokio::test]
async fn request_keys_workspace_scope_and_24h_expiry() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::request_keys_workspace_scope_and_24h_expiry(uow).await;
}

#[tokio::test]
async fn consumer_filters_before_limit_ignores_ack() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::consumer_filters_before_limit_ignores_ack(uow).await;
}

#[tokio::test]
async fn people_identities_and_tombstones() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::people_identities_and_tombstones(uow).await;
}

#[tokio::test]
async fn conversations_and_message_dedupe() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::conversations_and_message_dedupe(uow).await;
}

#[tokio::test]
async fn reducer_patch_and_event_are_atomic() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::reducer_patch_and_event_are_atomic(uow).await;
}

#[tokio::test]
async fn tasks_notes_merges_and_outbox() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::tasks_notes_merges_and_outbox(uow).await;
}

#[tokio::test]
async fn lost_defaults_existing_and_new_workspaces() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::lost_defaults_existing_and_new_workspaces(uow).await;
}

#[tokio::test]
async fn missing_user_references_are_not_found() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::missing_user_references_are_not_found(uow).await;
}

#[tokio::test]
async fn conversation_upsert_uses_the_natural_key() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::inbox_contract::conversation_upsert_uses_the_natural_key(uow).await;
}
