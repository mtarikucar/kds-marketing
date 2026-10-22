//! The twin rule (spec §4.5, B8): every use case in the catalog has a panel route, and an MCP
//! tool unless it is `panel_only`; the panel's route table and the MCP registry expose exactly
//! the catalog, no more and no less.

use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, by_mcp_tool};

/// Routes the panel serves that are infrastructure, not use cases.
const INFRASTRUCTURE_ROUTES: &[(&str, &str)] = &[("GET", "/healthz")];

/// Catalog panel routes not served yet: a use case may enter the catalog before its route, while
/// a plan lands it in steps. Empty while every catalog route is served (the strategy's are since
/// its routes landed); each entry must still be unserved, so serving one fails this test until it
/// is dropped from here.
const NOT_YET_SERVED: &[(&str, &str)] = &[];

#[test]
fn panel_routes_table_matches_catalog() {
    for uc in CATALOG {
        assert!(
            uc.panel_route.is_some(),
            "use case `{}` has no panel route",
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
