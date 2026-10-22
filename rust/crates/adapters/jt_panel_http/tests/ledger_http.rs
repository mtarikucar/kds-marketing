//! `GET /api/ledger` end to end through Postgres: newest first, its query filters and paging,
//! structured errors for a bad query, and who may read it.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::gate::NoStrategyYet;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_panel_http::{AppState, router};
use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;
use jt_testkit::fakes::PlainHasher;
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";
const REQUESTED_WITH: (&str, &str) = ("x-requested-with", "jeeta-panel");

/// A router over a fresh test database.
struct Panel {
    _db: TestDb,
    app: Router,
}

impl Panel {
    async fn new() -> Panel {
        let db = TestDb::new().await;
        let state = AppState {
            deps: Deps {
                uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
                clock: Arc::new(SystemClock),
                ids: Arc::new(UuidV7Gen),
                tokens: Arc::new(RandTokenGen),
                hasher: Arc::new(PlainHasher),
            },
            gate: Arc::new(NoStrategyYet),
            cookie_secure: false,
            panel_dir: None,
        };
        Panel {
            _db: db,
            app: router(state),
        }
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut builder = Request::builder().method(method.clone()).uri(path);
        if !method.is_safe() {
            builder = builder.header(REQUESTED_WITH.0, REQUESTED_WITH.1);
        }
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        self.app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn get(&self, path: &str, cookie: &str) -> Response {
        self.send(Method::GET, path, Some(cookie), None).await
    }

    /// Registers `email` with a new workspace; returns the `jt_session=…` pair.
    async fn register(&self, email: &str, workspace_name: &str) -> String {
        let body = json!({
            "email": email,
            "password": PASSWORD,
            "display_name": "Owner",
            "workspace_name": workspace_name,
        });
        let resp = self
            .send(Method::POST, "/api/auth/register", None, Some(body))
            .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        session_pair(&resp)
    }

    /// Invites `email` as `role_key` from `owner_cookie`; returns the invitation.
    async fn invite(&self, owner_cookie: &str, email: &str, role_key: &str) -> Value {
        let resp = self
            .send(
                Method::POST,
                "/api/team/invites",
                Some(owner_cookie),
                Some(json!({ "email": email, "role_key": role_key })),
            )
            .await;
        ok_json(resp).await
    }

    /// Invites `email` as `role_key` from `owner_cookie` and accepts as a new user; returns the
    /// new user's `jt_session=…` pair.
    async fn join(&self, owner_cookie: &str, email: &str, role_key: &str) -> String {
        let invite = self.invite(owner_cookie, email, role_key).await;
        let resp = self
            .send(
                Method::POST,
                "/api/team/invites/accept",
                None,
                Some(json!({
                    "token": invite["invite_token"],
                    "password": PASSWORD,
                    "display_name": email,
                })),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        session_pair(&resp)
    }

    /// The entries `GET /api/ledger{query}` lists for `cookie`.
    async fn ledger(&self, query: &str, cookie: &str) -> Vec<Value> {
        let body = ok_json(self.get(&format!("/api/ledger{query}"), cookie).await).await;
        body.as_array().expect("the ledger is a JSON array").clone()
    }
}

/// The `jt_session=…` pair of the response's single `Set-Cookie` header.
fn session_pair(resp: &Response) -> String {
    let all: Vec<_> = resp.headers().get_all(header::SET_COOKIE).iter().collect();
    assert_eq!(all.len(), 1, "exactly one Set-Cookie header");
    let pair = all[0].to_str().unwrap().split(';').next().unwrap().trim();
    assert!(pair.starts_with("jt_session="), "{pair}");
    pair.to_owned()
}

async fn body_text(resp: Response) -> String {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// The JSON body of a `2xx` response.
async fn ok_json(resp: Response) -> Value {
    assert!(resp.status().is_success(), "{}", resp.status());
    serde_json::from_str(&body_text(resp).await).unwrap()
}

/// Asserts a structured error with this status and code, and returns its body.
async fn expect_error(resp: Response, status: StatusCode, code: &str) -> Value {
    assert_eq!(resp.status(), status);
    let body: Value = serde_json::from_str(&body_text(resp).await).unwrap();
    assert_eq!(body["code"], code, "{body}");
    assert!(body["message"].is_string(), "{body}");
    assert!(body["details"].is_object(), "{body}");
    body
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
    let owner = p.register("owner@alpha.example", "Alpha").await;
    let invite = p.invite(&owner, "bob@example.com", "rep").await;

    // Registration, then the invitation: newest first, each with its id and its entry.
    let all = p.ledger("", &owner).await;
    assert_eq!(actions(&all), ["team.invite", "auth.register"]);
    let all_ids = ids(&all);
    assert!(all_ids[0] > all_ids[1], "newest first: {all_ids:?}");
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
    assert!(p.ledger("?actor_kind=agent", &owner).await.is_empty());

    // `limit` pages; `before_id` with the last id of a page gives the next one.
    let first = p.ledger("?limit=1", &owner).await;
    assert_eq!(actions(&first), ["team.invite"]);
    let next = p
        .ledger(&format!("?limit=1&before_id={}", all_ids[0]), &owner)
        .await;
    assert_eq!(actions(&next), ["auth.register"]);
    assert_eq!(ids(&next), [all_ids[1]]);
    let past_the_end = p
        .ledger(&format!("?limit=1&before_id={}", all_ids[1]), &owner)
        .await;
    assert!(past_the_end.is_empty());

    // A limit above the maximum is capped, not refused.
    assert_eq!(p.ledger("?limit=100000", &owner).await.len(), 2);
}

#[tokio::test]
async fn bad_ledger_queries_are_structured_422() {
    let p = Panel::new().await;
    let owner = p.register("owner@alpha.example", "Alpha").await;

    let resp = p.get("/api/ledger?limit=many", &owner).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let resp = p.get("/api/ledger?before_id=x", &owner).await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    let resp = p.get("/api/ledger?actor_kind=robot", &owner).await;
    let body = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(body["details"], json!({ "field": "actor_kind" }));
}

#[tokio::test]
async fn rep_cannot_read_ledger_403() {
    let p = Panel::new().await;
    let owner = p.register("owner@alpha.example", "Alpha").await;
    let rep = p.join(&owner, "rep@alpha.example", "rep").await;

    let resp = p.get("/api/ledger", &rep).await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"], json!({ "permission": "ledger.read" }));

    // Without a session there is no ledger at all.
    let resp = p.send(Method::GET, "/api/ledger", None, None).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}
