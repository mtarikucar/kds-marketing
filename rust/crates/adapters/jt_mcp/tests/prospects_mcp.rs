//! The `jeeta.prospects.*` and `jeeta.research.*` tools (leads L1-T6, L2): their permissions,
//! risks and schemas, what they tell an agent, and a create through the tool that records the
//! agent's connection.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::Risk;
use jt_app::ctx::Ctx;
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, Permission, SystemRole};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
use serde_json::json;

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    tools_of("jeeta.prospects.")
}

fn tools_of(prefix: &str) -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with(prefix))
        .map(|t| (t.name, t))
        .collect()
}

#[test]
fn research_tools_listed_with_risks() {
    let tools = tools_of("jeeta.research.");
    let expected = [
        ("tasks_list", Risk::Read),
        ("tasks_get", Risk::Read),
        ("tasks_create", Risk::Write),
        ("tasks_claim", Risk::Write),
        ("tasks_close", Risk::Write),
    ];
    assert_eq!(tools.len(), expected.len());
    for (action, risk) in expected {
        let name = format!("jeeta.research.{action}");
        let tool = &tools[name.as_str()];
        assert_eq!(tool.use_case, format!("research.{action}"), "{name}");
        assert_eq!(tool.permission, Permission::ProspectsWork, "{name}");
        assert_eq!(tool.risk, risk, "{name}");
        assert!(tool.description.ends_with(jt_mcp::risk_tag(risk)), "{name}");
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("recorder"), "{name}");
    }
    let create = tools["jeeta.research.tasks_create"].input_schema.as_value();
    assert_eq!(
        create["required"],
        json!(["brief", "target_count", "daily_cap"])
    );
    assert!(
        tools["jeeta.research.tasks_close"]
            .description
            .contains("standing_task")
    );
}

/// Every `jeeta.*` tool a pool or research description names is a registered tool.
#[test]
fn descriptions_name_only_registered_tools() {
    let registered: Vec<&str> = jt_mcp::registry().iter().map(|t| t.name).collect();
    let mut named = Vec::new();
    for tool in jt_mcp::registry()
        .iter()
        .filter(|t| t.name.starts_with("jeeta.prospects.") || t.name.starts_with("jeeta.research."))
    {
        for (i, _) in tool.description.match_indices("jeeta.") {
            let name: String = tool.description[i..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_')
                .collect();
            named.push((tool.name, name.trim_end_matches('.').to_owned()));
        }
    }
    assert!(!named.is_empty());
    for (tool, name) in named {
        assert!(registered.contains(&name.as_str()), "{tool} names {name}");
    }
}

#[test]
fn tools_listed_with_risks() {
    let tools = tools();
    let expected = [
        ("playbook", Risk::Read, Permission::ProspectsWork),
        ("check", Risk::Read, Permission::ProspectsWork),
        ("create", Risk::Write, Permission::ProspectsWork),
        ("update", Risk::Write, Permission::ProspectsWork),
        ("list", Risk::Read, Permission::ProspectsWork),
        ("get", Risk::Read, Permission::ProspectsWork),
        ("score", Risk::Write, Permission::ProspectsWork),
        ("decide", Risk::Write, Permission::ProspectsWork),
        (
            "do_not_contact",
            Risk::Destructive,
            Permission::ProspectsWork,
        ),
        ("dnc_lift", Risk::Write, Permission::ProspectsManage),
        ("erase", Risk::Destructive, Permission::ProspectsManage),
        ("settings_get", Risk::Read, Permission::ProspectsWork),
        ("settings_set", Risk::Write, Permission::ProspectsManage),
        ("promote", Risk::Write, Permission::ProspectsWork),
    ];
    assert_eq!(tools.len(), expected.len());
    for (action, risk, permission) in expected {
        let name = format!("jeeta.prospects.{action}");
        let tool = &tools[name.as_str()];
        assert_eq!(tool.use_case, format!("prospects.{action}"), "{name}");
        assert_eq!(tool.permission, permission, "{name}");
        assert_eq!(tool.risk, risk, "{name}");
        assert!(tool.description.ends_with(jt_mcp::risk_tag(risk)), "{name}");
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name}");
        // The recorder is never input.
        assert!(!schema.to_string().contains("recorder"), "{name}");
    }
    let schema = |name: &str| tools[name].input_schema.as_value().clone();
    assert_eq!(
        schema("jeeta.prospects.create")["required"],
        json!(["business_name", "entity_kind"])
    );
    let phone = &schema("jeeta.prospects.create")["properties"]["phone"];
    assert_eq!(
        phone["required"],
        json!(["value", "sources", "captured_at"])
    );
    assert_eq!(phone["properties"]["sources"]["minItems"], 1);
    for name in ["jeeta.prospects.do_not_contact", "jeeta.prospects.erase"] {
        assert!(
            tools[name].description.contains("Requires confirm: true"),
            "{name}"
        );
    }
    let create = tools["jeeta.prospects.create"].description;
    for word in [
        "public source URL",
        "captured_at",
        "possible_duplicate",
        "previously_rejected_soft",
        "never a refusal",
        "distinct_from",
        "in_inbox",
        "daily_cap",
        "do_not_contact",
        "never a private individual",
    ] {
        assert!(create.contains(word), "{word}");
    }
    assert!(create.contains("jeeta.prospects.playbook"));
    // The do-not-contact list holds hard keys only.
    for name in ["jeeta.prospects.do_not_contact", "jeeta.prospects.dnc_lift"] {
        let schema = schema(name).to_string();
        assert!(!schema.contains("name_city"), "{name}");
        assert!(!schema.contains("\"domain\""), "{name}");
    }
}

#[tokio::test]
async fn create_through_mcp_records_connection() {
    let uow = Arc::new(InMemoryUow::new());
    let deps = jt_testkit::fakes::deps(uow.clone());
    let out = jt_app::usecases::auth::register(
        &deps,
        jt_app::usecases::auth::RegisterInput {
            email: "owner@pool.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Pool".into(),
        },
    )
    .await
    .unwrap();
    let (ws, owner) = (out.me.current_workspace.unwrap(), out.me.user_id);
    let connection = AgentConnectionId::new_v7();
    let agent = Ctx {
        workspace_id: ws,
        actor: Actor::Agent {
            connection_id: connection,
            user_id: owner,
        },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: Some(connection),
    };
    let tools = tools();
    let args = json!({
        "business_name": "Örnek Kafe",
        "entity_kind": "sole_trader",
        "city": "İstanbul",
        "phone": {
            "value": "0500 000 00 00",
            "sources": [{"kind": "url", "url": "https://ornek.example.invalid/iletisim"}],
            "captured_at": "2026-10-20T10:00:00Z",
        },
    });
    let created = (tools["jeeta.prospects.create"].run)(&deps, &agent, args)
        .await
        .unwrap();
    let recorder = &created["prospect"]["contact"]["phone"]["evidence"]["recorder"];
    assert_eq!(
        *recorder,
        json!({"kind": "agent", "connection_id": connection, "user_id": owner})
    );
    // A recorder in the input is refused, at any depth.
    let forged = json!({
        "business_name": "Başka Kafe",
        "entity_kind": "sole_trader",
        "recorder": {"kind": "human", "user_id": owner},
    });
    let e = (tools["jeeta.prospects.create"].run)(&deps, &agent, forged)
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Validation);
    let id = created["prospect"]["id"].clone();
    let got = (tools["jeeta.prospects.get"].run)(&deps, &agent, json!({ "prospect_id": id }))
        .await
        .unwrap();
    assert_eq!(got["prospect"], created["prospect"]);
}
