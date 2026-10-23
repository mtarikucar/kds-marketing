//! Shared persistence contracts on the in-memory unit of work.
use jt_testkit::{compliance_contract, fakes::InMemoryUow};
use std::sync::Arc;

#[tokio::test]
async fn compliance_history_rates_and_financial_rows() {
    compliance_contract::compliance_history_rates_and_financial_rows(Arc::new(InMemoryUow::new()))
        .await;
}

#[tokio::test]
async fn commission_unique_per_journey() {
    compliance_contract::commission_unique_per_journey(Arc::new(InMemoryUow::new())).await;
}

#[tokio::test]
async fn erasure_replay_and_tenant_isolation() {
    compliance_contract::erasure_replay_and_tenant_isolation(Arc::new(InMemoryUow::new())).await;
}

#[tokio::test]
async fn mail_cursor_and_drafts_atomic() {
    compliance_contract::mail_cursor_and_drafts_atomic(Arc::new(InMemoryUow::new())).await;
}

#[tokio::test]
async fn dlr_capability_isolation() {
    compliance_contract::dlr_capability_isolation(Arc::new(InMemoryUow::new())).await;
}

#[tokio::test]
async fn attribution_by_ad_half_open_window_and_tenant_isolation() {
    compliance_contract::attribution_by_ad_half_open_window_and_tenant_isolation(Arc::new(
        InMemoryUow::new(),
    ))
    .await;
}
