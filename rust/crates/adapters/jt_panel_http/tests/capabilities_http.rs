//! Capabilities, their groups and the budget on the panel, end to end through Postgres: an owner
//! declares, groups, links, spends and retires; a rep only reads; an agent verifies its own phone
//! over MCP and the panel shows it verified; a workspace awaiting payment is locked out.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::catalog::CATALOG;
use jt_mcp::McpState;
use jt_pg::PgStrategyGate;
use jt_testkit::panel::{Panel, body_json, expect_error, ok_json};
use serde_json::{Value, json};
use tower::ServiceExt;

const OWNER: &str = "owner@alpha.example";

/// `method path` as `cookie`, with a JSON body when given.
async fn send(
    p: &Panel,
    method: Method,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> Response {
    p.send(method, path, Some(cookie), body).await
}

/// `POST path` as `cookie` with a JSON body.
async fn post(p: &Panel, path: &str, cookie: &str, body: Value) -> Response {
    send(p, Method::POST, path, cookie, Some(body)).await
}

/// The JSON body of a response with exactly this status.
async fn expect(resp: Response, status: StatusCode) -> Value {
    assert_eq!(resp.status(), status);
    body_json(resp).await
}

/// Declares a capability of `kind` called `name` as `cookie`; returns its id.
async fn declare(p: &Panel, cookie: &str, kind: &str, name: &str) -> String {
    let body = json!({ "kind_key": kind, "name": name });
    let out = expect(
        post(p, "/api/capabilities", cookie, body).await,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(out["capability"]["kind_key"], kind);
    assert_eq!(out["effective_status"], "declared");
    out["capability"]["id"].as_str().unwrap().to_owned()
}

/// The ids of a list of capabilities, in order.
fn ids(capabilities: &Value) -> Vec<&str> {
    capabilities
        .as_array()
        .unwrap_or_else(|| panic!("not a list: {capabilities}"))
        .iter()
        .map(|c| c["capability"]["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn owner_declares_groups_and_links_a_budget_on_the_panel() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // Two hands: a phone and a printer, both devices, both declared.
    let phone = declare(&p, &owner, "phone", "Saha telefonu").await;
    let printer = declare(&p, &owner, "printer", "Ofis yazıcısı").await;
    let got = ok_json(p.get(&format!("/api/capabilities/{phone}"), &owner).await).await;
    assert_eq!(got["capability"]["reach"], "device");
    assert_eq!(got["capability"]["name"], "Saha telefonu");

    // A group holding both.
    let group = expect(
        post(
            &p,
            "/api/capability-groups",
            &owner,
            json!({ "name": "Marka A", "purpose": "kampanya cihazları" }),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(group["group"]["name"], "Marka A");
    assert_eq!(group["members"], json!([]));
    let group_id = group["group"]["id"].as_str().unwrap().to_owned();
    let members = format!("/api/capability-groups/{group_id}/members");
    for id in [&phone, &printer] {
        ok_json(post(&p, &members, &owner, json!({ "capability_id": id })).await).await;
    }
    let renamed = ok_json(
        send(
            &p,
            Method::PATCH,
            &format!("/api/capability-groups/{group_id}"),
            &owner,
            Some(json!({ "name": "Marka B" })),
        )
        .await,
    )
    .await;
    assert_eq!(renamed["group"]["name"], "Marka B");
    assert_eq!(ids(&renamed["members"]), [phone.as_str(), printer.as_str()]);

    // A cash budget item, linked to the phone.
    let item = expect(
        post(
            &p,
            "/api/budget/items",
            &owner,
            json!({
                "name": "Nakit",
                "kind": "cash",
                "unit": { "kind": "currency", "value": "TRY" },
                "cap": 100_000,
                "period": "monthly",
            }),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(item["remaining"], 100_000);
    let item_id = item["item"]["id"].as_str().unwrap().to_owned();
    let linked = ok_json(
        post(
            &p,
            &format!("/api/capabilities/{phone}/budget-links"),
            &owner,
            json!({ "budget_item_id": item_id }),
        )
        .await,
    )
    .await;
    assert_eq!(linked["capability"]["budget_item_ids"], json!([item_id]));

    // A spend from it, and the page of spend.
    let spent = expect(
        post(
            &p,
            &format!("/api/budget/items/{item_id}/spend"),
            &owner,
            json!({ "amount": 2_500, "reference": "fatura-1" }),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(spent["remaining"], 97_500);
    assert_eq!(spent["spend"]["source"], json!({ "kind": "human" }));
    let spend_path = format!("/api/budget/items/{item_id}/spend");
    let page = ok_json(p.get(&format!("{spend_path}?limit=10"), &owner).await).await;
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["reference"], "fatura-1");
    let at = page[0]["at"].as_str().unwrap();
    let path = format!(
        "{spend_path}?before_at={}&before_id={}",
        at.replace(':', "%3A").replace('+', "%2B"),
        page[0]["id"].as_str().unwrap()
    );
    assert_eq!(ok_json(p.get(&path, &owner).await).await, json!([]));
    let refused = expect_error(
        p.get(&format!("{spend_path}?before_id={item_id}"), &owner)
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["field"], "before_at");
    let items = ok_json(p.get("/api/budget/items", &owner).await).await;
    assert_eq!(items[0]["spent_in_period"], 2_500);

    // The lists show the group, its members and the link.
    let groups = ok_json(p.get("/api/capability-groups", &owner).await).await;
    assert_eq!(groups.as_array().unwrap().len(), 1);
    assert_eq!(
        ids(&groups[0]["members"]),
        [phone.as_str(), printer.as_str()]
    );
    let all = ok_json(p.get("/api/capabilities", &owner).await).await;
    assert_eq!(ids(&all), [phone.as_str(), printer.as_str()]);
    assert_eq!(all[0]["capability"]["budget_item_ids"], json!([item_id]));
    let in_group = ok_json(
        p.get(&format!("/api/capabilities?group_id={group_id}"), &owner)
            .await,
    )
    .await;
    assert_eq!(ids(&in_group).len(), 2);
    let phones = ok_json(
        p.get("/api/capabilities?kind=phone&group=device", &owner)
            .await,
    )
    .await;
    assert_eq!(ids(&phones), [phone.as_str()]);
    let refused = expect_error(
        p.get("/api/capabilities?kind=pager", &owner).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["field"], "kind");

    // A policy, and an unreachable mark.
    let policy = json!({
        "active_hours": { "tz": "Europe/Istanbul", "from": 9, "to": 18, "days": [1, 2, 3, 4, 5] },
        "daily_ops_cap": 40,
        "requires_human_approval": true,
    });
    let with_policy = ok_json(
        send(
            &p,
            Method::PUT,
            &format!("/api/capabilities/{phone}/policy"),
            &owner,
            Some(policy),
        )
        .await,
    )
    .await;
    assert_eq!(with_policy["capability"]["policy"]["daily_ops_cap"], 40);
    assert_eq!(
        with_policy["capability"]["policy"]["requires_human_approval"],
        true
    );
    let refused = expect_error(
        send(
            &p,
            Method::PUT,
            &format!("/api/capabilities/{phone}/policy"),
            &owner,
            Some(json!({ "requires_human_aproval": true })),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["field"], "policy");
    let unreachable = ok_json(
        post(
            &p,
            &format!("/api/capabilities/{printer}/unreachable"),
            &owner,
            json!({ "reason": "kâğıt sıkıştı" }),
        )
        .await,
    )
    .await;
    assert_eq!(unreachable["effective_status"], "unreachable");

    // Retiring needs the confirmation; once retired, the printer leaves the group.
    let retire = format!("/api/capabilities/{printer}/retire");
    let refused = expect_error(
        post(&p, &retire, &owner, json!({ "confirm": false })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(refused["details"]["field"], "confirm");
    let retired = ok_json(post(&p, &retire, &owner, json!({ "confirm": true })).await).await;
    assert_eq!(retired["capability"]["status"], "retired");
    assert_eq!(retired["effective_status"], "retired");
    let groups = ok_json(p.get("/api/capability-groups", &owner).await).await;
    assert_eq!(ids(&groups[0]["members"]), [phone.as_str()]);
    expect_error(
        post(&p, &retire, &owner, json!({ "confirm": true })).await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;

    // Unlinking, removing a member and deleting the group leave nothing to show.
    let unlink = format!("/api/capabilities/{phone}/budget-links/{item_id}");
    let resp = send(&p, Method::DELETE, &unlink, &owner, None).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let got = ok_json(p.get(&format!("/api/capabilities/{phone}"), &owner).await).await;
    assert_eq!(got["capability"]["budget_item_ids"], json!([]));
    let remove = format!("/api/capability-groups/{group_id}/members/{phone}");
    let resp = send(&p, Method::DELETE, &remove, &owner, None).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let resp = send(
        &p,
        Method::DELETE,
        &format!("/api/capability-groups/{group_id}"),
        &owner,
        None,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        ok_json(p.get("/api/capability-groups", &owner).await).await,
        json!([])
    );

    // Every change was recorded.
    let entries = ok_json(p.get("/api/ledger?action_prefix=capability.", &owner).await).await;
    let actions: Vec<&str> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entry"]["action"].as_str().unwrap())
        .collect();
    for action in [
        "capability.declare",
        "capability.groups.create",
        "capability.groups.rename",
        "capability.groups.add_member",
        "capability.link_budget",
        "capability.set_policy",
        "capability.mark_unreachable",
        "capability.retire",
        "capability.unlink_budget",
        "capability.groups.remove_member",
        "capability.groups.delete",
    ] {
        assert!(actions.contains(&action), "{action} in {actions:?}");
    }
}

#[tokio::test]
async fn rep_can_list_but_not_declare() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let phone = declare(&p, &owner, "phone", "Saha telefonu").await;
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;

    // Reading needs workspace.read, which a rep has.
    let listed = ok_json(p.get("/api/capabilities", &rep).await).await;
    assert_eq!(ids(&listed), [phone.as_str()]);
    ok_json(p.get(&format!("/api/capabilities/{phone}"), &rep).await).await;
    assert_eq!(
        ok_json(p.get("/api/capability-groups", &rep).await).await,
        json!([])
    );
    assert_eq!(
        ok_json(p.get("/api/budget/items", &rep).await).await,
        json!([])
    );

    // Changing them does not.
    let refused = expect_error(
        post(
            &p,
            "/api/capabilities",
            &rep,
            json!({ "kind_key": "printer", "name": "Yazıcı" }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(
        refused["details"],
        json!({ "permission": "capabilities.manage" })
    );
    // A person verifies only with capabilities.manage: the evidence-only path is the agent's.
    let refused = expect_error(
        post(
            &p,
            &format!("/api/capabilities/{phone}/verify"),
            &rep,
            json!({ "evidence": { "text": "gördüm" } }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(
        refused["details"],
        json!({ "permission": "capabilities.manage" })
    );
    let refused = expect_error(
        post(
            &p,
            "/api/capability-groups",
            &rep,
            json!({ "name": "Marka A" }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(
        refused["details"],
        json!({ "permission": "capabilities.manage" })
    );
    let refused = expect_error(
        post(
            &p,
            "/api/budget/items",
            &rep,
            json!({
                "name": "Nakit",
                "kind": "cash",
                "unit": { "kind": "currency", "value": "TRY" },
                "cap": 1_000,
                "period": "total",
            }),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(refused["details"], json!({ "permission": "budget.manage" }));

    // Nothing changed.
    let listed = ok_json(p.get("/api/capabilities", &owner).await).await;
    assert_eq!(ids(&listed), [phone.as_str()]);
    assert_eq!(listed[0]["effective_status"], "declared");
}

// ---------------------------------------------------------------------------------------------
// The agent's side, over MCP
// ---------------------------------------------------------------------------------------------

/// The panel's router merged with the MCP endpoint's over the same ports, as `jeeta serve`
/// builds them.
fn with_mcp(p: &Panel) -> Router {
    let gate = Arc::new(PgStrategyGate::new(p.db.pool.clone()));
    let mcp = McpState::new(p.deps.clone(), gate);
    p.app.clone().merge(jt_mcp::http_service(mcp))
}

/// An MCP request with `key` as the bearer, in `session` when given.
fn mcp_request(key: &str, session: Option<&str>, body: &Value) -> Request<Body> {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "127.0.0.1")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream");
    if let Some(session) = session {
        req = req.header("mcp-session-id", session);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

/// The JSON-RPC message with this id in an SSE response body.
async fn sse_message(resp: Response, id: i64) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|message| message["id"] == id)
        .expect("the response message")
}

/// Opens an MCP session on `app` with `key`; returns its id.
async fn mcp_session(app: &Router, key: &str) -> String {
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "phone-agent", "version": "1.0" },
        },
    });
    let resp = app
        .clone()
        .oneshot(mcp_request(key, None, &initialize))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let session = resp.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(sse_message(resp, 1).await["result"].is_object());
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = app
        .clone()
        .oneshot(mcp_request(key, Some(&session), &initialized))
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    session
}

/// The result of tool `name` called with `arguments` in `session`.
async fn call_tool(app: &Router, key: &str, session: &str, name: &str, arguments: Value) -> Value {
    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    let resp = app
        .clone()
        .oneshot(mcp_request(key, Some(session), &call))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    sse_message(resp, 2).await["result"].clone()
}

#[tokio::test]
async fn agent_verifies_a_phone_over_mcp_and_panel_shows_verified() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let phone = declare(&p, &owner, "phone", "Saha telefonu").await;

    // The owner issues the agent a key that may only read the workspace.
    let key = expect(
        post(
            &p,
            "/api/api-keys",
            &owner,
            json!({ "name": "telefon ajanı", "scopes": ["workspace.read"] }),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    let key = key["plaintext"].as_str().unwrap().to_owned();

    // The agent proves the phone is in its hands: its claim, recorded as given.
    let app = with_mcp(&p);
    let session = mcp_session(&app, &key).await;
    let evidence = json!({
        "text": "adb devices listed the phone and a test SMS was sent",
        "refs": ["serial:R58M12345", "screenshot:0f3a"],
    });
    let result = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.verify",
        json!({ "capability_id": phone, "evidence": evidence }),
    )
    .await;
    assert_ne!(result["isError"], json!(true), "{result}");
    assert_eq!(result["structuredContent"]["effective_status"], "verified");

    // The same key may not declare anything.
    let refused = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.declare",
        json!({ "kind_key": "printer", "name": "Yazıcı" }),
    )
    .await;
    assert_eq!(refused["isError"], json!(true), "{refused}");
    assert_eq!(refused["structuredContent"]["code"], "FORBIDDEN");

    // The panel shows the phone verified, with the agent's evidence.
    let got = ok_json(p.get(&format!("/api/capabilities/{phone}"), &owner).await).await;
    assert_eq!(got["effective_status"], "verified");
    assert_eq!(got["capability"]["status"], "verified");
    assert_eq!(got["capability"]["evidence"], evidence);
    assert!(got["capability"]["last_verified_at"].is_string());

    // The ledger names the agent as the one who verified it, never the evidence text.
    let entries = ok_json(
        p.get("/api/ledger?action_prefix=capability.verify", &owner)
            .await,
    )
    .await;
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["entry"]["actor"]["kind"], "agent");
    assert_eq!(
        entries[0]["entry"]["payload"],
        json!({ "evidence_refs": 2 })
    );
}

#[tokio::test]
async fn pending_payment_workspace_gets_workspace_inactive_on_capabilities() {
    let p = Panel::new().await;
    let (cookie, _) = p.register_pending(OWNER, "Alpha").await;

    // Exempt from the strategy gate, but not from the status check: every capability, group and
    // budget route answers 423 before its handler runs.
    let some_id = "0192f0c4-0000-7000-8000-000000000000";
    let routes = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("capability.") || uc.id.starts_with("budget."));
    let mut checked = 0;
    for uc in routes {
        let (method, template) = uc.panel_route.unwrap();
        let path = template
            .split('/')
            .map(|part| if part.starts_with('{') { some_id } else { part })
            .collect::<Vec<_>>()
            .join("/");
        let method = Method::from_bytes(method.as_bytes()).unwrap();
        let body = (method != Method::GET && method != Method::DELETE).then(|| json!({}));
        let refused = expect_error(
            send(&p, method, &path, &cookie, body).await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
        assert_eq!(
            refused["details"],
            json!({ "status": "pending_payment" }),
            "{}",
            uc.id
        );
        checked += 1;
    }
    assert_eq!(checked, 19);
}
