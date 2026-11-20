//! The knowledge base on the panel, end to end through Postgres (design 2026-11-19 "Paylaşımlar
//! and Bilgi bankası" §4.4-§4.9, §4.11.1): the first read seeds it, the owner's cards, rules,
//! goals, notes, one account's approval and the proposals, each answering what it changed, and
//! who may do what.

use axum::http::{Method, StatusCode};
use axum::response::Response;
use jt_testkit::panel::{Panel, expect_error, ok_json};
use serde_json::{Value, json};

const OWNER: &str = "owner@alpha.example";

async fn send(
    p: &Panel,
    method: Method,
    path: &str,
    cookie: &str,
    body: Option<Value>,
) -> Response {
    p.send(method, path, Some(cookie), body).await
}

fn card<'a>(kb: &'a Value, key: &str) -> &'a Value {
    kb["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["key"] == key)
        .unwrap_or_else(|| panic!("no {key} card in {kb}"))
}

#[tokio::test]
async fn the_owner_keeps_the_knowledge_base_on_the_panel() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;

    // The first read seeds a new workspace: blank seed cards, no rules, no frame.
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["revision"], 1);
    assert_eq!(kb["empty"], true);
    assert_eq!(kb["frame"], Value::Null);
    assert_eq!(kb["cards"].as_array().unwrap().len(), 8);
    assert_eq!(kb["notes_agent"]["state"], "none");
    assert_eq!(ok_json(p.get("/api/knowledge", &owner).await).await, kb);
    // The home page's work (design 2026-11-19 §4.10.12, §5.2): empty, a card asked for.
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["knowledge"]["empty"], true);
    assert_eq!(pending["items"][0]["kind"], "knowledge_empty");

    // A Kurallar save first: still empty, no frame.
    let rules = ok_json(
        send(
            &p,
            Method::PUT,
            "/api/knowledge/rules",
            &owner,
            Some(json!({
                "expected_revision": kb["rules"]["revision"],
                "prohibitions": ["Rakip adı anma"],
                "post_approval": false,
            })),
        )
        .await,
    )
    .await;
    assert_eq!(rules["prohibitions"], json!(["Rakip adı anma"]));
    assert_eq!(rules["revision"], 2);
    let stale = send(
        &p,
        Method::PUT,
        "/api/knowledge/rules",
        &owner,
        Some(json!({ "expected_revision": 1, "prohibitions": [], "post_approval": false })),
    )
    .await;
    let refused = expect_error(stale, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(refused["details"]["reason"], "rules_changed");
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["empty"], true);
    assert_eq!(kb["frame"], Value::Null);
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(
        pending["knowledge"]["empty"], true,
        "a Kurallar save is no card"
    );

    // The first card text: the frame is bootstrapped in the same write.
    let who = card(&kb, "who_we_are").clone();
    let path = format!("/api/knowledge/cards/{}", who["id"].as_str().unwrap());
    let edited = ok_json(
        send(
            &p,
            Method::PATCH,
            &path,
            &owner,
            Some(json!({ "expected_revision": who["revision"], "body": "Mahalle kahvecisi." })),
        )
        .await,
    )
    .await;
    assert_eq!(edited["body"], "Mahalle kahvecisi.");
    let resp = send(
        &p,
        Method::PATCH,
        &path,
        &owner,
        Some(json!({ "expected_revision": who["revision"], "body": "Eski" })),
    )
    .await;
    let refused = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(refused["details"]["reason"], "card_changed");
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["empty"], false);
    assert_eq!(kb["frame"]["number"], 1);
    assert_eq!(kb["frame"]["topics"][0]["title"], "Genel");
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["knowledge"]["empty"], false);
    assert_eq!(pending["knowledge"]["frame"], 1);
    assert_eq!(pending["strategy"], json!({ "approved": { "number": 1 } }));

    // A card of the owner's own, its removal and restoration, and its history.
    let resp = send(
        &p,
        Method::POST,
        "/api/knowledge/cards",
        &owner,
        Some(json!({ "title": "Sık sorulanlar", "body": "Kargo 2 gün." })),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let own = ok_json(resp).await;
    assert_eq!(own["key"], Value::Null);
    let id = own["id"].as_str().unwrap().to_owned();
    let removed = ok_json(
        send(
            &p,
            Method::POST,
            &format!("/api/knowledge/cards/{id}/archive"),
            &owner,
            Some(json!({ "expected_revision": own["revision"], "archived": true })),
        )
        .await,
    )
    .await;
    assert!(removed["archived_at"].is_string());
    ok_json(
        send(
            &p,
            Method::POST,
            &format!("/api/knowledge/cards/{id}/archive"),
            &owner,
            Some(json!({ "expected_revision": removed["revision"], "archived": false })),
        )
        .await,
    )
    .await;
    let history = ok_json(
        p.get(&format!("/api/knowledge/cards/{id}/history"), &owner)
            .await,
    )
    .await;
    assert_eq!(history["revisions"].as_array().unwrap().len(), 3);
    assert_eq!(history["revisions"][0]["revision"], 3, "newest first");
    let page = ok_json(
        p.get(
            &format!("/api/knowledge/cards/{id}/history?before=3"),
            &owner,
        )
        .await,
    )
    .await;
    assert_eq!(page["revisions"].as_array().unwrap().len(), 2);

    // Hedefler.
    let goals = ok_json(
        send(
            &p,
            Method::PUT,
            "/api/knowledge/goals",
            &owner,
            Some(json!({ "expected_revision": kb["goals"]["revision"], "items": ["Ayda 50 DM"] })),
        )
        .await,
    )
    .await;
    assert_eq!(goals["items"], json!(["Ayda 50 DM"]));

    // A note, and taking it back.
    let resp = send(
        &p,
        Method::POST,
        "/api/knowledge/notes",
        &owner,
        Some(json!({ "request_key": "n1", "text": "Yarın kapalıyız." })),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let note = ok_json(resp).await;
    assert_eq!(note["status"], "open");
    let replay = ok_json(
        send(
            &p,
            Method::POST,
            "/api/knowledge/notes",
            &owner,
            Some(json!({ "request_key": "n1", "text": "Yarın kapalıyız." })),
        )
        .await,
    )
    .await;
    assert_eq!(replay["id"], note["id"]);
    let withdrawn = ok_json(
        send(
            &p,
            Method::POST,
            &format!(
                "/api/knowledge/notes/{}/withdraw",
                note["id"].as_str().unwrap()
            ),
            &owner,
            Some(json!({ "expected_revision": note["revision"] })),
        )
        .await,
    )
    .await;
    assert_eq!(withdrawn["status"], "withdrawn");

    // The read has it all, in the same transaction's terms.
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["rules"]["prohibitions"], json!(["Rakip adı anma"]));
    assert_eq!(kb["goals"]["items"], json!(["Ayda 50 DM"]));
    assert_eq!(kb["notes"][0]["status"], "withdrawn");
    assert!(card(&kb, "who_we_are")["body"] == "Mahalle kahvecisi.");
    let unknown = send(
        &p,
        Method::POST,
        "/api/knowledge/post-approval",
        &owner,
        Some(json!({
            "capability_id": "0192f0c0-0000-7000-8000-000000000001",
            "required": true,
            "expected_revision": kb["rules"]["revision"],
        })),
    )
    .await;
    expect_error(unknown, StatusCode::NOT_FOUND, "NOT_FOUND").await;

    // A member without team.manage reads it and changes nothing.
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;
    ok_json(p.get("/api/knowledge", &rep).await).await;
    let resp = send(
        &p,
        Method::POST,
        "/api/knowledge/cards",
        &rep,
        Some(json!({ "title": "Benim", "body": "x" })),
    )
    .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = send(
        &p,
        Method::PUT,
        "/api/knowledge/goals",
        &rep,
        Some(json!({ "expected_revision": 2, "items": [] })),
    )
    .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
}

#[tokio::test]
async fn a_draft_left_from_the_old_page_becomes_proposals_the_owner_adds_or_skips() {
    let p = Panel::new().await;
    let (owner, _) = p.register(OWNER, "Alpha").await;
    // Before the knowledge base, a draft never approved (the old strategy page).
    ok_json(send(&p, Method::POST, "/api/strategy/consultation", &owner, None).await).await;
    for (key, value) in [
        (
            "identity",
            json!({ "product": "Kahve", "voice": "sıcak", "positioning": "mahalle", "usp": "" }),
        ),
        ("prohibitions", json!(["Rakip adı anma"])),
    ] {
        ok_json(
            send(
                &p,
                Method::PUT,
                &format!("/api/strategy/draft/sections/{key}"),
                &owner,
                Some(value),
            )
            .await,
        )
        .await;
    }

    // Seeding makes its parts proposals and archives it; nothing takes effect yet.
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["empty"], true);
    assert_eq!(kb["frame"], Value::Null);
    let proposals = kb["proposals"].as_array().unwrap().clone();
    assert!(proposals.len() >= 3, "{proposals:?}");
    let strategy = ok_json(p.get("/api/strategy", &owner).await).await;
    assert_eq!(strategy["draft"], Value::Null, "the draft was archived");

    // Adding the who_we_are proposal bootstraps the frame; skipping the rule keeps it out.
    let who = card(&kb, "who_we_are")["id"].clone();
    let edit = proposals
        .iter()
        .find(|x| x["kind"] == "card_edit" && x["card_id"] == who)
        .unwrap();
    let accepted = ok_json(
        send(
            &p,
            Method::POST,
            &format!(
                "/api/knowledge/proposals/{}/accept",
                edit["id"].as_str().unwrap()
            ),
            &owner,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(accepted["status"], "accepted");
    let rule = proposals.iter().find(|x| x["kind"] == "rule_add").unwrap();
    let skipped = ok_json(
        send(
            &p,
            Method::POST,
            &format!(
                "/api/knowledge/proposals/{}/skip",
                rule["id"].as_str().unwrap()
            ),
            &owner,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(skipped["status"], "skipped");
    let again = send(
        &p,
        Method::POST,
        &format!(
            "/api/knowledge/proposals/{}/skip",
            rule["id"].as_str().unwrap()
        ),
        &owner,
        None,
    )
    .await;
    assert!(again.status().is_client_error());
    let kb = ok_json(p.get("/api/knowledge", &owner).await).await;
    assert_eq!(kb["empty"], false);
    assert!(kb["frame"]["number"].is_i64());
    assert_eq!(kb["rules"]["prohibitions"], json!([]));
}
