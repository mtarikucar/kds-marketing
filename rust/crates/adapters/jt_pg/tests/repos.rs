//! Repositories and the unit of work against a real database: every repo's contract, the error
//! mapping, workspace scoping, and that a bundle commits or rolls back as one transaction.

use std::collections::BTreeSet;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{
    AgentConnectionRow, ApiKeyRow, ApiKeyStatus, LedgerFilter, MemberOut, MembershipRow,
    MembershipView, OperatorRow, PlatformSessionRow, SessionRow, UnitOfWork, UserRow,
};
use jt_ledger::{Action, Actor, LedgerEntry, Subject};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, MembershipStatus, OperatorId, Permission,
    RoleDef, RoleId, SessionId, SystemRole, UserId, WorkspaceId, WorkspaceStatus,
};
use jt_testkit::TestDb;
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// A fixed instant after any `now()` a seeded row gets, so explicit times sort after seeded ones.
const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

fn uow(db: &TestDb) -> PgUnitOfWork {
    PgUnitOfWork::new(db.pool.clone())
}

fn email(s: &str) -> Email {
    Email::parse(s).unwrap()
}

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn user_row(addr: &str) -> UserRow {
    UserRow {
        id: UserId::new_v7(),
        email: email(addr),
        password_hash: "plain:pw".into(),
        display_name: format!("User {addr}"),
        created_at: T0,
    }
}

/// Inserts and commits a user.
async fn new_user(uow: &PgUnitOfWork, addr: &str) -> UserRow {
    let row = user_row(addr);
    let mut u = uow.user().await.unwrap();
    u.users().insert(row.clone()).await.unwrap();
    u.commit().await.unwrap();
    row
}

async fn role(uow: &PgUnitOfWork, ws: WorkspaceId, key: &str) -> RoleDef {
    let mut t = uow.tenant(ws).await.unwrap();
    t.roles().find_by_key(key).await.unwrap().unwrap()
}

fn custom_role(key: &str) -> RoleDef {
    RoleDef {
        id: RoleId::new_v7(),
        key: key.into(),
        name: format!("Role {key}"),
        permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::LedgerRead]),
        is_system: false,
    }
}

fn invite(ws: WorkspaceId, role: RoleId, by: UserId, addr: &str, hash: &str) -> MembershipRow {
    MembershipRow {
        id: MembershipId::new_v7(),
        workspace_id: ws,
        user_id: None,
        role_id: role,
        status: MembershipStatus::Invited,
        invited_email: Some(email(addr)),
        invite_token_hash: Some(hash.into()),
        invite_expires_at: Some(T0 + Duration::days(7)),
        invited_by: Some(by),
        created_at: T0,
    }
}

fn api_key(ws: WorkspaceId, by: UserId, hash: &str) -> ApiKeyRow {
    ApiKeyRow {
        id: ApiKeyId::new_v7(),
        workspace_id: ws,
        name: format!("key {hash}"),
        prefix: "jt_live_abcd".into(),
        key_hash: hash.into(),
        scopes: BTreeSet::from([Permission::WorkspaceRead]),
        issued_by: by,
        status: ApiKeyStatus::Active,
        created_at: T0,
        last_used_at: None,
        revoked_at: None,
    }
}

fn connection(
    ws: WorkspaceId,
    key: ApiKeyId,
    version: &str,
    at: OffsetDateTime,
) -> AgentConnectionRow {
    AgentConnectionRow {
        id: AgentConnectionId::new_v7(),
        workspace_id: ws,
        api_key_id: key,
        client_name: "agent-cli".into(),
        client_version: version.into(),
        protocol_version: "2025-06-18".into(),
        first_seen_at: at,
        last_seen_at: at,
        tool_calls: 0,
    }
}

fn entry(ws: WorkspaceId, actor: Actor, action: &str, at: OffsetDateTime) -> LedgerEntry {
    LedgerEntry::new(ws, actor, Action::new(action).unwrap(), json!({}), at)
}

fn filter(limit: u32) -> LedgerFilter {
    LedgerFilter {
        action_prefix: None,
        actor_kind: None,
        agent_connection_id: None,
        limit,
        before_id: None,
    }
}

fn session(
    user: UserId,
    ws: Option<WorkspaceId>,
    hash: &str,
    expires_at: OffsetDateTime,
) -> SessionRow {
    SessionRow {
        id: SessionId::new_v7(),
        user_id: user,
        token_hash: hash.into(),
        current_workspace_id: ws,
        created_at: T0,
        expires_at,
        revoked_at: None,
    }
}

// ---------------------------------------------------------------------------------------------
// One test per repository
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn users_insert_and_find_by_email_is_case_insensitive() {
    let db = TestDb::new().await;
    // A row written with mixed case by another path is still found, and reads back normalised.
    let grace = UserId::new_v7();
    sqlx::query(
        "insert into users (id, email, password_hash, display_name) \
         values ($1, 'Grace@Example.COM', 'plain:pw', 'Grace')",
    )
    .bind(grace.as_uuid())
    .execute(&db.pool)
    .await
    .unwrap();
    let uow = uow(&db);

    let ada = user_row("ada@example.com");
    let mut u = uow.user().await.unwrap();
    u.users().insert(ada.clone()).await.unwrap();
    assert_eq!(
        u.users()
            .find_by_email(&email("  ADA@Example.COM "))
            .await
            .unwrap(),
        Some(ada.clone())
    );
    assert_eq!(
        u.users().find_by_id(ada.id).await.unwrap(),
        Some(ada.clone())
    );
    assert_eq!(
        u.users()
            .find_by_email(&email("bob@example.com"))
            .await
            .unwrap(),
        None
    );
    assert_eq!(u.users().find_by_id(UserId::new_v7()).await.unwrap(), None);

    let found = u
        .users()
        .find_by_email(&email("grace@example.com"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, grace);
    assert_eq!(found.email.as_str(), "grace@example.com");

    // A taken email, in any case, is CONFLICT; the bundle stays usable and commits.
    let dup = UserRow {
        id: UserId::new_v7(),
        ..user_row("GRACE@example.com")
    };
    assert_eq!(code(u.users().insert(dup).await), ErrorCode::Conflict);
    u.commit().await.unwrap();

    let mut u = uow.user().await.unwrap();
    assert_eq!(u.users().find_by_id(ada.id).await.unwrap(), Some(ada));
}

#[tokio::test]
async fn sessions_find_by_hash_and_revoke() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, _) = db.seed_workspace("other").await;
    let uow = uow(&db);

    let mut u = uow.user().await.unwrap();
    let s = session(owner, Some(ws), "sess-1", T0 + Duration::hours(1));
    u.sessions().insert(s.clone()).await.unwrap();
    assert_eq!(
        u.sessions().find_by_token_hash("sess-1").await.unwrap(),
        Some(s.clone())
    );
    assert_eq!(u.sessions().find_by_token_hash("nope").await.unwrap(), None);

    // Revoking twice keeps the first time.
    let at = T0 + Duration::minutes(5);
    u.sessions().revoke(s.id, at).await.unwrap();
    u.sessions()
        .revoke(s.id, at + Duration::minutes(5))
        .await
        .unwrap();
    let revoked = u
        .sessions()
        .find_by_token_hash("sess-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoked.revoked_at, Some(at));

    // Switching the current workspace.
    let s2 = session(owner, None, "sess-2", T0 + Duration::hours(1));
    u.sessions().insert(s2.clone()).await.unwrap();
    u.sessions()
        .set_current_workspace(s2.id, Some(other))
        .await
        .unwrap();
    let current = u
        .sessions()
        .find_by_token_hash("sess-2")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.current_workspace_id, Some(other));
    u.sessions()
        .set_current_workspace(s2.id, Some(ws))
        .await
        .unwrap();

    // revoke_all_for_workspace touches only live sessions of that user in that workspace.
    let expired = session(owner, Some(ws), "sess-expired", T0 - Duration::hours(1));
    let elsewhere = session(owner, Some(other), "sess-other", T0 + Duration::hours(1));
    u.sessions().insert(expired.clone()).await.unwrap();
    u.sessions().insert(elsewhere.clone()).await.unwrap();
    u.sessions()
        .revoke_all_for_workspace(owner, ws, T0)
        .await
        .unwrap();
    assert_eq!(
        u.sessions()
            .find_by_token_hash("sess-2")
            .await
            .unwrap()
            .unwrap()
            .revoked_at,
        Some(T0)
    );
    assert_eq!(
        u.sessions()
            .find_by_token_hash("sess-1")
            .await
            .unwrap()
            .unwrap()
            .revoked_at,
        Some(at),
        "an already revoked session keeps its time"
    );
    assert_eq!(
        u.sessions()
            .find_by_token_hash("sess-expired")
            .await
            .unwrap()
            .unwrap()
            .revoked_at,
        None
    );
    assert_eq!(
        u.sessions()
            .find_by_token_hash("sess-other")
            .await
            .unwrap()
            .unwrap()
            .revoked_at,
        None
    );

    // A taken token hash is CONFLICT.
    let dup = session(owner, None, "sess-1", T0);
    assert_eq!(code(u.sessions().insert(dup).await), ErrorCode::Conflict);
    u.commit().await.unwrap();
}

#[tokio::test]
async fn roles_list_has_three_system_roles_and_custom_crud() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("acme").await;
    let (other, _) = db.seed_workspace("other").await;
    let uow = uow(&db);
    let other_rep = role(&uow, other, "rep").await;

    let mut t = uow.tenant(ws).await.unwrap();
    let roles = t.roles().list().await.unwrap();
    let keys: BTreeSet<&str> = roles.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, BTreeSet::from(["manager", "owner", "rep"]));
    assert!(roles.iter().all(|r| r.is_system));
    let rep = t.roles().find_by_key("rep").await.unwrap().unwrap();
    assert_eq!(rep.permissions, SystemRole::Rep.permissions());
    assert_eq!(t.roles().find(rep.id).await.unwrap(), Some(rep.clone()));
    let owner = t.roles().find_by_key("owner").await.unwrap().unwrap();
    assert_eq!(owner.permissions, SystemRole::Owner.permissions());

    // Custom role: insert, find, update, count, delete.
    let custom = custom_role("auditor");
    t.roles().insert(custom.clone()).await.unwrap();
    assert_eq!(
        t.roles().find_by_key("auditor").await.unwrap(),
        Some(custom.clone())
    );
    assert_eq!(t.roles().list().await.unwrap().len(), 4);
    let dup = RoleDef {
        id: RoleId::new_v7(),
        ..custom.clone()
    };
    assert_eq!(code(t.roles().insert(dup).await), ErrorCode::Conflict);
    t.roles()
        .update_permissions(custom.id, BTreeSet::from([Permission::LedgerRead]))
        .await
        .unwrap();
    assert_eq!(
        t.roles()
            .find(custom.id)
            .await
            .unwrap()
            .unwrap()
            .permissions,
        BTreeSet::from([Permission::LedgerRead])
    );
    assert_eq!(
        t.roles().count_memberships_using(custom.id).await.unwrap(),
        0
    );
    assert_eq!(
        t.roles().count_memberships_using(owner.id).await.unwrap(),
        1
    );
    t.roles().delete_custom(custom.id).await.unwrap();
    assert_eq!(t.roles().find(custom.id).await.unwrap(), None);

    // A system role cannot be deleted and stays.
    assert_eq!(
        code(t.roles().delete_custom(rep.id).await),
        ErrorCode::Forbidden
    );
    assert!(t.roles().find(rep.id).await.unwrap().is_some());

    // Unknown ids, and another workspace's role, are NOT_FOUND / invisible.
    assert_eq!(
        code(t.roles().delete_custom(RoleId::new_v7()).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(
            t.roles()
                .update_permissions(RoleId::new_v7(), BTreeSet::new())
                .await
        ),
        ErrorCode::NotFound
    );
    assert_eq!(t.roles().find(other_rep.id).await.unwrap(), None);
    assert_eq!(
        code(
            t.roles()
                .update_permissions(other_rep.id, BTreeSet::new())
                .await
        ),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(t.roles().delete_custom(other_rep.id).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        t.roles()
            .count_memberships_using(other_rep.id)
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    // The other workspace's role is untouched.
    assert_eq!(role(&uow, other, "rep").await, other_rep);
}

#[tokio::test]
async fn memberships_invite_activate_set_role_remove_and_count_owners() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);
    let bob = new_user(&uow, "bob@example.com").await;
    let rep = role(&uow, ws, "rep").await;
    let owner_role = role(&uow, ws, "owner").await;

    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);
    let owner_membership = t.memberships().find_by_user(owner).await.unwrap().unwrap();
    assert_eq!(owner_membership.status, MembershipStatus::Active);
    assert_eq!(owner_membership.role_id, owner_role.id);

    let inv = invite(ws, rep.id, owner, "bob@example.com", "invite-bob");
    t.memberships().insert_invite(inv.clone()).await.unwrap();
    assert_eq!(
        t.memberships().find(inv.id).await.unwrap(),
        Some(inv.clone())
    );
    let list = t.memberships().list().await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].user_id, Some(owner));
    assert_eq!(list[0].role_key, "owner");
    assert_eq!(
        list[1],
        MemberOut {
            membership_id: inv.id,
            user_id: None,
            email: email("bob@example.com"),
            display_name: None,
            role_key: "rep".into(),
            role_name: "Rep".into(),
            status: MembershipStatus::Invited,
            created_at: T0,
        }
    );

    // Activate: an open invitation -> Active only, and the token is spent.
    t.memberships().activate(inv.id, bob.id, T0).await.unwrap();
    let active = t.memberships().find(inv.id).await.unwrap().unwrap();
    assert_eq!(active.status, MembershipStatus::Active);
    assert_eq!(active.user_id, Some(bob.id));
    assert_eq!(active.invite_token_hash, None);
    assert_eq!(active.invite_expires_at, None);
    assert_eq!(active.invited_email, inv.invited_email);
    assert_eq!(active.invited_by, inv.invited_by);
    assert_eq!(
        t.memberships()
            .find_by_user(bob.id)
            .await
            .unwrap()
            .map(|m| m.id),
        Some(inv.id)
    );
    assert_eq!(
        code(t.memberships().activate(inv.id, bob.id, T0).await),
        ErrorCode::Conflict
    );
    let list = t.memberships().list().await.unwrap();
    assert_eq!(list[1].display_name, Some(bob.display_name.clone()));
    assert_eq!(list[1].email, bob.email);

    // An invitation for someone already a member cannot be activated for them.
    let again = invite(ws, rep.id, owner, "bob@example.com", "invite-bob-2");
    t.memberships().insert_invite(again.clone()).await.unwrap();
    assert_eq!(
        code(t.memberships().activate(again.id, bob.id, T0).await),
        ErrorCode::Conflict
    );
    t.memberships().remove(again.id).await.unwrap();

    // Promote to owner, then remove.
    t.memberships()
        .set_role(inv.id, owner_role.id)
        .await
        .unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 2);
    t.memberships().remove(inv.id).await.unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);
    assert_eq!(t.memberships().list().await.unwrap().len(), 1);
    assert_eq!(t.memberships().find_by_user(bob.id).await.unwrap(), None);
    assert_eq!(
        t.memberships().find(inv.id).await.unwrap().unwrap().status,
        MembershipStatus::Removed
    );

    // Unknown ids are NOT_FOUND.
    let missing = MembershipId::new_v7();
    assert_eq!(
        code(t.memberships().activate(missing, bob.id, T0).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(t.memberships().set_role(missing, rep.id).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(t.memberships().remove(missing).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(t.memberships().set_role(inv.id, RoleId::new_v7()).await),
        ErrorCode::NotFound
    );
    assert_eq!(t.memberships().find(missing).await.unwrap(), None);
    t.commit().await.unwrap();

    // The platform finds an invitation by its token hash, whatever the workspace; an activated
    // invitation's token is gone.
    let mut p = uow.platform().await.unwrap();
    let found = p
        .membership_find_by_invite_hash("invite-bob-2")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, again.id);
    assert_eq!(found.workspace_id, ws);
    for gone in ["invite-bob", "nope"] {
        assert_eq!(p.membership_find_by_invite_hash(gone).await.unwrap(), None);
    }
}

#[tokio::test]
async fn activating_an_expired_invitation_is_conflict() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);
    let bob = new_user(&uow, "bob@example.com").await;
    let rep = role(&uow, ws, "rep").await;
    let inv = invite(ws, rep.id, owner, "bob@example.com", "invite-bob");
    let expires_at = inv.invite_expires_at.unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.memberships().insert_invite(inv.clone()).await.unwrap();
    t.commit().await.unwrap();

    // At the expiry instant the invitation is no longer open.
    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(t.memberships().activate(inv.id, bob.id, expires_at).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(ws).await.unwrap();
    t.memberships()
        .activate(inv.id, bob.id, expires_at - Duration::seconds(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
}

#[tokio::test]
async fn user_bundle_activates_an_invitation_with_the_user_it_creates() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, _) = db.seed_workspace("other").await;
    let uow = uow(&db);
    let rep = role(&uow, ws, "rep").await;
    let inv = invite(ws, rep.id, owner, "bob@example.com", "invite-bob");
    let mut t = uow.tenant(ws).await.unwrap();
    t.memberships().insert_invite(inv.clone()).await.unwrap();
    t.commit().await.unwrap();

    // The membership is another workspace's: NOT_FOUND, and nothing is kept.
    let bob = user_row("bob@example.com");
    let mut u = uow.user().await.unwrap();
    u.users().insert(bob.clone()).await.unwrap();
    assert_eq!(
        code(u.memberships_activate(other, inv.id, bob.id, T0).await),
        ErrorCode::NotFound
    );
    drop(u);

    // One transaction creates the user, activates the invitation and opens a session.
    let mut u = uow.user().await.unwrap();
    u.users().insert(bob.clone()).await.unwrap();
    u.memberships_activate(ws, inv.id, bob.id, T0)
        .await
        .unwrap();
    u.sessions()
        .insert(session(
            bob.id,
            Some(ws),
            "bob-session",
            T0 + Duration::days(30),
        ))
        .await
        .unwrap();
    let views = u.memberships_of_user(bob.id).await.unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].membership_id, inv.id);
    assert_eq!(views[0].role_key, "rep");
    u.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let active = t.memberships().find(inv.id).await.unwrap().unwrap();
    assert_eq!(active.status, MembershipStatus::Active);
    assert_eq!(active.user_id, Some(bob.id));
    assert_eq!(active.invite_token_hash, None);
    drop(t);

    // Used once, it is no open invitation any more.
    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(u.memberships_activate(ws, inv.id, bob.id, T0).await),
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn api_keys_insert_find_by_hash_revoke_touch() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, other_owner) = db.seed_workspace("other").await;
    let uow = uow(&db);

    let key = api_key(ws, owner, "hash-1");
    let mut t = uow.tenant(ws).await.unwrap();
    t.api_keys().insert(key.clone()).await.unwrap();
    assert_eq!(t.api_keys().list().await.unwrap(), vec![key.clone()]);
    let dup = ApiKeyRow {
        id: ApiKeyId::new_v7(),
        ..key.clone()
    };
    assert_eq!(code(t.api_keys().insert(dup).await), ErrorCode::Conflict);
    t.commit().await.unwrap();

    let mut o = uow.tenant(other).await.unwrap();
    o.api_keys()
        .insert(api_key(other, other_owner, "hash-2"))
        .await
        .unwrap();
    assert_eq!(
        o.api_keys().list().await.unwrap().len(),
        1,
        "only its own keys"
    );
    o.commit().await.unwrap();

    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.api_key_find_by_hash("hash-1").await.unwrap(),
        Some(key.clone())
    );
    assert_eq!(
        p.api_key_find_by_hash("hash-2")
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        other
    );
    assert_eq!(p.api_key_find_by_hash("nope").await.unwrap(), None);
    drop(p);

    let used = T0 + Duration::minutes(1);
    let revoked = T0 + Duration::minutes(2);
    let mut t = uow.tenant(ws).await.unwrap();
    t.api_keys().touch_last_used(key.id, used).await.unwrap();
    t.api_keys().revoke(key.id, revoked).await.unwrap();
    assert_eq!(
        code(t.api_keys().revoke(ApiKeyId::new_v7(), revoked).await),
        ErrorCode::NotFound
    );
    t.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let stored = t.api_keys().list().await.unwrap().remove(0);
    assert_eq!(
        stored,
        ApiKeyRow {
            status: ApiKeyStatus::Revoked,
            last_used_at: Some(used),
            revoked_at: Some(revoked),
            ..key
        }
    );
}

#[tokio::test]
async fn api_keys_revoke_all_for_user_revokes_only_that_users_active_keys_here() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, other_owner) = db.seed_workspace("other").await;
    let uow = uow(&db);

    // In `ws`: two active keys and one revoked key of the owner, one key of another user.
    let (a, b) = (api_key(ws, owner, "hash-a"), api_key(ws, owner, "hash-b"));
    let old = ApiKeyRow {
        status: ApiKeyStatus::Revoked,
        revoked_at: Some(T0),
        ..api_key(ws, owner, "hash-old")
    };
    let someone_elses = api_key(ws, other_owner, "hash-else");
    // In `other`: a key the same user issued there.
    let elsewhere = api_key(other, owner, "hash-elsewhere");
    let mut t = uow.tenant(ws).await.unwrap();
    for key in [&a, &b, &old, &someone_elses] {
        t.api_keys().insert(key.clone()).await.unwrap();
    }
    t.commit().await.unwrap();
    let mut o = uow.tenant(other).await.unwrap();
    o.api_keys().insert(elsewhere.clone()).await.unwrap();
    o.commit().await.unwrap();

    let at = T0 + Duration::hours(1);
    let mut t = uow.tenant(ws).await.unwrap();
    let mut expected = vec![a.id, b.id];
    expected.sort();
    assert_eq!(
        t.api_keys().revoke_all_for_user(owner, at).await.unwrap(),
        expected
    );
    // Nothing is left to revoke the second time.
    assert!(
        t.api_keys()
            .revoke_all_for_user(owner, at)
            .await
            .unwrap()
            .is_empty()
    );
    t.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let stored = t.api_keys().list().await.unwrap();
    let state = |id: ApiKeyId| {
        let row = stored.iter().find(|k| k.id == id).unwrap();
        (row.status, row.revoked_at)
    };
    assert_eq!(state(a.id), (ApiKeyStatus::Revoked, Some(at)));
    assert_eq!(state(b.id), (ApiKeyStatus::Revoked, Some(at)));
    assert_eq!(state(old.id), (ApiKeyStatus::Revoked, Some(T0)));
    assert_eq!(state(someone_elses.id), (ApiKeyStatus::Active, None));
    drop(t);
    let mut o = uow.tenant(other).await.unwrap();
    assert_eq!(
        o.api_keys().list().await.unwrap()[0].status,
        ApiKeyStatus::Active,
        "the same user's key in another workspace stays"
    );
}

#[tokio::test]
async fn agent_connections_upsert_increments_on_second_initialize_and_touch_counts_calls() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);
    let key = api_key(ws, owner, "hash-1");

    let mut t = uow.tenant(ws).await.unwrap();
    t.api_keys().insert(key.clone()).await.unwrap();

    let first = connection(ws, key.id, "1.0", T0);
    assert_eq!(
        t.agent_connections()
            .upsert_on_initialize(first.clone())
            .await
            .unwrap(),
        (first.id, true)
    );
    // Same (key, client name, version) again: the stored connection is seen again.
    let later = T0 + Duration::hours(1);
    let second = AgentConnectionRow {
        protocol_version: "2025-11-25".into(),
        ..connection(ws, key.id, "1.0", later)
    };
    assert_eq!(
        t.agent_connections()
            .upsert_on_initialize(second)
            .await
            .unwrap(),
        (first.id, false)
    );
    let stored = t.agent_connections().find(first.id).await.unwrap().unwrap();
    assert_eq!(stored.first_seen_at, T0);
    assert_eq!(stored.last_seen_at, later);
    assert_eq!(stored.protocol_version, "2025-11-25");
    assert_eq!(stored.tool_calls, 0);

    // Each tool call is counted and moves last_seen_at.
    let call = T0 + Duration::hours(2);
    t.agent_connections()
        .touch_tool_call(first.id, call)
        .await
        .unwrap();
    t.agent_connections()
        .touch_tool_call(first.id, call)
        .await
        .unwrap();
    let stored = t.agent_connections().find(first.id).await.unwrap().unwrap();
    assert_eq!(stored.tool_calls, 2);
    assert_eq!(stored.last_seen_at, call);

    // Another client version is another connection.
    let v2 = connection(ws, key.id, "2.0", T0 + Duration::hours(3));
    assert_eq!(
        t.agent_connections()
            .upsert_on_initialize(v2.clone())
            .await
            .unwrap(),
        (v2.id, true)
    );
    let ids: Vec<AgentConnectionId> = t
        .agent_connections()
        .list()
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec![first.id, v2.id]);
    assert_eq!(
        t.agent_connections()
            .find(AgentConnectionId::new_v7())
            .await
            .unwrap(),
        None
    );
    t.commit().await.unwrap();
}

#[tokio::test]
async fn ledger_append_and_list_newest_first_with_limit_and_filters() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, other_owner) = db.seed_workspace("other").await;
    let uow = uow(&db);

    let mut invited = entry(ws, Actor::Human { user_id: owner }, "team.invite", T0);
    invited.subject = Some(Subject {
        kind: "membership".into(),
        id: "m-1".into(),
    });
    invited.payload = json!({ "email": "bob@example.com", "nested": { "n": [1, 2] } });
    invited.strategy_version_id = Some(Uuid::now_v7());
    let agent_connection = AgentConnectionId::new_v7();
    let entries = vec![
        invited,
        entry(
            ws,
            Actor::Agent {
                connection_id: agent_connection,
                user_id: owner,
            },
            "mcp.tool_call",
            T0 + Duration::seconds(1),
        ),
        entry(
            ws,
            Actor::System {
                component: "scheduler".into(),
            },
            "team.remove",
            T0 + Duration::seconds(2),
        ),
        entry(
            ws,
            Actor::Human { user_id: owner },
            "team_x.y",
            T0 + Duration::seconds(3),
        ),
        entry(
            ws,
            Actor::Human { user_id: owner },
            "teamax.y",
            T0 + Duration::seconds(4),
        ),
    ];

    let mut t = uow.tenant(ws).await.unwrap();
    let mut ids = Vec::new();
    for e in &entries {
        ids.push(t.ledger().append(e.clone()).await.unwrap());
    }
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    t.commit().await.unwrap();

    let mut o = uow.tenant(other).await.unwrap();
    o.ledger()
        .append(entry(
            other,
            Actor::Human {
                user_id: other_owner,
            },
            "team.invite",
            T0,
        ))
        .await
        .unwrap();
    o.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let all = t.ledger().list(filter(50)).await.unwrap();
    let listed: Vec<i64> = all.iter().map(|r| r.id).collect();
    let mut newest_first = ids.clone();
    newest_first.reverse();
    assert_eq!(listed, newest_first, "only this workspace, newest first");
    for row in &all {
        let i = ids.iter().position(|id| *id == row.id).unwrap();
        assert_eq!(row.entry, entries[i], "round trip of entry {i}");
    }

    let action_ids = |rows: Vec<jt_app::ports::LedgerRow>| -> Vec<String> {
        rows.into_iter()
            .map(|r| r.entry.action.as_str().to_owned())
            .collect()
    };
    assert_eq!(
        action_ids(t.ledger().list(filter(2)).await.unwrap()),
        ["teamax.y", "team_x.y"]
    );
    let by_prefix = |p: &str| LedgerFilter {
        action_prefix: Some(p.into()),
        ..filter(50)
    };
    assert_eq!(
        action_ids(t.ledger().list(by_prefix("team.")).await.unwrap()),
        ["team.remove", "team.invite"]
    );
    // `_` and `%` in the prefix are literal, not wildcards.
    assert_eq!(
        action_ids(t.ledger().list(by_prefix("team_")).await.unwrap()),
        ["team_x.y"]
    );
    assert!(t.ledger().list(by_prefix("%")).await.unwrap().is_empty());
    let agents = LedgerFilter {
        actor_kind: Some("agent".into()),
        ..filter(50)
    };
    assert_eq!(
        action_ids(t.ledger().list(agents).await.unwrap()),
        ["mcp.tool_call"]
    );
    let by_connection = |id: AgentConnectionId| LedgerFilter {
        agent_connection_id: Some(id),
        ..filter(50)
    };
    assert_eq!(
        action_ids(
            t.ledger()
                .list(by_connection(agent_connection))
                .await
                .unwrap()
        ),
        ["mcp.tool_call"]
    );
    assert!(
        t.ledger()
            .list(by_connection(AgentConnectionId::new_v7()))
            .await
            .unwrap()
            .is_empty()
    );
    let page = LedgerFilter {
        before_id: Some(ids[2]),
        ..filter(50)
    };
    assert_eq!(
        action_ids(t.ledger().list(page).await.unwrap()),
        ["mcp.tool_call", "team.invite"]
    );
    assert_eq!(
        t.ledger().list(filter(0)).await.unwrap().len(),
        1,
        "limit is at least 1"
    );
}

#[tokio::test]
async fn operators_count_insert_find() {
    let db = TestDb::new().await;
    let uow = uow(&db);

    let mut p = uow.platform().await.unwrap();
    assert_eq!(p.operators().count().await.unwrap(), 0);
    let op = OperatorRow {
        id: OperatorId::new_v7(),
        email: email("ops@example.com"),
        password_hash: "plain:pw".into(),
        created_at: T0,
    };
    p.operators().insert(op.clone()).await.unwrap();
    assert_eq!(p.operators().count().await.unwrap(), 1);
    assert_eq!(
        p.operators()
            .find_by_email(&email("OPS@Example.com"))
            .await
            .unwrap(),
        Some(op.clone())
    );
    assert_eq!(
        p.operators()
            .find_by_email(&email("x@example.com"))
            .await
            .unwrap(),
        None
    );
    let dup = OperatorRow {
        id: OperatorId::new_v7(),
        ..op.clone()
    };
    assert_eq!(code(p.operators().insert(dup).await), ErrorCode::Conflict);

    let s = PlatformSessionRow {
        id: Uuid::now_v7(),
        operator_id: op.id,
        token_hash: "op-sess-1".into(),
        created_at: T0,
        expires_at: T0 + Duration::hours(8),
    };
    p.platform_sessions().insert(s.clone()).await.unwrap();
    assert_eq!(
        p.platform_sessions()
            .find_by_token_hash("op-sess-1")
            .await
            .unwrap(),
        Some(s)
    );
    assert_eq!(
        p.platform_sessions()
            .find_by_token_hash("nope")
            .await
            .unwrap(),
        None
    );
    p.commit().await.unwrap();

    let mut p = uow.platform().await.unwrap();
    assert_eq!(p.operators().count().await.unwrap(), 1);
}

#[tokio::test]
async fn platform_workspaces_list_and_set_status() {
    let db = TestDb::new().await;
    let (a, a_owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let uow = uow(&db);

    let mut p = uow.platform().await.unwrap();
    let list = p.workspaces_list().await.unwrap();
    assert_eq!(list.iter().map(|w| w.id).collect::<Vec<_>>(), vec![a, b]);
    assert_eq!(list[0].name, "a");
    assert_eq!(list[0].status, WorkspaceStatus::Active);
    assert_eq!(p.workspace_get(a).await.unwrap(), Some(list[0].clone()));
    assert_eq!(p.workspace_get(WorkspaceId::new_v7()).await.unwrap(), None);

    p.workspace_set_status(a, WorkspaceStatus::Suspended)
        .await
        .unwrap();
    assert_eq!(
        p.workspace_get(a).await.unwrap().unwrap().status,
        WorkspaceStatus::Suspended
    );
    assert_eq!(
        code(
            p.workspace_set_status(WorkspaceId::new_v7(), WorkspaceStatus::Active)
                .await
        ),
        ErrorCode::NotFound
    );
    assert_eq!(
        p.workspace_owner_email(a).await.unwrap(),
        Some(email(&format!("owner+{a_owner}@test.local")))
    );
    assert_eq!(
        p.workspace_owner_email(WorkspaceId::new_v7())
            .await
            .unwrap(),
        None
    );
    assert_eq!(p.workspace_member_count(a).await.unwrap(), 1);
    assert_eq!(
        p.workspace_member_count(WorkspaceId::new_v7())
            .await
            .unwrap(),
        0
    );
    p.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let own = t.workspace().get().await.unwrap();
    assert_eq!((own.id, own.status), (a, WorkspaceStatus::Suspended));
}

#[tokio::test]
async fn uow_tenant_commit_persists_and_rollback_on_drop_discards() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);

    let mut t = uow.tenant(ws).await.unwrap();
    t.roles().insert(custom_role("kept")).await.unwrap();
    t.ledger()
        .append(entry(
            ws,
            Actor::Human { user_id: owner },
            "roles.create",
            T0,
        ))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    t.roles().insert(custom_role("dropped")).await.unwrap();
    t.ledger()
        .append(entry(
            ws,
            Actor::Human { user_id: owner },
            "roles.create",
            T0,
        ))
        .await
        .unwrap();
    drop(t);

    let mut t = uow.tenant(ws).await.unwrap();
    assert!(t.roles().find_by_key("kept").await.unwrap().is_some());
    assert_eq!(t.roles().find_by_key("dropped").await.unwrap(), None);
    assert_eq!(t.ledger().list(filter(50)).await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Contracts across repositories
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn user_bundle_registers_a_workspace_in_one_transaction() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let ws = WorkspaceId::new_v7();
    let ada = user_row("ada@example.com");
    let system: Vec<RoleDef> = [
        (SystemRole::Owner, "Owner"),
        (SystemRole::Manager, "Manager"),
        (SystemRole::Rep, "Rep"),
    ]
    .into_iter()
    .map(|(r, name)| RoleDef {
        id: RoleId::new_v7(),
        key: r.key().into(),
        name: name.into(),
        permissions: r.permissions(),
        is_system: true,
    })
    .collect();
    let membership = MembershipId::new_v7();

    let mut u = uow.user().await.unwrap();
    u.users().insert(ada.clone()).await.unwrap();
    u.workspaces_create(ws, "Acme", "acme", WorkspaceStatus::PendingPayment, T0)
        .await
        .unwrap();
    u.roles_create_system(ws, &system).await.unwrap();
    u.memberships_insert_active(membership, ws, ada.id, system[0].id, T0)
        .await
        .unwrap();
    let id = u
        .ledger_append(entry(
            ws,
            Actor::Human { user_id: ada.id },
            "auth.register",
            T0,
        ))
        .await
        .unwrap();
    assert!(id > 0);
    assert_eq!(
        u.memberships_of_user(ada.id).await.unwrap(),
        vec![MembershipView {
            membership_id: membership,
            workspace_id: ws,
            workspace_name: "Acme".into(),
            workspace_slug: "acme".into(),
            workspace_status: WorkspaceStatus::PendingPayment,
            role_key: "owner".into(),
            permissions: SystemRole::Owner.permissions(),
        }]
    );
    // A taken slug is CONFLICT and does not poison the transaction.
    assert_eq!(
        code(
            u.workspaces_create(
                WorkspaceId::new_v7(),
                "Other",
                "acme",
                WorkspaceStatus::Active,
                T0
            )
            .await
        ),
        ErrorCode::Conflict
    );
    u.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let own = t.workspace().get().await.unwrap();
    assert_eq!((own.name.as_str(), own.created_at), ("Acme", T0));
    assert_eq!(t.roles().list().await.unwrap(), system);
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);
    assert_eq!(t.ledger().list(filter(50)).await.unwrap()[0].id, id);
}

#[tokio::test]
async fn tenant_bundle_refuses_rows_for_another_workspace_with_internal() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, other_owner) = db.seed_workspace("other").await;
    let uow = uow(&db);
    let other_rep = role(&uow, other, "rep").await;
    let mut o = uow.tenant(other).await.unwrap();
    let other_key = api_key(other, other_owner, "hash-other");
    o.api_keys().insert(other_key.clone()).await.unwrap();
    o.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let foreign_invite = invite(other, other_rep.id, other_owner, "x@example.com", "inv-x");
    assert_eq!(
        code(t.memberships().insert_invite(foreign_invite).await),
        ErrorCode::Internal
    );
    assert_eq!(
        code(
            t.api_keys()
                .insert(api_key(other, other_owner, "hash-x"))
                .await
        ),
        ErrorCode::Internal
    );
    assert_eq!(
        code(
            t.agent_connections()
                .upsert_on_initialize(connection(other, other_key.id, "1.0", T0))
                .await
        ),
        ErrorCode::Internal
    );
    // A connection through another workspace's key is refused too.
    assert_eq!(
        code(
            t.agent_connections()
                .upsert_on_initialize(connection(ws, other_key.id, "1.0", T0))
                .await
        ),
        ErrorCode::Internal
    );
    assert_eq!(
        code(
            t.ledger()
                .append(entry(
                    other,
                    Actor::Human { user_id: owner },
                    "team.invite",
                    T0
                ))
                .await
        ),
        ErrorCode::Internal
    );
    t.commit().await.unwrap();

    // Nothing was written anywhere.
    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.membership_find_by_invite_hash("inv-x").await.unwrap(),
        None
    );
    assert_eq!(p.api_key_find_by_hash("hash-x").await.unwrap(), None);
    let mut o = uow.tenant(other).await.unwrap();
    assert!(o.agent_connections().list().await.unwrap().is_empty());
    assert!(o.ledger().list(filter(50)).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_role_from_another_workspace_is_not_found() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, _) = db.seed_workspace("other").await;
    let uow = uow(&db);
    let other_owner_role = role(&uow, other, "owner").await;
    let bob = new_user(&uow, "bob@example.com").await;
    let rep = role(&uow, ws, "rep").await;

    let mut t = uow.tenant(ws).await.unwrap();
    let inv = invite(ws, rep.id, owner, "bob@example.com", "invite-bob");
    t.memberships().insert_invite(inv.clone()).await.unwrap();
    assert_eq!(
        code(t.memberships().set_role(inv.id, other_owner_role.id).await),
        ErrorCode::NotFound
    );
    let foreign_role = invite(ws, other_owner_role.id, owner, "c@example.com", "invite-c");
    assert_eq!(
        code(t.memberships().insert_invite(foreign_role).await),
        ErrorCode::NotFound
    );
    assert_eq!(
        t.memberships().find(inv.id).await.unwrap().unwrap().role_id,
        rep.id
    );
    t.commit().await.unwrap();

    let mut u = uow.user().await.unwrap();
    assert_eq!(
        code(
            u.memberships_insert_active(
                MembershipId::new_v7(),
                ws,
                bob.id,
                other_owner_role.id,
                T0
            )
            .await
        ),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn deleting_a_role_still_in_use_is_conflict() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);

    let mut t = uow.tenant(ws).await.unwrap();
    let custom = custom_role("auditor");
    t.roles().insert(custom.clone()).await.unwrap();
    // An open invitation holds the role.
    let inv = invite(ws, custom.id, owner, "bob@example.com", "invite-bob");
    t.memberships().insert_invite(inv.clone()).await.unwrap();
    assert_eq!(
        t.roles().count_memberships_using(custom.id).await.unwrap(),
        1
    );
    assert_eq!(
        code(t.roles().delete_custom(custom.id).await),
        ErrorCode::Conflict
    );
    assert!(t.roles().find(custom.id).await.unwrap().is_some());
    t.commit().await.unwrap();
}

#[tokio::test]
async fn used_then_removed_role_can_be_deleted() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let (other, other_owner) = db.seed_workspace("other").await;
    let uow = uow(&db);
    let rep = role(&uow, ws, "rep").await;

    // The other workspace holds a removed membership of its own; it must stay as it is.
    let mut o = uow.tenant(other).await.unwrap();
    let other_custom = custom_role("auditor");
    o.roles().insert(other_custom.clone()).await.unwrap();
    let other_inv = invite(
        other,
        other_custom.id,
        other_owner,
        "zed@example.com",
        "invite-zed",
    );
    o.memberships()
        .insert_invite(other_inv.clone())
        .await
        .unwrap();
    o.memberships().remove(other_inv.id).await.unwrap();
    o.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    let custom = custom_role("auditor");
    t.roles().insert(custom.clone()).await.unwrap();
    let bob = invite(ws, custom.id, owner, "bob@example.com", "invite-bob");
    let carol = invite(ws, custom.id, owner, "carol@example.com", "invite-carol");
    for inv in [&bob, &carol] {
        t.memberships().insert_invite(inv.clone()).await.unwrap();
        t.memberships().remove(inv.id).await.unwrap();
    }
    // Removed memberships still reference the role, but do not hold it.
    assert_eq!(
        t.roles().count_memberships_using(custom.id).await.unwrap(),
        0
    );
    t.roles().delete_custom(custom.id).await.unwrap();
    assert_eq!(t.roles().find(custom.id).await.unwrap(), None);
    t.commit().await.unwrap();

    // Committed: the removed memberships moved to the system `rep` role and stay removed.
    let mut t = uow.tenant(ws).await.unwrap();
    for inv in [&bob, &carol] {
        let m = t.memberships().find(inv.id).await.unwrap().unwrap();
        assert_eq!(m.role_id, rep.id);
        assert_eq!(m.status, MembershipStatus::Removed);
    }
    drop(t);
    let mut o = uow.tenant(other).await.unwrap();
    let m = o.memberships().find(other_inv.id).await.unwrap().unwrap();
    assert_eq!(m.role_id, other_custom.id);
    assert!(o.roles().find(other_custom.id).await.unwrap().is_some());
}

#[tokio::test]
async fn unknown_stored_permission_keys_are_skipped_on_read() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("acme").await;
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into roles (id, workspace_id, key, name, permissions) \
         values ($1, $2, 'legacy', 'Legacy', array['workspace.read', 'retired.permission'])",
    )
    .bind(Uuid::now_v7())
    .bind(ws.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let mut t = uow(&db).tenant(ws).await.unwrap();
    let legacy = t.roles().find_by_key("legacy").await.unwrap().unwrap();
    assert_eq!(
        legacy.permissions,
        BTreeSet::from([Permission::WorkspaceRead])
    );
}

#[tokio::test]
async fn ledger_list_clamps_limit_to_at_most_500() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("acme").await;
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into ledger_entries (workspace_id, at, actor_kind, actor_component, action) \
         select $1, now(), 'system', 'test', 'bulk.entry' from generate_series(1, 501)",
    )
    .bind(ws.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let mut t = uow(&db).tenant(ws).await.unwrap();
    assert_eq!(t.ledger().list(filter(10_000)).await.unwrap().len(), 500);
}

#[tokio::test]
async fn a_failed_statement_fails_the_commit_instead_of_losing_writes_silently() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let ada = user_row("ada@example.com");

    let mut u = uow.user().await.unwrap();
    u.users().insert(ada.clone()).await.unwrap();
    // An unknown user is a foreign-key violation: NOT_FOUND, and the transaction is spoiled.
    let orphan = session(UserId::new_v7(), None, "sess-x", T0);
    assert_eq!(code(u.sessions().insert(orphan).await), ErrorCode::NotFound);
    assert_eq!(code(u.commit().await), ErrorCode::Internal);

    let mut u = uow.user().await.unwrap();
    assert_eq!(u.users().find_by_id(ada.id).await.unwrap(), None);
}

#[tokio::test]
async fn count_active_owners_locks_the_owner_rows_until_the_transaction_ends() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("acme").await;
    let uow = uow(&db);

    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(t.memberships().count_active_owners().await.unwrap(), 1);

    // Another transaction cannot change the owner's membership meanwhile.
    let mut other = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("set local lock_timeout = '200ms'")
        .execute(other.conn())
        .await
        .unwrap();
    let err = sqlx::query(
        "update memberships set status = 'removed' where workspace_id = $1 and user_id = $2",
    )
    .bind(ws.as_uuid())
    .bind(owner.as_uuid())
    .execute(other.conn())
    .await
    .unwrap_err();
    assert_eq!(
        err.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("55P03"),
        "{err}"
    );
    other.rollback().await.unwrap();

    // Once the first transaction ends, the row is free again.
    t.commit().await.unwrap();
    let mut other = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("set local lock_timeout = '200ms'")
        .execute(other.conn())
        .await
        .unwrap();
    sqlx::query(
        "update memberships set status = 'removed' where workspace_id = $1 and user_id = $2",
    )
    .bind(ws.as_uuid())
    .bind(owner.as_uuid())
    .execute(other.conn())
    .await
    .unwrap();
    other.rollback().await.unwrap();
}
