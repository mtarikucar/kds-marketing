//! Team and roles use cases over the in-memory fakes: listing, inviting, accepting, re-roling and
//! removing members, and the workspace's custom roles. One test per rule.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::{MembershipRow, SessionRow};
use jt_app::usecases::auth::{self, LoginInput, Principal, RegisterInput};
use jt_app::usecases::roles::{self, CreateRole};
use jt_app::usecases::team::{self, AcceptInput, InviteInput, InviteOut};
use jt_app::usecases::{Deps, hash_token};
use jt_ledger::{Actor, LedgerEntry, Subject};
use jt_tenancy::{
    Email, MembershipId, MembershipStatus, Permission, RoleId, UserId, WorkspaceId, WorkspaceStatus,
};
use jt_testkit::fakes::{FIXED_NOW, FixedClock, FixedTokenGen, InMemoryUow, deps};
use serde_json::json;
use time::{Duration, OffsetDateTime};

/// The instant the clock of `fakes::deps` reads.
const T0: OffsetDateTime = FIXED_NOW;
const PASSWORD: &str = "correct horse battery";
const INVALID_INVITE: &str = "invite is not valid";

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

/// The fakes behind one `Deps`, with the clock at `T0` and tokens `aaaa`, `owner-session`,
/// `token-3`, `token-4`, … in order.
struct World {
    uow: InMemoryUow,
    deps: Deps,
}

impl World {
    fn new() -> World {
        let tokens = ["aaaa".to_owned(), "owner-session".to_owned()]
            .into_iter()
            .chain((3..=80).map(|i| format!("token-{i}")));
        let uow = InMemoryUow::new();
        let deps = Deps {
            tokens: Arc::new(FixedTokenGen::new(tokens)),
            ..deps(Arc::new(uow.clone()))
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

    fn membership(&self, id: MembershipId) -> MembershipRow {
        self.uow
            .snapshot()
            .memberships
            .into_iter()
            .find(|m| m.id == id)
            .expect("the membership exists")
    }

    fn sessions_of(&self, user: UserId) -> Vec<SessionRow> {
        self.uow
            .snapshot()
            .sessions
            .into_iter()
            .filter(|s| s.user_id == user)
            .collect()
    }

    /// The ledger entries with this action, oldest first.
    fn entries(&self, action: &str) -> Vec<LedgerEntry> {
        self.uow
            .snapshot()
            .ledger
            .into_iter()
            .map(|row| row.entry)
            .filter(|e| e.action.as_str() == action)
            .collect()
    }
}

/// The workspace "Acme", registered by `owner@acme.example`.
struct Team {
    w: World,
    ws: WorkspaceId,
    owner: UserId,
    owner_membership: MembershipId,
    owner_principal: Principal,
    owner_ctx: Ctx,
}

/// A member who joined through an invitation as a new user.
struct Member {
    user_id: UserId,
    membership_id: MembershipId,
    ctx: Ctx,
}

async fn team() -> Team {
    let w = World::new();
    let out = auth::register(
        &w.deps,
        RegisterInput {
            email: "owner@acme.example".into(),
            password: PASSWORD.into(),
            display_name: "Owner".into(),
            workspace_name: "Acme".into(),
        },
    )
    .await
    .unwrap();
    let ws = out.me.current_workspace.unwrap();
    // The operator activates the new workspace: invitations open only an active one.
    set_status(&w.uow, ws, WorkspaceStatus::Active).await;
    let owner_principal = auth::resolve_session(&w.deps, &out.token).await.unwrap();
    let owner_ctx = auth::ctx_for(&owner_principal, ws, T0).unwrap();
    Team {
        ws,
        owner: out.me.user_id,
        owner_membership: out.me.memberships[0].membership_id,
        owner_principal,
        owner_ctx,
        w,
    }
}

impl Team {
    async fn invite(&self, email: &str, role_key: &str) -> InviteOut {
        team::invite(&self.w.deps, &self.owner_ctx, invite_input(email, role_key))
            .await
            .unwrap()
    }

    /// Invites `email` as `role_key` and accepts as a new user named after the email.
    async fn join(&self, email: &str, role_key: &str) -> Member {
        let invite = self.invite(email, role_key).await;
        let out = team::accept_invite(&self.w.deps, new_user(&invite.invite_token, email))
            .await
            .unwrap();
        let session = out.session.expect("a new user gets a session");
        Member {
            user_id: session.me.user_id,
            membership_id: out.membership_id,
            ctx: self.ctx_of(&session.token).await,
        }
    }

    /// The context, in this workspace, of the user behind a session token, read afresh.
    async fn ctx_of(&self, session_token: &str) -> Ctx {
        let principal = auth::resolve_session(&self.w.deps, session_token)
            .await
            .unwrap();
        auth::ctx_for(&principal, self.ws, T0).unwrap()
    }

    fn role_id(&self, key: &str) -> RoleId {
        self.w
            .uow
            .snapshot()
            .roles
            .into_iter()
            .find(|r| r.workspace_id == self.ws && r.role.key == key)
            .expect("the role exists")
            .role
            .id
    }
}

async fn set_status(uow: &InMemoryUow, ws: WorkspaceId, status: WorkspaceStatus) {
    let mut platform = uow.platform().await.unwrap();
    platform
        .workspace_set_status(
            ws,
            status,
            "test status transition",
            &jt_ledger::Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
    platform.commit().await.unwrap();
}

fn invite_input(email: &str, role_key: &str) -> InviteInput {
    InviteInput {
        email: email.into(),
        role_key: role_key.into(),
    }
}

/// Accepting as someone without an account.
fn new_user(token: &str, email: &str) -> AcceptInput<'static> {
    AcceptInput {
        token: token.into(),
        password: Some(PASSWORD.into()),
        display_name: Some(format!("User {email}")),
        principal: None,
    }
}

/// Accepting while signed in.
fn signed_in<'a>(token: &str, principal: &'a Principal) -> AcceptInput<'a> {
    AcceptInput {
        token: token.into(),
        password: None,
        display_name: None,
        principal: Some(principal),
    }
}

fn err<T: Debug>(r: Result<T, AppError>) -> AppError {
    r.expect_err("expected an error")
}

/// A context with `permissions` removed.
fn without(ctx: &Ctx, permissions: &[Permission]) -> Ctx {
    let mut ctx = ctx.clone();
    for p in permissions {
        ctx.permissions.remove(p);
    }
    ctx
}

fn membership_subject(id: MembershipId) -> Option<Subject> {
    Some(Subject {
        kind: "membership".into(),
        id: id.to_string(),
    })
}

fn role_subject(id: RoleId) -> Option<Subject> {
    Some(Subject {
        kind: "role".into(),
        id: id.to_string(),
    })
}

// ---------------------------------------------------------------------------------------------
// team.list
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_shows_members_and_open_invitations_and_needs_workspace_read() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let carol = t.invite("carol@example.com", "manager").await;

    let members = team::list(&t.w.deps, &bob.ctx).await.unwrap();
    let rows: Vec<(MembershipId, &str, &str, MembershipStatus)> = members
        .iter()
        .map(|m| {
            (
                m.membership_id,
                m.email.as_str(),
                m.role_key.as_str(),
                m.status,
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                t.owner_membership,
                "owner@acme.example",
                "owner",
                MembershipStatus::Active
            ),
            (
                bob.membership_id,
                "bob@example.com",
                "rep",
                MembershipStatus::Active
            ),
            (
                carol.membership_id,
                "carol@example.com",
                "manager",
                MembershipStatus::Invited
            ),
        ]
    );
    assert_eq!(
        members[1].display_name.as_deref(),
        Some("User bob@example.com")
    );
    assert_eq!(members[1].user_id, Some(bob.user_id));
    assert_eq!(members[2].user_id, None);

    let e = err(team::list(&t.w.deps, &without(&bob.ctx, &[Permission::WorkspaceRead])).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
}

// ---------------------------------------------------------------------------------------------
// team.invite
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn invite_requires_team_manage() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let before = t.w.uow.snapshot().memberships.len();

    let e = err(team::invite(
        &t.w.deps,
        &bob.ctx,
        invite_input("carol@example.com", "rep"),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details, json!({ "permission": "team.manage" }));
    assert_eq!(t.w.uow.snapshot().memberships.len(), before);
}

#[tokio::test]
async fn invite_stores_only_the_token_hash_with_a_seven_day_expiry_and_ledgers_it() {
    let t = team().await;
    let out = team::invite(
        &t.w.deps,
        &t.owner_ctx,
        invite_input("  Carol@Example.COM ", "manager"),
    )
    .await
    .unwrap();
    assert_eq!(out.invite_token, "token-3");
    assert_eq!(out.expires_at, T0 + Duration::days(7));
    assert!(
        !format!("{out:?}").contains("token-3"),
        "Debug masks the token"
    );

    let m = t.w.membership(out.membership_id);
    assert_eq!(m.workspace_id, t.ws);
    assert_eq!(m.status, MembershipStatus::Invited);
    assert_eq!(m.user_id, None);
    assert_eq!(m.role_id, t.role_id("manager"));
    assert_eq!(
        m.invited_email,
        Some(Email::parse("carol@example.com").unwrap())
    );
    assert_eq!(m.invite_token_hash, Some(hash_token("token-3")));
    assert_eq!(m.invite_expires_at, Some(T0 + Duration::days(7)));
    assert_eq!(m.invited_by, Some(t.owner));
    assert_eq!(m.created_at, T0);

    let entries = t.w.entries("team.invite");
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.workspace_id, t.ws);
    assert_eq!(e.actor, Actor::Human { user_id: t.owner });
    assert_eq!(e.subject, membership_subject(out.membership_id));
    assert_eq!(
        e.payload,
        json!({
            "invited_email": "carol@example.com",
            "role_key": "manager",
            "replaced_membership_ids": [],
        })
    );
    assert_eq!(e.at, T0);
    let stored = serde_json::to_string(&t.w.uow.snapshot().ledger).unwrap();
    assert!(
        !stored.contains("token-3"),
        "the token never enters the ledger"
    );
}

#[tokio::test]
async fn invite_validates_the_email_and_the_role() {
    let t = team().await;
    let e = err(team::invite(&t.w.deps, &t.owner_ctx, invite_input("not an email", "rep")).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "field": "email" }));

    let e = err(team::invite(
        &t.w.deps,
        &t.owner_ctx,
        invite_input("carol@example.com", "nope"),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "role_key": "nope" }));
    assert_eq!(t.w.uow.snapshot().memberships.len(), 1);
}

#[tokio::test]
async fn invite_of_an_active_member_is_conflict() {
    let t = team().await;
    t.join("bob@example.com", "rep").await;
    for email in ["OWNER@acme.example", "bob@example.com"] {
        let e = err(team::invite(&t.w.deps, &t.owner_ctx, invite_input(email, "manager")).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{email}");
    }
}

#[tokio::test]
async fn invite_with_an_open_invitation_is_conflict_and_an_expired_one_is_replaced() {
    let t = team().await;
    let first = t.invite("carol@example.com", "rep").await;
    let e = err(team::invite(
        &t.w.deps,
        &t.owner_ctx,
        invite_input("carol@example.com", "manager"),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);

    // Once the first has expired, a new invitation replaces it.
    let mut later = t.owner_ctx.clone();
    later.now = first.expires_at;
    let second = team::invite(
        &t.w.deps,
        &later,
        invite_input("carol@example.com", "manager"),
    )
    .await
    .unwrap();
    assert_eq!(second.expires_at, first.expires_at + Duration::days(7));
    assert_eq!(
        t.w.membership(first.membership_id).status,
        MembershipStatus::Removed
    );
    assert_eq!(
        t.w.membership(second.membership_id).status,
        MembershipStatus::Invited
    );
    let listed: Vec<MembershipId> = team::list(&t.w.deps, &later)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.membership_id)
        .collect();
    assert_eq!(listed, vec![t.owner_membership, second.membership_id]);

    // The replacement is recorded with the new invitation.
    let entries = t.w.entries("team.invite");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].subject, membership_subject(second.membership_id));
    assert_eq!(
        entries[1].payload,
        json!({
            "invited_email": "carol@example.com",
            "role_key": "manager",
            "replaced_membership_ids": [first.membership_id],
        })
    );
}

// ---------------------------------------------------------------------------------------------
// team.accept_invite
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn accept_as_a_new_user_creates_the_user_activates_and_opens_a_session() {
    let t = team().await;
    let invite = t.invite("Bob@Example.com", "rep").await;
    let out = team::accept_invite(
        &t.w.deps,
        AcceptInput {
            token: invite.invite_token.clone(),
            password: Some(PASSWORD.into()),
            display_name: Some("  Bob Builder ".into()),
            principal: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(out.workspace_id, t.ws);
    assert_eq!(out.membership_id, invite.membership_id);
    let session = out.session.expect("a new user gets a session");
    assert_eq!(session.expires_at, T0 + Duration::days(30));
    assert_eq!(session.me.email.as_str(), "bob@example.com");
    assert_eq!(session.me.display_name, "Bob Builder");
    assert_eq!(session.me.current_workspace, Some(t.ws));
    assert_eq!(session.me.memberships.len(), 1);
    assert_eq!(session.me.memberships[0].workspace_id, t.ws);
    assert_eq!(session.me.memberships[0].role_key, "rep");

    let s = t.w.uow.snapshot();
    let user = s.users.iter().find(|u| u.id == session.me.user_id).unwrap();
    assert_eq!(user.password_hash, format!("plain:{PASSWORD}"));
    assert_eq!(user.created_at, T0);
    let m = t.w.membership(invite.membership_id);
    assert_eq!(m.status, MembershipStatus::Active);
    assert_eq!(m.user_id, Some(user.id));
    assert_eq!(m.invite_token_hash, None, "the token cannot be used again");
    assert_eq!(m.invite_expires_at, None);
    assert_eq!(
        m.invited_email,
        Some(Email::parse("bob@example.com").unwrap())
    );

    // The session works and is in the workspace.
    let principal = auth::resolve_session(&t.w.deps, &session.token)
        .await
        .unwrap();
    assert_eq!(principal.user_id, user.id);
    assert_eq!(principal.current_workspace, Some(t.ws));

    let entries = t.w.entries("team.accept_invite");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].workspace_id, t.ws);
    assert_eq!(entries[0].actor, Actor::Human { user_id: user.id });
    assert_eq!(entries[0].subject, membership_subject(invite.membership_id));
    assert_eq!(
        entries[0].payload,
        json!({ "invited_email": "bob@example.com", "role_key": "rep" })
    );
    let stored = serde_json::to_string(&s.ledger).unwrap();
    assert!(!stored.contains(&invite.invite_token));
    assert!(!stored.contains(PASSWORD));
}

#[tokio::test]
async fn accept_as_a_new_user_needs_a_password_and_a_display_name() {
    let t = team().await;
    let invite = t.invite("bob@example.com", "rep").await;
    let cases = [
        (None, Some("Bob"), "password"),
        (Some("too short"), Some("Bob"), "password"),
        (Some(PASSWORD), None, "display_name"),
        (Some(PASSWORD), Some("   "), "display_name"),
    ];
    for (password, display_name, field) in cases {
        let e = err(team::accept_invite(
            &t.w.deps,
            AcceptInput {
                token: invite.invite_token.clone(),
                password: password.map(String::from),
                display_name: display_name.map(String::from),
                principal: None,
            },
        )
        .await);
        assert_eq!(e.code, ErrorCode::Validation, "{field}");
        assert_eq!(e.details, json!({ "field": field }));
    }
    let s = t.w.uow.snapshot();
    assert_eq!(s.users.len(), 1);
    assert_eq!(
        t.w.membership(invite.membership_id).status,
        MembershipStatus::Invited
    );
}

#[tokio::test]
async fn accept_for_a_registered_email_without_a_session_is_conflict() {
    let t = team().await;
    auth::register(
        &t.w.deps,
        RegisterInput {
            email: "bob@example.com".into(),
            password: PASSWORD.into(),
            display_name: "Bob".into(),
            workspace_name: "Bobco".into(),
        },
    )
    .await
    .unwrap();
    let invite = t.invite("bob@example.com", "rep").await;

    let e = err(
        team::accept_invite(&t.w.deps, new_user(&invite.invite_token, "bob@example.com")).await,
    );
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.message, "sign in to accept this invite");
    assert_eq!(
        t.w.membership(invite.membership_id).status,
        MembershipStatus::Invited
    );
}

#[tokio::test]
async fn accept_by_the_signed_in_invitee_activates_and_keeps_their_session() {
    let t = team().await;
    let bob = auth::register(
        &t.w.deps,
        RegisterInput {
            email: "bob@example.com".into(),
            password: PASSWORD.into(),
            display_name: "Bob".into(),
            workspace_name: "Bobco".into(),
        },
    )
    .await
    .unwrap();
    let principal = auth::resolve_session(&t.w.deps, &bob.token).await.unwrap();
    let invite = t.invite("BOB@example.com", "manager").await;
    let sessions_before = t.w.uow.snapshot().sessions.len();

    let out = team::accept_invite(&t.w.deps, signed_in(&invite.invite_token, &principal))
        .await
        .unwrap();
    assert_eq!(out.workspace_id, t.ws);
    assert_eq!(out.membership_id, invite.membership_id);
    assert!(out.session.is_none(), "the current session is kept");
    assert_eq!(t.w.uow.snapshot().sessions.len(), sessions_before);

    let m = t.w.membership(invite.membership_id);
    assert_eq!(m.status, MembershipStatus::Active);
    assert_eq!(m.user_id, Some(bob.me.user_id));
    assert_eq!(m.invite_token_hash, None);
    let principal = auth::resolve_session(&t.w.deps, &bob.token).await.unwrap();
    assert_eq!(principal.memberships.len(), 2);
    assert!(auth::ctx_for(&principal, t.ws, T0).is_ok());

    let entries = t.w.entries("team.accept_invite");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].actor,
        Actor::Human {
            user_id: bob.me.user_id
        }
    );
    assert_eq!(
        entries[0].payload,
        json!({ "invited_email": "bob@example.com", "role_key": "manager" })
    );
}

/// Review Focus 4: an invitation binds to the invited email, never to whoever holds the link.
#[tokio::test]
async fn accept_with_a_different_signed_in_email_is_forbidden() {
    let t = team().await;
    let invite = t.invite("bob@example.com", "rep").await;

    // The workspace's own owner holds the link but is not the invitee.
    let e = err(team::accept_invite(
        &t.w.deps,
        signed_in(&invite.invite_token, &t.owner_principal),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let m = t.w.membership(invite.membership_id);
    assert_eq!(m.status, MembershipStatus::Invited);
    assert_eq!(m.user_id, None);
    assert!(t.w.entries("team.accept_invite").is_empty());
}

#[tokio::test]
async fn accept_with_a_used_token_is_forbidden() {
    let t = team().await;
    let invite = t.invite("bob@example.com", "rep").await;
    team::accept_invite(&t.w.deps, new_user(&invite.invite_token, "bob@example.com"))
        .await
        .unwrap();

    let e = err(
        team::accept_invite(&t.w.deps, new_user(&invite.invite_token, "bob@example.com")).await,
    );
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.message, INVALID_INVITE);
}

#[tokio::test]
async fn accept_with_an_expired_token_is_forbidden() {
    let t = team().await;
    let invite = t.invite("bob@example.com", "rep").await;
    let at_expiry = t.w.at(invite.expires_at);

    let e = err(team::accept_invite(
        &at_expiry,
        new_user(&invite.invite_token, "bob@example.com"),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.message, INVALID_INVITE);
    assert_eq!(t.w.uow.snapshot().users.len(), 1);

    // A second before expiry it still works.
    let before = t.w.at(invite.expires_at - Duration::seconds(1));
    team::accept_invite(&before, new_user(&invite.invite_token, "bob@example.com"))
        .await
        .unwrap();
}

#[tokio::test]
async fn accept_with_an_unknown_or_cancelled_token_is_forbidden() {
    let t = team().await;
    let e = err(team::accept_invite(&t.w.deps, new_user("no-such-token", "bob@example.com")).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.message, INVALID_INVITE);

    let invite = t.invite("bob@example.com", "rep").await;
    team::remove(&t.w.deps, &t.owner_ctx, invite.membership_id)
        .await
        .unwrap();
    let e = err(
        team::accept_invite(&t.w.deps, new_user(&invite.invite_token, "bob@example.com")).await,
    );
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.message, INVALID_INVITE);
}

#[tokio::test]
async fn accept_into_an_inactive_workspace_is_workspace_inactive() {
    let t = team().await;
    let invite = t.invite("bob@example.com", "rep").await;
    for status in [WorkspaceStatus::Suspended, WorkspaceStatus::PendingPayment] {
        set_status(&t.w.uow, t.ws, status).await;
        let e = err(team::accept_invite(
            &t.w.deps,
            new_user(&invite.invite_token, "bob@example.com"),
        )
        .await);
        assert_eq!(e.code, ErrorCode::WorkspaceInactive, "{status:?}");
        assert_eq!(e.details, json!({ "status": status.key() }));
        assert_eq!(t.w.uow.snapshot().users.len(), 1, "no user was created");
        assert_eq!(
            t.w.membership(invite.membership_id).status,
            MembershipStatus::Invited
        );
    }
    // A bad token still gets the one answer for bad tokens, whatever the workspace's status.
    let e = err(team::accept_invite(&t.w.deps, new_user("no-such-token", "bob@example.com")).await);
    assert_eq!(e.code, ErrorCode::Forbidden);

    // Once the workspace is active again the same invitation opens it.
    set_status(&t.w.uow, t.ws, WorkspaceStatus::Active).await;
    team::accept_invite(&t.w.deps, new_user(&invite.invite_token, "bob@example.com"))
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------------------------
// team.set_role
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn set_role_requires_team_manage() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let e = err(team::set_role(&t.w.deps, &bob.ctx, bob.membership_id, "owner").await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(t.w.membership(bob.membership_id).role_id, t.role_id("rep"));
}

#[tokio::test]
async fn set_role_moves_the_member_and_ledgers_it() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;

    let out = team::set_role(&t.w.deps, &t.owner_ctx, bob.membership_id, "manager")
        .await
        .unwrap();
    assert_eq!(out.membership_id, bob.membership_id);
    assert_eq!(out.role_key, "manager");
    assert_eq!(out.status, MembershipStatus::Active);
    assert_eq!(
        t.w.membership(bob.membership_id).role_id,
        t.role_id("manager")
    );

    let entries = t.w.entries("team.set_role");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].actor, Actor::Human { user_id: t.owner });
    assert_eq!(entries[0].subject, membership_subject(bob.membership_id));
    assert_eq!(
        entries[0].payload,
        json!({ "role_key": "manager", "previous_role_key": "rep" })
    );
}

#[tokio::test]
async fn set_role_needs_an_active_membership_of_this_workspace() {
    let t = team().await;
    let invited = t.invite("carol@example.com", "rep").await;
    let removed = t.join("dave@example.com", "rep").await;
    team::remove(&t.w.deps, &t.owner_ctx, removed.membership_id)
        .await
        .unwrap();
    let other = auth::register(
        &t.w.deps,
        RegisterInput {
            email: "eve@example.com".into(),
            password: PASSWORD.into(),
            display_name: "Eve".into(),
            workspace_name: "Other".into(),
        },
    )
    .await
    .unwrap();
    let elsewhere = other.me.memberships[0].membership_id;

    for id in [
        MembershipId::new_v7(),
        invited.membership_id,
        removed.membership_id,
        elsewhere,
    ] {
        let e = err(team::set_role(&t.w.deps, &t.owner_ctx, id, "manager").await);
        assert_eq!(e.code, ErrorCode::NotFound, "{id}");
    }
}

#[tokio::test]
async fn set_role_to_an_unknown_role_is_validation() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let e = err(team::set_role(&t.w.deps, &t.owner_ctx, bob.membership_id, "boss").await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "role_key": "boss" }));
}

#[tokio::test]
async fn demoting_the_last_owner_is_conflict_last_owner() {
    let t = team().await;
    let e = err(team::set_role(&t.w.deps, &t.owner_ctx, t.owner_membership, "manager").await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.message, "cannot demote the last owner");
    assert_eq!(e.details, json!({ "reason": "last_owner" }));
    assert_eq!(
        t.w.membership(t.owner_membership).role_id,
        t.role_id("owner")
    );

    // Keeping the owner role is no demotion.
    team::set_role(&t.w.deps, &t.owner_ctx, t.owner_membership, "owner")
        .await
        .unwrap();

    // With a second owner, the first may step down.
    let bob = t.join("bob@example.com", "rep").await;
    team::set_role(&t.w.deps, &t.owner_ctx, bob.membership_id, "owner")
        .await
        .unwrap();
    let out = team::set_role(&t.w.deps, &t.owner_ctx, t.owner_membership, "manager")
        .await
        .unwrap();
    assert_eq!(out.role_key, "manager");
}

// ---------------------------------------------------------------------------------------------
// team.remove
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn remove_requires_team_manage() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let e = err(team::remove(&t.w.deps, &bob.ctx, t.owner_membership).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = err(team::remove(&t.w.deps, &bob.ctx, bob.membership_id).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(
        t.w.membership(bob.membership_id).status,
        MembershipStatus::Active
    );
}

#[tokio::test]
async fn remove_marks_removed_revokes_sessions_in_this_workspace_and_ledgers_it() {
    let t = team().await;
    // Bob has his own workspace and joins Acme while signed in.
    let bob = auth::register(
        &t.w.deps,
        RegisterInput {
            email: "bob@example.com".into(),
            password: PASSWORD.into(),
            display_name: "Bob".into(),
            workspace_name: "Bobco".into(),
        },
    )
    .await
    .unwrap();
    let bobco = bob.me.current_workspace.unwrap();
    let principal = auth::resolve_session(&t.w.deps, &bob.token).await.unwrap();
    let invite = t.invite("bob@example.com", "rep").await;
    team::accept_invite(&t.w.deps, signed_in(&invite.invite_token, &principal))
        .await
        .unwrap();
    // One session works in Acme, another (a fresh login) in Bobco.
    auth::switch_workspace(&t.w.deps, &principal, t.ws)
        .await
        .unwrap();
    let other = auth::login(
        &t.w.deps,
        LoginInput {
            email: "bob@example.com".into(),
            password: PASSWORD.into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(other.me.current_workspace, Some(bobco));

    team::remove(&t.w.deps, &t.owner_ctx, invite.membership_id)
        .await
        .unwrap();
    assert_eq!(
        t.w.membership(invite.membership_id).status,
        MembershipStatus::Removed
    );
    let sessions = t.w.sessions_of(bob.me.user_id);
    let revoked: Vec<(Option<WorkspaceId>, Option<OffsetDateTime>)> = sessions
        .iter()
        .map(|s| (s.current_workspace_id, s.revoked_at))
        .collect();
    assert_eq!(revoked, vec![(Some(t.ws), Some(T0)), (Some(bobco), None)]);
    assert!(
        t.w.sessions_of(t.owner)
            .iter()
            .all(|s| s.revoked_at.is_none()),
        "other users' sessions are untouched"
    );
    assert!(auth::resolve_session(&t.w.deps, &bob.token).await.is_err());
    let still = auth::resolve_session(&t.w.deps, &other.token)
        .await
        .unwrap();
    assert_eq!(still.memberships.len(), 1);

    let entries = t.w.entries("team.remove");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].actor, Actor::Human { user_id: t.owner });
    assert_eq!(entries[0].subject, membership_subject(invite.membership_id));
    assert_eq!(
        entries[0].payload,
        json!({
            "user_id": bob.me.user_id,
            "role_key": "rep",
            "previous_status": "active",
            "revoked_api_key_ids": [],
        })
    );
}

#[tokio::test]
async fn removing_the_last_owner_is_conflict_but_a_member_may_remove_themselves() {
    let t = team().await;
    let e = err(team::remove(&t.w.deps, &t.owner_ctx, t.owner_membership).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details, json!({ "reason": "last_owner" }));

    assert_eq!(
        t.w.membership(t.owner_membership).status,
        MembershipStatus::Active
    );

    // A manager may leave.
    let manager = t.join("manager@example.com", "manager").await;
    team::remove(&t.w.deps, &manager.ctx, manager.membership_id)
        .await
        .unwrap();

    // With a second owner, the first owner may leave too.
    let bob = t.join("bob@example.com", "rep").await;
    team::set_role(&t.w.deps, &t.owner_ctx, bob.membership_id, "owner")
        .await
        .unwrap();
    team::remove(&t.w.deps, &t.owner_ctx, t.owner_membership)
        .await
        .unwrap();
    assert_eq!(
        t.w.membership(t.owner_membership).status,
        MembershipStatus::Removed
    );
    assert_eq!(
        t.w.membership(bob.membership_id).status,
        MembershipStatus::Active
    );
}

#[tokio::test]
async fn remove_cancels_an_open_invitation() {
    let t = team().await;
    let invite = t.invite("carol@example.com", "rep").await;
    team::remove(&t.w.deps, &t.owner_ctx, invite.membership_id)
        .await
        .unwrap();
    assert_eq!(
        t.w.membership(invite.membership_id).status,
        MembershipStatus::Removed
    );
    let entries = t.w.entries("team.remove");
    assert_eq!(
        entries[0].payload,
        json!({
            "user_id": null,
            "role_key": "rep",
            "previous_status": "invited",
            "revoked_api_key_ids": [],
        })
    );
    // The same email can be invited again.
    t.invite("carol@example.com", "rep").await;
}

#[tokio::test]
async fn remove_of_a_missing_or_removed_membership_is_not_found() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    team::remove(&t.w.deps, &t.owner_ctx, bob.membership_id)
        .await
        .unwrap();
    for id in [MembershipId::new_v7(), bob.membership_id] {
        let e = err(team::remove(&t.w.deps, &t.owner_ctx, id).await);
        assert_eq!(e.code, ErrorCode::NotFound);
    }
    assert_eq!(t.w.entries("team.remove").len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Who may grant what
// ---------------------------------------------------------------------------------------------

/// Asserts `FORBIDDEN` with `details.reason = "owner_only"`.
fn assert_owner_only(e: &AppError) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(e.details, json!({ "reason": "owner_only" }));
}

/// Asserts `FORBIDDEN` with `details.reason = "exceeds_own_authority"` and these missing keys.
fn assert_exceeds(e: &AppError, missing: &[&str]) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(
        e.details,
        json!({ "reason": "exceeds_own_authority", "missing": missing })
    );
}

#[tokio::test]
async fn manager_cannot_grant_owner() {
    let t = team().await;
    let manager = t.join("manager@example.com", "manager").await;
    let bob = t.join("bob@example.com", "rep").await;

    let e = err(team::invite(
        &t.w.deps,
        &manager.ctx,
        invite_input("carol@example.com", "owner"),
    )
    .await);
    assert_owner_only(&e);
    for target in [manager.membership_id, bob.membership_id] {
        let e = err(team::set_role(&t.w.deps, &manager.ctx, target, "owner").await);
        assert_owner_only(&e);
    }
    assert_eq!(
        t.w.membership(manager.membership_id).role_id,
        t.role_id("manager")
    );
    assert_eq!(t.w.entries("team.invite").len(), 2, "only the two joins");
    assert!(t.w.entries("team.set_role").is_empty());

    // Every other role is the manager's to give.
    team::invite(
        &t.w.deps,
        &manager.ctx,
        invite_input("carol@example.com", "manager"),
    )
    .await
    .unwrap();
    team::set_role(&t.w.deps, &manager.ctx, bob.membership_id, "manager")
        .await
        .unwrap();
}

#[tokio::test]
async fn manager_cannot_change_or_remove_an_owner() {
    let t = team().await;
    let manager = t.join("manager@example.com", "manager").await;
    // Two owners, so the last-owner rule is not what refuses.
    let second = t.join("second@example.com", "rep").await;
    team::set_role(&t.w.deps, &t.owner_ctx, second.membership_id, "owner")
        .await
        .unwrap();
    let pending_owner = t.invite("carol@example.com", "owner").await;

    for owner in [t.owner_membership, second.membership_id] {
        let e = err(team::set_role(&t.w.deps, &manager.ctx, owner, "rep").await);
        assert_owner_only(&e);
        let e = err(team::remove(&t.w.deps, &manager.ctx, owner).await);
        assert_owner_only(&e);
        assert_eq!(t.w.membership(owner).status, MembershipStatus::Active);
        assert_eq!(t.w.membership(owner).role_id, t.role_id("owner"));
    }
    // An invitation to the owner role is the owners' to cancel.
    let e = err(team::remove(&t.w.deps, &manager.ctx, pending_owner.membership_id).await);
    assert_owner_only(&e);
    assert!(t.w.entries("team.remove").is_empty());
}

#[tokio::test]
async fn owner_can_grant_owner() {
    let t = team().await;
    let bob = t.join("bob@example.com", "manager").await;
    let out = team::set_role(&t.w.deps, &t.owner_ctx, bob.membership_id, "owner")
        .await
        .unwrap();
    assert_eq!(out.role_key, "owner");

    let carol = t.invite("carol@example.com", "owner").await;
    let accepted = team::accept_invite(
        &t.w.deps,
        new_user(&carol.invite_token, "carol@example.com"),
    )
    .await
    .unwrap();
    let session = accepted.session.unwrap();
    assert_eq!(session.me.memberships[0].role_key, "owner");

    // The new owner, on their next request, may change the founding owner's role.
    let carol_ctx = t.ctx_of(&session.token).await;
    assert_eq!(carol_ctx.role_key.as_deref(), Some("owner"));
    team::set_role(&t.w.deps, &carol_ctx, t.owner_membership, "manager")
        .await
        .unwrap();
}

#[tokio::test]
async fn custom_role_cannot_grant_permissions_it_lacks() {
    let t = team().await;
    roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("team_lead", &["workspace.read", "team.manage"]),
    )
    .await
    .unwrap();
    let lead = t.join("lead@example.com", "team_lead").await;
    let bob = t.join("bob@example.com", "rep").await;
    let auditor = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("auditor", &["ledger.read"]),
    )
    .await
    .unwrap();
    let missing = [
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
    ];

    // invite and set_role to a role wider than the lead's own.
    let e = err(team::invite(
        &t.w.deps,
        &lead.ctx,
        invite_input("carol@example.com", "manager"),
    )
    .await);
    assert_exceeds(&e, &missing);
    let e = err(team::set_role(&t.w.deps, &lead.ctx, bob.membership_id, "manager").await);
    assert_exceeds(&e, &missing);
    let e = err(team::set_role(&t.w.deps, &lead.ctx, bob.membership_id, "auditor").await);
    assert_exceeds(&e, &["ledger.read", "inbox.work", "calls.work"]);

    // roles.create and roles.update with permissions the lead lacks.
    let e = err(roles::create(
        &t.w.deps,
        &lead.ctx,
        create_input("keys", &["workspace.read", "api_keys.manage"]),
    )
    .await);
    assert_exceeds(&e, &["api_keys.manage"]);
    let e = err(roles::update(
        &t.w.deps,
        &lead.ctx,
        auditor.id,
        vec!["ledger.read".into(), "workspace.read".into()],
    )
    .await);
    assert_exceeds(&e, &["ledger.read"]);

    assert!(t.w.entries("team.set_role").is_empty());
    assert!(t.w.entries("roles.update").is_empty());
    assert_eq!(t.w.entries("roles.create").len(), 2);
    assert_eq!(t.w.membership(bob.membership_id).role_id, t.role_id("rep"));

    // The unchanged custom role cannot grant or strip a Rep's inbox and calls permissions.
    let e = err(team::invite(
        &t.w.deps,
        &lead.ctx,
        invite_input("carol@example.com", "rep"),
    )
    .await);
    assert_exceeds(&e, &["inbox.work", "calls.work"]);
    let e = err(team::set_role(&t.w.deps, &lead.ctx, bob.membership_id, "team_lead").await);
    assert_exceeds(&e, &["inbox.work", "calls.work"]);
    assert_eq!(t.w.membership(bob.membership_id).role_id, t.role_id("rep"));
    assert!(t.w.entries("team.set_role").is_empty());

    // Within its own permissions the lead may still act.
    let helper = roles::create(
        &t.w.deps,
        &lead.ctx,
        create_input("helper", &["workspace.read"]),
    )
    .await
    .unwrap();
    roles::update(
        &t.w.deps,
        &lead.ctx,
        helper.id,
        vec!["workspace.read".into(), "team.manage".into()],
    )
    .await
    .unwrap();
}

/// The workspace with a custom `team_lead` role (`team.manage`, `workspace.read`) held by
/// `lead`, a `manager` and a `rep`.
struct LeadTeam {
    t: Team,
    lead: Member,
    manager: Member,
    rep: Member,
}

async fn lead_team() -> LeadTeam {
    let t = team().await;
    roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("team_lead", &["workspace.read", "team.manage"]),
    )
    .await
    .unwrap();
    let lead = t.join("lead@example.com", "team_lead").await;
    let manager = t.join("manager@example.com", "manager").await;
    let rep = t.join("rep@example.com", "rep").await;
    LeadTeam {
        t,
        lead,
        manager,
        rep,
    }
}

#[tokio::test]
async fn custom_role_cannot_demote_or_remove_a_manager() {
    let LeadTeam {
        t, lead, manager, ..
    } = lead_team().await;
    // Even to a role the lead may give, and even out of the workspace: the manager's present
    // authority exceeds the lead's own.
    let missing = [
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
    ];
    for role_key in ["rep", "team_lead"] {
        let e = err(team::set_role(&t.w.deps, &lead.ctx, manager.membership_id, role_key).await);
        assert_exceeds(&e, &missing);
    }
    let e = err(team::remove(&t.w.deps, &lead.ctx, manager.membership_id).await);
    assert_exceeds(&e, &missing);
    // Nor may it cancel an invitation to a role wider than its own.
    let pending = t.invite("carol@example.com", "manager").await;
    let e = err(team::remove(&t.w.deps, &lead.ctx, pending.membership_id).await);
    assert_exceeds(&e, &missing);

    let m = t.w.membership(manager.membership_id);
    assert_eq!(m.status, MembershipStatus::Active);
    assert_eq!(m.role_id, t.role_id("manager"));
    assert_eq!(
        t.w.membership(pending.membership_id).status,
        MembershipStatus::Invited
    );
    assert!(t.w.entries("team.set_role").is_empty());
    assert!(t.w.entries("team.remove").is_empty());
}

#[tokio::test]
async fn custom_role_cannot_strip_permissions_it_lacks_via_roles_update() {
    let LeadTeam { t, lead, .. } = lead_team().await;
    let keys = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("key_keeper", &["workspace.read", "api_keys.manage"]),
    )
    .await
    .unwrap();

    // Narrowing the role to what the lead holds would strip `api_keys.manage` from its members.
    let e = err(roles::update(&t.w.deps, &lead.ctx, keys.id, vec!["workspace.read".into()]).await);
    assert_exceeds(&e, &["api_keys.manage"]);
    // Emptying it too.
    let e = err(roles::update(&t.w.deps, &lead.ctx, keys.id, Vec::new()).await);
    assert_exceeds(&e, &["api_keys.manage"]);
    let stored = roles::list(&t.w.deps, &t.owner_ctx)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.id == keys.id)
        .unwrap();
    assert_eq!(stored.permissions, keys.permissions);
    assert!(t.w.entries("roles.update").is_empty());
}

#[tokio::test]
async fn owner_can_still_do_all_of_these() {
    let LeadTeam { t, manager, .. } = lead_team().await;
    let keys = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("key_keeper", &["workspace.read", "api_keys.manage"]),
    )
    .await
    .unwrap();

    roles::update(
        &t.w.deps,
        &t.owner_ctx,
        keys.id,
        vec!["workspace.read".into()],
    )
    .await
    .unwrap();
    let out = team::set_role(&t.w.deps, &t.owner_ctx, manager.membership_id, "rep")
        .await
        .unwrap();
    assert_eq!(out.role_key, "rep");
    team::set_role(&t.w.deps, &t.owner_ctx, manager.membership_id, "manager")
        .await
        .unwrap();
    let pending = t.invite("carol@example.com", "manager").await;
    team::remove(&t.w.deps, &t.owner_ctx, pending.membership_id)
        .await
        .unwrap();
    team::remove(&t.w.deps, &t.owner_ctx, manager.membership_id)
        .await
        .unwrap();
    assert_eq!(
        t.w.membership(manager.membership_id).status,
        MembershipStatus::Removed
    );
}

#[tokio::test]
async fn manager_can_change_a_rep() {
    let LeadTeam {
        t,
        manager,
        rep,
        lead,
    } = lead_team().await;
    let out = team::set_role(&t.w.deps, &manager.ctx, rep.membership_id, "team_lead")
        .await
        .unwrap();
    assert_eq!(out.role_key, "team_lead");
    team::set_role(&t.w.deps, &manager.ctx, rep.membership_id, "rep")
        .await
        .unwrap();
    // The unchanged custom lead lacks InboxWork and CallsWork, so cannot change or remove a Rep.
    for role_key in ["team_lead", "rep"] {
        let e = err(team::set_role(&t.w.deps, &lead.ctx, rep.membership_id, role_key).await);
        assert_exceeds(&e, &["inbox.work", "calls.work"]);
    }
    let e = err(team::remove(&t.w.deps, &lead.ctx, rep.membership_id).await);
    assert_exceeds(&e, &["inbox.work", "calls.work"]);
    assert_eq!(t.w.membership(rep.membership_id).role_id, t.role_id("rep"));
    team::remove(&t.w.deps, &manager.ctx, rep.membership_id)
        .await
        .unwrap();
    assert_eq!(t.w.entries("team.set_role").len(), 2);
}

#[tokio::test]
async fn owner_can_create_role_with_any_permissions() {
    let t = team().await;
    let all: Vec<&str> = Permission::all().iter().map(Permission::key).collect();
    let role = roles::create(&t.w.deps, &t.owner_ctx, create_input("deputy", &all))
        .await
        .unwrap();
    assert_eq!(
        role.permissions,
        Permission::all().iter().copied().collect()
    );
    let updated = roles::update(
        &t.w.deps,
        &t.owner_ctx,
        role.id,
        all.iter().map(|k| (*k).to_owned()).collect(),
    )
    .await
    .unwrap();
    assert_eq!(updated.permissions, role.permissions);
}

// ---------------------------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------------------------

fn create_input(key: &str, permissions: &[&str]) -> CreateRole {
    CreateRole {
        key: key.into(),
        name: format!("Role {key}"),
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
    }
}

#[tokio::test]
async fn roles_list_shows_the_system_roles_and_needs_workspace_read() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let roles = roles::list(&t.w.deps, &bob.ctx).await.unwrap();
    let keys: Vec<(&str, bool)> = roles
        .iter()
        .map(|r| (r.key.as_str(), r.is_system))
        .collect();
    assert_eq!(
        keys,
        vec![("owner", true), ("manager", true), ("rep", true)]
    );

    let e = err(roles::list(&t.w.deps, &without(&bob.ctx, &[Permission::WorkspaceRead])).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn roles_mutations_require_team_manage() {
    let t = team().await;
    let bob = t.join("bob@example.com", "rep").await;
    let custom = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("analyst", &["ledger.read"]),
    )
    .await
    .unwrap();

    let e = err(roles::create(&t.w.deps, &bob.ctx, create_input("viewer", &[])).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = err(roles::update(
        &t.w.deps,
        &bob.ctx,
        custom.id,
        vec!["workspace.read".into()],
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = err(roles::delete(&t.w.deps, &bob.ctx, custom.id).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(t.w.entries("roles.create").len(), 1);
    assert!(t.w.entries("roles.update").is_empty());
    assert!(t.w.entries("roles.delete").is_empty());
}

#[tokio::test]
async fn roles_create_stores_a_custom_role_and_ledgers_it() {
    let t = team().await;
    let role = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        CreateRole {
            key: "sales_lead".into(),
            name: "  Satış Lideri ".into(),
            permissions: vec![
                "ledger.read".into(),
                "workspace.read".into(),
                "ledger.read".into(),
            ],
        },
    )
    .await
    .unwrap();
    assert_eq!(role.key, "sales_lead");
    assert_eq!(role.name, "Satış Lideri");
    assert_eq!(
        role.permissions,
        BTreeSet::from([Permission::WorkspaceRead, Permission::LedgerRead])
    );
    assert!(!role.is_system);
    let listed = roles::list(&t.w.deps, &t.owner_ctx).await.unwrap();
    assert_eq!(listed.last(), Some(&role));

    let entries = t.w.entries("roles.create");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].actor, Actor::Human { user_id: t.owner });
    assert_eq!(entries[0].subject, role_subject(role.id));
    assert_eq!(
        entries[0].payload,
        json!({ "key": "sales_lead", "name": "Satış Lideri", "permissions": ["workspace.read", "ledger.read"] })
    );

    // The role can be given to members.
    let bob = t.join("bob@example.com", "sales_lead").await;
    assert_eq!(
        bob.ctx.permissions,
        BTreeSet::from([Permission::WorkspaceRead, Permission::LedgerRead])
    );
}

#[tokio::test]
async fn roles_create_validates_the_key_name_and_permissions() {
    let t = team().await;
    let too_long = "x".repeat(33);
    for key in [
        "a",
        "Analyst",
        "has-dash",
        "has space",
        "",
        too_long.as_str(),
    ] {
        let e = err(roles::create(&t.w.deps, &t.owner_ctx, create_input(key, &[])).await);
        assert_eq!(e.code, ErrorCode::Validation, "{key:?}");
        assert_eq!(e.details, json!({ "field": "key" }), "{key:?}");
    }
    for key in ["owner", "manager", "rep"] {
        let e = err(roles::create(&t.w.deps, &t.owner_ctx, create_input(key, &[])).await);
        assert_eq!(e.code, ErrorCode::Validation, "{key}");
        assert_eq!(e.details, json!({ "field": "key" }), "{key}");
    }
    let e = err(roles::create(
        &t.w.deps,
        &t.owner_ctx,
        CreateRole {
            name: "  ".into(),
            ..create_input("analyst", &[])
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "field": "name" }));

    let e = err(roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("analyst", &["ledger.read", "bogus", "team.MANAGE"]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "unknown": ["bogus", "team.MANAGE"] }));

    // Two-character and 32-character keys of the allowed alphabet are fine.
    let longest = "ab_1".repeat(8);
    for key in ["ab", longest.as_str()] {
        roles::create(&t.w.deps, &t.owner_ctx, create_input(key, &[]))
            .await
            .unwrap();
    }
    assert_eq!(t.w.entries("roles.create").len(), 2);
}

#[tokio::test]
async fn roles_create_with_a_taken_key_is_conflict() {
    let t = team().await;
    roles::create(&t.w.deps, &t.owner_ctx, create_input("analyst", &[]))
        .await
        .unwrap();
    let e = err(roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("analyst", &["ledger.read"]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(t.w.entries("roles.create").len(), 1);
}

#[tokio::test]
async fn roles_update_replaces_custom_permissions_but_not_system_ones() {
    let t = team().await;
    let role = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("analyst", &["ledger.read"]),
    )
    .await
    .unwrap();

    let updated = roles::update(
        &t.w.deps,
        &t.owner_ctx,
        role.id,
        vec!["workspace.read".into(), "api_keys.manage".into()],
    )
    .await
    .unwrap();
    assert_eq!(updated.id, role.id);
    assert_eq!(
        updated.permissions,
        BTreeSet::from([Permission::WorkspaceRead, Permission::ApiKeysManage])
    );
    let entries = t.w.entries("roles.update");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].subject, role_subject(role.id));
    assert_eq!(
        entries[0].payload,
        json!({ "key": "analyst", "permissions": ["workspace.read", "api_keys.manage"] })
    );

    let e = err(roles::update(&t.w.deps, &t.owner_ctx, t.role_id("rep"), vec![]).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = err(roles::update(&t.w.deps, &t.owner_ctx, RoleId::new_v7(), vec![]).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = err(roles::update(&t.w.deps, &t.owner_ctx, role.id, vec!["nope".into()]).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "unknown": ["nope"] }));
    assert_eq!(t.w.entries("roles.update").len(), 1);
}

#[tokio::test]
async fn roles_delete_removes_an_unused_custom_role_only() {
    let t = team().await;
    let unused = roles::create(&t.w.deps, &t.owner_ctx, create_input("analyst", &[]))
        .await
        .unwrap();
    let used = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("viewer", &["workspace.read"]),
    )
    .await
    .unwrap();
    t.join("bob@example.com", "viewer").await;

    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, t.role_id("rep")).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, used.id).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, RoleId::new_v7()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(t.w.entries("roles.delete").is_empty());

    roles::delete(&t.w.deps, &t.owner_ctx, unused.id)
        .await
        .unwrap();
    let keys: Vec<String> = roles::list(&t.w.deps, &t.owner_ctx)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.key)
        .collect();
    assert_eq!(keys, vec!["owner", "manager", "rep", "viewer"]);
    let entries = t.w.entries("roles.delete");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].subject, role_subject(unused.id));
    assert_eq!(entries[0].payload, json!({ "key": "analyst" }));
    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, unused.id).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

/// A custom role is in use while a member or an open invitation holds it; once both are removed
/// it can be deleted, and the removed memberships move to the system `rep` role (their last role
/// stays on record in the `team.remove` ledger entries).
#[tokio::test]
async fn used_then_removed_role_can_be_deleted() {
    let t = team().await;
    let viewer = roles::create(
        &t.w.deps,
        &t.owner_ctx,
        create_input("viewer", &["workspace.read"]),
    )
    .await
    .unwrap();
    let bob = t.join("bob@example.com", "viewer").await;
    let carol = t.invite("carol@example.com", "viewer").await;

    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, viewer.id).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    team::remove(&t.w.deps, &t.owner_ctx, bob.membership_id)
        .await
        .unwrap();
    // The open invitation still holds it.
    let e = err(roles::delete(&t.w.deps, &t.owner_ctx, viewer.id).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    team::remove(&t.w.deps, &t.owner_ctx, carol.membership_id)
        .await
        .unwrap();
    assert!(t.w.entries("roles.delete").is_empty());

    roles::delete(&t.w.deps, &t.owner_ctx, viewer.id)
        .await
        .unwrap();
    let keys: Vec<String> = roles::list(&t.w.deps, &t.owner_ctx)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.key)
        .collect();
    assert_eq!(keys, vec!["owner", "manager", "rep"]);
    for id in [bob.membership_id, carol.membership_id] {
        let m = t.w.membership(id);
        assert_eq!(m.status, MembershipStatus::Removed);
        assert_eq!(m.role_id, t.role_id("rep"));
    }
    let entries = t.w.entries("roles.delete");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].subject, role_subject(viewer.id));
    assert_eq!(entries[0].payload, json!({ "key": "viewer" }));
    let removed: Vec<_> =
        t.w.entries("team.remove")
            .into_iter()
            .map(|e| e.payload["role_key"].clone())
            .collect();
    assert_eq!(removed, vec![json!("viewer"), json!("viewer")]);
}
