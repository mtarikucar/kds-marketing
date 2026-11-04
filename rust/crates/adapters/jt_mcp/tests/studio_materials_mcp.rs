//! The materials library's tools (spec 2026-11-03 §5.2, §8): their permissions, risks and
//! schemas, what they tell an agent about a human's decisions, that the human decisions have no
//! tool, and a round trip through them by an agent in a workspace with no approved strategy (D35).

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::{CATALOG, GateMode, Risk};
use jt_app::ctx::Ctx;
use jt_app::gate::{NoStrategyYet, check_gate};
use jt_ledger::Actor;
use jt_tenancy::{Permission, SystemRole, WorkspaceStatus};
use jt_testkit::fakes::files::MemoryFiles;
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
use serde_json::{Value, json};

/// Every library twin, with its risk and required arguments.
const TWINS: &[(&str, Risk, &[&str])] = &[
    ("olays_list", Risk::Read, &[]),
    ("olay_get", Risk::Read, &["olay_id"]),
    (
        "olay_create",
        Risk::Write,
        &["request_key", "kind", "title", "starts_on", "ends_on"],
    ),
    (
        "olay_update",
        Risk::Write,
        &["olay_id", "expected_revision"],
    ),
    ("materials_list", Risk::Read, &[]),
    ("material_get", Risk::Read, &["material_id"]),
    (
        "material_add",
        Risk::Write,
        &["request_key", "file_id", "origin"],
    ),
    (
        "material_tag",
        Risk::Write,
        &["material_id", "expected_revision"],
    ),
    ("slot_materials", Risk::Read, &["slot_id"]),
    ("calendar_list", Risk::Read, &[]),
    ("shoot_list", Risk::Read, &[]),
    ("shoot_request", Risk::Write, &["request_key", "text"]),
    ("shoot_resolve", Risk::Write, &["request_id", "status"]),
];

/// A human's decisions (D4): panel routes, never a tool.
const HUMAN_ONLY: &[&str] = &[
    "olay_confirm",
    "material_permission",
    "material_free",
    "material_bind",
    "material_delete",
    "calendar_set",
    "material_policy_set",
    "material_check_release",
];

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .map(|t| (t.name, t))
        .collect()
}

#[tokio::test]
async fn library_tools_listed_with_schemas_and_no_tool_for_a_humans_decision() {
    let tools = tools();
    for (action, risk, required) in TWINS {
        let name = format!("jeeta.studio.{action}");
        let tool = &tools[name.as_str()];
        assert_eq!(tool.use_case, format!("studio.{action}"), "{name}");
        assert_eq!(tool.permission, Permission::StudioWork, "{name}");
        assert_eq!(tool.risk, *risk, "{name}");
        assert!(
            tool.description.ends_with(jt_mcp::risk_tag(*risk)),
            "{name}"
        );
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name}");
        assert_eq!(schema["required"], json!(required), "{name}");
        // Exempt from the strategy gate, not from the status check.
        let row = jt_app::catalog::find(&format!("studio.{action}")).unwrap();
        assert_eq!(row.gate, GateMode::Exempt, "{name}");
        let ws = jt_tenancy::WorkspaceId::new_v7();
        check_gate(row, WorkspaceStatus::Active, &NoStrategyYet, ws)
            .await
            .unwrap();
        assert!(
            check_gate(row, WorkspaceStatus::Suspended, &NoStrategyYet, ws)
                .await
                .is_err()
        );
    }
    for action in HUMAN_ONLY {
        let row = jt_app::catalog::find(&format!("studio.{action}")).unwrap();
        assert!(row.panel_only && row.mcp_tool.is_none(), "{action}");
        assert!(
            !tools.contains_key(format!("jeeta.studio.{action}").as_str()),
            "{action}"
        );
    }
    assert_eq!(
        CATALOG
            .iter()
            .filter(|r| r.id.starts_with("studio.") && r.panel_only)
            .count(),
        3 + HUMAN_ONLY.len()
    );
    // The schemas name the closed vocabularies.
    let add = tools["jeeta.studio.material_add"].input_schema.as_value();
    assert_eq!(
        add["properties"]["depicts"]["items"]["enum"],
        json!(["face", "name", "child", "client_logo", "corporate_ref"])
    );
    assert_eq!(
        add["properties"]["share"]["enum"],
        json!(["shareable", "not_shareable", "product_only", null])
    );
    let tag = tools["jeeta.studio.material_tag"].input_schema.as_value();
    assert_eq!(
        tag["properties"]["quality"]["enum"],
        json!(["publishable", "needs_crop", "unusable", null])
    );
    // What a human decides, the agent is told.
    let says = |name: &str, words: &[&str]| {
        let text = tools[name].description;
        for word in words {
            assert!(text.contains(word), "{name}: {word}");
        }
    };
    says(
        "jeeta.studio.material_add",
        &[
            "jeeta.studio.file_upload",
            "a human's decision",
            "depicts",
            "olay_suggestions",
            "only while its depicts is []",
        ],
    );
    says(
        "jeeta.studio.olay_create",
        &["proposed", "owner or manager confirms", "never invent"],
    );
    says(
        "jeeta.studio.olay_update",
        &["proposed olays only", "owner_or_manager_human"],
    );
    says(
        "jeeta.studio.material_tag",
        &[
            "never remove them",
            "human_required",
            "clears that permission",
        ],
    );
    says("jeeta.studio.calendar_list", &["Only an owner or manager"]);
    says("jeeta.studio.shoot_resolve", &["closes_itself"]);
    says(
        "jeeta.studio.slot_materials",
        &["jeeta.studio.piece_submit", "anchor"],
    );
}

#[tokio::test]
async fn an_agent_builds_the_library_through_the_tools_without_a_strategy() {
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.files = Arc::new(MemoryFiles::default());
    let out = jt_app::usecases::auth::register(
        &deps,
        jt_app::usecases::auth::RegisterInput {
            email: "owner@materials.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Materials".into(),
        },
    )
    .await
    .unwrap();
    let (ws, owner) = (out.me.current_workspace.unwrap(), out.me.user_id);
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let connection_id = jt_tenancy::AgentConnectionId::new_v7();
    let agent = Ctx {
        workspace_id: ws,
        actor: Actor::Agent {
            connection_id,
            user_id: owner,
        },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: Some(connection_id),
    };
    let tools = tools();
    let run = |name: &str, args: Value| {
        let tool = &tools[name];
        (tool.run)(&deps, &agent, args)
    };
    let png = "iVBORw0KGgpwb3N0ZXI=";
    let file = run(
        "jeeta.studio.file_upload",
        json!({"request_key":"poster","filename":"poster.png","mime":"image/png",
            "content":{"kind":"bytes_base64","data":png}}),
    )
    .await
    .unwrap();
    let olay = run(
        "jeeta.studio.olay_create",
        json!({"request_key":"workshop","kind":"workshop","title":"Kasım atölyesi",
            "starts_on":"2026-11-16","ends_on":"2026-11-16"}),
    )
    .await
    .unwrap();
    assert_eq!(olay["status"], "proposed");
    let added = run(
        "jeeta.studio.material_add",
        json!({"request_key":"poster","file_id":file["id"],"olay_id":olay["id"],
            "origin":{"kind":"ai_generated","generator":"codex"},"depicts":[],
            "share":"shareable","quality":"publishable","captured_at":"2026-11-16T07:00:00Z"}),
    )
    .await
    .unwrap();
    let material = &added["material"];
    assert_eq!(
        material["origin"],
        json!({"kind":"ai_generated","generator":"codex"})
    );
    assert_eq!(material["share"]["by"], Value::Null);
    assert_eq!(added["olay_suggestions"][0]["id"], olay["id"]);
    // A real material's permission is a human's.
    let refused = run(
        "jeeta.studio.material_add",
        json!({"request_key":"real","file_id":file["id"],"olay_id":olay["id"],
            "origin":{"kind":"real"},"share":"shareable"}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.details["reason"], "owner_or_manager_human");
    let listed = run("jeeta.studio.materials_list", json!({"olay_id":olay["id"]}))
        .await
        .unwrap();
    assert_eq!(listed["materials"][0]["id"], material["id"]);
    let tagged = run(
        "jeeta.studio.material_tag",
        json!({"material_id":material["id"],"expected_revision":1,"product_groups":["figur"]}),
    )
    .await
    .unwrap();
    assert_eq!(tagged["tags"]["product_groups"], json!(["figur"]));
    let detail = run(
        "jeeta.studio.material_get",
        json!({"material_id":material["id"]}),
    )
    .await
    .unwrap();
    assert_eq!(detail["used_in"], json!([]));
    let updated = run(
        "jeeta.studio.olay_update",
        json!({"olay_id":olay["id"],"expected_revision":1,"place":"Moda"}),
    )
    .await
    .unwrap();
    assert_eq!(updated["place"], "Moda");
    let olays = run("jeeta.studio.olays_list", json!({})).await.unwrap();
    assert_eq!(olays["olays"][0]["materials"], 1);
    let got = run("jeeta.studio.olay_get", json!({"olay_id":olay["id"]}))
        .await
        .unwrap();
    assert_eq!(got["materials"][0]["material"]["id"], material["id"]);
    let asked = run(
        "jeeta.studio.shoot_request",
        json!({"request_key":"photo","text":"Atölyeden bir fotoğraf yükle"}),
    )
    .await
    .unwrap();
    assert_eq!(asked["key"], "agent:photo");
    let list = run("jeeta.studio.shoot_list", json!({})).await.unwrap();
    assert_eq!(list["requests"][0]["id"], asked["id"]);
    let done = run(
        "jeeta.studio.shoot_resolve",
        json!({"request_id":asked["id"],"status":"done"}),
    )
    .await
    .unwrap();
    assert_eq!(done["status"], "done");
    let calendar = run("jeeta.studio.calendar_list", json!({"year":2027}))
        .await
        .unwrap();
    assert_eq!(calendar["year"], 2027);
    assert_eq!(calendar["policy"]["lead_days"], 21);
    let slot = run(
        "jeeta.studio.slot_materials",
        json!({"slot_id":uuid::Uuid::from_u128(77)}),
    )
    .await
    .unwrap_err();
    assert_eq!(slot.code, jt_app::error::ErrorCode::NotFound);
    // Unknown arguments are refused.
    let e = run(
        "jeeta.studio.olays_list",
        json!({"status":"proposed","x":1}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Validation);
}
