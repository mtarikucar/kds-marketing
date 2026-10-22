use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, GateMode, Risk, by_mcp_tool, find};

#[test]
fn ids_are_unique() {
    let mut seen = BTreeSet::new();
    for uc in CATALOG {
        assert!(seen.insert(uc.id), "duplicate use case id {}", uc.id);
    }
}

#[test]
fn every_non_panel_only_use_case_has_both_surfaces() {
    for uc in CATALOG.iter().filter(|uc| !uc.panel_only) {
        assert!(uc.mcp_tool.is_some(), "{} has no MCP tool", uc.id);
        assert!(uc.panel_route.is_some(), "{} has no panel route", uc.id);
    }
}

#[test]
fn panel_only_use_cases_have_no_mcp_tool() {
    for uc in CATALOG.iter().filter(|uc| uc.panel_only) {
        assert!(
            uc.mcp_tool.is_none(),
            "{} is panel-only but has an MCP tool",
            uc.id
        );
        assert!(
            uc.panel_route.is_some(),
            "{} is panel-only but has no panel route",
            uc.id
        );
    }
}

#[test]
fn mcp_tool_names_follow_prefix() {
    for (id, tool) in CATALOG
        .iter()
        .filter_map(|uc| uc.mcp_tool.map(|t| (uc.id, t)))
    {
        let parts: Vec<&str> = tool.split('.').collect();
        assert!(
            tool.starts_with("jeeta."),
            "{id}: {tool} lacks the jeeta. prefix"
        );
        assert_eq!(
            parts.len(),
            3,
            "{id}: {tool} is not jeeta.<domain>.<action>"
        );
        assert!(
            parts.iter().all(|p| !p.is_empty()),
            "{id}: {tool} has an empty part"
        );
    }
}

#[test]
fn panel_routes_are_unique() {
    let mut seen = BTreeSet::new();
    for (id, route) in CATALOG
        .iter()
        .filter_map(|uc| uc.panel_route.map(|r| (uc.id, r)))
    {
        assert!(seen.insert(route), "{id}: duplicate panel route {route:?}");
    }
}

// Beyond the brief: pins the details later crates rely on.

#[test]
#[rustfmt::skip]
fn catalog_is_the_m0_table() {
    let rows: Vec<_> = CATALOG
        .iter()
        .map(|uc| (uc.id, uc.mcp_tool, uc.panel_route, uc.panel_only, uc.risk))
        .collect();
    let expected = [
        ("auth.register", None, Some(("POST", "/api/auth/register")), true, Risk::Write),
        ("auth.login", None, Some(("POST", "/api/auth/login")), true, Risk::Write),
        ("auth.logout", None, Some(("POST", "/api/auth/logout")), true, Risk::Write),
        ("auth.me", None, Some(("GET", "/api/auth/me")), true, Risk::Read),
        ("workspace.info", Some("jeeta.workspace.info"), Some(("GET", "/api/workspace")), false, Risk::Read),
        ("workspace.switch", None, Some(("POST", "/api/auth/switch-workspace")), true, Risk::Write),
        ("team.list", Some("jeeta.team.list"), Some(("GET", "/api/team")), false, Risk::Read),
        ("team.invite", Some("jeeta.team.invite"), Some(("POST", "/api/team/invites")), false, Risk::Write),
        ("team.accept_invite", None, Some(("POST", "/api/team/invites/accept")), true, Risk::Write),
        ("team.set_role", Some("jeeta.team.set_role"), Some(("PATCH", "/api/team/{membership_id}/role")), false, Risk::Write),
        ("team.remove", Some("jeeta.team.remove"), Some(("DELETE", "/api/team/{membership_id}")), false, Risk::Destructive),
        ("roles.list", Some("jeeta.roles.list"), Some(("GET", "/api/roles")), false, Risk::Read),
        ("roles.create", Some("jeeta.roles.create"), Some(("POST", "/api/roles")), false, Risk::Write),
        ("roles.update", Some("jeeta.roles.update"), Some(("PATCH", "/api/roles/{role_id}")), false, Risk::Write),
        ("roles.delete", Some("jeeta.roles.delete"), Some(("DELETE", "/api/roles/{role_id}")), false, Risk::Destructive),
        ("api_keys.create", Some("jeeta.api_keys.create"), Some(("POST", "/api/api-keys")), false, Risk::Write),
        ("api_keys.list", Some("jeeta.api_keys.list"), Some(("GET", "/api/api-keys")), false, Risk::Read),
        ("api_keys.revoke", Some("jeeta.api_keys.revoke"), Some(("DELETE", "/api/api-keys/{key_id}")), false, Risk::Destructive),
        ("agents.list", Some("jeeta.agents.list"), Some(("GET", "/api/agents")), false, Risk::Read),
        ("agents.whoami", Some("jeeta.agent.whoami"), Some(("GET", "/api/whoami")), false, Risk::Read),
        ("ledger.list", Some("jeeta.ledger.list"), Some(("GET", "/api/ledger")), false, Risk::Read),
        ("platform.login", None, Some(("POST", "/api/platform/login")), true, Risk::Write),
        ("platform.workspaces.list", None, Some(("GET", "/api/platform/workspaces")), true, Risk::Read),
        ("platform.workspaces.set_status", None, Some(("PATCH", "/api/platform/workspaces/{workspace_id}/status")), true, Risk::Write),
    ];
    assert_eq!(rows, expected);
    assert!(CATALOG.iter().all(|uc| uc.gate == GateMode::Exempt), "M0 has no gated use case");
    let status_exempt: Vec<&str> =
        CATALOG.iter().filter(|uc| uc.status_exempt).map(|uc| uc.id).collect();
    assert_eq!(
        status_exempt,
        [
            "auth.register",
            "auth.login",
            "auth.logout",
            "auth.me",
            "workspace.info",
            "workspace.switch",
            "platform.login",
            "platform.workspaces.list",
            "platform.workspaces.set_status",
        ]
    );
}

#[test]
fn lookups_by_id_and_mcp_tool() {
    assert_eq!(
        find("team.invite").map(|uc| uc.mcp_tool),
        Some(Some("jeeta.team.invite"))
    );
    assert!(find("team.nope").is_none());
    assert_eq!(
        by_mcp_tool("jeeta.agent.whoami").map(|uc| uc.id),
        Some("agents.whoami")
    );
    assert!(by_mcp_tool("agents.whoami").is_none());
    assert_eq!(find("auth.me").map(|uc| uc.mcp_tool), Some(None));
}

#[test]
fn gate_mode_and_risk_serialise_snake_case() {
    assert_eq!(serde_json::to_value(GateMode::Exempt).unwrap(), "exempt");
    assert_eq!(serde_json::to_value(GateMode::Gated).unwrap(), "gated");
    for (risk, name) in [
        (Risk::Read, "read"),
        (Risk::Write, "write"),
        (Risk::Spend, "spend"),
        (Risk::Destructive, "destructive"),
    ] {
        assert_eq!(serde_json::to_value(risk).unwrap(), name);
    }
}
