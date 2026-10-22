//! The tool registry against the use-case catalog: one tool per catalog row with an MCP tool,
//! named and described as the catalog says.

use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, Risk};
use jt_mcp::{NOT_YET_DEFINED, ToolSpec, registry, registry_with, risk_tag};
use jt_tenancy::Permission;
use serde_json::Value;

const TOOLS: &[&str] = &[
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
    "jeeta.strategy.get",
    "jeeta.strategy.start_consultation",
    "jeeta.strategy.record",
    "jeeta.strategy.write_section",
    "jeeta.strategy.set_hypotheses",
    "jeeta.strategy.submit",
    "jeeta.strategy.approve",
    "jeeta.strategy.archive",
    "jeeta.strategy.list_versions",
    "jeeta.strategy.consultation",
    "jeeta.capability.list",
    "jeeta.capability.get",
    "jeeta.capability.declare",
    "jeeta.capability.verify",
    "jeeta.capability.mark_unreachable",
    "jeeta.capability.set_policy",
    "jeeta.capability.retire",
    "jeeta.capability.link_budget",
    "jeeta.capability.unlink_budget",
    "jeeta.capability.groups_list",
    "jeeta.capability.groups_create",
    "jeeta.capability.groups_rename",
    "jeeta.capability.groups_delete",
    "jeeta.capability.groups_add_member",
    "jeeta.capability.groups_remove_member",
    "jeeta.budget.items_list",
    "jeeta.budget.items_create",
    "jeeta.budget.spend_record",
    "jeeta.budget.spend_list",
    "jeeta.work.pending",
    "jeeta.work.checkin",
    "jeeta.work.set_checkin_interval",
];

#[test]
fn every_catalog_mcp_tool_is_registered_and_nothing_else() {
    assert!(NOT_YET_DEFINED.is_empty(), "{NOT_YET_DEFINED:?}");
    assert_eq!(TOOLS.len(), 47);
    let catalog: BTreeSet<&str> = CATALOG.iter().filter_map(|uc| uc.mcp_tool).collect();
    let registered: BTreeSet<&str> = registry().iter().map(|t| t.name).collect();
    assert_eq!(registered, catalog);
    assert_eq!(registered, TOOLS.iter().copied().collect());

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
    assert_eq!(all.len(), TOOLS.len() + 1);
    assert_eq!(all.last().unwrap().name, "jeeta.demo.read");

    let taken = std::panic::catch_unwind(|| registry_with(vec![whoami]));
    assert!(taken.is_err(), "a duplicate tool name must be refused");
}

#[test]
fn strategy_tools_read_with_workspace_read_and_change_with_team_manage() {
    for spec in registry()
        .iter()
        .filter(|s| s.use_case.starts_with("strategy."))
    {
        let expected = match spec.name {
            "jeeta.strategy.get"
            | "jeeta.strategy.list_versions"
            | "jeeta.strategy.consultation" => Permission::WorkspaceRead,
            _ => Permission::TeamManage,
        };
        assert_eq!(spec.permission, expected, "{}", spec.name);
    }
    let get = registry()
        .into_iter()
        .find(|t| t.name == "jeeta.strategy.get")
        .unwrap();
    // The entry point tells the agent the consultation protocol.
    assert!(
        get.description.contains(
            "Ask the owner the open questions, record each answer, write sections, set \
             hypotheses, submit; the owner or a manager approves."
        ),
        "{}",
        get.description
    );
    let archive = registry()
        .into_iter()
        .find(|t| t.name == "jeeta.strategy.archive")
        .unwrap();
    assert_eq!(archive.risk, Risk::Destructive);
    let schema = archive.input_schema.to_value();
    assert_eq!(schema["properties"]["confirm"]["type"], "boolean");
    assert_eq!(schema["required"], serde_json::json!(["version_id"]));
}

#[test]
fn capability_tools_need_the_permissions_their_use_cases_check() {
    let specs: Vec<ToolSpec> = registry()
        .into_iter()
        .filter(|s| s.use_case.starts_with("capability.") || s.use_case.starts_with("budget."))
        .collect();
    assert_eq!(specs.len(), 19);
    for spec in &specs {
        let expected = match spec.name {
            // Reading, and what an agent reports about its own hands and spend: the use cases
            // decide per actor (a person verifies only with capabilities.manage).
            "jeeta.capability.list"
            | "jeeta.capability.get"
            | "jeeta.capability.verify"
            | "jeeta.capability.groups_list"
            | "jeeta.budget.items_list"
            | "jeeta.budget.spend_record"
            | "jeeta.budget.spend_list" => Permission::WorkspaceRead,
            "jeeta.budget.items_create" => Permission::BudgetManage,
            _ => Permission::CapabilitiesManage,
        };
        assert_eq!(spec.permission, expected, "{}", spec.name);
    }
    let destructive: BTreeSet<&str> = specs
        .iter()
        .filter(|s| s.risk == Risk::Destructive)
        .map(|s| s.name)
        .collect();
    assert_eq!(
        destructive,
        BTreeSet::from(["jeeta.capability.retire", "jeeta.capability.groups_delete"])
    );

    let find = |name: &str| specs.iter().find(|s| s.name == name).unwrap();
    let declare = find("jeeta.capability.declare");
    for group in jt_capability::KindGroup::all() {
        assert!(
            declare.description.contains(group.key()),
            "the declare description names the kind group {}",
            group.key()
        );
    }
    assert!(
        declare
            .description
            .contains("key_detail only for third_party.other"),
        "{}",
        declare.description
    );
    let schema = declare.input_schema.clone().to_value();
    let kinds = schema["properties"]["kind_key"]["enum"].as_array().unwrap();
    assert_eq!(kinds.len(), jt_capability::KINDS.len());
    assert_eq!(required(&schema), BTreeSet::from(["kind_key", "name"]));

    let verify = find("jeeta.capability.verify");
    assert!(
        verify.description.contains(
            "for your own agent/device capabilities; connectors are verified by their probe"
        ),
        "{}",
        verify.description
    );
    let schema = verify.input_schema.clone().to_value();
    assert_eq!(
        required(&schema["properties"]["evidence"]),
        BTreeSet::from(["text"])
    );
    let retire = find("jeeta.capability.retire")
        .input_schema
        .clone()
        .to_value();
    assert_eq!(retire["properties"]["confirm"]["type"], "boolean");
    let create = find("jeeta.budget.items_create")
        .input_schema
        .clone()
        .to_value();
    assert_eq!(
        required(&create),
        BTreeSet::from(["name", "kind", "unit", "cap", "period"])
    );
}

/// The `required` property names of an object schema.
fn required(schema: &Value) -> BTreeSet<&str> {
    schema["required"]
        .as_array()
        .unwrap_or_else(|| panic!("no required list in {schema}"))
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn work_tools_read_and_check_in_with_workspace_read_and_set_the_interval_with_team_manage() {
    let specs: Vec<ToolSpec> = registry()
        .into_iter()
        .filter(|s| s.use_case.starts_with("work."))
        .collect();
    let permissions: Vec<(&str, Permission, Risk)> = specs
        .iter()
        .map(|s| (s.name, s.permission, s.risk))
        .collect();
    assert_eq!(
        permissions,
        [
            ("jeeta.work.pending", Permission::WorkspaceRead, Risk::Read),
            ("jeeta.work.checkin", Permission::WorkspaceRead, Risk::Write),
            (
                "jeeta.work.set_checkin_interval",
                Permission::TeamManage,
                Risk::Write
            ),
        ]
    );
    let find = |name: &str| specs.iter().find(|s| s.name == name).unwrap();
    // The check-in tells the agent that waking up is its own job (spec §4.2 rule 3).
    let checkin = find("jeeta.work.checkin");
    assert!(
        checkin.description.contains("on your own schedule"),
        "{}",
        checkin.description
    );
    let interval = find("jeeta.work.set_checkin_interval")
        .input_schema
        .clone()
        .to_value();
    assert_eq!(required(&interval), BTreeSet::from(["minutes"]));
    assert_eq!(interval["properties"]["minutes"]["minimum"], 15);
    assert_eq!(interval["properties"]["minutes"]["maximum"], 10_080);
}
