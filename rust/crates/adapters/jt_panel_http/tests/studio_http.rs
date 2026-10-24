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
            ("POST", "/api/studio/approvals")
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
}
