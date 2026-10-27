//! The `jeeta.calls.*` tools (voice V0): their permissions, risks, schemas and what they tell an
//! agent; and one place → end round trip through the dispatcher with numbers masked.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::Risk;
use jt_app::ctx::Ctx;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::SendReceipt;
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_ledger::Actor;
use jt_strategy::{Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{Permission, SystemRole};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, ScriptedConnector, ScriptedRegistry};
use serde_json::{Value, json};

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.calls."))
        .map(|t| (t.name, t))
        .collect()
}

#[test]
fn calls_tools_have_their_permissions_risks_and_strict_schemas() {
    let tools = tools();
    let expected = [
        ("jeeta.calls.policy_get", Permission::CallsWork, Risk::Read),
        (
            "jeeta.calls.policy_set",
            Permission::CallsManage,
            Risk::Write,
        ),
        ("jeeta.calls.place", Permission::CallsWork, Risk::Spend),
        ("jeeta.calls.get", Permission::CallsWork, Risk::Read),
        ("jeeta.calls.list", Permission::CallsWork, Risk::Read),
        ("jeeta.calls.end", Permission::CallsWork, Risk::Write),
    ];
    assert_eq!(tools.len(), expected.len());
    for (name, permission, risk) in expected {
        let tool = &tools[name];
        assert_eq!(tool.permission, permission, "{name}");
        assert_eq!(tool.risk, risk, "{name}");
        assert!(
            tool.description.ends_with(jt_mcp::risk_tag(risk).trim()),
            "{name}"
        );
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
    }
    let place = tools["jeeta.calls.place"].input_schema.as_value().clone();
    assert_eq!(place["required"], json!(["purpose", "mode"]));
    assert_eq!(
        place["properties"]["purpose"]["enum"],
        json!(["service", "commercial", "callback"])
    );
    // The agent is told what the gates refuse and that a rep's call rings the rep first.
    let text = tools["jeeta.calls.place"].description;
    for word in [
        "consent_missing",
        "bridge_offline",
        "rep_extension",
        "jeeta.calls.end",
    ] {
        assert!(text.contains(word), "{word}");
    }
}

#[tokio::test]
async fn place_and_end_through_the_dispatcher_keep_numbers_masked() {
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(netgsm.clone()));
    let (ws, owner) = {
        let out = jt_app::usecases::auth::register(
            &deps,
            jt_app::usecases::auth::RegisterInput {
                email: "owner@calls.example".into(),
                password: "correct horse battery".into(),
                display_name: "Owner".into(),
                workspace_name: "Calls".into(),
            },
        )
        .await
        .unwrap();
        (out.me.current_workspace.unwrap(), out.me.user_id)
    };
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let owner_ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: owner },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let mut r = uow.tenant(ws).await.unwrap();
    r.strategy()
        .insert(StrategyVersion {
            id: StrategyVersionId::new_v7(),
            workspace_id: ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: owner },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(owner),
            archived_at: None,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let person = jt_app::usecases::inbox::people::create(
        &deps,
        &owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Ada",
            "identities": [{ "channel": "phone", "value": "05321234567" }],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "netgsm_pbx".into(),
            name: "Santral".into(),
            external_id: Some("santral".into()),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let sealed = deps
        .seal
        .seal(
            ws,
            &serde_json::to_vec(&Credential::NetgsmPbx {
                username: "santral".into(),
                password: "pbx-private".into(),
                trunk: Some("8508401234".into()),
                pbxnum: None,
            })
            .unwrap(),
        )
        .unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    netgsm.push_click_to_call(Ok(SendReceipt {
        provider_id: "crm-9".into(),
        cost_minor: None,
    }));
    let agent = Ctx {
        actor: Actor::Agent {
            connection_id: jt_tenancy::AgentConnectionId::new_v7(),
            user_id: owner,
        },
        role_key: None,
        ..owner_ctx.clone()
    };
    let tools = tools();
    let run = |name: &str, args: Value| {
        let tool = &tools[name];
        (tool.run)(&deps, &agent, args)
    };
    // A service call needs a relationship; this person has none: the refusal names the reason.
    let refused = run(
        "jeeta.calls.place",
        json!({ "person_id": person.id, "purpose": "service", "mode": "human", "rep_extension": "101" }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.details["reason"], "no_relationship");
    // With İYS phone consent recorded, a commercial call goes through.
    jt_app::usecases::inbox::consent::record_consent(
        &deps,
        &owner_ctx,
        person.id,
        serde_json::from_value(json!({
            "channel": "phone",
            "kind": "explicit",
            "source": "iys_sync",
            "at": "2026-10-21T09:00:00Z",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let placed = run(
        "jeeta.calls.place",
        json!({ "person_id": person.id, "purpose": "commercial", "mode": "human", "rep_extension": "101" }),
    )
    .await
    .unwrap();
    let id = placed["call"]["id"].clone();
    let listed = run("jeeta.calls.list", json!({})).await.unwrap();
    let ended = run(
        "jeeta.calls.end",
        json!({ "call_id": id, "outcome": "no_answer" }),
    )
    .await
    .unwrap();
    assert_eq!(ended["call"]["outcome"], "no_answer");
    for out in [&placed, &listed, &ended] {
        assert!(!out.to_string().contains("5321234567"), "{out}");
    }
    assert_eq!(listed["calls"][0]["counterpart"], "+90 5** *** ** 67");
}
