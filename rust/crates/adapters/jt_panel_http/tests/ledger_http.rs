//! `GET /api/ledger` end to end through Postgres: newest first, its query filters and paging,
//! structured errors for a bad query, and who may read it.

use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error, ok_json};
use serde_json::{Value, json};

/// The ledger route, on the shared harness.
trait LedgerRoute {
    /// The entries `GET /api/ledger{query}` lists for `cookie`.
    async fn ledger(&self, query: &str, cookie: &str) -> Vec<Value>;
}

impl LedgerRoute for Panel {
    async fn ledger(&self, query: &str, cookie: &str) -> Vec<Value> {
        let body = ok_json(self.get(&format!("/api/ledger{query}"), cookie).await).await;
        body.as_array().expect("the ledger is a JSON array").clone()
    }
}

/// The action names of listed entries, in order.
fn actions(entries: &[Value]) -> Vec<&str> {
    entries
        .iter()
        .map(|e| e["entry"]["action"].as_str().unwrap())
        .collect()
}

/// The sequence ids of listed entries, in order.
fn ids(entries: &[Value]) -> Vec<i64> {
    entries.iter().map(|e| e["id"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn owner_lists_ledger_newest_first_with_filters() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let invite = p.invite(&owner, "bob@example.com", "rep").await;

    // Registration, the operator's activation, then the invitation: newest first, each with
    // its id and its entry.
    let all = p.ledger("", &owner).await;
    assert_eq!(
        actions(&all),
        ["team.invite", "platform.workspace_status", "auth.register"]
    );
    let all_ids = ids(&all);
    assert!(
        all_ids[0] > all_ids[1] && all_ids[1] > all_ids[2],
        "newest first: {all_ids:?}"
    );
    assert_eq!(all[1]["entry"]["actor"]["kind"], "system");
    assert_eq!(
        all[1]["entry"]["payload"],
        json!({ "from": "pending_payment", "to": "active", "reason":"fixture activation", "by":all[1]["entry"]["actor"] })
    );
    assert_eq!(all[0]["entry"]["actor"]["kind"], "human");
    assert_eq!(
        all[0]["entry"]["subject"],
        json!({ "kind": "membership", "id": invite["membership_id"] })
    );
    assert_eq!(
        all[0]["entry"]["payload"]["invited_email"],
        "bob@example.com"
    );
    // The invite token never reaches the ledger.
    let token = invite["invite_token"].as_str().unwrap();
    assert!(!Value::Array(all.clone()).to_string().contains(token));

    // `action_prefix` keeps only matching actions; `actor_kind` only that kind of actor.
    let team = p.ledger("?action_prefix=team.", &owner).await;
    assert_eq!(actions(&team), ["team.invite"]);
    assert_eq!(ids(&team), [all_ids[0]]);
    let auth = p.ledger("?action_prefix=auth.", &owner).await;
    assert_eq!(actions(&auth), ["auth.register"]);
    assert_eq!(p.ledger("?actor_kind=human", &owner).await.len(), 2);
    assert_eq!(
        actions(&p.ledger("?actor_kind=system", &owner).await),
        ["platform.workspace_status"]
    );
    assert!(p.ledger("?actor_kind=agent", &owner).await.is_empty());

    // `limit` pages; `before_id` with the last id of a page gives the next one.
    let first = p.ledger("?limit=1", &owner).await;
    assert_eq!(actions(&first), ["team.invite"]);
    let next = p
        .ledger(&format!("?limit=2&before_id={}", all_ids[0]), &owner)
        .await;
    assert_eq!(
        actions(&next),
        ["platform.workspace_status", "auth.register"]
    );
    assert_eq!(ids(&next), [all_ids[1], all_ids[2]]);
    let past_the_end = p
        .ledger(&format!("?limit=1&before_id={}", all_ids[2]), &owner)
        .await;
    assert!(past_the_end.is_empty());

    // A limit above the maximum is capped, not refused.
    assert_eq!(p.ledger("?limit=100000", &owner).await.len(), 3);
}

#[tokio::test]
async fn bad_ledger_queries_are_structured_422() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;

    let resp = p.get("/api/ledger?limit=many", &owner).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let resp = p.get("/api/ledger?before_id=x", &owner).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let resp = p.get("/api/ledger?actor_kind=robot", &owner).await;
    let body = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(body["details"], json!({ "field": "actor_kind" }));
    // An unknown parameter is refused, not ignored, as on every panel list.
    let resp = p.get("/api/ledger?action=team.invite", &owner).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
}

#[tokio::test]
async fn rep_cannot_read_ledger_403() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;

    let resp = p.get("/api/ledger", &rep).await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"], json!({ "permission": "ledger.read" }));

    // Without a session there is no ledger at all.
    let resp = p.send(Method::GET, "/api/ledger", None, None).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}
