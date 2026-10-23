//! The panel's HTTP surface end to end through Postgres: the session cookie, the request-header
//! check, structured errors, the auth and workspace routes, `/healthz` and the static panel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::ports::{Clock, UnitOfWork};
use jt_app::std_impls::{Argon2Hasher, SystemClock};
use jt_tenancy::{MembershipId, UserId, WorkspaceId};
use jt_testkit::fakes::PlainHasher;
use jt_testkit::panel::{
    PASSWORD, Panel, REQUESTED_WITH, body_json, body_text, cookie_pair, expect_error, set_cookie,
};
use serde_json::{Value, json};

const ALL_PERMISSIONS: [&str; 8] = [
    "workspace.read",
    "team.manage",
    "api_keys.manage",
    "ledger.read",
    "capabilities.manage",
    "budget.manage",
    "inbox.work",
    "inbox.manage",
];

fn register_body(email: &str, workspace_name: &str) -> Value {
    json!({
        "email": email,
        "password": PASSWORD,
        "display_name": "Owner",
        "workspace_name": workspace_name,
    })
}

/// A mutating request with the request header, a JSON body and, optionally, a cookie.
fn post(path: &str, cookie: Option<&str>, body: Value) -> Request<Body> {
    request(
        Method::POST,
        path,
        cookie,
        Some(REQUESTED_WITH),
        body.to_string(),
    )
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    request(Method::GET, path, cookie, None, String::new())
}

fn request(
    method: Method,
    path: &str,
    cookie: Option<&str>,
    requested_with: Option<(&str, &str)>,
    body: String,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if !body.is_empty() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    if let Some((name, value)) = requested_with {
        builder = builder.header(name, value);
    }
    builder.body(Body::from(body)).unwrap()
}

fn cache_control(resp: &Response) -> &str {
    resp.headers()
        .get(header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap())
        .unwrap_or("")
}

/// A fresh, empty directory under Cargo's per-target temporary directory.
fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("{label}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn register_sets_httponly_samesite_strict_cookie_and_returns_me() {
    let p = Panel::new().await;
    let resp = p
        .call(post(
            "/api/auth/register",
            None,
            register_body("Owner@Alpha.example", "Alpha Ajans"),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let header = set_cookie(&resp);
    let token = cookie_pair(&header)
        .strip_prefix("jt_session=")
        .expect("the session cookie is jt_session")
        .to_owned();
    assert_eq!(token.len(), 43, "32 random bytes, base64url");
    assert_eq!(
        header,
        format!("jt_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000")
    );

    let text = body_text(resp).await;
    assert!(
        !text.contains(&token),
        "the token travels only in the cookie"
    );
    let me: Value = serde_json::from_str(&text).unwrap();
    assert!(me.get("token").is_none());
    assert_eq!(me["email"], "owner@alpha.example");
    assert_eq!(me["display_name"], "Owner");
    let ws = &me["memberships"][0];
    assert_eq!(me["current_workspace"], ws["workspace_id"]);
    assert_eq!(ws["workspace_name"], "Alpha Ajans");
    assert_eq!(ws["workspace_status"], "pending_payment");
    assert_eq!(ws["role_key"], "owner");
    assert_eq!(ws["permissions"], json!(ALL_PERMISSIONS));

    // The cookie signs the user in.
    let resp = p
        .call(get("/api/auth/me", Some(&format!("jt_session={token}"))))
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await, me);

    // Behind TLS the cookie is also `Secure`.
    let secure = Panel::with(Arc::new(PlainHasher), true, None).await;
    let resp = secure
        .call(post(
            "/api/auth/register",
            None,
            register_body("owner@beta.example", "Beta"),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let header = set_cookie(&resp);
    assert_eq!(
        header,
        format!(
            "{}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure",
            cookie_pair(&header)
        )
    );
}

#[tokio::test]
async fn login_then_me_round_trip() {
    // The production hasher, so hashing and verification run off the reactor threads.
    let p = Panel::with(Arc::new(Argon2Hasher::default()), false, None).await;
    let (register_cookie, registered) = p.register_pending("owner@alpha.example", "Alpha").await;

    // A wrong password and an unknown email get the same answer.
    for (email, password) in [
        ("owner@alpha.example", "wrong horse battery"),
        ("nobody@alpha.example", PASSWORD),
    ] {
        let resp = p
            .call(post(
                "/api/auth/login",
                None,
                json!({ "email": email, "password": password }),
            ))
            .await;
        assert!(resp.headers().get(header::SET_COOKIE).is_none());
        let body = expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
        assert_eq!(body["message"], "invalid credentials");
    }

    let resp = p
        .call(post(
            "/api/auth/login",
            None,
            json!({ "email": "OWNER@alpha.example", "password": PASSWORD }),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let login_cookie = cookie_pair(&set_cookie(&resp));
    assert!(login_cookie.starts_with("jt_session="));
    assert_ne!(
        login_cookie, register_cookie,
        "every login opens a new session"
    );
    let logged_in = body_json(resp).await;
    assert_eq!(logged_in["user_id"], registered["user_id"]);
    assert_eq!(
        logged_in["current_workspace"],
        registered["current_workspace"]
    );

    let resp = p.call(get("/api/auth/me", Some(&login_cookie))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await, logged_in);
}

#[tokio::test]
async fn logout_revokes_the_session_and_clears_the_cookie() {
    let p = Panel::new().await;
    let (cookie, _) = p.register_pending("owner@alpha.example", "Alpha").await;

    let resp = p
        .call(post("/api/auth/logout", Some(&cookie), json!({})))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        set_cookie(&resp),
        "jt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    );
    let resp = p.call(get("/api/auth/me", Some(&cookie))).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;

    // Logging out without a session, or again, still succeeds and clears the cookie.
    for cookie in [None, Some(cookie.as_str())] {
        let resp = p.call(post("/api/auth/logout", cookie, json!({}))).await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(set_cookie(&resp).starts_with("jt_session=; "));
    }
}

#[tokio::test]
async fn post_without_requested_with_header_is_403() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@alpha.example", "Alpha").await;
    let ws = me["current_workspace"].clone();
    let missing = json!({
        "code": "FORBIDDEN",
        "message": "missing request header",
        "details": {},
    });

    // A valid cookie and a valid body do not make up for the missing or wrong header.
    for requested_with in [None, Some(("x-requested-with", "XMLHttpRequest"))] {
        let resp = p
            .call(request(
                Method::POST,
                "/api/auth/switch-workspace",
                Some(&cookie),
                requested_with,
                json!({ "workspace_id": ws }).to_string(),
            ))
            .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(resp).await, missing);
    }

    // Logging out is refused too, and the session stays alive.
    let resp = p
        .call(request(
            Method::POST,
            "/api/auth/logout",
            Some(&cookie),
            None,
            "{}".into(),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert!(resp.headers().get(header::SET_COOKIE).is_none());
    let resp = p.call(get("/api/auth/me", Some(&cookie))).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // The header is checked before the body is parsed and before authentication.
    let resp = p
        .call(request(
            Method::POST,
            "/api/auth/register",
            None,
            None,
            "{".into(),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await, missing);
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        for path in ["/api/workspace", "/api/auth/me", "/api/nothing"] {
            let resp = p
                .call(request(method.clone(), path, None, None, String::new()))
                .await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "{method} {path}");
            assert_eq!(body_json(resp).await, missing);
        }
    }

    // A refused registration stores nothing.
    let resp = p
        .call(request(
            Method::POST,
            "/api/auth/register",
            None,
            None,
            register_body("refused@alpha.example", "Refused").to_string(),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let resp = p
        .call(post(
            "/api/auth/login",
            None,
            json!({ "email": "refused@alpha.example", "password": PASSWORD }),
        ))
        .await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}

#[tokio::test]
async fn me_without_cookie_is_401_structured_error() {
    let p = Panel::new().await;
    let resp = p.call(get("/api/auth/me", None)).await;
    let body = expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    assert_eq!(body["details"], json!({}));

    for cookie in [
        "jt_session=",
        "jt_session=not-a-session",
        "other=1; jt_session=forged",
    ] {
        let resp = p.call(get("/api/auth/me", Some(cookie))).await;
        expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    }
    let resp = p.call(get("/api/workspace", None)).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    let resp = p
        .call(post(
            "/api/auth/switch-workspace",
            None,
            json!({ "workspace_id": WorkspaceId::new_v7() }),
        ))
        .await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}

#[tokio::test]
async fn bad_bodies_and_refusals_are_structured_errors() {
    let p = Panel::new().await;
    p.register_pending("owner@alpha.example", "Alpha").await;

    // Malformed JSON, a wrong type, a missing field and a missing content type.
    for (body, content_type) in [
        ("{", true),
        (r#"{"email": 5, "password": "x"}"#, true),
        (r#"{"email": "a@b.example"}"#, true),
        (
            &register_body("new@alpha.example", "New").to_string(),
            false,
        ),
    ] {
        let mut req = request(
            Method::POST,
            "/api/auth/register",
            None,
            Some(REQUESTED_WITH),
            body.to_owned(),
        );
        if !content_type {
            req.headers_mut().remove(header::CONTENT_TYPE);
        }
        expect_error(
            p.call(req).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        )
        .await;
    }

    // A rule of the use case.
    let resp = p
        .call(post(
            "/api/auth/register",
            None,
            json!({
                "email": "short@alpha.example",
                "password": "short",
                "display_name": "Short",
                "workspace_name": "Short",
            }),
        ))
        .await;
    let body = expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    assert_eq!(body["details"], json!({ "field": "password" }));

    // A taken email.
    let resp = p
        .call(post(
            "/api/auth/register",
            None,
            register_body("OWNER@alpha.example", "Again"),
        ))
        .await;
    expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;

    // Unknown routes and methods under `/api` are JSON, never the panel.
    for req in [
        get("/api/nothing", None),
        get("/api", None),
        get("/api/auth/register", None),
        post("/api/auth/me", None, json!({})),
    ] {
        expect_error(p.call(req).await, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    }
}

#[tokio::test]
async fn switch_workspace_moves_the_session_and_workspace_info_follows() {
    let p = Panel::new().await;
    let (cookie, me) = p
        .register_pending("owner@alpha.example", "Alpha Ajans")
        .await;
    let ws_a = me["current_workspace"].clone();

    let resp = p.call(get("/api/workspace", Some(&cookie))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let info = body_json(resp).await;
    assert_eq!(info["id"], ws_a);
    assert_eq!(info["name"], "Alpha Ajans");
    assert!(info["slug"].as_str().unwrap().starts_with("alpha-ajans-"));
    assert_eq!(info["status"], "pending_payment");
    assert_eq!(info["my_role"], "owner");
    assert_eq!(info["my_permissions"], json!(ALL_PERMISSIONS));

    // The user also joins another (active) workspace as a rep.
    let (ws_b, _) = p.db.seed_workspace("beta").await;
    let user_id: UserId = serde_json::from_value(me["user_id"].clone()).unwrap();
    let rep = {
        let mut t = p.uow.tenant(ws_b).await.unwrap();
        t.roles().find_by_key("rep").await.unwrap().unwrap()
    };
    let mut u = p.uow.user().await.unwrap();
    u.memberships_insert_active(
        MembershipId::new_v7(),
        ws_b,
        user_id,
        rep.id,
        SystemClock.now(),
    )
    .await
    .unwrap();
    u.commit().await.unwrap();

    let resp = p
        .call(post(
            "/api/auth/switch-workspace",
            Some(&cookie),
            json!({ "workspace_id": ws_b }),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let switched = body_json(resp).await;
    assert_eq!(switched["current_workspace"], json!(ws_b));
    assert_eq!(switched["memberships"].as_array().unwrap().len(), 2);

    let resp = p.call(get("/api/workspace", Some(&cookie))).await;
    let info = body_json(resp).await;
    assert_eq!(info["id"], json!(ws_b));
    assert_eq!(info["status"], "active");
    assert_eq!(info["my_role"], "rep");
    assert_eq!(
        info["my_permissions"],
        json!(["workspace.read", "inbox.work"])
    );
    let resp = p.call(get("/api/auth/me", Some(&cookie))).await;
    assert_eq!(body_json(resp).await["current_workspace"], json!(ws_b));

    // A workspace the user does not belong to, and a malformed id.
    let (ws_c, _) = p.db.seed_workspace("gamma").await;
    let resp = p
        .call(post(
            "/api/auth/switch-workspace",
            Some(&cookie),
            json!({ "workspace_id": ws_c }),
        ))
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = p
        .call(post(
            "/api/auth/switch-workspace",
            Some(&cookie),
            json!({ "workspace_id": "not-a-uuid" }),
        ))
        .await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
}

#[tokio::test]
async fn workspace_routes_need_a_current_workspace() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@alpha.example", "Alpha").await;
    let ws: WorkspaceId = serde_json::from_value(me["current_workspace"].clone()).unwrap();
    let membership: MembershipId =
        serde_json::from_value(me["memberships"][0]["membership_id"].clone()).unwrap();

    // Once the user is no longer a member anywhere, the session has no current workspace.
    let mut t = p.uow.tenant(ws).await.unwrap();
    t.memberships().remove(membership).await.unwrap();
    t.commit().await.unwrap();

    let resp = p.call(get("/api/auth/me", Some(&cookie))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["current_workspace"], Value::Null);
    let resp = p.call(get("/api/workspace", Some(&cookie))).await;
    let body = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(body["message"], "no current workspace");
}

#[tokio::test]
async fn head_on_workspace_route_passes_the_gate() {
    let p = Panel::new().await;
    let (cookie, _) = p.register_pending("owner@alpha.example", "Alpha").await;

    // HEAD is answered by the GET handler and passes the same gate, with an empty body.
    for path in ["/api/workspace", "/api/auth/me"] {
        let resp = p
            .call(request(
                Method::HEAD,
                path,
                Some(&cookie),
                None,
                String::new(),
            ))
            .await;
        assert_eq!(resp.status(), StatusCode::OK, "HEAD {path}");
        assert_eq!(body_text(resp).await, "", "HEAD {path}");
    }
    let resp = p
        .call(request(
            Method::HEAD,
            "/api/workspace",
            None,
            None,
            String::new(),
        ))
        .await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn healthz_ok() {
    let p = Panel::new().await;
    let resp = p.call(get("/healthz", None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await, json!({ "ok": true }));
}

#[tokio::test]
async fn static_index_served_when_panel_dir_set() {
    let dir = temp_dir("panel");
    let index = "<!doctype html><title>Jeeta</title><div id=root></div>";
    std::fs::write(dir.join("index.html"), index).unwrap();
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets/app.js"), "console.log('jeeta');").unwrap();
    let p = Panel::with(Arc::new(PlainHasher), false, Some(dir.clone())).await;

    // Panel pages fall back to `index.html`, which is always revalidated.
    for path in ["/", "/team", "/team/invites", "/index.html"] {
        let resp = p.call(get(path, None)).await;
        assert_eq!(resp.status(), StatusCode::OK, "{path}");
        assert_eq!(cache_control(&resp), "no-cache", "{path}");
        assert_eq!(body_text(resp).await, index, "{path}");
    }

    // Hashed assets are cached for good; a missing one is a 404, not the index.
    let resp = p.call(get("/assets/app.js", None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(cache_control(&resp), "public, max-age=31536000, immutable");
    assert_eq!(body_text(resp).await, "console.log('jeeta');");
    let resp = p.call(get("/assets/missing.js", None)).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(cache_control(&resp), "");

    // API, MCP and health paths never fall back to the panel.
    for path in ["/api/nothing", "/api", "/mcp", "/healthz/extra"] {
        let resp = p.call(get(path, None)).await;
        expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    }
    let resp = p.call(get("/healthz", None)).await;
    assert_eq!(body_json(resp).await, json!({ "ok": true }));

    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let dir = temp_dir("panel-headers");
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>Jeeta</title>",
    )
    .unwrap();
    let p = Panel::with(Arc::new(PlainHasher), false, Some(dir.clone())).await;
    let assert_headers = |resp: &Response, what: &str| {
        for (name, value) in jt_panel_http::headers::SECURITY_HEADERS {
            let all: Vec<_> = resp.headers().get_all(*name).iter().collect();
            assert_eq!(all, [*value], "{name} on {what}");
        }
    };

    // The panel page and the signed-out `me`, then a signed-in one.
    let resp = p.call(get("/", None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_headers(&resp, "/");
    let resp = p.call(get("/api/auth/me", None)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_headers(&resp, "/api/auth/me signed out");
    let resp = p
        .call(post(
            "/api/auth/register",
            None,
            register_body("owner@alpha.example", "Alpha"),
        ))
        .await;
    assert_headers(&resp, "/api/auth/register");
    let cookie = cookie_pair(&set_cookie(&resp));
    let resp = p.call(get("/api/auth/me", Some(&cookie))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_headers(&resp, "/api/auth/me signed in");

    // Health, unknown paths, a refused request without the panel header.
    for path in ["/healthz", "/api/nothing", "/assets/missing.js"] {
        let resp = p.call(get(path, None)).await;
        assert_headers(&resp, path);
    }
    let resp = p
        .call(
            Request::post("/api/auth/logout")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_headers(&resp, "a refused POST");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn without_panel_dir_everything_else_is_404_json() {
    let p = Panel::new().await;
    for path in ["/", "/team", "/assets/app.js", "/api/nothing"] {
        let resp = p.call(get(path, None)).await;
        expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    }
}
