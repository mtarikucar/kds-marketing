//! The pending work on the panel, end to end through Postgres (B11): the home page's data
//! (`GET /api/work/pending`) with the strategy state, the pending items and the agent check-in
//! warning; the check-in interval (`PUT /api/work/checkin-interval`); the agents list's overdue
//! flag. The agent's own check-in is MCP-only: the panel serves no route for it.

use axum::http::{Method, StatusCode};
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys;
use jt_testkit::panel::{Panel, expect_error, ok_json};
use serde_json::{Value, json};

const OWNER: &str = "owner@alpha.example";

/// The kinds of the pending items, in order.
fn kinds(pending: &Value) -> Vec<&str> {
    pending["items"]
        .as_array()
        .unwrap_or_else(|| panic!("no items in {pending}"))
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect()
}

/// Opens an API key as `cookie` and connects an agent client through it, as an MCP `initialize`
/// does.
async fn connect_agent(p: &Panel, cookie: &str) {
    let key = ok_json(
        p.send(
            Method::POST,
            "/api/api-keys",
            Some(cookie),
            Some(json!({ "name": "ajan" })),
        )
        .await,
    )
    .await;
    let principal = api_keys::authenticate(&p.deps, key["plaintext"].as_str().unwrap())
        .await
        .unwrap();
    agents::register_initialize(
        &p.deps,
        &principal,
        ClientInfo {
            name: "acme-agent".into(),
            version: "1.0".into(),
            protocol_version: "2025-06-18".into(),
        },
        p.deps.clock.now(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn home_data_shows_agent_overdue() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // No agent has ever connected: the warning is on, and there is everything to do.
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["strategy"], "missing");
    assert_eq!(
        pending["agent"],
        json!({ "last_seen_at": null, "interval_minutes": 1440, "overdue": true })
    );
    assert_eq!(
        kinds(&pending),
        ["consult_strategy", "declare_first_capability"]
    );
    assert_eq!(pending["items"][0]["priority"], 1);
    assert!(pending["items"][0]["hint"].is_string());

    // An agent connects: the warning goes off, and the agents list agrees.
    connect_agent(&p, &owner).await;
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["agent"]["overdue"], false);
    assert!(pending["agent"]["last_seen_at"].is_string());
    let listed = ok_json(p.get("/api/agents", &owner).await).await;
    assert_eq!(listed[0]["overdue"], false);
    assert_eq!(listed[0]["last_seen_at"], pending["agent"]["last_seen_at"]);

    // A declared phone waits for the agent's verification; the first-capability item is gone.
    let phone = ok_json(
        p.send(
            Method::POST,
            "/api/capabilities",
            Some(&owner),
            Some(json!({ "kind_key": "phone", "name": "Saha telefonu" })),
        )
        .await,
    )
    .await;
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(kinds(&pending), ["consult_strategy", "verify_capability"]);
    let verify = &pending["items"][1];
    assert_eq!(verify["capability_id"], phone["capability"]["id"]);
    assert_eq!(verify["name"], "Saha telefonu");
    assert_eq!(verify["stale"], false);
    assert_eq!(verify["priority"], 2);
}

#[tokio::test]
async fn the_owner_sets_the_checkin_interval_and_a_rep_cannot() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let interval = |minutes: Value| Some(json!({ "minutes": minutes }));

    let state = ok_json(
        p.send(
            Method::PUT,
            "/api/work/checkin-interval",
            Some(&owner),
            interval(json!(60)),
        )
        .await,
    )
    .await;
    assert_eq!(
        state,
        json!({ "last_seen_at": null, "interval_minutes": 60, "overdue": true })
    );
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["agent"], state);

    for bad in [json!(14), json!(10_081)] {
        let body = expect_error(
            p.send(
                Method::PUT,
                "/api/work/checkin-interval",
                Some(&owner),
                interval(bad),
            )
            .await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        )
        .await;
        assert_eq!(body["details"]["field"], "minutes");
    }
    // Not a whole number of minutes, or an unknown field: refused before the use case.
    for body in [
        json!({ "minutes": -5 }),
        json!({ "minutes": 60, "extra": 1 }),
    ] {
        expect_error(
            p.send(
                Method::PUT,
                "/api/work/checkin-interval",
                Some(&owner),
                Some(body),
            )
            .await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        )
        .await;
    }

    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;
    let body = expect_error(
        p.send(
            Method::PUT,
            "/api/work/checkin-interval",
            Some(&rep),
            interval(json!(30)),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(body["details"], json!({ "permission": "team.manage" }));
    // A rep still reads what is pending.
    let pending = ok_json(p.get("/api/work/pending", &rep).await).await;
    assert_eq!(pending["agent"]["interval_minutes"], 60);
}

#[tokio::test]
async fn pending_work_answers_before_payment_and_checkin_has_no_route() {
    let p = Panel::new().await;
    let (owner, _) = p.register_pending(OWNER, "Alpha").await;

    // A workspace awaiting payment may already ask what is pending (the strategy comes first).
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["strategy"], "missing");
    // While the capabilities stay closed.
    expect_error(
        p.get("/api/capabilities", &owner).await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;

    // Checking in is an agent's call, over MCP only.
    for method in [Method::GET, Method::POST] {
        let resp = p
            .send(method.clone(), "/api/work/checkin", Some(&owner), None)
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{method}");
    }
}
