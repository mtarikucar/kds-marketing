//! The strategy on the panel, end to end through Postgres: a consultation from an empty
//! workspace to an approved version (with the gaps an early submission shows), who may do what,
//! archiving a named version, and the consultation log's keyset pages.

use axum::http::{Method, StatusCode};
use axum::response::Response;
use jt_testkit::panel::{Panel, body_json, expect_error, ok_json};
use serde_json::{Value, json};

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

/// `POST path` as `cookie`, with a JSON body when given.
async fn post(p: &Panel, path: &str, cookie: &str, body: Option<Value>) -> Response {
    send(p, Method::POST, path, cookie, body).await
}

/// `PUT path` as `cookie` with a JSON body.
async fn put(p: &Panel, path: &str, cookie: &str, body: Value) -> Response {
    send(p, Method::PUT, path, cookie, Some(body)).await
}

/// Writes section `key` of the draft as `cookie`.
async fn write_section(p: &Panel, cookie: &str, key: &str, value: Value) -> Response {
    put(
        p,
        &format!("/api/strategy/draft/sections/{key}"),
        cookie,
        value,
    )
    .await
}

/// Every section a minimal approvable strategy needs, on the `any` channel (no workspace has a
/// channel kind yet).
fn sections() -> Vec<(&'static str, Value)> {
    vec![
        (
            "identity",
            json!({ "product": "Kahve", "voice": "sıcak", "positioning": "mahalle", "usp": "taze" }),
        ),
        (
            "audience",
            json!([{ "key": "students", "name": "Öğrenciler", "description": "kampüs" }]),
        ),
        (
            "goals",
            json!({ "objective": "ayda 50 DM", "kpis": [{ "name": "dm", "target": "50" }] }),
        ),
        (
            "cadence",
            json!({ "per_week": 3, "channel_mix": [{ "channel": "any", "share_pct": 100 }] }),
        ),
        (
            "channels",
            json!([{ "channel": "any", "rationale": "her yerde" }]),
        ),
    ]
}

/// One hypothesis on the `any` channel about the `students` segment.
fn hypotheses() -> Value {
    json!([{
        "title": "Sınav haftası",
        "segment_key": "students",
        "angle": "gece açık",
        "channel": "any",
        "metric": "dm",
        "confidence": 0.6,
    }])
}

/// The fields of a `details.gaps` list, in order.
fn gap_fields(details: &Value) -> Vec<&str> {
    details["gaps"]
        .as_array()
        .unwrap_or_else(|| panic!("no gaps in {details}"))
        .iter()
        .map(|g| g["field"].as_str().unwrap())
        .collect()
}

/// Opens a consultation as `cookie`, writes every section and the hypotheses and submits;
/// returns the submitted draft.
async fn submit_a_draft(p: &Panel, cookie: &str) -> Value {
    ok_json(post(p, "/api/strategy/consultation", cookie, None).await).await;
    for (key, value) in sections() {
        ok_json(write_section(p, cookie, key, value).await).await;
    }
    ok_json(put(p, "/api/strategy/draft/hypotheses", cookie, hypotheses()).await).await;
    ok_json(post(p, "/api/strategy/draft/submit", cookie, None).await).await
}

/// [`submit_a_draft`], then approves it as the same caller; returns the approved version.
async fn approve_a_strategy(p: &Panel, cookie: &str) -> Value {
    submit_a_draft(p, cookie).await;
    ok_json(post(p, "/api/strategy/draft/approve", cookie, None).await).await
}

/// The consultation entries of `version_id` on one page, with `query` (e.g. `?limit=2`).
async fn consultation(p: &Panel, cookie: &str, version_id: &str, query: &str) -> Vec<Value> {
    let path = format!("/api/strategy/versions/{version_id}/consultation{query}");
    let body = ok_json(p.get(&path, cookie).await).await;
    body.as_array().expect("the log is a JSON array").clone()
}

/// The `kind` of each entry, in order.
fn kinds(entries: &[Value]) -> Vec<&str> {
    entries
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn owner_runs_the_consultation_to_approval_on_the_panel() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // A new workspace has no strategy at all.
    let empty = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(
        empty,
        json!({ "approved": null, "draft": null, "gaps": [] })
    );
    assert_eq!(
        ok_json(p.get("/api/strategy/versions", &owner).await).await,
        json!([])
    );

    // Opening the consultation answers the new draft; asking again answers the same one.
    let draft = ok_json(post(&p, "/api/strategy/consultation", &owner, None).await).await;
    assert_eq!(draft["number"], 1);
    assert_eq!(draft["status"], "draft");
    assert_eq!(draft["consultation_count"], 1, "the log notes the start");
    assert_eq!(draft["submitted_at"], Value::Null);
    let id = draft["id"].as_str().unwrap().to_owned();
    let again = ok_json(post(&p, "/api/strategy/consultation", &owner, None).await).await;
    assert_eq!(again["id"], draft["id"]);

    // The question put to the owner and the answer go into the log.
    for (kind, text) in [("question", "Ne satıyorsunuz?"), ("answer", "Kahve")] {
        let body = json!({ "kind": kind, "section_key": "identity", "text": text });
        let resp = post(&p, "/api/strategy/consultation/entries", &owner, Some(body)).await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        assert!(body_json(resp).await["id"].is_string());
    }
    let resp = post(
        &p,
        "/api/strategy/consultation/entries",
        &owner,
        Some(json!({ "kind": "approved", "text": "x" })),
    )
    .await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;

    // A section with an unknown field is refused with its gaps, and an unknown section by name.
    let resp = write_section(
        &p,
        &owner,
        "identity",
        json!({ "product": "Kahve", "prodcut": "x" }),
    )
    .await;
    let refused = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(gap_fields(&refused["details"]), ["identity.prodcut"]);
    let resp = write_section(&p, &owner, "competitors", json!([])).await;
    let refused = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(refused["details"]["field"], "section_key");

    // Every section but the channels, and the hypotheses: the draft says what it still lacks.
    let mut last = Value::Null;
    for (key, value) in sections().into_iter().filter(|(k, _)| *k != "channels") {
        last = ok_json(write_section(&p, &owner, key, value).await).await;
    }
    assert_eq!(last["sections"]["identity"]["product"], "Kahve");
    let with_hypotheses =
        ok_json(put(&p, "/api/strategy/draft/hypotheses", &owner, hypotheses()).await).await;
    assert_eq!(with_hypotheses["hypotheses"][0]["state"], "added");
    let missing = ["channels", "cadence.channel_mix[0].channel"];
    assert_eq!(gap_fields(&with_hypotheses), missing);
    let shown = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(gap_fields(&shown), missing);
    assert_eq!(shown["draft"]["gaps"], shown["gaps"]);

    // Submitting early shows the same gaps; approving what was never submitted is a conflict.
    let resp = post(&p, "/api/strategy/draft/submit", &owner, None).await;
    let refused = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(gap_fields(&refused["details"]), missing);
    let resp = post(&p, "/api/strategy/draft/approve", &owner, None).await;
    let refused = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(refused["details"]["reason"], "not_submitted");

    // The channels close the gaps; then submission and approval go through.
    let (key, value) = sections().pop().unwrap();
    let fixed = ok_json(write_section(&p, &owner, key, value).await).await;
    assert_eq!(fixed["gaps"], json!([]));
    let submitted = ok_json(post(&p, "/api/strategy/draft/submit", &owner, None).await).await;
    assert!(submitted["submitted_at"].is_string());
    let approved = ok_json(post(&p, "/api/strategy/draft/approve", &owner, None).await).await;
    assert_eq!(approved["id"], json!(id));
    assert_eq!(approved["status"], "approved");
    assert_eq!(approved["approved_by_email"], OWNER);
    assert!(approved["approved_at"].is_string());
    assert_eq!(approved["gaps"], json!([]));

    // The strategy in force, and no draft left.
    let strategy = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(strategy["approved"], approved);
    assert_eq!(strategy["draft"], Value::Null);
    assert_eq!(strategy["gaps"], json!([]));
    let versions = ok_json(p.get("/api/strategy/versions", &owner).await).await;
    assert_eq!(versions.as_array().unwrap().len(), 1);
    assert_eq!(versions[0]["id"], json!(id));
    assert_eq!(versions[0]["status"], "approved");

    // The log, newest first: refused calls left nothing in it.
    let log = consultation(&p, &owner, &id, "").await;
    assert_eq!(
        kinds(&log),
        [
            "approved",
            "submitted",
            "section_draft",
            "section_draft",
            "section_draft",
            "section_draft",
            "section_draft",
            "answer",
            "question",
            "note",
        ]
    );
    assert_eq!(approved["consultation_count"], json!(log.len()));
    assert_eq!(log[2]["section_key"], "channels");
    assert_eq!(log[7]["text"], "Kahve");
    assert_eq!(log[0]["actor"]["kind"], "human");

    // The ledger names each change, the approval under the version it put in force.
    let ledger = ok_json(p.get("/api/ledger?action_prefix=strategy.", &owner).await).await;
    let actions: Vec<&str> = ledger
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entry"]["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        [
            "strategy.approve",
            "strategy.submit",
            "strategy.write_section",
            "strategy.set_hypotheses",
            "strategy.write_section",
            "strategy.write_section",
            "strategy.write_section",
            "strategy.write_section",
            "strategy.record",
            "strategy.record",
            "strategy.start_consultation",
        ]
    );
    assert_eq!(ledger[0]["entry"]["strategy_version_id"], json!(id));
    assert!(!ledger.to_string().contains("Ne satıyorsunuz?"));
}

#[tokio::test]
async fn rep_cannot_write_sections_403() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let draft = ok_json(post(&p, "/api/strategy/consultation", &owner, None).await).await;
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;

    // A rep reads the strategy and its log ...
    let shown = ok_json(p.get("/api/strategy", &rep).await).await;
    assert_eq!(shown["draft"]["id"], draft["id"]);
    let id = draft["id"].as_str().unwrap();
    assert_eq!(consultation(&p, &rep, id, "").await.len(), 1);
    ok_json(p.get("/api/strategy/versions", &rep).await).await;

    // ... but runs none of the consultation.
    let (key, value) = sections().remove(0);
    let resp = write_section(&p, &rep, key, value).await;
    let refused = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(refused["details"], json!({ "permission": "team.manage" }));
    for (path, body) in [
        ("/api/strategy/consultation", None),
        (
            "/api/strategy/consultation/entries",
            Some(json!({ "kind": "note", "text": "x" })),
        ),
        ("/api/strategy/draft/submit", None),
    ] {
        let resp = post(&p, path, &rep, body).await;
        let refused = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(refused["details"]["permission"], "team.manage", "{path}");
    }
    let resp = put(&p, "/api/strategy/draft/hypotheses", &rep, hypotheses()).await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;

    // Approving and archiving need an owner or a manager.
    let resp = post(&p, "/api/strategy/draft/approve", &rep, None).await;
    let refused = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(refused["details"]["reason"], "owner_or_manager");
    let resp = post(
        &p,
        "/api/strategy/archive",
        &rep,
        Some(json!({ "version_id": id, "confirm": true })),
    )
    .await;
    let refused = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(refused["details"]["reason"], "owner_or_manager");

    // Nothing the rep tried reached the log.
    assert_eq!(consultation(&p, &owner, id, "").await.len(), 1);
}

#[tokio::test]
async fn a_manager_approves_what_the_owner_submitted() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let submitted = submit_a_draft(&p, &owner).await;
    let (manager, _) = p.join(&owner, "manager@alpha.example", "manager").await;

    let approved = ok_json(post(&p, "/api/strategy/draft/approve", &manager, None).await).await;
    assert_eq!(approved["id"], submitted["id"]);
    assert_eq!(approved["approved_by_email"], "manager@alpha.example");
}

#[tokio::test]
async fn archive_with_wrong_version_is_409() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let approved = approve_a_strategy(&p, &owner).await;
    let id = approved["id"].as_str().unwrap();
    let archive = |body: Value| post(&p, "/api/strategy/archive", &owner, Some(body));

    // Another version than the one in force: refused, naming the one in force.
    let other = "0192f0c0-0000-7000-8000-000000000001";
    let resp = archive(json!({ "version_id": other, "confirm": true })).await;
    let refused = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(refused["details"]["approved_version_id"], json!(id));

    // The right version without confirmation, or with a malformed id: refused.
    let resp = archive(json!({ "version_id": id })).await;
    let refused = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(refused["details"]["field"], "confirm");
    let resp = archive(json!({ "version_id": id, "confirm": false })).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let resp = archive(json!({ "version_id": "v1", "confirm": true })).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let still = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(still["approved"]["id"], json!(id));

    // Confirmed: archived (`200` with the confirmation `jeeta.strategy.archive` answers), and the
    // strategy gate is closed again.
    let resp = archive(json!({ "version_id": id, "confirm": true })).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        body_json(resp).await,
        json!({ "version_id": id, "archived": true })
    );
    let strategy = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(strategy["approved"], Value::Null);
    let versions = ok_json(p.get("/api/strategy/versions", &owner).await).await;
    assert_eq!(versions[0]["status"], "archived");
    assert!(versions[0]["archived_at"].is_string());
    let log = consultation(&p, &owner, id, "?limit=1").await;
    assert_eq!(kinds(&log), ["archived"]);

    // Nothing is left to archive.
    let resp = archive(json!({ "version_id": id, "confirm": true })).await;
    let refused = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(refused["details"]["reason"], "no_approved_version");
}

/// `at` as a query value.
fn query_value(at: &Value) -> String {
    at.as_str().unwrap().replace('+', "%2B").replace(':', "%3A")
}

#[tokio::test]
async fn consultation_pages_by_keyset() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    let draft = ok_json(post(&p, "/api/strategy/consultation", &owner, None).await).await;
    let id = draft["id"].as_str().unwrap();
    for i in 1..=6 {
        let body = json!({ "kind": "question", "text": format!("q{i}") });
        let resp = post(&p, "/api/strategy/consultation/entries", &owner, Some(body)).await;
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    // Pages of three, each continuing before the previous page's last entry.
    let mut texts = Vec::new();
    let mut query = "?limit=3".to_owned();
    loop {
        let page = consultation(&p, &owner, id, &query).await;
        assert!(page.len() <= 3);
        let Some(last) = page.last() else { break };
        query = format!(
            "?limit=3&before_at={}&before_id={}",
            query_value(&last["at"]),
            last["id"].as_str().unwrap()
        );
        texts.extend(page.iter().map(|e| e["text"].as_str().unwrap().to_owned()));
    }
    assert_eq!(
        texts,
        ["q6", "q5", "q4", "q3", "q2", "q1", "consultation started"]
    );
    // Without a limit, a page holds them all.
    assert_eq!(consultation(&p, &owner, id, "").await.len(), 7);

    // The cursor is both halves or neither, and each must parse; an unknown parameter is refused,
    // as on every panel list.
    let entry = "0192f0c0-0000-7000-8000-000000000001";
    for query in [
        format!("?before_id={entry}"),
        "?before_at=2026-10-22T09%3A00%3A00Z".to_owned(),
        format!("?before_at=yesterday&before_id={entry}"),
        "?limit=many".to_owned(),
        "?limit=3&page=2".to_owned(),
    ] {
        let path = format!("/api/strategy/versions/{id}/consultation{query}");
        let resp = p.get(&path, &owner).await;
        expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    }

    // A version that is not this workspace's, or not an id at all.
    let resp = p
        .get(
            &format!("/api/strategy/versions/{entry}/consultation"),
            &owner,
        )
        .await;
    expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    let resp = p
        .get("/api/strategy/versions/v1/consultation", &owner)
        .await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
}

#[tokio::test]
async fn pending_payment_workspace_can_call_strategy_routes() {
    let p = Panel::new().await;
    let (owner, _) = p.register_pending(OWNER, "Alpha").await;

    // The strategy may be worked out before payment: `strategy.*` is exempt from the
    // workspace-status check, so the whole consultation runs, up to approval.
    let empty = ok_json(p.get("/api/strategy", &owner).await).await;
    assert!(empty["approved"].is_null(), "{empty}");
    assert!(empty["draft"].is_null(), "{empty}");
    let draft = ok_json(post(&p, "/api/strategy/consultation", &owner, None).await).await;
    assert_eq!(draft["status"], "draft");
    let approved = approve_a_strategy(&p, &owner).await;
    assert_eq!(approved["status"], "approved");
    let got = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(got["approved"]["id"], approved["id"]);
    assert_eq!(
        consultation(&p, &owner, approved["id"].as_str().unwrap(), "")
            .await
            .first()
            .map(|e| e["kind"].clone()),
        Some(json!("approved"))
    );

    // Everything else stays locked until the operator activates the workspace.
    expect_error(
        p.get("/api/capabilities", &owner).await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;
}
