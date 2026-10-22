//! The platform console's routes end to end through Postgres: operator login and its
//! `jt_platform` cookie, the workspace list, activating a workspace, and the separation between
//! operator and tenant sessions.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::gate::NoStrategyYet;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::platform;
use jt_panel_http::{AppState, router};
use jt_pg::PgUnitOfWork;
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use jt_testkit::fakes::PlainHasher;
use serde_json::{Value, json};
use tower::ServiceExt;

const TENANT_PASSWORD: &str = "correct horse battery";
const OPERATOR_EMAIL: &str = "ops@jeeta.test";
const OPERATOR_PASSWORD: &str = "operator passphrase";
/// The request header every mutating `/api` call must carry.
const REQUESTED_WITH: (&str, &str) = ("x-requested-with", "jeeta-panel");

/// A router over a fresh test database, with one bootstrapped operator.
struct Panel {
    _db: TestDb,
    app: Router,
}

impl Panel {
    async fn new() -> Panel {
        let db = TestDb::new().await;
        let deps = Deps {
            uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7Gen),
            tokens: Arc::new(RandTokenGen),
            hasher: Arc::new(PlainHasher),
        };
        assert!(
            platform::bootstrap(&deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
                .await
                .unwrap()
        );
        let state = AppState {
            deps,
            gate: Arc::new(NoStrategyYet),
            cookie_secure: false,
            panel_dir: None,
        };
        Panel {
            _db: db,
            app: router(state),
        }
    }

    async fn send(&self, req: Request<Body>) -> Response {
        self.app.clone().oneshot(req).await.unwrap()
    }

    /// Registers a tenant owner with a new workspace; returns the `jt_session=…` pair and the
    /// workspace.
    async fn register(&self, email: &str, workspace_name: &str) -> (String, WorkspaceId) {
        let body = json!({
            "email": email,
            "password": TENANT_PASSWORD,
            "display_name": "Owner",
            "workspace_name": workspace_name,
        });
        let resp = self
            .send(request(
                Method::POST,
                "/api/auth/register",
                None,
                true,
                Some(body),
            ))
            .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        let cookie = cookie_pair(&set_cookie(&resp));
        let me = body_json(resp).await;
        let ws = serde_json::from_value(me["current_workspace"].clone()).unwrap();
        (cookie, ws)
    }

    /// Logs the operator in; returns the full `Set-Cookie` value and the response body.
    async fn operator_login(&self) -> (String, Value) {
        let resp = self
            .send(request(
                Method::POST,
                "/api/platform/login",
                None,
                true,
                Some(json!({ "email": OPERATOR_EMAIL, "password": OPERATOR_PASSWORD })),
            ))
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cookie = set_cookie(&resp);
        (cookie, body_json(resp).await)
    }

    async fn get(&self, path: &str, cookie: &str) -> Response {
        self.send(request(Method::GET, path, Some(cookie), false, None))
            .await
    }

    async fn set_status(&self, ws: &str, cookie: &str, body: Value) -> Response {
        let path = format!("/api/platform/workspaces/{ws}/status");
        self.send(request(
            Method::PATCH,
            &path,
            Some(cookie),
            true,
            Some(body),
        ))
        .await
    }
}

/// A request with an optional cookie, the request header when `requested_with`, and an optional
/// JSON body.
fn request(
    method: Method,
    path: &str,
    cookie: Option<&str>,
    requested_with: bool,
    body: Option<Value>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    if requested_with {
        builder = builder.header(REQUESTED_WITH.0, REQUESTED_WITH.1);
    }
    let body = match body {
        Some(body) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

/// The single `Set-Cookie` header of a response.
fn set_cookie(resp: &Response) -> String {
    let all: Vec<_> = resp.headers().get_all(header::SET_COOKIE).iter().collect();
    assert_eq!(all.len(), 1, "exactly one Set-Cookie header");
    all[0].to_str().unwrap().to_owned()
}

/// The `name=value` part of a `Set-Cookie` header.
fn cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().trim().to_owned()
}

async fn body_json(resp: Response) -> Value {
    assert_eq!(
        resp.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn ok_json(resp: Response) -> Value {
    assert_eq!(resp.status(), StatusCode::OK);
    body_json(resp).await
}

/// Asserts a structured error with this status and code, and returns its body.
async fn expect_error(resp: Response, status: StatusCode, code: &str) -> Value {
    assert_eq!(resp.status(), status);
    let body = body_json(resp).await;
    assert_eq!(body["code"], code, "{body}");
    assert!(body["message"].is_string(), "{body}");
    assert!(body["details"].is_object(), "{body}");
    assert_eq!(body.as_object().unwrap().len(), 3, "{body}");
    body
}

#[tokio::test]
async fn operator_lists_workspaces_and_activates_one() {
    let p = Panel::new().await;
    let (tenant, ws) = p.register("Owner@Alpha.example", "Alpha Ajans").await;
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "pending_payment");

    // Login sets the operator cookie, with the session cookie's flags and a 12-hour life; the
    // token travels only in the cookie.
    let (set, body) = p.operator_login().await;
    let (pair, attributes) = set.split_once(';').unwrap();
    let token = pair.strip_prefix("jt_platform=").unwrap();
    assert!(token.len() >= 43, "32 random bytes, base64url: {token}");
    assert_eq!(
        attributes,
        " HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"
    );
    assert!(body["expires_at"].is_string(), "{body}");
    assert!(!body.to_string().contains(token), "{body}");
    let operator = cookie_pair(&set);

    // The list shows the new workspace with its owner and members.
    let listed = ok_json(p.get("/api/platform/workspaces", &operator).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    let alpha = &listed[0];
    assert_eq!(alpha["id"], json!(ws));
    assert_eq!(alpha["name"], "Alpha Ajans");
    assert_eq!(alpha["status"], "pending_payment");
    assert_eq!(alpha["owner_email"], "owner@alpha.example");
    assert_eq!(alpha["member_count"], 1);
    assert!(alpha["slug"].as_str().unwrap().starts_with("alpha-ajans-"));
    assert!(alpha["created_at"].is_string());

    // Activation answers with the changed workspace.
    let activated = ok_json(
        p.set_status(&ws.to_string(), &operator, json!({ "status": "active" }))
            .await,
    )
    .await;
    assert_eq!(activated["id"], json!(ws));
    assert_eq!(activated["status"], "active");
    assert_eq!(activated["owner_email"], "owner@alpha.example");
    assert_eq!(activated["member_count"], 1);

    // The tenant sees the workspace active, and its ledger records who changed it.
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "active");
    let entries = ok_json(p.get("/api/ledger?action_prefix=platform.", &tenant).await).await;
    assert_eq!(entries.as_array().unwrap().len(), 1, "{entries}");
    let entry = &entries[0]["entry"];
    assert_eq!(entry["action"], "platform.workspace_status");
    assert_eq!(
        entry["payload"],
        json!({ "from": "pending_payment", "to": "active" })
    );
    assert_eq!(entry["actor"]["kind"], "system", "{entry}");
    assert!(
        entry["actor"]["component"]
            .as_str()
            .unwrap()
            .starts_with("platform_operator:"),
        "{entry}"
    );

    // Bad input is structured: an unknown status, a malformed id, an unknown workspace.
    expect_error(
        p.set_status(&ws.to_string(), &operator, json!({ "status": "deleted" }))
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    expect_error(
        p.set_status("not-a-uuid", &operator, json!({ "status": "active" }))
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    expect_error(
        p.set_status(
            &WorkspaceId::new_v7().to_string(),
            &operator,
            json!({ "status": "active" }),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;

    // A wrong operator password is the same 401 as an unknown email, and sets no cookie.
    for (email, password) in [
        (OPERATOR_EMAIL, "wrong passphrase"),
        ("nobody@jeeta.test", OPERATOR_PASSWORD),
    ] {
        let resp = p
            .send(request(
                Method::POST,
                "/api/platform/login",
                None,
                true,
                Some(json!({ "email": email, "password": password })),
            ))
            .await;
        assert!(resp.headers().get(header::SET_COOKIE).is_none());
        let refused = expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
        assert_eq!(refused["message"], "invalid credentials");
    }
}

#[tokio::test]
async fn tenant_session_cannot_call_platform_routes_401() {
    let p = Panel::new().await;
    let (tenant, ws) = p.register("owner@alpha.example", "Alpha").await;
    let tenant_token = tenant.strip_prefix("jt_session=").unwrap();
    let ws = ws.to_string();

    // No cookie, the tenant's own cookie, and the tenant's token under the operator cookie's
    // name: none is an operator session.
    let impostor = format!("jt_platform={tenant_token}");
    for cookie in ["", tenant.as_str(), impostor.as_str()] {
        expect_error(
            p.get("/api/platform/workspaces", cookie).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
        expect_error(
            p.set_status(&ws, cookie, json!({ "status": "active" }))
                .await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "pending_payment", "nothing changed");

    // Nor does an operator session open the tenant routes.
    let (set, _) = p.operator_login().await;
    let operator = cookie_pair(&set);
    let operator_token = operator.strip_prefix("jt_platform=").unwrap();
    for cookie in [operator.clone(), format!("jt_session={operator_token}")] {
        expect_error(
            p.get("/api/workspace", &cookie).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}

#[tokio::test]
async fn platform_login_requires_header_403() {
    let p = Panel::new().await;
    let (tenant, ws) = p.register("owner@alpha.example", "Alpha").await;

    let resp = p
        .send(request(
            Method::POST,
            "/api/platform/login",
            None,
            false,
            Some(json!({ "email": OPERATOR_EMAIL, "password": OPERATOR_PASSWORD })),
        ))
        .await;
    assert!(resp.headers().get(header::SET_COOKIE).is_none());
    let refused = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(refused["message"], "missing request header");

    // A signed-in operator still needs the header to change a workspace.
    let (set, _) = p.operator_login().await;
    let operator = cookie_pair(&set);
    let path = format!("/api/platform/workspaces/{ws}/status");
    let resp = p
        .send(request(
            Method::PATCH,
            &path,
            Some(&operator),
            false,
            Some(json!({ "status": "active" })),
        ))
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "pending_payment", "nothing changed");

    // Reading needs no header.
    let listed = ok_json(p.get("/api/platform/workspaces", &operator).await).await;
    assert_eq!(listed[0]["status"], "pending_payment");
}
