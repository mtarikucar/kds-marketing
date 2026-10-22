//! Authentication use cases over the in-memory fakes: registration, login, sessions, switching
//! workspace and the request context of a signed-in user.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{LedgerFilter, UnitOfWork, UserRow};
use jt_app::usecases::auth::{self, LoginInput, RegisterInput};
use jt_app::usecases::{Deps, hash_token};
use jt_ledger::Actor;
use jt_tenancy::{
    Email, MembershipId, MembershipStatus, Permission, SystemRole, UserId, WorkspaceId,
    WorkspaceStatus,
};
use jt_testkit::fakes::{
    FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox, SeqIdGen,
};
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const T0: OffsetDateTime = datetime!(2026-10-22 09:00 UTC);
const PASSWORD: &str = "correct horse battery";

/// The fakes behind one `Deps`, with the clock at `T0`.
struct World {
    uow: InMemoryUow,
    deps: Deps,
}

impl World {
    /// A world whose token generator hands out `tokens` in order.
    fn new(tokens: &[&str]) -> World {
        let uow = InMemoryUow::new();
        let deps = Deps {
            uow: Arc::new(uow.clone()),
            clock: Arc::new(FixedClock(T0)),
            ids: Arc::new(SeqIdGen::new()),
            tokens: Arc::new(FixedTokenGen::new(tokens.iter().copied())),
            hasher: Arc::new(PlainHasher),
            seal: Arc::new(PlainSecretBox),
        };
        World { uow, deps }
    }

    /// The same world with its clock at `now`.
    fn at(&self, now: OffsetDateTime) -> Deps {
        Deps {
            clock: Arc::new(FixedClock(now)),
            ..self.deps.clone()
        }
    }
}

fn input(email: &str, workspace_name: &str) -> RegisterInput {
    RegisterInput {
        email: email.into(),
        password: PASSWORD.into(),
        display_name: "Owner".into(),
        workspace_name: workspace_name.into(),
    }
}

fn login(email: &str, password: &str) -> LoginInput {
    LoginInput {
        email: email.into(),
        password: password.into(),
    }
}

fn err<T: Debug>(r: Result<T, AppError>) -> AppError {
    r.expect_err("expected an error")
}

#[tokio::test]
async fn register_creates_workspace_owner_roles_and_session() {
    let w = World::new(&["Ab1-", "session-1"]);
    let out = auth::register(
        &w.deps,
        RegisterInput {
            display_name: "  Ayşe Owner ".into(),
            ..input("owner@example.com", "  Çiçek Bahçesi  ")
        },
    )
    .await
    .unwrap();

    let s = w.uow.snapshot();
    assert_eq!(s.users.len(), 1);
    let user = &s.users[0];
    assert_eq!(user.email.as_str(), "owner@example.com");
    assert_eq!(user.display_name, "Ayşe Owner");
    assert_eq!(user.password_hash, format!("plain:{PASSWORD}"));
    assert_eq!(user.created_at, T0);

    assert_eq!(s.workspaces.len(), 1);
    let ws = &s.workspaces[0];
    assert_eq!(ws.name, "Çiçek Bahçesi");
    assert_eq!(ws.slug, "cicek-bahcesi-ab10");
    assert_eq!(ws.status, WorkspaceStatus::PendingPayment);
    assert_eq!(ws.created_at, T0);

    let roles: Vec<(&str, &str, BTreeSet<Permission>, bool)> = s
        .roles
        .iter()
        .filter(|r| r.workspace_id == ws.id)
        .map(|r| {
            (
                r.role.key.as_str(),
                r.role.name.as_str(),
                r.role.permissions.clone(),
                r.role.is_system,
            )
        })
        .collect();
    assert_eq!(
        roles,
        vec![
            ("owner", "Sahip", SystemRole::Owner.permissions(), true),
            (
                "manager",
                "Yönetici",
                SystemRole::Manager.permissions(),
                true
            ),
            ("rep", "Temsilci", SystemRole::Rep.permissions(), true),
        ]
    );
    let owner_role = s.roles.iter().find(|r| r.role.key == "owner").unwrap();

    assert_eq!(s.memberships.len(), 1);
    let m = &s.memberships[0];
    assert_eq!(m.workspace_id, ws.id);
    assert_eq!(m.user_id, Some(user.id));
    assert_eq!(m.role_id, owner_role.role.id);
    assert_eq!(m.status, MembershipStatus::Active);
    assert_eq!(m.created_at, T0);

    assert_eq!(s.sessions.len(), 1);
    let session = &s.sessions[0];
    assert_eq!(session.user_id, user.id);
    assert_eq!(session.token_hash, hash_token("session-1"));
    assert_ne!(
        session.token_hash, "session-1",
        "only the token's hash is stored"
    );
    assert_eq!(session.current_workspace_id, Some(ws.id));
    assert_eq!(session.created_at, T0);
    assert_eq!(session.expires_at, T0 + Duration::days(30));
    assert_eq!(session.revoked_at, None);

    assert_eq!(out.token, "session-1");
    assert_eq!(out.expires_at, T0 + Duration::days(30));
    assert_eq!(out.me.user_id, user.id);
    assert_eq!(out.me.email, user.email);
    assert_eq!(out.me.display_name, "Ayşe Owner");
    assert_eq!(out.me.current_workspace, Some(ws.id));
    assert_eq!(out.me.memberships.len(), 1);
    let view = &out.me.memberships[0];
    assert_eq!(view.workspace_id, ws.id);
    assert_eq!(view.workspace_slug, ws.slug);
    assert_eq!(view.workspace_status, WorkspaceStatus::PendingPayment);
    assert_eq!(view.role_key, "owner");
    assert_eq!(view.permissions, SystemRole::Owner.permissions());

    let principal = auth::resolve_session(&w.deps, &out.token).await.unwrap();
    assert_eq!(principal.session_id, session.id);
    assert_eq!(auth::me(&w.deps, &principal), out.me);
}

#[tokio::test]
async fn register_normalises_email_and_rejects_duplicate_with_conflict() {
    let w = World::new(&["aaaa", "s1", "bbbb", "s2"]);
    let out = auth::register(&w.deps, input("  Owner@Example.COM ", "Acme"))
        .await
        .unwrap();
    assert_eq!(out.me.email.as_str(), "owner@example.com");
    assert_eq!(
        w.uow.snapshot().users[0].email.as_str(),
        "owner@example.com"
    );

    let dup = err(auth::register(&w.deps, input("OWNER@example.com", "Other")).await);
    assert_eq!(dup.code, ErrorCode::Conflict);

    let s = w.uow.snapshot();
    assert_eq!(
        (
            s.users.len(),
            s.workspaces.len(),
            s.roles.len(),
            s.memberships.len(),
            s.sessions.len(),
            s.ledger.len()
        ),
        (1, 1, 3, 1, 1, 1),
        "the refused registration wrote nothing"
    );
}

#[tokio::test]
async fn register_rejects_short_password_with_validation() {
    let w = World::new(&["aaaa", "s1"]);
    for short in ["", "123456789", "şşşşşşşşş"] {
        let e = err(auth::register(
            &w.deps,
            RegisterInput {
                password: short.into(),
                ..input("owner@example.com", "Acme")
            },
        )
        .await);
        assert_eq!(e.code, ErrorCode::Validation, "{short:?}");
        assert_eq!(e.details, json!({ "field": "password" }));
    }
    assert!(w.uow.snapshot().users.is_empty());

    // Ten characters are enough, counted as characters rather than bytes.
    auth::register(
        &w.deps,
        RegisterInput {
            password: "şifreşifre".into(),
            ..input("owner@example.com", "Acme")
        },
    )
    .await
    .unwrap();
    assert_eq!(w.uow.snapshot().users.len(), 1);
}

#[tokio::test]
async fn register_validates_email_and_names() {
    let w = World::new(&[]);
    let cases = [
        (input("not-an-email", "Acme"), "email"),
        (input("   ", "Acme"), "email"),
        (
            RegisterInput {
                display_name: " \t ".into(),
                ..input("owner@example.com", "Acme")
            },
            "display_name",
        ),
        (input("owner@example.com", "   "), "workspace_name"),
    ];
    for (bad, field) in cases {
        let e = err(auth::register(&w.deps, bad).await);
        assert_eq!(e.code, ErrorCode::Validation, "{field}");
        assert_eq!(e.details, json!({ "field": field }));
    }
    assert!(w.uow.snapshot().users.is_empty());
}

#[tokio::test]
async fn register_retries_a_taken_workspace_slug() {
    let w = World::new(&["abcd", "s1", "abcd", "wxyz", "s2"]);
    auth::register(&w.deps, input("a@example.com", "Acme"))
        .await
        .unwrap();
    let second = auth::register(&w.deps, input("b@example.com", "Acme"))
        .await
        .unwrap();
    assert_eq!(second.me.memberships[0].workspace_slug, "acme-wxyz");

    let s = w.uow.snapshot();
    let slugs: Vec<&str> = s.workspaces.iter().map(|w| w.slug.as_str()).collect();
    assert_eq!(slugs, ["acme-abcd", "acme-wxyz"]);
    assert_eq!(
        (s.users.len(), s.sessions.len(), s.ledger.len()),
        (2, 2, 2),
        "the clashing attempt left nothing behind"
    );
}

#[tokio::test]
async fn login_accepts_any_case_email_and_rejects_wrong_password_with_identical_message() {
    let w = World::new(&["aaaa", "s1", "s2", "s3"]);
    let registered = auth::register(&w.deps, input("owner@example.com", "Acme"))
        .await
        .unwrap();
    let ws = registered.me.current_workspace.unwrap();

    let out = auth::login(
        &w.at(T0 + Duration::hours(1)),
        login("  OWNER@Example.com ", PASSWORD),
    )
    .await
    .unwrap();
    assert_eq!(out.token, "s2");
    assert_eq!(out.expires_at, T0 + Duration::hours(1) + Duration::days(30));
    assert_eq!(out.me, registered.me, "same user, same current workspace");
    let principal = auth::resolve_session(&w.deps, "s2").await.unwrap();
    assert_eq!(principal.current_workspace, Some(ws));

    let wrong = err(auth::login(&w.deps, login("owner@example.com", "wrong password!")).await);
    let unknown = err(auth::login(&w.deps, login("nobody@example.com", PASSWORD)).await);
    let malformed = err(auth::login(&w.deps, login("not-an-email", PASSWORD)).await);
    for e in [&wrong, &unknown, &malformed] {
        assert_eq!(e.code, ErrorCode::Unauthenticated);
        assert_eq!(e.message, wrong.message);
        assert_eq!(e.details, wrong.details);
    }
    assert_eq!(wrong.message, "invalid credentials");
    assert_eq!(
        w.uow.snapshot().sessions.len(),
        2,
        "failed logins open no session"
    );

    // A user without any membership logs in with no current workspace.
    let mut u = w.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: UserId::new_v7(),
            email: Email::parse("loner@example.com").unwrap(),
            password_hash: format!("plain:{PASSWORD}"),
            display_name: "Loner".into(),
            created_at: T0,
        })
        .await
        .unwrap();
    u.commit().await.unwrap();
    let loner = auth::login(&w.deps, login("loner@example.com", PASSWORD))
        .await
        .unwrap();
    assert_eq!(loner.me.current_workspace, None);
    assert!(loner.me.memberships.is_empty());
}

#[tokio::test]
async fn resolve_session_rejects_expired_and_revoked() {
    let w = World::new(&["aaaa", "s1", "s2"]);
    auth::register(&w.deps, input("owner@example.com", "Acme"))
        .await
        .unwrap();
    let expires = T0 + Duration::days(30);

    assert!(
        auth::resolve_session(&w.at(expires - Duration::seconds(1)), "s1")
            .await
            .is_ok()
    );
    let expired = err(auth::resolve_session(&w.at(expires), "s1").await);
    assert_eq!(expired.code, ErrorCode::Unauthenticated);
    let unknown = err(auth::resolve_session(&w.deps, "no-such-token").await);
    assert_eq!(unknown.code, ErrorCode::Unauthenticated);

    auth::login(&w.deps, login("owner@example.com", PASSWORD))
        .await
        .unwrap();
    let logout_at = T0 + Duration::hours(1);
    auth::logout(&w.at(logout_at), "s1").await.unwrap();
    let revoked = err(auth::resolve_session(&w.deps, "s1").await);
    assert_eq!(revoked.code, ErrorCode::Unauthenticated);
    assert_eq!(revoked.message, expired.message);
    assert!(
        auth::resolve_session(&w.deps, "s2").await.is_ok(),
        "only the logged-out session is revoked"
    );

    // Logging out again, or with an unknown token, succeeds and changes nothing.
    auth::logout(&w.at(logout_at + Duration::hours(1)), "s1")
        .await
        .unwrap();
    auth::logout(&w.deps, "no-such-token").await.unwrap();
    let s = w.uow.snapshot();
    let first = s
        .sessions
        .iter()
        .find(|x| x.token_hash == hash_token("s1"))
        .unwrap();
    assert_eq!(first.revoked_at, Some(logout_at));
    assert_eq!(
        s.sessions.iter().filter(|x| x.revoked_at.is_some()).count(),
        1
    );
}

#[tokio::test]
async fn switch_workspace_requires_active_membership() {
    let w = World::new(&["aaaa", "a1", "bbbb", "b1", "cccc", "c1", "a2"]);
    let a = auth::register(&w.deps, input("owner@a.example", "Alpha"))
        .await
        .unwrap();
    let b = auth::register(&w.deps, input("owner@b.example", "Beta"))
        .await
        .unwrap();
    let c = auth::register(&w.deps, input("owner@c.example", "Gamma"))
        .await
        .unwrap();
    let (ws_a, ws_b, ws_c) = (
        a.me.current_workspace.unwrap(),
        b.me.current_workspace.unwrap(),
        c.me.current_workspace.unwrap(),
    );

    // Alpha's owner joins Beta as a rep, after creating Alpha.
    let rep = {
        let mut t = w.uow.tenant(ws_b).await.unwrap();
        t.roles().find_by_key("rep").await.unwrap().unwrap()
    };
    let joined = MembershipId::new_v7();
    let mut u = w.uow.user().await.unwrap();
    u.memberships_insert_active(
        joined,
        ws_b,
        a.me.user_id,
        rep.id,
        T0 + Duration::minutes(5),
    )
    .await
    .unwrap();
    u.commit().await.unwrap();

    let principal = auth::resolve_session(&w.deps, "a1").await.unwrap();
    assert_eq!(principal.current_workspace, Some(ws_a));
    let member_of: Vec<WorkspaceId> = principal
        .memberships
        .iter()
        .map(|m| m.workspace_id)
        .collect();
    assert_eq!(member_of, [ws_a, ws_b]);

    auth::switch_workspace(&w.deps, &principal, ws_b)
        .await
        .unwrap();
    let principal = auth::resolve_session(&w.deps, "a1").await.unwrap();
    assert_eq!(principal.current_workspace, Some(ws_b));
    assert_eq!(auth::me(&w.deps, &principal).current_workspace, Some(ws_b));

    for stranger in [ws_c, WorkspaceId::new_v7()] {
        let e = err(auth::switch_workspace(&w.deps, &principal, stranger).await);
        assert_eq!(e.code, ErrorCode::Forbidden);
    }
    let unchanged = auth::resolve_session(&w.deps, "a1").await.unwrap();
    assert_eq!(unchanged.current_workspace, Some(ws_b));

    // A new login starts in the oldest active membership.
    let fresh = auth::login(&w.deps, login("owner@a.example", PASSWORD))
        .await
        .unwrap();
    assert_eq!(fresh.me.current_workspace, Some(ws_a));

    // Once removed from Beta, switching there is refused even with a principal that still
    // lists it, and the session that points there resolves without a current workspace.
    let mut t = w.uow.tenant(ws_b).await.unwrap();
    t.memberships().remove(joined).await.unwrap();
    t.commit().await.unwrap();
    let e = err(auth::switch_workspace(&w.deps, &principal, ws_b).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let after = auth::resolve_session(&w.deps, "a1").await.unwrap();
    assert_eq!(after.current_workspace, None);
    assert_eq!(after.memberships.len(), 1);
}

#[tokio::test]
async fn register_writes_ledger_entry_auth_register() {
    let w = World::new(&["aaaa", "s1"]);
    let out = auth::register(&w.deps, input("Owner@Example.com", "Acme"))
        .await
        .unwrap();
    let ws = out.me.current_workspace.unwrap();

    let s = w.uow.snapshot();
    assert_eq!(s.ledger.len(), 1);
    let entry = &s.ledger[0].entry;
    assert_eq!(entry.workspace_id, ws);
    assert_eq!(entry.action.as_str(), "auth.register");
    assert_eq!(
        entry.actor,
        Actor::Human {
            user_id: out.me.user_id
        }
    );
    assert_eq!(entry.at, T0);
    assert_eq!(
        entry.payload,
        json!({ "email": "owner@example.com", "workspace_id": ws.to_string() })
    );
    assert!(!entry.payload.to_string().contains(PASSWORD));

    let mut t = w.uow.tenant(ws).await.unwrap();
    let listed = t
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("auth.".into()),
            actor_kind: Some("human".into()),
            limit: 10,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
}

#[tokio::test]
async fn ctx_for_builds_the_member_context_and_refuses_strangers() {
    let w = World::new(&["aaaa", "a1", "bbbb", "b1"]);
    let a = auth::register(&w.deps, input("owner@a.example", "Alpha"))
        .await
        .unwrap();
    let b = auth::register(&w.deps, input("owner@b.example", "Beta"))
        .await
        .unwrap();
    let (ws_a, ws_b) = (
        a.me.current_workspace.unwrap(),
        b.me.current_workspace.unwrap(),
    );
    let principal = auth::resolve_session(&w.deps, "a1").await.unwrap();
    let now = T0 + Duration::hours(2);

    assert_eq!(
        auth::ctx_for(&principal, ws_a, now).unwrap(),
        Ctx {
            workspace_id: ws_a,
            actor: Actor::Human {
                user_id: a.me.user_id
            },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now,
            agent_connection_id: None,
        }
    );
    let e = auth::ctx_for(&principal, ws_b, now).unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}
