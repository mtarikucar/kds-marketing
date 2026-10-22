//! The team and roles routes end to end through Postgres: inviting, accepting (as a new user and
//! while signed in), re-roling and removing members, the last-owner rule, and custom roles.

use axum::http::{Method, StatusCode, header};
use jt_testkit::panel::{PASSWORD, Panel, expect_error, ok_json, session_pair};
use serde_json::json;

#[tokio::test]
async fn owner_invites_and_invitee_accepts_and_appears_in_list() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@alpha.example", "Alpha").await;
    let ws = me["current_workspace"].clone();

    let invite = p.invite(&owner, "Bob@Example.com", "rep").await;
    let token = invite["invite_token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 43, "32 random bytes, base64url");
    assert!(invite["expires_at"].is_string());

    // The invitee accepts without an account: created, signed in, and in the workspace.
    let (bob, accepted) = p.accept_as_new_user(&token, "Bob Builder").await;
    assert_eq!(accepted["workspace_id"], ws);
    assert_eq!(accepted["membership_id"], invite["membership_id"]);
    assert_eq!(accepted["me"]["email"], "bob@example.com");
    assert!(
        !accepted
            .to_string()
            .contains(bob.trim_start_matches("jt_session=")),
        "the session token travels only in the cookie"
    );

    let me = ok_json(p.get("/api/auth/me", &bob).await).await;
    assert_eq!(me["email"], "bob@example.com");
    assert_eq!(me["display_name"], "Bob Builder");
    assert_eq!(me["current_workspace"], ws);
    let memberships = me["memberships"].as_array().unwrap();
    assert_eq!(memberships.len(), 1);
    assert_eq!(memberships[0]["membership_id"], invite["membership_id"]);
    assert_eq!(memberships[0]["role_key"], "rep");
    assert_eq!(memberships[0]["permissions"], json!(["workspace.read"]));

    // The owner sees Bob as an active member.
    let team = ok_json(p.get("/api/team", &owner).await).await;
    let team = team.as_array().unwrap();
    assert_eq!(team.len(), 2);
    assert_eq!(team[0]["email"], "owner@alpha.example");
    assert_eq!(team[0]["role_key"], "owner");
    assert_eq!(team[1]["membership_id"], invite["membership_id"]);
    assert_eq!(team[1]["email"], "bob@example.com");
    assert_eq!(team[1]["display_name"], "Bob Builder");
    assert_eq!(team[1]["role_key"], "rep");
    assert_eq!(team[1]["status"], "active");

    // The token is spent.
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites/accept",
            None,
            Some(json!({ "token": token, "password": PASSWORD, "display_name": "Again" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["message"], "invite is not valid");
}

#[tokio::test]
async fn rep_cannot_invite_403() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let (rep, rep_membership) = p.join(&owner, "rep@alpha.example", "rep").await;

    let resp = p
        .send(
            Method::POST,
            "/api/team/invites",
            Some(&rep),
            Some(json!({ "email": "carol@example.com", "role_key": "rep" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"], json!({ "permission": "team.manage" }));

    // Nor may a rep change roles, remove members or create roles; but a rep may read.
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/team/{rep_membership}/role"),
            Some(&rep),
            Some(json!({ "role_key": "owner" })),
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{rep_membership}"),
            Some(&rep),
            None,
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = p
        .send(
            Method::POST,
            "/api/roles",
            Some(&rep),
            Some(json!({ "key": "boss", "name": "Boss", "permissions": ["team.manage"] })),
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let team = ok_json(p.get("/api/team", &rep).await).await;
    assert_eq!(team.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn last_owner_cannot_be_removed_409() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@alpha.example", "Alpha").await;
    let own = me["memberships"][0]["membership_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{own}"),
            Some(&owner),
            None,
        )
        .await;
    let body = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(body["details"], json!({ "reason": "last_owner" }));
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/team/{own}/role"),
            Some(&owner),
            Some(json!({ "role_key": "manager" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(body["message"], "cannot demote the last owner");
    assert_eq!(body["details"], json!({ "reason": "last_owner" }));

    // A second owner makes stepping down possible.
    let (_, bob) = p.join(&owner, "bob@alpha.example", "rep").await;
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/team/{bob}/role"),
            Some(&owner),
            Some(json!({ "role_key": "owner" })),
        )
        .await;
    let member = ok_json(resp).await;
    assert_eq!(member["membership_id"], json!(bob));
    assert_eq!(member["role_key"], "owner");
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{own}"),
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // The removed owner's session no longer reaches the workspace.
    let resp = p.get("/api/team", &owner).await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
}

#[tokio::test]
async fn manager_promoting_self_to_owner_is_403() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@alpha.example", "Alpha").await;
    let own = me["memberships"][0]["membership_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (manager, membership) = p.join(&owner, "manager@alpha.example", "manager").await;

    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/team/{membership}/role"),
            Some(&manager),
            Some(json!({ "role_key": "owner" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"], json!({ "reason": "owner_only" }));

    // Nor may the manager invite an owner, or demote or remove the owner.
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites",
            Some(&manager),
            Some(json!({ "email": "carol@example.com", "role_key": "owner" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"], json!({ "reason": "owner_only" }));
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/team/{own}/role"),
            Some(&manager),
            Some(json!({ "role_key": "rep" })),
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{own}"),
            Some(&manager),
            None,
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;

    // Everyone keeps their role.
    let team = ok_json(p.get("/api/team", &owner).await).await;
    let roles: Vec<&str> = team
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role_key"].as_str().unwrap())
        .collect();
    assert_eq!(roles, vec!["owner", "manager"]);
}

#[tokio::test]
async fn signed_in_invitee_accepts_with_their_cookie_and_removal_ends_that_session() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@alpha.example", "Alpha").await;
    let ws = me["current_workspace"].clone();
    let (bob, bob_me) = p.register("bob@example.com", "Bobco").await;
    let bobco = bob_me["current_workspace"].clone();
    let invite = p.invite(&owner, "bob@example.com", "manager").await;
    let token = invite["invite_token"].as_str().unwrap();

    // Someone else's session cannot take Bob's invitation.
    let (carol, _) = p.register("carol@example.com", "Carolco").await;
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites/accept",
            Some(&carol),
            Some(json!({ "token": token })),
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    // Without a session, a registered invitee is asked to sign in.
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites/accept",
            None,
            Some(json!({ "token": token, "password": PASSWORD, "display_name": "Bob" })),
        )
        .await;
    let body = expect_error(resp, StatusCode::CONFLICT, "CONFLICT").await;
    assert_eq!(body["message"], "sign in to accept this invite");

    // Bob accepts with his own session, which goes on (no new cookie).
    let resp = p
        .send(
            Method::POST,
            "/api/team/invites/accept",
            Some(&bob),
            Some(json!({ "token": token })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(resp.headers().get(header::SET_COOKIE).is_none());
    let accepted = ok_json(resp).await;
    assert_eq!(
        accepted,
        json!({ "workspace_id": ws, "membership_id": invite["membership_id"] })
    );
    let me = ok_json(p.get("/api/auth/me", &bob).await).await;
    assert_eq!(me["memberships"].as_array().unwrap().len(), 2);

    // Bob works in Alpha, then is removed: that session ends; one in Bobco would not.
    let resp = p
        .send(
            Method::POST,
            "/api/auth/switch-workspace",
            Some(&bob),
            Some(json!({ "workspace_id": ws })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let resp = p
        .send(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "email": "bob@example.com", "password": PASSWORD })),
        )
        .await;
    let bob_in_bobco = session_pair(&resp);
    assert_eq!(ok_json(resp).await["current_workspace"], bobco);

    let membership = invite["membership_id"].as_str().unwrap();
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/team/{membership}"),
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    expect_error(
        p.get("/api/auth/me", &bob).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    let me = ok_json(p.get("/api/auth/me", &bob_in_bobco).await).await;
    assert_eq!(me["memberships"].as_array().unwrap().len(), 1);
    let team = ok_json(p.get("/api/team", &owner).await).await;
    assert_eq!(team.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn roles_crud_round_trip() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;

    let roles = ok_json(p.get("/api/roles", &owner).await).await;
    let keys: Vec<&str> = roles
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys.len(), 3);
    for key in ["owner", "manager", "rep"] {
        assert!(keys.contains(&key), "{key}");
    }

    // Create.
    let resp = p
        .send(
            Method::POST,
            "/api/roles",
            Some(&owner),
            Some(json!({
                "key": "analyst",
                "name": "Analist",
                "permissions": ["ledger.read", "workspace.read"],
            })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let role = ok_json(resp).await;
    assert_eq!(role["key"], "analyst");
    assert_eq!(role["name"], "Analist");
    assert_eq!(
        role["permissions"],
        json!(["workspace.read", "ledger.read"])
    );
    assert_eq!(role["is_system"], false);
    let id = role["id"].as_str().unwrap().to_owned();
    let roles = ok_json(p.get("/api/roles", &owner).await).await;
    assert!(roles.as_array().unwrap().contains(&role));

    // Refusals: a taken key, a system key, an unknown permission.
    for (body, status, code) in [
        (
            json!({ "key": "analyst", "name": "Again", "permissions": [] }),
            StatusCode::CONFLICT,
            "CONFLICT",
        ),
        (
            json!({ "key": "owner", "name": "Owner", "permissions": [] }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        ),
        (
            json!({ "key": "viewer", "name": "Viewer", "permissions": ["nope"] }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        ),
    ] {
        let resp = p
            .send(Method::POST, "/api/roles", Some(&owner), Some(body))
            .await;
        expect_error(resp, status, code).await;
    }

    // Update.
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/roles/{id}"),
            Some(&owner),
            Some(json!({ "permissions": ["workspace.read"] })),
        )
        .await;
    let updated = ok_json(resp).await;
    assert_eq!(updated["id"], json!(id));
    assert_eq!(updated["permissions"], json!(["workspace.read"]));

    // A system role is immutable; an unknown id is not found; a malformed one is invalid.
    let rep_id = roles
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "rep")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let resp = p
        .send(
            Method::PATCH,
            &format!("/api/roles/{rep_id}"),
            Some(&owner),
            Some(json!({ "permissions": ["team.manage"] })),
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/roles/{rep_id}"),
            Some(&owner),
            None,
        )
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    let missing = uuid_like();
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/roles/{missing}"),
            Some(&owner),
            None,
        )
        .await;
    expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    let resp = p
        .send(Method::DELETE, "/api/roles/not-a-uuid", Some(&owner), None)
        .await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;

    // Delete.
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/roles/{id}"),
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let roles = ok_json(p.get("/api/roles", &owner).await).await;
    assert_eq!(roles.as_array().unwrap().len(), 3);
    let resp = p
        .send(
            Method::DELETE,
            &format!("/api/roles/{id}"),
            Some(&owner),
            None,
        )
        .await;
    expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
}

/// A well-formed id that names nothing.
fn uuid_like() -> String {
    "00000000-0000-7000-8000-000000000000".to_owned()
}

#[tokio::test]
async fn twin_bodies_refuse_unknown_fields_as_their_tools_do() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let (_, membership) = p.join(&owner, "rep@alpha.example", "rep").await;
    let some_role = "0192f0c4-0000-7000-8000-000000000000";
    for (method, path, body) in [
        (
            Method::POST,
            "/api/team/invites".to_owned(),
            json!({ "email": "x@alpha.example", "role_key": "rep", "role": "rep" }),
        ),
        (
            Method::PATCH,
            format!("/api/team/{membership}/role"),
            json!({ "role_key": "manager", "role": "manager" }),
        ),
        (
            Method::POST,
            "/api/roles".to_owned(),
            json!({ "key": "editor", "name": "Editor", "permissions": [], "is_system": true }),
        ),
        (
            Method::PATCH,
            format!("/api/roles/{some_role}"),
            json!({ "permissions": [], "name": "x" }),
        ),
        (
            Method::POST,
            "/api/api-keys".to_owned(),
            json!({ "name": "ajan", "scopes": [], "expires_at": null }),
        ),
    ] {
        let resp = p.send(method, &path, Some(&owner), Some(body)).await;
        expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    }
    // Nothing was written.
    let team = ok_json(p.get("/api/team", &owner).await).await;
    assert_eq!(team.as_array().unwrap().len(), 2);
    let keys = ok_json(p.get("/api/api-keys", &owner).await).await;
    assert_eq!(keys.as_array().unwrap().len(), 0);
}
