use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error};
use serde_json::json;

#[test]
fn studio_routes_have_exact_catalog_twins() {
    let routes: Vec<_> = jt_panel_http::ROUTES
        .iter()
        .copied()
        .filter(|(_, p)| p.starts_with("/api/studio/"))
        .collect();
    assert_eq!(
        routes,
        [
            ("GET", "/api/studio/overview"),
            ("GET", "/api/studio/ledger"),
            ("POST", "/api/studio/ledger/export"),
            ("GET", "/api/studio/adsets"),
            ("POST", "/api/studio/adsets/bind"),
            ("POST", "/api/studio/budget-moves"),
            ("GET", "/api/studio/learned"),
            ("POST", "/api/studio/judgments"),
            ("POST", "/api/studio/files"),
            ("POST", "/api/studio/slots/{slot_id}/piece"),
            ("GET", "/api/studio/pending"),
            ("GET", "/api/studio/slots/{slot_id}"),
            ("POST", "/api/studio/slots/{slot_id}/cancel"),
            ("POST", "/api/studio/trends"),
            ("POST", "/api/studio/hypotheses/proposals"),
            ("POST", "/api/studio/brake"),
            ("PUT", "/api/studio/policy"),
            ("POST", "/api/studio/approvals"),
            ("GET", "/api/studio/slots/{slot_id}/tiktok"),
            ("POST", "/api/studio/slots/{slot_id}/tiktok"),
            ("GET", "/api/studio/slots/{slot_id}/tiktok/metrics")
        ]
    );
    for route in routes {
        assert_eq!(
            jt_app::catalog::CATALOG
                .iter()
                .filter(|r| r.panel_route == Some(route))
                .count(),
            1
        );
    }
    // The TikTok posting screen is the panel's alone: no agent tool reaches it.
    for id in [
        "studio.tiktok_posting",
        "studio.tiktok_post",
        "studio.tiktok_metrics",
    ] {
        let row = jt_app::catalog::find(id).unwrap();
        assert!(row.panel_only && row.mcp_tool.is_none(), "{id}");
    }
}

/// The TikTok posting screen's routes are served, behind the strategy gate.
#[tokio::test]
async fn tiktok_posting_routes_are_served_behind_the_strategy_gate() {
    let panel = Panel::new().await;
    let (cookie, _) = panel.register("tiktok@studio.test", "TikTok").await;
    let slot = jt_app::ports::studio::SlotId::new_v7();
    let path = format!("/api/studio/slots/{slot}/tiktok");
    for read in [path.clone(), format!("{path}/metrics")] {
        expect_error(
            panel.get(&read, &cookie).await,
            StatusCode::CONFLICT,
            "STRATEGY_REQUIRED",
        )
        .await;
    }
    let post = json!({
        "title": "Merhaba",
        "privacy_level": "SELF_ONLY",
        "allow_comment": false,
        "allow_duet": false,
        "allow_stitch": false,
        "disclose_commercial": false,
        "your_brand": false,
        "branded_content": false,
    });
    expect_error(
        panel
            .send(
                Method::POST,
                &path,
                Some(&cookie),
                Some(json!({ "expected_revision": 1, "post": post })),
            )
            .await,
        StatusCode::CONFLICT,
        "STRATEGY_REQUIRED",
    )
    .await;
}
