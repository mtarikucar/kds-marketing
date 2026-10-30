//! The `jeeta.prospects.*` tools (leads L1-T6): their permissions, risks and schemas, what they
//! tell an agent, and a create through the tool that records the agent's connection.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::Risk;
use jt_app::ctx::Ctx;
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, Permission, SystemRole};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
use serde_json::json;

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.prospects."))
        .map(|t| (t.name, t))
        .collect()
}

#[test]
fn tools_listed_with_risks() {
    let tools = tools();
    let expected = [
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
        "distinct_from",
        "in_inbox",
        "daily_cap",
        "do_not_contact",
        "never a private individual",
    ] {
        assert!(create.contains(word), "{word}");
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
