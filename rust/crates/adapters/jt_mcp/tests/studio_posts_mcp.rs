//! Olay-driven publishing's tools (spec 2026-11-03 §14.3): their permissions, risks, schemas and
//! the strategy gate, no tool for the posting policy (a human's), and an agent's round trip: the
//! planner's request, a package, the planned posts and the week's summary.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::{GateMode, Risk};
use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::gate::{NoStrategyYet, check_gate};
use jt_ledger::Actor;
use jt_tenancy::{Permission, SystemRole, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, ScriptedConnector, ScriptedRegistry};
use serde_json::{Value, json};

/// Every twin, with its risk and required arguments.
const TWINS: &[(&str, Risk, &[&str])] = &[
    ("post_requests", Risk::Read, &[]),
    (
        "posts_propose",
        Risk::Write,
        &["request_id", "request_key", "posts"],
    ),
    ("posts_list", Risk::Read, &[]),
    ("weekly_summary", Risk::Read, &[]),
];

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .map(|t| (t.name, t))
        .collect()
}

#[tokio::test]
async fn posting_tools_are_gated_twins_and_the_policy_has_no_tool() {
    let tools = tools();
    for (action, risk, required) in TWINS {
        let name = format!("jeeta.studio.{action}");
        let tool = &tools[name.as_str()];
        assert_eq!(tool.use_case, format!("studio.{action}"), "{name}");
        assert_eq!(tool.permissions, &[Permission::SocialWork], "{name}");
        assert_eq!(tool.risk, *risk, "{name}");
        assert!(
            tool.description.ends_with(jt_mcp::risk_tag(*risk)),
            "{name}"
        );
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name}");
        assert_eq!(schema["required"], json!(required), "{name}");
        // They plan content: behind the strategy gate.
        let row = jt_app::catalog::find(&format!("studio.{action}")).unwrap();
        assert_eq!(row.gate, GateMode::Gated, "{name}");
        let e = check_gate(
            row,
            WorkspaceStatus::Active,
            &NoStrategyYet,
            jt_tenancy::WorkspaceId::new_v7(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::StrategyRequired, "{name}");
    }
    let row = jt_app::catalog::find("studio.posting_policy_set").unwrap();
    assert!(row.panel_only && row.mcp_tool.is_none());
    assert!(!tools.contains_key("jeeta.studio.posting_policy_set"));
    // A package's schema names the formats and needs each post's essentials.
    let propose = tools["jeeta.studio.posts_propose"].input_schema.as_value();
    let post = &propose["properties"]["posts"]["items"];
    assert_eq!(
        post["properties"]["format"]["enum"],
        json!(["story", "feed_post", "carousel", "reel", "tiktok_video"])
    );
    assert_eq!(
        post["required"],
        json!([
            "format",
            "capability_id",
            "publish_at",
            "material_ids",
            "subject",
            "hypothesis_id"
        ])
    );
    for word in [
        "package_refused",
        "preparation start",
        "jeeta.studio.piece_submit",
    ] {
        assert!(
            tools["jeeta.studio.posts_propose"]
                .description
                .contains(word),
            "{word}"
        );
    }
}

#[tokio::test]
async fn an_agent_answers_a_request_and_reads_its_posts_and_the_week() {
    let uow = Arc::new(InMemoryUow::new());
    let f = jt_testkit::studio_contract::ready(uow.as_ref()).await;
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(Arc::new(ScriptedConnector::new(jt_connector::Provider::X))),
    );
    jt_testkit::studio_contract::make_postable(uow.as_ref(), &f, deps.seal.as_ref(), FIXED_NOW)
        .await;
    let connection_id = jt_tenancy::AgentConnectionId::new_v7();
    let user = jt_tenancy::UserId::new_v7();
    // Without the content module the planner asks agents for posts (design 2026-11-10 B18).
    let owner = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    jt_app::usecases::modules::remove(&deps, &owner, jt_app::usecases::modules::CONTENT)
        .await
        .unwrap();
    // The fixture's material settled half an hour ago: the planner asks for a package.
    let at = FIXED_NOW + time::Duration::minutes(31);
    jt_app::usecases::studio::planner::plan(&deps, f.ws, at)
        .await
        .unwrap();
    let agent = Ctx {
        workspace_id: f.ws,
        actor: Actor::Agent {
            connection_id,
            user_id: user,
        },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: at,
        agent_connection_id: Some(connection_id),
    };
    let tools = tools();
    let run = |name: &str, args: Value| {
        let tool = &tools[name];
        (tool.run)(&deps, &agent, args)
    };
    let requests = run("jeeta.studio.post_requests", json!({})).await.unwrap();
    let request = &requests["requests"][0];
    assert_eq!(request["trigger"], "olay");
    let material = request["material_ids"][0].clone();
    let post = |at: &str| {
        json!({"format":"feed_post","capability_id":f.slot.capability_id,"publish_at":at,
            "material_ids":[material],"subject":request["hints"]["subject"],
            "hypothesis_id":f.slot.chain.hypothesis_id})
    };
    // Refused whole: a carousel X does not publish, beside a valid post.
    let mut carousel = post("2026-10-25T07:00:00Z");
    carousel["format"] = json!("carousel");
    let e = run(
        "jeeta.studio.posts_propose",
        json!({"request_id":request["id"],"request_key":"refused",
            "posts":[post("2026-10-24T07:00:00Z"), carousel]}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(
        e.details["items"],
        json!([{"index":1,"reason":"format_unsupported"}])
    );
    let out = run(
        "jeeta.studio.posts_propose",
        json!({"request_id":request["id"],"request_key":"package",
            "posts":[post("2026-10-24T07:00:00Z")]}),
    )
    .await
    .unwrap();
    assert_eq!(out["request"]["status"], "answered");
    assert_eq!(
        out["posts"][0]["post"]["prep_start_at"],
        "2026-10-23T07:00:00Z"
    );
    assert_eq!(out["posts"][0]["slot"]["state"], "planned");
    let slot = out["posts"][0]["slot"]["id"].clone();
    let posts = run("jeeta.studio.posts_list", json!({})).await.unwrap();
    assert_eq!(posts["posts"][0]["slot"]["id"], slot);
    assert_eq!(posts["posts"][0]["pending"], false);
    assert_eq!(posts["settings"]["tz"], "Europe/Istanbul");
    let week = run("jeeta.studio.weekly_summary", json!({"week":"2026-10-19"}))
        .await
        .unwrap();
    assert_eq!(week["planned"][0]["slot_id"], slot);
    assert_eq!(week["cancelled"][0]["reason"], "replanned");
    // Unknown arguments and an empty package are refused.
    let e = run("jeeta.studio.posts_list", json!({"x":1}))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let e = run(
        "jeeta.studio.posts_propose",
        json!({"request_id":request["id"],"request_key":"empty","posts":[]}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "post_count");
}
