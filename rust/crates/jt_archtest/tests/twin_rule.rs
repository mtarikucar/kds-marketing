//! The twin rule (spec §4.5, B8): every use case in the catalog has a panel route unless it is
//! `mcp_only`, and an MCP tool unless it is `panel_only` (never both: a use case has at least one
//! surface); the panel's route table and the MCP registry expose exactly the catalog, no more and
//! no less.

use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, by_mcp_tool};

/// Routes the panel serves that are infrastructure, not use cases.
const INFRASTRUCTURE_ROUTES: &[(&str, &str)] = &[("GET", "/healthz")];

/// Catalog panel routes not served yet: a use case may enter the catalog before its route, while
/// a plan lands it in steps. Each entry must still be unserved, so serving one fails this test
/// until it is dropped from here. Empty: every catalog route is served (M1b Task 8 served the
/// connection routes).
const NOT_YET_SERVED: &[(&str, &str)] = &[];

#[test]
fn panel_routes_table_matches_catalog() {
    for uc in CATALOG {
        assert_eq!(
            uc.panel_route.is_some(),
            !uc.mcp_only,
            "use case `{}`: a panel route exactly when it is not MCP-only",
            uc.id
        );
    }
    for route in INFRASTRUCTURE_ROUTES {
        assert!(
            jt_panel_http::ROUTES.contains(route),
            "infrastructure route {route:?} is no longer served; drop it from the exclusions"
        );
    }
    for route in NOT_YET_SERVED {
        assert!(
            !jt_panel_http::ROUTES.contains(route),
            "{route:?} is served now; drop it from NOT_YET_SERVED"
        );
        assert!(
            CATALOG.iter().any(|uc| uc.panel_route == Some(*route)),
            "{route:?} is in NOT_YET_SERVED but not in the catalog"
        );
    }

    let served: BTreeSet<(&str, &str)> = jt_panel_http::ROUTES
        .iter()
        .copied()
        .filter(|route| !INFRASTRUCTURE_ROUTES.contains(route))
        .collect();
    let catalog: BTreeSet<(&str, &str)> = CATALOG
        .iter()
        .filter_map(|uc| uc.panel_route)
        .filter(|route| !NOT_YET_SERVED.contains(route))
        .collect();

    let unserved: Vec<_> = catalog.difference(&served).collect();
    let undescribed: Vec<_> = served.difference(&catalog).collect();
    assert!(
        unserved.is_empty(),
        "catalog panel routes missing from jt_panel_http::ROUTES: {unserved:?}"
    );
    assert!(
        undescribed.is_empty(),
        "jt_panel_http::ROUTES entries no catalog use case describes: {undescribed:?}"
    );
}

#[test]
fn mcp_registry_matches_catalog() {
    for uc in CATALOG {
        assert_eq!(
            uc.mcp_tool.is_some(),
            !uc.panel_only,
            "use case `{}`: an MCP tool exactly when it is not panel-only",
            uc.id
        );
        assert!(
            !(uc.panel_only && uc.mcp_only),
            "use case `{}` is both panel-only and MCP-only: it has no surface",
            uc.id
        );
    }

    let specs = jt_mcp::registry();
    let registered: BTreeSet<&str> = specs.iter().map(|s| s.name).collect();
    assert_eq!(registered.len(), specs.len(), "no tool is registered twice");
    // Tools the registry does not define yet; it checks each is still undefined.
    let catalog: BTreeSet<&str> = CATALOG
        .iter()
        .filter_map(|uc| uc.mcp_tool)
        .filter(|tool| !jt_mcp::NOT_YET_DEFINED.contains(tool))
        .collect();
    assert_eq!(registered, catalog, "MCP registry and catalog tools differ");

    for spec in &specs {
        let uc = by_mcp_tool(spec.name)
            .unwrap_or_else(|| panic!("tool `{}` is not in the catalog", spec.name));
        assert_eq!(
            spec.use_case, uc.id,
            "tool `{}` runs `{}`, but the catalog gives it to `{}`",
            spec.name, spec.use_case, uc.id
        );
    }
}

/// The MCP tools the registry defines, by domain: 15 from M0 (`agent`, `workspace`, `team`,
/// `roles`, `api_keys`, `agents`, `ledger`), 10 `strategy`, 19 `capability` and `budget` from
/// M1a, 3 `work`: 47; then M1b adds the three edits of Task 4b (`jeeta.capability.update`,
/// capability +1; `jeeta.budget.items_update` and `jeeta.budget.items_retire`, budget +2), the 7
/// `connector` tools (six from Task 8 and `jeeta.connector.hooks` from Task 9; the eighth
/// connection use case, completing an OAuth flow, is the panel's callback only) and the 3
/// `events` tools: 60. Inbox adds 46 and Studio operations add 18, giving 124; billing evidence adds one (125);
/// the PBX call policy (`jeeta.connector.set_pbx_policy`, connector +1) gives 126; the six
/// `calls` tools of voice V0 give 132.
/// Written out, so a tool added or dropped without updating the
/// documentation (the README lists them) fails here.
const MCP_TOOLS_BY_DOMAIN: &[(&str, usize)] = &[
    ("agent", 1),
    ("workspace", 1),
    ("billing", 1),
    ("team", 4),
    ("roles", 4),
    ("api_keys", 3),
    ("agents", 1),
    ("ledger", 1),
    ("strategy", 10),
    ("capability", 16),
    ("budget", 6),
    ("work", 3),
    ("connector", 8),
    ("calls", 6),
    ("events", 3),
    ("inbox", 46),
    ("studio", 18),
];

#[test]
fn the_registry_holds_132_tools() {
    let specs = jt_mcp::registry();
    assert_eq!(specs.len(), 132);
    let total: usize = MCP_TOOLS_BY_DOMAIN.iter().map(|(_, n)| n).sum();
    assert_eq!(total, 132);
    for (domain, expected) in MCP_TOOLS_BY_DOMAIN {
        let prefix = format!("jeeta.{domain}.");
        let found = specs.iter().filter(|s| s.name.starts_with(&prefix)).count();
        assert_eq!(found, *expected, "tools named {prefix}*");
    }
    // Every catalog tool is defined.
    assert!(jt_mcp::NOT_YET_DEFINED.is_empty());
    let catalog = CATALOG.iter().filter(|uc| uc.mcp_tool.is_some()).count();
    assert_eq!(catalog, 132);
}

/// An MCP-only use case has no human caller: only an agent's check-in is one.
#[test]
fn only_the_agent_check_in_is_mcp_only() {
    let mcp_only: Vec<&str> = CATALOG
        .iter()
        .filter(|uc| uc.mcp_only)
        .map(|uc| uc.id)
        .collect();
    assert_eq!(mcp_only, ["work.checkin"]);
}

/// These operations explicitly demand confirmation in addition to permission checks.
#[test]
fn destructive_confirmation_tools_are_explicitly_listed() {
    let tools = jt_mcp::registry();
    let confirmed: BTreeSet<_> = tools
        .iter()
        .filter(|tool| {
            tool.input_schema.as_value()["properties"]
                .get("confirm")
                .is_some()
        })
        .map(|tool| {
            assert_eq!(
                tool.risk,
                jt_app::catalog::Risk::Destructive,
                "{}",
                tool.name
            );
            assert_eq!(
                tool.input_schema.as_value()["properties"]["confirm"]["type"],
                "boolean"
            );
            tool.name
        })
        .collect();
    assert_eq!(
        confirmed,
        BTreeSet::from([
            "jeeta.strategy.archive",
            "jeeta.capability.retire",
            "jeeta.budget.items_retire",
            "jeeta.inbox.merges_undo",
            "jeeta.inbox.people_erase",
        ])
    );
}

#[test]
fn activation_is_panel_only_without_mcp_schema_or_handler() {
    let row = jt_app::catalog::find("billing.activate").unwrap();
    assert!(row.panel_only);
    assert_eq!(row.panel_route, Some(("POST", "/api/billing/activate")));
    assert!(row.mcp_tool.is_none());
    assert!(by_mcp_tool("jeeta.billing.activate").is_none());
    assert!(
        !jt_mcp::registry().iter().any(
            |tool| tool.name == "jeeta.billing.activate" || tool.use_case == "billing.activate"
        )
    );
}

#[test]
fn operational_health_is_operator_only_and_process_probes_have_no_catalog_rows() {
    let row = jt_app::catalog::find("ops.health").unwrap();
    assert!(row.panel_only && row.mcp_tool.is_none());
    assert_eq!(row.panel_route, Some(("GET", "/api/platform/health")));
    assert_eq!(CATALOG.len(), 151);
    for path in ["/readyz", "/metrics"] {
        assert!(
            CATALOG
                .iter()
                .all(|r| r.panel_route.is_none_or(|(_, p)| p != path))
        );
        assert!(jt_panel_http::static_files::is_reserved(path));
    }
    assert!(
        jt_mcp::registry()
            .iter()
            .all(|r| !r.name.starts_with("jeeta.ops."))
    );
}
