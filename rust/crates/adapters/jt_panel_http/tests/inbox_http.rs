#[test]
fn inbox_routes_are_registered_for_both_reads_and_mutations() {
    let routes: Vec<_> = jt_panel_http::ROUTES
        .iter()
        .filter(|(_, path)| path.starts_with("/api/inbox/"))
        .collect();
    assert_eq!(routes.len(), 30);
    for route in [
        ("GET", "/api/inbox/pending"),
        ("GET", "/api/inbox/conversations/{conversation_id}/context"),
        ("GET", "/api/inbox/conversations"),
        ("GET", "/api/inbox/conversations/{conversation_id}"),
        ("GET", "/api/inbox/conversations/{conversation_id}/messages"),
        (
            "POST",
            "/api/inbox/conversations/{conversation_id}/take-over",
        ),
        (
            "POST",
            "/api/inbox/conversations/{conversation_id}/hand-to-agent",
        ),
        ("POST", "/api/inbox/conversations/{conversation_id}/snooze"),
        (
            "POST",
            "/api/inbox/conversations/{conversation_id}/unsnooze",
        ),
        ("POST", "/api/inbox/conversations/{conversation_id}/close"),
        ("POST", "/api/inbox/conversations/{conversation_id}/reply"),
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
