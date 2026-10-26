//! The platform console's routes end to end through Postgres: operator login and its
//! `jt_platform` cookie, explicit suspension/resumption, and the separation between
//! operator and tenant sessions.

use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use jt_app::usecases::platform;
use jt_tenancy::WorkspaceId;
use jt_testkit::flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD};
use jt_testkit::panel::{
    Panel, body_json, cookie_pair, expect_error, ok_json, request, set_cookie, workspace_of,
};
use serde_json::{Value, json};

/// The shared harness with one bootstrapped operator.
async fn panel() -> Panel {
    let p = Panel::new().await;
    assert!(
        platform::bootstrap(&p.deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
            .await
            .unwrap()
    );
    p
}

/// The operator console's routes, on the shared harness.
trait Console {
    /// Registers a tenant owner with a new workspace, left awaiting payment; returns the
    /// `jt_session=…` pair and the workspace.
    async fn register_tenant(&self, email: &str, workspace_name: &str) -> (String, WorkspaceId);
    /// Logs the operator in; returns the full `Set-Cookie` value and the response body.
    async fn operator_login(&self) -> (String, Value);
    /// `POST /api/platform/workspaces/{ws}/suspend` as `cookie`.
    async fn suspend(&self, ws: &str, cookie: &str, body: Value) -> Response;
}

impl Console for Panel {
    async fn register_tenant(&self, email: &str, workspace_name: &str) -> (String, WorkspaceId) {
        let (cookie, me) = self.register_pending(email, workspace_name).await;
        (cookie, workspace_of(&me))
    }

    async fn operator_login(&self) -> (String, Value) {
        let resp = self
            .send(
                Method::POST,
                "/api/platform/login",
                None,
                Some(json!({ "email": OPERATOR_EMAIL, "password": OPERATOR_PASSWORD })),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cookie = set_cookie(&resp);
        (cookie, body_json(resp).await)
    }

    async fn suspend(&self, ws: &str, cookie: &str, body: Value) -> Response {
        let path = format!("/api/platform/workspaces/{ws}/suspend");
        self.send(Method::POST, &path, Some(cookie), Some(body))
            .await
    }
}

#[tokio::test]
async fn operator_lists_workspaces_and_suspends_one() {
    let p = panel().await;
    let (tenant, ws) = p
        .register_tenant("Owner@Alpha.example", "Alpha Ajans")
        .await;
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

    jt_testkit::flows::activate_workspace(&p.deps, ws).await;
    // Explicit suspension answers with the changed workspace.
    let suspended = ok_json(
        p.suspend(
            &ws.to_string(),
            &operator,
            json!({ "reason": "operator hold" }),
        )
        .await,
    )
    .await;
    assert_eq!(suspended["id"], json!(ws));
    assert_eq!(suspended["status"], "suspended");
    assert_eq!(suspended["owner_email"], "owner@alpha.example");
    assert_eq!(suspended["member_count"], 1);

    // The tenant sees suspension. Resume before reading the status-gated ledger.
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "suspended");
    let resumed = ok_json(
        p.send(
            Method::POST,
            &format!("/api/platform/workspaces/{ws}/resume"),
            Some(&operator),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(resumed["status"], "active");
    let entries = ok_json(p.get("/api/ledger?action_prefix=platform.", &tenant).await).await;
    assert_eq!(entries.as_array().unwrap().len(), 3, "{entries}");
    let entry = &entries[1]["entry"];
    assert_eq!(entry["action"], "platform.workspace_status");
    assert_eq!(
        entry["payload"],
        json!({ "from": "active", "to": "suspended", "reason":"operator hold", "by":entry["actor"] })
    );
    assert_eq!(entry["actor"]["kind"], "system", "{entry}");
    assert!(
        entry["actor"]["component"]
            .as_str()
            .unwrap()
            .starts_with("platform_operator:"),
        "{entry}"
    );

    // Bad input is structured: a blank reason, a malformed id, an unknown workspace.
    expect_error(
        p.suspend(&ws.to_string(), &operator, json!({ "reason": " " }))
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    expect_error(
        p.suspend(
            "not-a-uuid",
            &operator,
            json!({ "reason": "operator hold" }),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    expect_error(
        p.suspend(
            &WorkspaceId::new_v7().to_string(),
            &operator,
            json!({ "reason": "operator hold" }),
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
            .call(request(
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
    let p = panel().await;
    let (tenant, ws) = p.register_tenant("owner@alpha.example", "Alpha").await;
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
            p.suspend(&ws, cookie, json!({ "reason": "operator hold" }))
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
    let p = panel().await;
    let (tenant, ws) = p.register_tenant("owner@alpha.example", "Alpha").await;

    let resp = p
        .call(request(
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
    let path = format!("/api/platform/workspaces/{ws}/suspend");
    let resp = p
        .call(request(
            Method::POST,
            &path,
            Some(&operator),
            false,
            Some(json!({ "reason": "operator hold" })),
        ))
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let info = ok_json(p.get("/api/workspace", &tenant).await).await;
    assert_eq!(info["status"], "pending_payment", "nothing changed");

    // Reading needs no header.
    let listed = ok_json(p.get("/api/platform/workspaces", &operator).await).await;
    assert_eq!(listed[0]["status"], "pending_payment");
}
