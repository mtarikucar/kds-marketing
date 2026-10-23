#[test]
fn inbox_routes_are_registered_for_both_reads_and_mutations() {
    let routes: Vec<_> = jt_panel_http::ROUTES
        .iter()
        .filter(|(_, path)| path.starts_with("/api/inbox/"))
        .collect();
    assert_eq!(routes.len(), 11);
    assert!(jt_panel_http::ROUTES.contains(&("POST", "/api/inbox/journeys/{journey_id}/events")));
}
