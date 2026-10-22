//! The fakes keep the port contracts that use-case tests rely on.

use std::collections::BTreeSet;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{
    ApiKeyRow, ApiKeyStatus, Clock, IdGen, LedgerFilter, MembershipRow, PasswordHasher, SecretBox,
    SessionRow, TokenGen, UnitOfWork, UserRow,
};
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_tenancy::{
    ApiKeyId, Email, MembershipId, MembershipStatus, Permission, RoleDef, RoleId, SessionId,
    SystemRole, UserId, WorkspaceId, WorkspaceStatus,
};
use jt_testkit::fakes::{
    FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox, SeqIdGen,
};
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

#[tokio::test]
async fn service_fakes_are_deterministic() {
    assert_eq!(FixedClock(T0).now(), T0);

    let ids = SeqIdGen::new();
    assert_eq!(ids.uuid(), Uuid::from_u128(1));
    assert_eq!(ids.uuid(), Uuid::from_u128(2));

    let tokens = FixedTokenGen::new(["first", "second"]);
    assert_eq!(tokens.token(32), "first");
    assert_eq!(tokens.token(32), "second");

    let hash = PlainHasher.hash("correct horse").await.unwrap();
    assert_eq!(hash, "plain:correct horse");
    assert!(PlainHasher.verify("correct horse", &hash).await.unwrap());
    assert!(!PlainHasher.verify("wrong", &hash).await.unwrap());
    assert_eq!(
        code(PlainHasher.verify("x", "$argon2id$...").await.unwrap_err()),
        ErrorCode::Internal
    );
}

/// The plain secret box seals in the clear under its workspace and keeps the port's refusal.
#[test]
fn plain_secret_box_opens_only_for_its_workspace() {
    let ws = WorkspaceId(Uuid::from_u128(1));
    let other = WorkspaceId(Uuid::from_u128(2));
    let sealed = PlainSecretBox.seal(ws, b"jt_live_secret").unwrap();
    assert_eq!(
        sealed,
        format!("plain:{ws}:jt_live_secret").into_bytes(),
        "readable in tests"
    );
    assert_eq!(
        PlainSecretBox.open(ws, &sealed).unwrap().as_slice(),
        b"jt_live_secret"
    );
    for refused in [
        PlainSecretBox.open(other, &sealed),
        PlainSecretBox.open(ws, b"jt_live_secret"),
    ] {
        let e = refused.unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
        assert_eq!(e.message, "sealed data cannot be opened");
    }
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
async fn api_keys_revoke_all_for_user_revokes_only_that_users_active_keys_here() {
    let uow = InMemoryUow::new();
    let (a, user_a, _) = register(&uow, "a@example.com", "a").await;
    let (b, user_b, _) = register(&uow, "b@example.com", "b").await;
    let key =
        |ws: WorkspaceId, by: UserId, hash: &str, revoked_at: Option<OffsetDateTime>| ApiKeyRow {
            id: ApiKeyId::new_v7(),
            workspace_id: ws,
            name: hash.into(),
            prefix: "jt_live_x".into(),
            key_hash: hash.into(),
            scopes: BTreeSet::from([Permission::WorkspaceRead]),
            issued_by: by,
            status: if revoked_at.is_some() {
                ApiKeyStatus::Revoked
            } else {
                ApiKeyStatus::Active
            },
            created_at: T0,
            last_used_at: None,
            revoked_at,
        };
    let (k1, k2) = (key(a, user_a, "h1", None), key(a, user_a, "h2", None));
    let old = key(a, user_a, "h-old", Some(T0));
    let others = key(a, user_b, "h-b", None);
    let elsewhere = key(b, user_a, "h-elsewhere", None);
    let mut t = uow.tenant(a).await.unwrap();
    for k in [&k1, &k2, &old, &others] {
        t.api_keys().insert(k.clone()).await.unwrap();
    }
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.api_keys().insert(elsewhere.clone()).await.unwrap();
    t.commit().await.unwrap();

    let at = T0 + Duration::hours(1);
    let mut t = uow.tenant(a).await.unwrap();
    let mut expected = vec![k1.id, k2.id];
    expected.sort();
    assert_eq!(
        t.api_keys().revoke_all_for_user(user_a, at).await.unwrap(),
        expected
    );
    assert!(
        t.api_keys()
            .revoke_all_for_user(user_a, at)
            .await
            .unwrap()
            .is_empty(),
        "the working copy already sees them revoked"
    );
    // Nothing is shared before commit.
    assert!(
        uow.snapshot()
            .api_keys
            .iter()
            .all(|k| k.id == old.id || k.status == ApiKeyStatus::Active)
    );
    t.commit().await.unwrap();

    let state = |id: ApiKeyId| {
        let k = uow
            .snapshot()
            .api_keys
            .into_iter()
            .find(|k| k.id == id)
            .unwrap();
        (k.status, k.revoked_at)
    };
    assert_eq!(state(k1.id), (ApiKeyStatus::Revoked, Some(at)));
    assert_eq!(state(k2.id), (ApiKeyStatus::Revoked, Some(at)));
    assert_eq!(state(old.id), (ApiKeyStatus::Revoked, Some(T0)));
    assert_eq!(state(others.id), (ApiKeyStatus::Active, None));
    assert_eq!(state(elsewhere.id), (ApiKeyStatus::Active, None));
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

    // Refusals, probed in a bundle that is then dropped: a bundle that saw an error never
    // commits.
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
    assert_eq!(
        code(
            t.memberships()
                .remove(MembershipId::new_v7())
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    drop(t);

    let mut t = uow.tenant(ws).await.unwrap();
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

    t.memberships().activate(invite, invitee, T0).await.unwrap();
    let activated = t.memberships().find(invite).await.unwrap().unwrap();
    assert_eq!(activated.invite_token_hash, None);
    assert_eq!(activated.invite_expires_at, None);
    assert_eq!(activated.invited_email, Some(email("invitee@example.com")));
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
    t.commit().await.unwrap();

    // Only an open invitation can be activated.
    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(
            t.memberships()
                .activate(invite, invitee, T0)
                .await
                .unwrap_err()
        ),
        ErrorCode::Conflict
    );
    drop(t);

    // The spent token is found no more.
    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.membership_find_by_invite_hash("invite-hash")
            .await
            .unwrap(),
        None
    );
    assert_eq!(p.workspace_member_count(ws).await.unwrap(), 1);
}

#[tokio::test]
async fn invitations_activate_only_while_open_and_also_from_the_user_bundle() {
    let uow = InMemoryUow::new();
    let (ws, owner, _) = register(&uow, "owner@example.com", "acme").await;
    let (other, _, _) = register(&uow, "other@example.com", "other").await;
    let rep = {
        let mut t = uow.tenant(ws).await.unwrap();
        t.roles().find_by_key("rep").await.unwrap().unwrap()
    };
    let invite = MembershipId::new_v7();
    let expires_at = T0 + Duration::days(7);
    let mut t = uow.tenant(ws).await.unwrap();
    t.memberships()
        .insert_invite(MembershipRow {
            id: invite,
            workspace_id: ws,
            user_id: None,
            role_id: rep.id,
            status: MembershipStatus::Invited,
            invited_email: Some(email("bob@example.com")),
            invite_token_hash: Some("invite-hash".into()),
            invite_expires_at: Some(expires_at),
            invited_by: Some(owner),
            created_at: T0,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let bob = UserRow {
        id: UserId::new_v7(),
        email: email("bob@example.com"),
        password_hash: "plain:pw".into(),
        display_name: "Bob".into(),
        created_at: T0,
    };

    // Expired at the expiry instant; another workspace's id is unknown.
    let mut u = uow.user().await.unwrap();
    u.users().insert(bob.clone()).await.unwrap();
    assert_eq!(
        code(
            u.memberships_activate(ws, invite, bob.id, expires_at)
                .await
                .unwrap_err()
        ),
        ErrorCode::Conflict
    );
    drop(u);
    let mut u = uow.user().await.unwrap();
    u.users().insert(bob.clone()).await.unwrap();
    assert_eq!(
        code(
            u.memberships_activate(other, invite, bob.id, T0)
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    drop(u);

    // One user-level transaction creates the user and activates the invitation.
    let mut u = uow.user().await.unwrap();
    u.users().insert(bob.clone()).await.unwrap();
    u.memberships_activate(ws, invite, bob.id, expires_at - Duration::seconds(1))
        .await
        .unwrap();
    assert_eq!(u.memberships_of_user(bob.id).await.unwrap().len(), 1);
    u.commit().await.unwrap();
    let m = uow
        .snapshot()
        .memberships
        .into_iter()
        .find(|m| m.id == invite)
        .unwrap();
    assert_eq!(m.status, MembershipStatus::Active);
    assert_eq!(m.user_id, Some(bob.id));
    assert_eq!(m.invite_token_hash, None);
    assert_eq!(m.invite_expires_at, None);
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
    u.commit().await.unwrap();
    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(u.sessions().insert(live.clone()).await.unwrap_err()),
        ErrorCode::Conflict
    );
    drop(u);

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

#[tokio::test]
async fn a_failed_call_spoils_the_bundle_so_commit_fails() {
    let uow = InMemoryUow::new();
    let (ws, owner, _) = register(&uow, "owner@example.com", "acme").await;
    let spoiled = |e: AppError| {
        assert_eq!(e.code, ErrorCode::Internal);
        assert!(e.message.contains("nothing was committed"), "{}", e.message);
    };

    // User bundle: a good write, then a refused one; the commit refuses both.
    let mut u = uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: UserId::new_v7(),
            email: email("new@example.com"),
            password_hash: "plain:pw".into(),
            display_name: "New".into(),
            created_at: T0,
        })
        .await
        .unwrap();
    let dup = UserRow {
        id: UserId::new_v7(),
        email: email("owner@example.com"),
        password_hash: "plain:pw".into(),
        display_name: "Dup".into(),
        created_at: T0,
    };
    assert_eq!(
        code(u.users().insert(dup).await.unwrap_err()),
        ErrorCode::Conflict
    );
    spoiled(u.commit().await.unwrap_err());
    assert_eq!(uow.snapshot().users.len(), 1, "nothing was committed");

    // Tenant bundle.
    let mut t = uow.tenant(ws).await.unwrap();
    t.ledger()
        .append(entry(ws, owner, "test.kept", T0))
        .await
        .unwrap();
    assert_eq!(
        code(
            t.memberships()
                .remove(MembershipId::new_v7())
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    spoiled(t.commit().await.unwrap_err());
    assert_eq!(uow.snapshot().ledger.len(), 1);

    // Platform bundle.
    let mut p = uow.platform().await.unwrap();
    p.workspace_set_status(ws, WorkspaceStatus::Suspended)
        .await
        .unwrap();
    assert_eq!(
        code(
            p.workspace_set_status(WorkspaceId::new_v7(), WorkspaceStatus::Active)
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    spoiled(p.commit().await.unwrap_err());
    assert_eq!(uow.snapshot().workspaces[0].status, WorkspaceStatus::Active);
}

#[tokio::test]
async fn a_role_outside_the_workspace_is_not_found() {
    let uow = InMemoryUow::new();
    let (a, owner_a, _) = register(&uow, "a@example.com", "a").await;
    let (_, user_b, owner_role_b) = register(&uow, "b@example.com", "b").await;
    let invitation = |role_id: RoleId| MembershipRow {
        id: MembershipId::new_v7(),
        workspace_id: a,
        user_id: None,
        role_id,
        status: MembershipStatus::Invited,
        invited_email: Some(email("invitee@example.com")),
        invite_token_hash: Some(format!("hash-{role_id}")),
        invite_expires_at: Some(T0 + Duration::days(7)),
        invited_by: Some(owner_a),
        created_at: T0,
    };

    for role in [owner_role_b, RoleId::new_v7()] {
        let mut t = uow.tenant(a).await.unwrap();
        assert_eq!(
            code(
                t.memberships()
                    .insert_invite(invitation(role))
                    .await
                    .unwrap_err()
            ),
            ErrorCode::NotFound,
            "insert_invite"
        );
        drop(t);

        let mut t = uow.tenant(a).await.unwrap();
        let own = t
            .memberships()
            .find_by_user(owner_a)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            code(t.memberships().set_role(own.id, role).await.unwrap_err()),
            ErrorCode::NotFound,
            "set_role"
        );
        drop(t);

        let mut u = uow.user().await.unwrap();
        assert_eq!(
            code(
                u.memberships_insert_active(MembershipId::new_v7(), a, user_b, role, T0)
                    .await
                    .unwrap_err()
            ),
            ErrorCode::NotFound,
            "memberships_insert_active"
        );
    }
    assert_eq!(uow.snapshot().memberships.len(), 2);
}

#[tokio::test]
async fn role_insert_refuses_system_roles() {
    let uow = InMemoryUow::new();
    let (ws, _, _) = register(&uow, "owner@example.com", "acme").await;
    let mut t = uow.tenant(ws).await.unwrap();
    let system = RoleDef {
        id: RoleId::new_v7(),
        key: "auditor".into(),
        name: "Auditor".into(),
        permissions: BTreeSet::from([Permission::LedgerRead]),
        is_system: true,
    };
    assert_eq!(
        code(t.roles().insert(system).await.unwrap_err()),
        ErrorCode::Internal
    );
    drop(t);
    assert_eq!(uow.snapshot().roles.len(), 3);
}

#[tokio::test]
async fn a_missing_user_or_workspace_is_not_found() {
    let uow = InMemoryUow::new();
    let (ws, user, _) = register(&uow, "owner@example.com", "acme").await;
    let session = |user_id: UserId, current: Option<WorkspaceId>| SessionRow {
        id: SessionId::new_v7(),
        user_id,
        token_hash: format!("hash-{user_id}"),
        current_workspace_id: current,
        created_at: T0,
        expires_at: T0 + Duration::days(30),
        revoked_at: None,
    };
    let ghost_ws = WorkspaceId::new_v7();

    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(
            u.sessions()
                .insert(session(UserId::new_v7(), None))
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(
            u.sessions()
                .insert(session(user, Some(ghost_ws)))
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(
            u.ledger_append(entry(ghost_ws, user, "test.ghost", T0))
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
    drop(u);

    let mut t = uow.tenant(ws).await.unwrap();
    let rep = t.roles().find_by_key("rep").await.unwrap().unwrap();
    let invite = MembershipId::new_v7();
    t.memberships()
        .insert_invite(MembershipRow {
            id: invite,
            workspace_id: ws,
            user_id: None,
            role_id: rep.id,
            status: MembershipStatus::Invited,
            invited_email: Some(email("invitee@example.com")),
            invite_token_hash: Some("invite".into()),
            invite_expires_at: Some(T0 + Duration::days(7)),
            invited_by: Some(user),
            created_at: T0,
        })
        .await
        .unwrap();
    assert_eq!(
        code(
            t.memberships()
                .activate(invite, UserId::new_v7(), T0)
                .await
                .unwrap_err()
        ),
        ErrorCode::NotFound
    );
}
