//! The panel's HTTP surface in process: the full `jt_panel_http` router over a fresh test
//! database (no socket), with helpers to build requests and read responses. Shared by the HTTP
//! test suites of `jt_panel_http`.
//!
//! Requests go through `tower::ServiceExt::oneshot`; mutating requests sent with
//! [`Panel::send`] carry the panel's request header ([`REQUESTED_WITH`]), safe ones do not.

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::ports::PasswordHasher;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::capabilities::UowChannelCatalog;
use jt_app::usecases::strategy::NoopArchivedHook;
use jt_panel_http::{AppState, router};
use jt_pg::{PgStrategyGate, PgUnitOfWork};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::db::TestDb;
use crate::fakes::{PlainHasher, PlainSecretBox, RecordingTenantHosts};
use crate::flows::activate_workspace;

/// The password every account the harness opens uses.
pub const PASSWORD: &str = "correct horse battery";
/// The request header every mutating `/api` call must carry.
pub const REQUESTED_WITH: (&str, &str) = ("x-requested-with", "jeeta-panel");

/// The panel router over a fresh test database, and the ports behind it: the real Postgres unit
/// of work, clock, ids, tokens, channel catalog and strategy gate (as the binary serves them),
/// with a plain-text hasher (unless asked otherwise), a plain-text secret box and a tenant host
/// registry that records. No strategy is approved anywhere until a test approves one.
pub struct Panel {
    pub app: Router,
    pub deps: Deps,
    pub uow: PgUnitOfWork,
    /// Declared last, so the database is dropped after everything that holds its pool.
    pub db: TestDb,
}

impl Panel {
    /// Plain hashing, no `Secure` cookie, no static panel.
    pub async fn new() -> Panel {
        Panel::with(Arc::new(PlainHasher), false, None).await
    }

    /// The router with this password hasher, `Secure` cookies when `cookie_secure`, and the
    /// static panel from `panel_dir`.
    pub async fn with(
        hasher: Arc<dyn PasswordHasher>,
        cookie_secure: bool,
        panel_dir: Option<PathBuf>,
    ) -> Panel {
        let db = TestDb::new().await;
        let uow = PgUnitOfWork::new(db.pool.clone());
        let shared: Arc<PgUnitOfWork> = Arc::new(uow.clone());
        let deps = Deps {
            uow: shared.clone(),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7Gen),
            tokens: Arc::new(RandTokenGen),
            hasher,
            seal: Arc::new(PlainSecretBox),
            channels: Arc::new(UowChannelCatalog::new(shared)),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
        };
        let state = AppState {
            deps: deps.clone(),
            gate: Arc::new(PgStrategyGate::new(db.pool.clone())),
            cookie_secure,
            panel_dir,
        };
        Panel {
            app: router(state),
            deps,
            uow,
            db,
        }
    }

    /// Sends a request as built.
    pub async fn call(&self, req: Request<Body>) -> Response {
        self.app.clone().oneshot(req).await.unwrap()
    }

    /// Sends `method path` with an optional cookie and JSON body; a method that is not safe
    /// carries the request header.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let requested_with = !method.is_safe();
        self.call(request(method, path, cookie, requested_with, body))
            .await
    }

    /// `GET path` with `cookie`.
    pub async fn get(&self, path: &str, cookie: &str) -> Response {
        self.send(Method::GET, path, Some(cookie), None).await
    }

    /// Registers `email` (display name "Owner") with a new workspace named `workspace_name`,
    /// left awaiting payment; returns the `jt_session=…` pair and `me` as registration answered.
    pub async fn register_pending(&self, email: &str, workspace_name: &str) -> (String, Value) {
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
        let cookie = session_pair(&resp);
        (cookie, body_json(resp).await)
    }

    /// [`Panel::register_pending`], then the platform operator activates the workspace.
    pub async fn register(&self, email: &str, workspace_name: &str) -> (String, Value) {
        let (cookie, me) = self.register_pending(email, workspace_name).await;
        activate_workspace(&self.deps, workspace_of(&me)).await;
        (cookie, me)
    }

    /// Invites `email` as `role_key` from the session `cookie`; returns the invitation.
    pub async fn invite(&self, cookie: &str, email: &str, role_key: &str) -> Value {
        let resp = self
            .send(
                Method::POST,
                "/api/team/invites",
                Some(cookie),
                Some(json!({ "email": email, "role_key": role_key })),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::CREATED);
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        body_json(resp).await
    }

    /// Accepts `token` as a new user named `name`; returns their `jt_session=…` pair and the
    /// answer.
    pub async fn accept_as_new_user(&self, token: &str, name: &str) -> (String, Value) {
        let resp = self
            .send(
                Method::POST,
                "/api/team/invites/accept",
                None,
                Some(json!({ "token": token, "password": PASSWORD, "display_name": name })),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cookie = session_pair(&resp);
        (cookie, body_json(resp).await)
    }

    /// Invites `email` as `role_key` from `owner_cookie` and accepts as a new user; returns the
    /// new user's `jt_session=…` pair and membership id.
    pub async fn join(&self, owner_cookie: &str, email: &str, role_key: &str) -> (String, String) {
        let invite = self.invite(owner_cookie, email, role_key).await;
        let (cookie, accepted) = self
            .accept_as_new_user(invite["invite_token"].as_str().unwrap(), email)
            .await;
        (
            cookie,
            accepted["membership_id"].as_str().unwrap().to_owned(),
        )
    }
}

/// The current workspace of a `me` answer.
pub fn workspace_of(me: &Value) -> WorkspaceId {
    me["current_workspace"]
        .as_str()
        .expect("`me` has a current workspace")
        .parse()
        .unwrap()
}

/// A request with an optional cookie, the request header when `requested_with`, and an optional
/// JSON body.
pub fn request(
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
pub fn set_cookie(resp: &Response) -> String {
    let all: Vec<_> = resp.headers().get_all(header::SET_COOKIE).iter().collect();
    assert_eq!(all.len(), 1, "exactly one Set-Cookie header");
    all[0].to_str().unwrap().to_owned()
}

/// The `name=value` part of a `Set-Cookie` header.
pub fn cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().trim().to_owned()
}

/// The `jt_session=…` pair of the response's single `Set-Cookie` header.
pub fn session_pair(resp: &Response) -> String {
    let pair = cookie_pair(&set_cookie(resp));
    assert!(pair.starts_with("jt_session="), "{pair}");
    pair
}

/// The body as UTF-8 text.
pub async fn body_text(resp: Response) -> String {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// The JSON body, which must be labelled `application/json`.
pub async fn body_json(resp: Response) -> Value {
    assert_eq!(
        resp.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    serde_json::from_str(&body_text(resp).await).unwrap()
}

/// The JSON body of a `2xx` response.
pub async fn ok_json(resp: Response) -> Value {
    assert!(resp.status().is_success(), "{}", resp.status());
    body_json(resp).await
}

/// Asserts a structured error, `{code, message, details}` and nothing else, with this status and
/// code, and returns its body.
pub async fn expect_error(resp: Response, status: StatusCode, code: &str) -> Value {
    assert_eq!(resp.status(), status);
    let body = body_json(resp).await;
    assert_eq!(body["code"], code, "{body}");
    assert!(body["message"].is_string(), "{body}");
    assert!(body["details"].is_object(), "{body}");
    assert_eq!(body.as_object().unwrap().len(), 3, "{body}");
    body
}
