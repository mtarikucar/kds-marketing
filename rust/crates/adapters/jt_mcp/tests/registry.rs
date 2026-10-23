//! The tool registry against the use-case catalog: one tool per catalog row with an MCP tool,
//! named and described as the catalog says.

use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, Risk};
use jt_mcp::{ToolSpec, registry, registry_with, risk_tag};
use serde_json::Value;

const M0_TOOLS: &[&str] = &[
    "jeeta.agent.whoami",
    "jeeta.workspace.info",
    "jeeta.team.list",
    "jeeta.team.invite",
    "jeeta.team.set_role",
    "jeeta.team.remove",
    "jeeta.roles.list",
    "jeeta.roles.create",
    "jeeta.roles.update",
    "jeeta.roles.delete",
    "jeeta.api_keys.create",
    "jeeta.api_keys.list",
    "jeeta.api_keys.revoke",
    "jeeta.agents.list",
    "jeeta.ledger.list",
];

#[test]
fn every_catalog_mcp_tool_is_registered_and_nothing_else() {
    let catalog: BTreeSet<&str> = CATALOG.iter().filter_map(|uc| uc.mcp_tool).collect();
    let registered: BTreeSet<&str> = registry().iter().map(|t| t.name).collect();
    assert_eq!(registered, catalog);
    assert_eq!(registered, M0_TOOLS.iter().copied().collect());

    for spec in registry() {
        let uc = CATALOG
            .iter()
            .find(|uc| uc.mcp_tool == Some(spec.name))
            .unwrap();
        assert_eq!(spec.use_case, uc.id, "{}", spec.name);
        assert_eq!(spec.risk, uc.risk, "{}", spec.name);
        assert!(!uc.panel_only, "{}", spec.name);
    }
}

#[test]
fn registry_names_are_unique_and_prefixed() {
    let specs = registry();
    let names: BTreeSet<&str> = specs.iter().map(|t| t.name).collect();
    assert_eq!(names.len(), specs.len(), "duplicate tool names");
    for name in names {
        let parts: Vec<&str> = name.split('.').collect();
        assert_eq!(parts.len(), 3, "{name} is jeeta.<domain>.<action>");
        assert_eq!(parts[0], "jeeta", "{name}");
        assert!(
            parts[1..]
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c == '_')),
            "{name}"
        );
    }
}

#[test]
fn descriptions_end_with_the_catalog_risk() {
    assert_eq!(risk_tag(Risk::Read), " [risk: READ]");
    assert_eq!(risk_tag(Risk::Write), " [risk: WRITE]");
    assert_eq!(risk_tag(Risk::Spend), " [risk: SPEND]");
    assert_eq!(risk_tag(Risk::Destructive), " [risk: DESTRUCTIVE]");
    for spec in registry() {
        assert!(
            spec.description.ends_with(risk_tag(spec.risk)),
            "{}: {}",
            spec.name,
            spec.description
        );
        let text = spec.description.trim_end_matches(risk_tag(spec.risk));
        assert!(text.len() > 20 && text.is_ascii(), "{}", spec.name);
    }
}

#[test]
fn input_schemas_are_objects() {
    for spec in registry() {
        let schema: Value = spec.input_schema.clone().to_value();
        assert_eq!(schema["type"], "object", "{}", spec.name);
        // Self-contained: no references for a client to resolve.
        assert!(!schema.to_string().contains("$ref"), "{}", spec.name);
    }
    let invite = registry()
        .into_iter()
        .find(|t| t.name == "jeeta.team.invite")
        .unwrap();
    let schema = invite.input_schema.to_value();
    let required: BTreeSet<&str> = schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(required, BTreeSet::from(["email", "role_key"]));
}

#[test]
fn registry_with_appends_extra_tools_and_refuses_a_taken_name() {
    let whoami = registry()
        .into_iter()
        .find(|t| t.name == "jeeta.agent.whoami")
        .unwrap();
    let extra = ToolSpec {
        name: "jeeta.demo.read",
        use_case: "demo.read",
        ..whoami.clone()
    };
    let all = registry_with(vec![extra]);
    assert_eq!(all.len(), M0_TOOLS.len() + 1);
    assert_eq!(all.last().unwrap().name, "jeeta.demo.read");

    let taken = std::panic::catch_unwind(|| registry_with(vec![whoami]));
    assert!(taken.is_err(), "a duplicate tool name must be refused");
}
