//! The fakes keep the port contracts that use-case tests rely on.

use std::collections::BTreeSet;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{
    ApiKeyRow, ApiKeyStatus, Clock, IdGen, LedgerFilter, MembershipRow, PasswordHasher, SessionRow,
    TokenGen, UnitOfWork, UserRow,
};
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_tenancy::{
    ApiKeyId, Email, MembershipId, MembershipStatus, Permission, RoleDef, RoleId, SessionId,
    SystemRole, UserId, WorkspaceId, WorkspaceStatus,
};
use jt_testkit::fakes::{FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, SeqIdGen};
use serde_json::json;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const T0: OffsetDateTime = time::macros::datetime!(2026-10-22 09:00 UTC);

fn code(err: AppError) -> ErrorCode {
    err.code
}

fn email(s: &str) -> Email {
    Email::parse(s).unwrap()
}

fn system_roles() -> Vec<RoleDef> {
    [SystemRole::Owner, SystemRole::Manager, SystemRole::Rep]
        .into_iter()
        .map(|r| RoleDef {
            id: RoleId::new_v7(),
            key: r.key().to_owned(),
            name: r.key().to_owned(),
            permissions: r.permissions(),
            is_system: true,
        })
        .collect()
}

fn entry(ws: WorkspaceId, user: UserId, action: &str, at: OffsetDateTime) -> LedgerEntry {
    LedgerEntry::new(
        ws,
        Actor::Human { user_id: user },
        Action::new(action).unwrap(),
        json!({}),
        at,
    )
}

/// Registers `owner` with a workspace `slug`, as the registration use case does. Returns the
/// workspace, the user and the owner role.
async fn register(uow: &InMemoryUow, owner: &str, slug: &str) -> (WorkspaceId, UserId, RoleId) {
    let (ws, user, membership) = (
        WorkspaceId::new_v7(),
        UserId::new_v7(),
        MembershipId::new_v7(),
    );
    let roles = system_roles();
    let owner_role = roles[0].id;
    let mut u = uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: email(owner),
            password_hash: "plain:pw".into(),
            display_name: "Owner".into(),
            created_at: T0,
        })
        .await
        .unwrap();
    u.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, T0)
        .await
        .unwrap();
    u.roles_create_system(ws, &roles).await.unwrap();
    u.memberships_insert_active(membership, ws, user, owner_role, T0)
        .await
        .unwrap();
    u.ledger_append(entry(ws, user, "auth.register", T0))
        .await
        .unwrap();
    u.commit().await.unwrap();
    (ws, user, owner_role)
}

#[test]
fn service_fakes_are_deterministic() {
    assert_eq!(FixedClock(T0).now(), T0);

    let ids = SeqIdGen::new();
    assert_eq!(ids.uuid(), Uuid::from_u128(1));
    assert_eq!(ids.uuid(), Uuid::from_u128(2));

    let tokens = FixedTokenGen::new(["first", "second"]);
    assert_eq!(tokens.token(32), "first");
    assert_eq!(tokens.token(32), "second");

    let hash = PlainHasher.hash("correct horse").unwrap();
    assert_eq!(hash, "plain:correct horse");
    assert!(PlainHasher.verify("correct horse", &hash).unwrap());
    assert!(!PlainHasher.verify("wrong", &hash).unwrap());
    assert_eq!(
        code(PlainHasher.verify("x", "$argon2id$...").unwrap_err()),
        ErrorCode::Internal
    );
}

#[test]
#[should_panic(expected = "FixedTokenGen is exhausted")]
fn fixed_token_gen_panics_when_exhausted() {
    let tokens = FixedTokenGen::new(["only"]);
    tokens.token(32);
    tokens.token(32);
}

#[tokio::test]
async fn committed_writes_reach_every_bundle_and_uncommitted_ones_are_discarded() {
    let uow = InMemoryUow::new();
    let (ws, user, _) = register(&uow, "Owner@Example.com", "acme").await;

    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(t.roles().list().await.unwrap().len(), 3);
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);
    assert_eq!(t.workspace().get().await.unwrap().slug, "acme");
    drop(t);

    let mut p = uow.platform().await.unwrap();
    assert_eq!(p.workspaces_list().await.unwrap().len(), 1);
    assert_eq!(
        p.workspace_owner_email(ws).await.unwrap(),
        Some(email("owner@example.com"))
    );
    drop(p);

    let mut u = uow.user().await.unwrap();
    let views = u.memberships_of_user(user).await.unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].role_key, "owner");
    assert_eq!(views[0].workspace_slug, "acme");
    // Written but never committed.
    u.users()
        .insert(UserRow {
            id: UserId::new_v7(),
            email: email("ghost@example.com"),
            password_hash: "plain:pw".into(),
            display_name: "Ghost".into(),
            created_at: T0,
        })
        .await
        .unwrap();
    assert!(
        u.users()
            .find_by_email(&email("ghost@example.com"))
            .await
            .unwrap()
            .is_some(),
        "a bundle reads its own writes"
    );
    drop(u);

    let mut u = uow.user().await.unwrap();
    assert!(
        u.users()
            .find_by_email(&email("ghost@example.com"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(uow.snapshot().users.len(), 1);
}

#[tokio::test]
async fn tenant_bundle_sees_only_its_workspace_and_refuses_foreign_rows() {
    let uow = InMemoryUow::new();
    let (a, user_a, _) = register(&uow, "a@example.com", "a").await;
    let (b, _, _) = register(&uow, "b@example.com", "b").await;

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.roles().list().await.unwrap().len(), 3);
    assert_eq!(t.memberships().list().await.unwrap().len(), 1);
    assert_eq!(t.ledger().list(filter(10)).await.unwrap().len(), 1);

    let foreign = entry(b, user_a, "test.foreign", T0);
    assert_eq!(
        code(t.ledger().append(foreign).await.unwrap_err()),
        ErrorCode::Internal
    );
    let key = ApiKeyRow {
        id: ApiKeyId::new_v7(),
        workspace_id: b,
        name: "k".into(),
        prefix: "jt_live_x".into(),
        key_hash: "hash".into(),
        scopes: BTreeSet::from([Permission::WorkspaceRead]),
        issued_by: user_a,
        status: ApiKeyStatus::Active,
        created_at: T0,
        last_used_at: None,
        revoked_at: None,
    };
    assert_eq!(
        code(t.api_keys().insert(key).await.unwrap_err()),
        ErrorCode::Internal
    );
}

#[tokio::test]
async fn unique_keys_are_conflicts() {
    let uow = InMemoryUow::new();
    let (ws, _, _) = register(&uow, "taken@example.com", "taken").await;

    let mut u = uow.user().await.unwrap();
    let dup_user = UserRow {
        id: UserId::new_v7(),
        email: email("TAKEN@example.com"),
        password_hash: "plain:pw".into(),
        display_name: "Dup".into(),
        created_at: T0,
    };
    assert_eq!(
        code(u.users().insert(dup_user).await.unwrap_err()),
        ErrorCode::Conflict
    );
    let dup_slug = u
        .workspaces_create(
            WorkspaceId::new_v7(),
            "Other",
            "taken",
            WorkspaceStatus::PendingPayment,
            T0,
        )
        .await
        .unwrap_err();
    assert_eq!(code(dup_slug), ErrorCode::Conflict);
    drop(u);

    let mut t = uow.tenant(ws).await.unwrap();
    let dup_role = RoleDef {
        id: RoleId::new_v7(),
        key: "owner".into(),
        name: "Second owner".into(),
        permissions: BTreeSet::new(),
        is_system: false,
    };
    assert_eq!(
        code(t.roles().insert(dup_role).await.unwrap_err()),
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn roles_and_memberships_keep_their_contracts() {
    let uow = InMemoryUow::new();
    let (ws, owner, _) = register(&uow, "owner@example.com", "acme").await;
    let (_, invitee, _) = register(&uow, "invitee@example.com", "elsewhere").await;

    let mut t = uow.tenant(ws).await.unwrap();
    let rep = t.roles().find_by_key("rep").await.unwrap().unwrap();
    let owner_role = t.roles().find_by_key("owner").await.unwrap().unwrap();
    assert_eq!(
        code(t.roles().delete_custom(rep.id).await.unwrap_err()),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(t.roles().delete_custom(RoleId::new_v7()).await.unwrap_err()),
        ErrorCode::NotFound
    );

    let invite = MembershipId::new_v7();
    t.memberships()
        .insert_invite(MembershipRow {
            id: invite,
            workspace_id: ws,
            user_id: None,
            role_id: rep.id,
            status: MembershipStatus::Invited,
            invited_email: Some(email("invitee@example.com")),
            invite_token_hash: Some("invite-hash".into()),
            invite_expires_at: Some(T0 + Duration::days(7)),
            invited_by: Some(owner),
            created_at: T0 + Duration::minutes(1),
        })
        .await
        .unwrap();
    let members = t.memberships().list().await.unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[1].email, email("invitee@example.com"));
    assert_eq!(members[1].status, MembershipStatus::Invited);

    t.memberships().activate(invite, invitee).await.unwrap();
    assert_eq!(
        code(t.memberships().activate(invite, invitee).await.unwrap_err()),
        ErrorCode::Conflict
    );
    assert_eq!(
        t.memberships()
            .find_by_user(invitee)
            .await
            .unwrap()
            .unwrap()
            .status,
        MembershipStatus::Active
    );
    assert_eq!(t.roles().count_memberships_using(rep.id).await.unwrap(), 1);

    t.memberships()
        .set_role(invite, owner_role.id)
        .await
        .unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 2);
    t.memberships().remove(invite).await.unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);
    assert_eq!(
        code(
            t.memberships()
                .remove(MembershipId::new_v7())
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    t.commit().await.unwrap();

    let mut p = uow.platform().await.unwrap();
    let found = p
        .membership_find_by_invite_hash("invite-hash")
        .await
        .unwrap();
    assert_eq!(found.unwrap().status, MembershipStatus::Removed);
    assert_eq!(p.workspace_member_count(ws).await.unwrap(), 1);
}

fn filter(limit: u32) -> LedgerFilter {
    LedgerFilter {
        action_prefix: None,
        actor_kind: None,
        limit,
        before_id: None,
    }
}

#[tokio::test]
async fn ledger_lists_newest_first_with_filters_and_pages() {
    let uow = InMemoryUow::new();
    let (ws, user, _) = register(&uow, "owner@example.com", "acme").await;

    let mut t = uow.tenant(ws).await.unwrap();
    let invite = t
        .ledger()
        .append(entry(ws, user, "team.invite", T0 + Duration::minutes(1)))
        .await
        .unwrap();
    let remove = t
        .ledger()
        .append(entry(ws, user, "team.remove", T0 + Duration::minutes(2)))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let all = t.ledger().list(filter(10)).await.unwrap();
    let ids: Vec<i64> = all.iter().map(|r| r.id).collect();
    assert_eq!(ids, vec![remove, invite, 1]);

    let team = t
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("team.".into()),
            ..filter(10)
        })
        .await
        .unwrap();
    assert_eq!(team.len(), 2);

    let page = t
        .ledger()
        .list(LedgerFilter {
            before_id: Some(remove),
            ..filter(1)
        })
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].id, invite);

    let system = t
        .ledger()
        .list(LedgerFilter {
            actor_kind: Some("system".into()),
            ..filter(10)
        })
        .await
        .unwrap();
    assert!(system.is_empty());
}

#[tokio::test]
async fn sessions_revoke_once_and_per_workspace() {
    let uow = InMemoryUow::new();
    let (ws, user, _) = register(&uow, "owner@example.com", "acme").await;

    let session = |hash: &str, ws: Option<WorkspaceId>, expires: OffsetDateTime| SessionRow {
        id: SessionId::new_v7(),
        user_id: user,
        token_hash: hash.into(),
        current_workspace_id: ws,
        created_at: T0,
        expires_at: expires,
        revoked_at: None,
    };
    let live = session("live", Some(ws), T0 + Duration::days(30));
    let elsewhere = session("elsewhere", None, T0 + Duration::days(30));
    let mut u = uow.user().await.unwrap();
    u.sessions().insert(live.clone()).await.unwrap();
    u.sessions().insert(elsewhere.clone()).await.unwrap();
    assert_eq!(
        code(u.sessions().insert(live.clone()).await.unwrap_err()),
        ErrorCode::Conflict
    );
    u.commit().await.unwrap();

    let now = T0 + Duration::hours(1);
    let mut u = uow.user().await.unwrap();
    u.sessions()
        .revoke_all_for_workspace(user, ws, now)
        .await
        .unwrap();
    u.sessions()
        .revoke(live.id, now + Duration::hours(1))
        .await
        .unwrap();
    u.commit().await.unwrap();

    let mut u = uow.user().await.unwrap();
    let live_after = u.sessions().find_by_token_hash("live").await.unwrap();
    assert_eq!(live_after.unwrap().revoked_at, Some(now));
    let other_after = u.sessions().find_by_token_hash("elsewhere").await.unwrap();
    assert_eq!(other_after.unwrap().revoked_at, None);
}
