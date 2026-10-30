use jt_app::catalog::{CATALOG, GateMode, Risk, StatusExemption, find};
#[test]
fn ops_catalog_is_exactly_one_operator_row() {
    assert_eq!(CATALOG.len(), 169);
    assert_eq!(CATALOG.iter().filter(|r| r.mcp_tool.is_some()).count(), 140);
    let row = find("ops.health").expect("operator health catalog row");
    assert!(row.panel_only);
    assert_eq!(row.panel_route, Some(("GET", "/api/platform/health")));
    assert_eq!(row.gate, GateMode::Exempt);
    assert_eq!(row.status_exemption, StatusExemption::Always);
    assert_eq!(row.risk, Risk::Read);
}

#[tokio::test]
async fn platform_projection_is_metadata_only() {
    use jt_app::{ctx::PlatformCtx, ports::ops::*, usecases::ops};
    use jt_testkit::fakes::{FIXED_NOW, FakeOpsSnapshot, InMemoryUow};
    use std::sync::Arc;
    let mut deps = jt_testkit::fakes::deps(Arc::new(InMemoryUow::new()));
    let mut snapshot = OpsHealthOut::unknown(FIXED_NOW);
    snapshot.webhooks.unrouted = 7;
    snapshot.connectors.push(ConnectorHealthCount {
        workspace_id: serde_json::from_value(serde_json::json!(
            "00000000-0000-4000-8000-000000000001"
        ))
        .unwrap(),
        kind_key: "x".into(),
        reconnect_required: 2,
        expires_before: Some(FIXED_NOW),
    });
    deps.ops = Arc::new(FakeOpsSnapshot(snapshot.clone()));
    let ctx = PlatformCtx {
        operator_id: serde_json::from_value(serde_json::json!(
            "00000000-0000-4000-8000-000000000002"
        ))
        .unwrap(),
        now: FIXED_NOW,
    };
    let out = serde_json::to_value(ops::health(&deps, &ctx).await.unwrap()).unwrap();
    assert_eq!(out, serde_json::to_value(snapshot).unwrap());
    let keys: std::collections::BTreeSet<_> = out["connectors"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        std::collections::BTreeSet::from([
            "workspace_id",
            "kind_key",
            "reconnect_required",
            "expires_before"
        ])
    );
}
