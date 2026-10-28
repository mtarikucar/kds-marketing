//! The API-key and agent routes end to end through Postgres: issuing a key (its plaintext shown
//! once), listing and revoking keys, who may manage them, and the agent connections a key makes.

use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use jt_app::error::ErrorCode;
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys;
use jt_testkit::flows::activate_workspace;
use jt_testkit::panel::{
    PASSWORD, Panel, body_text, expect_error, ok_json, session_pair, workspace_of,
};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

/// The API-key routes, on the shared harness.
trait KeyRoutes {
    /// `POST /api/api-keys` as `cookie`.
    async fn create_key(&self, cookie: &str, body: Value) -> Response;
    /// `DELETE /api/api-keys/{id}` as `cookie`.
    async fn revoke(&self, cookie: &str, id: &str) -> Response;
}

impl KeyRoutes for Panel {
    async fn create_key(&self, cookie: &str, body: Value) -> Response {
        self.send(Method::POST, "/api/api-keys", Some(cookie), Some(body))
            .await
    }

    async fn revoke(&self, cookie: &str, id: &str) -> Response {
        self.send(
            Method::DELETE,
            &format!("/api/api-keys/{id}"),
            Some(cookie),
            None,
        )
        .await
    }
}

/// The RFC 3339 timestamp in `value`.
fn instant(value: &Value) -> OffsetDateTime {
    OffsetDateTime::parse(value.as_str().unwrap(), &Rfc3339).unwrap()
}

#[tokio::test]
async fn a_workspace_awaiting_payment_mints_no_keys_and_invites_no_one_until_activated() {
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("owner@alpha.example", "Alpha").await;
    let ws = workspace_of(&me);

    let resp = p.create_key(&owner, json!({ "name": "CI bot" })).await;
    let body = expect_error(resp, StatusCode::LOCKED, "WORKSPACE_INACTIVE").await;
    assert_eq!(body["details"], json!({ "status": "pending_payment" }));
    let invite = json!({ "email": "bob@example.com", "role_key": "rep" });
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites",
            Some(&owner),
            Some(invite.clone()),
        )
        .await;
    expect_error(resp, StatusCode::LOCKED, "WORKSPACE_INACTIVE").await;
    // The workspace itself, and who is signed in, can still be read.
    let info = ok_json(p.get("/api/workspace", &owner).await).await;
    assert_eq!(info["status"], "pending_payment");
    assert_eq!(p.get("/api/auth/me", &owner).await.status(), StatusCode::OK);

    // The operator activates it; the same session now may do both.
    activate_workspace(&p.deps, ws).await;
    let resp = p.create_key(&owner, json!({ "name": "CI bot" })).await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites",
            Some(&owner),
            Some(invite),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn create_list_revoke_round_trip() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;

    // Created: the plaintext is in the body, once, and must not be cached.
    let resp = p
        .create_key(
            &owner,
            json!({ "name": "CI bot", "scopes": ["workspace.read", "team.manage"] }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    assert_eq!(
        resp.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let key = ok_json(resp).await;
    let plaintext = key["plaintext"].as_str().unwrap().to_owned();
    assert!(plaintext.starts_with("jt_live_"), "{plaintext}");
    assert_eq!(
        plaintext.len(),
        "jt_live_".len() + 43,
        "32 random bytes, base64url"
    );
    assert_eq!(key["prefix"], plaintext[..12]);
    assert_eq!(key["name"], "CI bot");
    assert_eq!(key["scopes"], json!(["workspace.read", "team.manage"]));
    assert!(key["created_at"].is_string());
    assert!(key.get("key_hash").is_none(), "{key}");
    let id = key["id"].as_str().unwrap().to_owned();

    // Listed without the plaintext or its hash.
    let resp = p.get("/api/api-keys", &owner).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body_text(resp).await;
    assert!(!text.contains(&plaintext[8..]), "{text}");
    assert!(
        !text.contains("plaintext") && !text.contains("key_hash"),
        "{text}"
    );
    let listed: Value = serde_json::from_str(&text).unwrap();
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], json!(id));
    assert_eq!(listed[0]["name"], "CI bot");
    assert_eq!(listed[0]["prefix"], key["prefix"]);
    assert_eq!(listed[0]["scopes"], key["scopes"]);
    assert_eq!(listed[0]["status"], "active");
    assert!(listed[0]["issued_by"].is_string());
    // Postgres keeps microseconds; the answer to the create carried the clock's full precision.
    let gap = instant(&listed[0]["created_at"]) - instant(&key["created_at"]);
    assert!(gap.abs() < Duration::microseconds(1), "{gap}");
    assert_eq!(listed[0]["last_used_at"], Value::Null);
    assert_eq!(listed[0]["revoked_at"], Value::Null);

    // Revoked once; a second revocation clashes; an unknown key is not found.
    let resp = p.revoke(&owner, &id).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert!(body_text(resp).await.is_empty());
    expect_error(
        p.revoke(&owner, &id).await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    expect_error(
        p.revoke(&owner, "0199f2c4-0000-7000-8000-000000000000")
            .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    expect_error(
        p.revoke(&owner, "not-a-uuid").await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    let listed = ok_json(p.get("/api/api-keys", &owner).await).await;
    assert_eq!(listed[0]["status"], "revoked");
    assert!(listed[0]["revoked_at"].is_string());
    let e = api_keys::authenticate(&p.deps, &plaintext)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Unauthenticated);
}

#[tokio::test]
async fn create_refuses_bad_input_with_structured_errors() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;

    let body = expect_error(
        p.create_key(&owner, json!({ "name": "  ", "scopes": [] }))
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"], json!({ "field": "name" }));
    let body = expect_error(
        p.create_key(&owner, json!({ "name": "Bot", "scopes": ["nope"] }))
            .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"], json!({ "unknown": ["nope"] }));
    expect_error(
        p.create_key(&owner, json!({ "scopes": [] })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    // Scopes may be left out: the key gets all of the issuer's permissions.
    let key = ok_json(p.create_key(&owner, json!({ "name": "Bot" })).await).await;
    assert_eq!(
        key["scopes"],
        json!([
            "workspace.read",
            "team.manage",
            "api_keys.manage",
            "ledger.read",
            "capabilities.manage",
            "budget.manage",
            "inbox.work",
            "inbox.manage",
            "studio.work",
            "studio.manage",
            "calls.work",
            "calls.manage",
            "calls.bridge",
        ])
    );
}

#[tokio::test]
async fn rep_cannot_manage_keys_403() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let key = ok_json(p.create_key(&owner, json!({ "name": "CI bot" })).await).await;
    let id = key["id"].as_str().unwrap().to_owned();
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;

    let refused = [
        p.create_key(
            &rep,
            json!({ "name": "Mine", "scopes": ["workspace.read"] }),
        )
        .await,
        p.get("/api/api-keys", &rep).await,
        p.revoke(&rep, &id).await,
    ];
    for resp in refused {
        let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(body["details"], json!({ "permission": "api_keys.manage" }));
    }
    let listed = ok_json(p.get("/api/api-keys", &owner).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["status"], "active");

    // Without a session nothing is shown at all.
    let resp = p.send(Method::GET, "/api/api-keys", None, None).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}

#[tokio::test]
async fn removed_members_key_is_unauthenticated_even_after_rejoin() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let email = "manager@alpha.example";
    let (manager, _) = p.join(&owner, email, "manager").await;
    let key = ok_json(
        p.create_key(&manager, json!({ "name": "Manager's bot" }))
            .await,
    )
    .await;
    let plaintext = key["plaintext"].as_str().unwrap();
    api_keys::authenticate(&p.deps, plaintext).await.unwrap();

    // The owner removes the manager: the key is revoked with the membership.
    let team = ok_json(p.get("/api/team", &owner).await).await;
    let membership = team
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == email)
        .unwrap()["membership_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{membership}"),
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let keys = ok_json(p.get("/api/api-keys", &owner).await).await;
    let listed = keys
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["id"] == key["id"])
        .unwrap()
        .clone();
    assert_eq!(listed["status"], "revoked");

    // Invited back, the same person signs in and accepts: a member again, with the same role.
    let invite = ok_json(
        p.send(
            Method::POST,
            "/api/team/invites",
            Some(&owner),
            Some(json!({ "email": email, "role_key": "manager" })),
        )
        .await,
    )
    .await;
    let resp = p
        .send(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let again = session_pair(&resp);
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites/accept",
            Some(&again),
            Some(json!({ "token": invite["invite_token"] })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // The old key stays dead: it does not come back with its issuer.
    let e = api_keys::authenticate(&p.deps, plaintext)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Unauthenticated);
    assert_eq!(e.message, "invalid api key");
}

#[tokio::test]
async fn a_key_authenticates_and_its_agent_connections_are_listed() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let key = ok_json(p.create_key(&owner, json!({ "name": "CI bot" })).await).await;
    let plaintext = key["plaintext"].as_str().unwrap();

    let principal = api_keys::authenticate(&p.deps, plaintext).await.unwrap();
    assert_eq!(
        principal.api_key_id.to_string(),
        key["id"].as_str().unwrap()
    );
    assert_eq!(principal.issuer_role_key, "owner");
    let now = OffsetDateTime::now_utc();
    let client = ClientInfo {
        name: "acme-agent".into(),
        version: "2.1.0".into(),
        protocol_version: "2025-06-18".into(),
    };
    let connection = agents::register_initialize(&p.deps, &principal, client.clone(), now)
        .await
        .unwrap();
    let again = agents::register_initialize(&p.deps, &principal, client, now)
        .await
        .unwrap();
    assert_eq!(again, connection);
    agents::touch_tool_call(&p.deps, principal.workspace_id, connection, now)
        .await
        .unwrap();

    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;
    let listed = ok_json(p.get("/api/agents", &rep).await).await;
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], json!(connection.to_string()));
    assert_eq!(listed[0]["api_key_id"], key["id"]);
    assert_eq!(listed[0]["api_key_name"], "CI bot");
    assert_eq!(listed[0]["client_name"], "acme-agent");
    assert_eq!(listed[0]["client_version"], "2.1.0");
    assert_eq!(listed[0]["protocol_version"], "2025-06-18");
    assert_eq!(listed[0]["tool_calls"], 1);

    let keys = ok_json(p.get("/api/api-keys", &owner).await).await;
    assert!(keys[0]["last_used_at"].is_string(), "{keys}");

    // A workspace of its own sees none of them.
    let (other, _) = p.register("owner@beta.example", "Beta").await;
    let listed = ok_json(p.get("/api/agents", &other).await).await;
    assert_eq!(listed, json!([]));
    let listed = ok_json(p.get("/api/api-keys", &other).await).await;
    assert_eq!(listed, json!([]));
}
