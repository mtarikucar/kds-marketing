#[test]
fn inbox_routes_are_registered_for_both_reads_and_mutations() {
    let routes: Vec<_> = jt_panel_http::ROUTES
        .iter()
        .filter(|(_, path)| path.starts_with("/api/inbox/"))
        .collect();
    assert_eq!(routes.len(), 19);
    for route in [
        ("GET", "/api/inbox/merges"),
        ("POST", "/api/inbox/merges/{merge_id}/apply"),
        ("POST", "/api/inbox/merges/{merge_id}/undo"),
        ("POST", "/api/inbox/merges/{merge_id}/refuse"),
        ("POST", "/api/inbox/journeys/{journey_id}/tasks"),
        ("POST", "/api/inbox/tasks/{task_id}/complete"),
        ("GET", "/api/inbox/tasks"),
        ("POST", "/api/inbox/journeys/{journey_id}/notes"),
        ("POST", "/api/inbox/journeys/{journey_id}/events"),
    ] {
        assert!(jt_panel_http::ROUTES.contains(&route), "{route:?}");
    }
}
