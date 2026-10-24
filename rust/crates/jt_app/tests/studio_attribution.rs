use std::sync::Arc;

#[tokio::test]
async fn attribution_reader_consumes_m2b_rows_after_raw_retention() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::attribution_reader_consumes_m2b_rows_after_raw_retention(uow).await;
}

#[tokio::test]
async fn attribution_by_ad_window_and_by_journey_are_tenant_scoped() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::attribution_by_ad_window_and_by_journey_are_tenant_scoped(uow).await;
}

#[tokio::test]
async fn page_ads_mapping_requires_selected_group() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::page_ads_mapping_requires_selected_group(uow).await;
}

#[tokio::test]
async fn ad_to_set_to_arm_join_is_proven() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::ad_to_set_to_arm_join_is_proven(uow).await;
}

#[tokio::test]
async fn shared_campaign_does_not_attribute_two_arms() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::shared_campaign_does_not_attribute_two_arms(uow).await;
}

#[tokio::test]
async fn missing_mapping_leaves_journey_unattributed() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::missing_mapping_leaves_journey_unattributed(uow).await;
}

#[tokio::test]
async fn studio_attribution_never_fetches_or_ingests_leads() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::studio_attribution_never_fetches_or_ingests_leads(uow)
        .await;
}

#[tokio::test]
async fn read_projection_preserves_first_touch_and_tombstones() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::read_projection_preserves_first_touch_and_tombstones(
        uow,
    )
    .await;
}
#[tokio::test]
async fn stored_set_proof_survives_missing_resolution_without_guessing_campaign() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::stored_set_proof_survives_missing_resolution_without_guessing_campaign(uow).await;
}

#[tokio::test]
async fn attribution_checks_permissions_windows_and_capability_access() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::attribution_checks_permissions_windows_and_capability_access(uow).await;
}

#[tokio::test]
async fn historical_attribution_paginates_retained_page_evidence() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::historical_attribution_paginates_retained_page_evidence(uow).await;
}

#[tokio::test]
async fn group_change_during_account_read_discards_proof() {
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::studio_attribution_contract::group_change_during_account_read_discards_proof(uow)
        .await;
}
