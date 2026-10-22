//! API keys and agent connections over the in-memory fakes: issuing, listing and revoking keys,
//! authenticating a bearer key into an agent principal, the agent's context, and recording the
//! agent clients that connect with a key. One test per rule.

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::catalog::Risk;
use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{AgentConnectionRow, ApiKeyRow, ApiKeyStatus, UnitOfWork};
use jt_app::usecases::agents::{self, ClientInfo, WhoAmI};
use jt_app::usecases::api_keys::{self, CreateKey, KeyOut};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::roles::{self, CreateRole};
use jt_app::usecases::team::{self, AcceptInput, InviteInput};
use jt_app::usecases::{Deps, hash_token};
use jt_ledger::{Actor, LedgerEntry, Subject};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, MembershipId, Permission, SystemRole, UserId, WorkspaceId,
    WorkspaceStatus,
};
use jt_testkit::fakes::{
    FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox, SeqIdGen,
};
use serde_json::{Value, json};
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const T0: OffsetDateTime = datetime!(2026-10-22 09:00 UTC);
const PASSWORD: &str = "correct horse battery";
const INVALID_KEY: &str = "invalid api key";

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

/// The fakes behind one `Deps`, with the clock at `T0` and tokens `aaaa`, `owner-session`, then
/// 43-character tokens `t03xxx…`, `t04xxx…`, … in order.
struct World {
    uow: InMemoryUow,
    deps: Deps,
}

impl World {
    fn new() -> World {
        let tokens = ["aaaa".to_owned(), "owner-session".to_owned()]
            .into_iter()
            .chain((3..=80).map(|i| format!("t{i:02}{}", "x".repeat(40))));
        let uow = InMemoryUow::new();
        let deps = Deps {
            uow: Arc::new(uow.clone()),
            clock: Arc::new(FixedClock(T0)),
            ids: Arc::new(SeqIdGen::new()),
            tokens: Arc::new(FixedTokenGen::new(tokens)),
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

    fn key_row(&self, id: ApiKeyId) -> ApiKeyRow {
        self.uow
            .snapshot()
            .api_keys
            .into_iter()
            .find(|k| k.id == id)
            .expect("the key exists")
    }

    fn connections(&self) -> Vec<AgentConnectionRow> {
        self.uow.snapshot().agent_connections
    }

    /// Every ledger entry, oldest first.
    fn ledger(&self) -> Vec<LedgerEntry> {
        self.uow
            .snapshot()
            .ledger
            .into_iter()
            .map(|row| row.entry)
            .collect()
    }

    /// The ledger entries with this action, oldest first.
    fn entries(&self, action: &str) -> Vec<LedgerEntry> {
        self.ledger()
            .into_iter()
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
    let mut platform = w.uow.platform().await.unwrap();
    platform
        .workspace_set_status(ws, WorkspaceStatus::Active)
        .await
        .unwrap();
    platform.commit().await.unwrap();
    let principal = auth::resolve_session(&w.deps, &out.token).await.unwrap();
    let owner_ctx = auth::ctx_for(&principal, ws, T0).unwrap();
    Team {
        ws,
        owner: out.me.user_id,
        owner_membership: out.me.memberships[0].membership_id,
        owner_ctx,
        w,
    }
}

impl Team {
    /// Invites `email` as `role_key` (from the owner) and accepts as a new user.
    async fn join(&self, email: &str, role_key: &str) -> Member {
        let invite = team::invite(
            &self.w.deps,
            &self.owner_ctx,
            InviteInput {
                email: email.into(),
                role_key: role_key.into(),
            },
        )
        .await
        .unwrap();
        let out = team::accept_invite(
            &self.w.deps,
            AcceptInput {
                token: invite.invite_token,
                password: Some(PASSWORD.into()),
                display_name: Some(format!("User {email}")),
                principal: None,
            },
        )
        .await
        .unwrap();
        let session = out.session.expect("a new user gets a session");
        let principal = auth::resolve_session(&self.w.deps, &session.token)
            .await
            .unwrap();
        Member {
            user_id: session.me.user_id,
            membership_id: out.membership_id,
            ctx: auth::ctx_for(&principal, self.ws, T0).unwrap(),
        }
    }

    /// Creates a key named `name` with `scopes` as `ctx`.
    async fn create_key(&self, ctx: &Ctx, name: &str, scopes: &[&str]) -> KeyOut {
        api_keys::create(&self.w.deps, ctx, create_input(name, scopes))
            .await
            .unwrap()
    }
}

fn create_input(name: &str, scopes: &[&str]) -> CreateKey {
    CreateKey {
        name: name.into(),
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
    }
}

fn client(name: &str, version: &str, protocol_version: &str) -> ClientInfo {
    ClientInfo {
        name: name.into(),
        version: version.into(),
        protocol_version: protocol_version.into(),
    }
}

fn all_permissions() -> BTreeSet<Permission> {
    SystemRole::Owner.permissions()
}

fn assert_invalid_key(e: &AppError) {
    assert_eq!(e.code, ErrorCode::Unauthenticated, "{e:?}");
    assert_eq!(e.message, INVALID_KEY);
    assert_eq!(e.details, json!({}));
}

fn assert_forbidden_permission(e: &AppError, permission: &str) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(e.details, json!({ "permission": permission }));
}

// ---------------------------------------------------------------------------------------------
// Issuing, listing and revoking keys
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn create_returns_plaintext_once_and_list_hides_it() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "  CI bot  ", &[]).await;

    // The plaintext is `jt_live_` and the generated token; its first 12 characters are the
    // display prefix, and only its hash is stored.
    let token = format!("t03{}", "x".repeat(40));
    assert_eq!(key.plaintext, format!("jt_live_{token}"));
    assert_eq!(key.prefix, "jt_live_t03x");
    assert_eq!(key.name, "CI bot");
    assert_eq!(
        key.scopes,
        all_permissions(),
        "no scopes: all of the issuer's"
    );
    assert_eq!(key.created_at, T0);
    let row = t.w.key_row(key.id);
    assert_eq!(row.key_hash, hash_token(&key.plaintext));
    assert_eq!(row.prefix, key.prefix);
    assert_eq!(row.scopes, all_permissions());
    assert_eq!(row.issued_by, t.owner);
    assert_eq!(row.status, ApiKeyStatus::Active);
    assert_eq!(row.workspace_id, t.ws);
    assert!(
        !format!("{key:?}").contains(&token),
        "Debug masks the plaintext"
    );

    let listed = api_keys::list(&t.w.deps, &t.owner_ctx).await.unwrap();
    assert_eq!(listed.len(), 1);
    let summary = &listed[0];
    assert_eq!(summary.id, key.id);
    assert_eq!(summary.name, "CI bot");
    assert_eq!(summary.prefix, "jt_live_t03x");
    assert_eq!(summary.scopes, all_permissions());
    assert_eq!(summary.status, ApiKeyStatus::Active);
    assert_eq!(summary.issued_by, t.owner);
    assert_eq!(summary.created_at, T0);
    assert_eq!(summary.last_used_at, None);
    assert_eq!(summary.revoked_at, None);
    let wire = serde_json::to_string(&listed).unwrap();
    assert!(!wire.contains(&token), "{wire}");
    assert!(!wire.contains(&row.key_hash), "{wire}");
    assert!(
        !wire.contains("key_hash") && !wire.contains("plaintext"),
        "{wire}"
    );

    // The create answer is the only place the plaintext travels.
    let created = serde_json::to_value(&key).unwrap();
    assert_eq!(created["plaintext"], key.plaintext);
    assert_eq!(
        created["scopes"],
        json!([
            "workspace.read",
            "team.manage",
            "api_keys.manage",
            "ledger.read"
        ])
    );
    assert!(created.get("key_hash").is_none());
}

#[tokio::test]
async fn create_writes_the_ledger_and_validates_the_name() {
    let t = team().await;
    let e = api_keys::create(&t.w.deps, &t.owner_ctx, create_input("   ", &[]))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "field": "name" }));

    let key = t
        .create_key(&t.owner_ctx, "Reader", &["workspace.read"])
        .await;
    let entries = t.w.entries("api_keys.create");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.workspace_id, t.ws);
    assert_eq!(entry.actor, Actor::Human { user_id: t.owner });
    assert_eq!(entry.at, T0);
    assert_eq!(
        entry.subject,
        Some(Subject {
            kind: "api_key".into(),
            id: key.id.to_string(),
        })
    );
    assert_eq!(
        entry.payload,
        json!({ "name": "Reader", "prefix": "jt_live_t03x", "scopes": ["workspace.read"] })
    );
}

#[tokio::test]
async fn scopes_must_be_subset_of_issuer_permissions() {
    let t = team().await;
    roles::create(
        &t.w.deps,
        &t.owner_ctx,
        CreateRole {
            key: "keyholder".into(),
            name: "Key holder".into(),
            permissions: vec!["workspace.read".into(), "api_keys.manage".into()],
        },
    )
    .await
    .unwrap();
    let holder = t.join("holder@acme.example", "keyholder").await;
    let ledger_before = t.w.ledger().len();

    // Scopes the issuer does not hold.
    let e = api_keys::create(
        &t.w.deps,
        &holder.ctx,
        create_input(
            "Too wide",
            &["workspace.read", "team.manage", "ledger.read"],
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(
        e.details,
        json!({ "reason": "exceeds_own_authority", "missing": ["team.manage", "ledger.read"] })
    );

    // Scopes that are no permission at all.
    let e = api_keys::create(
        &t.w.deps,
        &holder.ctx,
        create_input(
            "Typos",
            &["workspace.read", "nope", "nope", "team.everything"],
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "unknown": ["nope", "team.everything"] }));
    assert!(
        t.w.uow.snapshot().api_keys.is_empty(),
        "a refused key stores nothing"
    );
    assert_eq!(t.w.ledger().len(), ledger_before);

    // A subset is fine, and no scopes means exactly the issuer's own permissions.
    let narrow = t
        .create_key(&holder.ctx, "Narrow", &["workspace.read"])
        .await;
    assert_eq!(narrow.scopes, BTreeSet::from([Permission::WorkspaceRead]));
    let all = t.create_key(&holder.ctx, "Everything mine", &[]).await;
    assert_eq!(
        all.scopes,
        BTreeSet::from([Permission::WorkspaceRead, Permission::ApiKeysManage])
    );
    assert_eq!(t.w.key_row(all.id).issued_by, holder.user_id);
}

#[tokio::test]
async fn managing_keys_needs_api_keys_manage() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let rep = t.join("rep@acme.example", "rep").await;

    let e = api_keys::create(&t.w.deps, &rep.ctx, create_input("Mine", &[]))
        .await
        .unwrap_err();
    assert_forbidden_permission(&e, "api_keys.manage");
    let e = api_keys::list(&t.w.deps, &rep.ctx).await.unwrap_err();
    assert_forbidden_permission(&e, "api_keys.manage");
    let e = api_keys::revoke(&t.w.deps, &rep.ctx, key.id)
        .await
        .unwrap_err();
    assert_forbidden_permission(&e, "api_keys.manage");
    assert_eq!(t.w.key_row(key.id).status, ApiKeyStatus::Active);
}

#[tokio::test]
async fn revoke_marks_the_key_and_refuses_a_second_time_or_an_unknown_key() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let later = T0 + Duration::hours(1);
    let ctx = Ctx {
        now: later,
        ..t.owner_ctx.clone()
    };

    api_keys::revoke(&t.w.deps, &ctx, key.id).await.unwrap();
    let row = t.w.key_row(key.id);
    assert_eq!(row.status, ApiKeyStatus::Revoked);
    assert_eq!(row.revoked_at, Some(later));
    let entries = t.w.entries("api_keys.revoke");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].at, later);
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "api_key".into(),
            id: key.id.to_string(),
        })
    );
    assert_eq!(
        entries[0].payload,
        json!({ "name": "CI bot", "prefix": "jt_live_t03x" })
    );

    let e = api_keys::revoke(&t.w.deps, &ctx, key.id).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = api_keys::revoke(&t.w.deps, &ctx, ApiKeyId::new_v7())
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(t.w.entries("api_keys.revoke").len(), 1);

    let listed = api_keys::list(&t.w.deps, &ctx).await.unwrap();
    assert_eq!(listed[0].status, ApiKeyStatus::Revoked);
    assert_eq!(listed[0].revoked_at, Some(later));
}

// ---------------------------------------------------------------------------------------------
// Authenticating a bearer key
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn authenticate_rejects_unknown_revoked_and_wrong_prefix_with_unauthenticated() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let later = T0 + Duration::minutes(5);

    let principal = api_keys::authenticate(&t.w.at(later), &key.plaintext)
        .await
        .unwrap();
    assert_eq!(principal.workspace_id, t.ws);
    assert_eq!(principal.api_key_id, key.id);
    assert_eq!(principal.issued_by, t.owner);
    assert_eq!(principal.issuer_role_key, "owner");
    assert_eq!(principal.permissions, all_permissions());
    assert_eq!(
        t.w.key_row(key.id).last_used_at,
        Some(later),
        "authenticating touches last_used_at"
    );

    let token = key.plaintext.trim_start_matches("jt_live_");
    let wrong = [
        // No prefix, another prefix, the prefix alone, an unknown key, an empty bearer.
        token.to_owned(),
        format!("jt_test_{token}"),
        "jt_live_".to_owned(),
        format!("jt_live_{}", "y".repeat(43)),
        String::new(),
        // The stored hash is no key either.
        t.w.key_row(key.id).key_hash,
    ];
    for bearer in &wrong {
        let e = api_keys::authenticate(&t.w.deps, bearer).await.unwrap_err();
        assert_invalid_key(&e);
    }

    api_keys::revoke(&t.w.deps, &t.owner_ctx, key.id)
        .await
        .unwrap();
    let e = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap_err();
    assert_invalid_key(&e);
    assert_eq!(t.w.key_row(key.id).last_used_at, Some(later));
}

#[tokio::test]
async fn effective_scopes_shrink_when_issuer_is_demoted() {
    let t = team().await;
    let second_owner = t.join("second@acme.example", "owner").await;
    let key = t.create_key(&t.owner_ctx, "Everything", &[]).await;
    assert_eq!(key.scopes, all_permissions());
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    assert_eq!(principal.permissions, all_permissions());

    // Another owner demotes the issuer to rep: the key keeps its scopes but, from the next call
    // on, acts only with what the issuer still holds.
    team::set_role(&t.w.deps, &second_owner.ctx, t.owner_membership, "rep")
        .await
        .unwrap();
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    assert_eq!(
        principal.permissions,
        BTreeSet::from([Permission::WorkspaceRead])
    );
    assert_eq!(principal.issuer_role_key, "rep");
    assert_eq!(t.w.key_row(key.id).scopes, all_permissions());

    // The agent's context is the rep's, so it cannot manage keys any more.
    let agent = api_keys::ctx_for_agent(&principal, AgentConnectionId::new_v7(), T0);
    let e = api_keys::list(&t.w.deps, &agent).await.unwrap_err();
    assert_forbidden_permission(&e, "api_keys.manage");

    // And a key narrower than its issuer stays narrow: an owner's read-only key only reads.
    let reader = t
        .create_key(&second_owner.ctx, "Reader", &["workspace.read"])
        .await;
    let principal = api_keys::authenticate(&t.w.deps, &reader.plaintext)
        .await
        .unwrap();
    assert_eq!(
        principal.permissions,
        BTreeSet::from([Permission::WorkspaceRead])
    );
    assert_eq!(principal.issuer_role_key, "owner");
}

#[tokio::test]
async fn removing_a_member_revokes_their_api_keys_and_ledgers_them() {
    let t = team().await;
    let manager = t.join("manager@acme.example", "manager").await;
    let first = t.create_key(&manager.ctx, "Manager's bot", &[]).await;
    let second = t
        .create_key(&manager.ctx, "Manager's reader", &["workspace.read"])
        .await;
    let already = t.create_key(&manager.ctx, "Old bot", &[]).await;
    api_keys::revoke(&t.w.deps, &manager.ctx, already.id)
        .await
        .unwrap();
    let owners = t.create_key(&t.owner_ctx, "Owner's bot", &[]).await;
    api_keys::authenticate(&t.w.deps, &first.plaintext)
        .await
        .unwrap();

    let later = T0 + Duration::hours(1);
    let owner_later = Ctx {
        now: later,
        ..t.owner_ctx.clone()
    };
    team::remove(&t.w.deps, &owner_later, manager.membership_id)
        .await
        .unwrap();

    // The member's active keys are revoked at the removal's time, in the same transaction.
    for key in [&first, &second] {
        let row = t.w.key_row(key.id);
        assert_eq!(row.status, ApiKeyStatus::Revoked, "{}", key.name);
        assert_eq!(row.revoked_at, Some(later), "{}", key.name);
        let e = api_keys::authenticate(&t.w.deps, &key.plaintext)
            .await
            .unwrap_err();
        assert_invalid_key(&e);
    }
    // A key revoked before keeps its time; another member's key is untouched.
    assert_eq!(t.w.key_row(already.id).revoked_at, Some(T0));
    assert_eq!(t.w.key_row(owners.id).status, ApiKeyStatus::Active);
    api_keys::authenticate(&t.w.deps, &owners.plaintext)
        .await
        .unwrap();

    // The removal's entry names the keys it revoked, in id order.
    let mut revoked = vec![first.id, second.id];
    revoked.sort();
    let entries = t.w.entries("team.remove");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({
            "user_id": manager.user_id,
            "role_key": "manager",
            "previous_status": "active",
            "revoked_api_key_ids": revoked,
        })
    );
    assert!(
        t.w.entries("api_keys.revoke").len() == 1,
        "only the manual revocation has an entry of its own"
    );
}

#[tokio::test]
async fn ctx_for_agent_acts_as_an_agent_with_the_issuers_role() {
    let t = team().await;
    let key = t
        .create_key(&t.owner_ctx, "Reader", &["workspace.read", "team.manage"])
        .await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection_id = AgentConnectionId::new_v7();
    let at = T0 + Duration::seconds(30);

    let ctx = api_keys::ctx_for_agent(&principal, connection_id, at);
    assert_eq!(
        ctx,
        Ctx {
            workspace_id: t.ws,
            actor: Actor::Agent {
                connection_id,
                user_id: t.owner,
            },
            permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage]),
            role_key: Some("owner".into()),
            now: at,
            agent_connection_id: Some(connection_id),
        }
    );
    assert!(ctx.authority().is_owner, "an owner's agent may grant owner");
}

// ---------------------------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn register_initialize_is_idempotent_per_client_and_ledgers_once() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();

    let first = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("acme-agent", "2.1.0", "2025-03-26"),
        T0,
    )
    .await
    .unwrap();
    let later = T0 + Duration::minutes(10);
    let again = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("acme-agent", "2.1.0", "2025-06-18"),
        later,
    )
    .await
    .unwrap();
    assert_eq!(
        again, first,
        "the same client on the same key is one connection"
    );

    let connections = t.w.connections();
    assert_eq!(connections.len(), 1);
    let row = &connections[0];
    assert_eq!(row.id, first);
    assert_eq!(row.workspace_id, t.ws);
    assert_eq!(row.api_key_id, key.id);
    assert_eq!(row.client_name, "acme-agent");
    assert_eq!(row.client_version, "2.1.0");
    assert_eq!(row.protocol_version, "2025-06-18");
    assert_eq!(row.first_seen_at, T0);
    assert_eq!(row.last_seen_at, later);
    assert_eq!(row.tool_calls, 0);

    let entries = t.w.entries("agent.connected");
    assert_eq!(entries.len(), 1, "only the first sight is ledgered");
    let entry = &entries[0];
    assert_eq!(entry.workspace_id, t.ws);
    assert_eq!(entry.at, T0);
    assert_eq!(
        entry.actor,
        Actor::Agent {
            connection_id: first,
            user_id: t.owner,
        }
    );
    assert_eq!(
        entry.subject,
        Some(Subject {
            kind: "agent_connection".into(),
            id: first.to_string(),
        })
    );
    assert_eq!(
        entry.payload,
        json!({
            "client_name": "acme-agent",
            "client_version": "2.1.0",
            "protocol_version": "2025-03-26",
            "api_key_prefix": "jt_live_t03x",
        })
    );

    // Another version of the client is another connection, ledgered on its own.
    let newer = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("acme-agent", "2.2.0", "2025-06-18"),
        later,
    )
    .await
    .unwrap();
    assert_ne!(newer, first);
    assert_eq!(t.w.connections().len(), 2);
    assert_eq!(t.w.entries("agent.connected").len(), 2);
}

#[tokio::test]
async fn agents_list_joins_key_names_and_counts_tool_calls() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("beta-agent", "1.4", "2025-06-18"),
        T0,
    )
    .await
    .unwrap();
    let later = T0 + Duration::minutes(3);
    for _ in 0..2 {
        agents::touch_tool_call(&t.w.deps, t.ws, connection, later)
            .await
            .unwrap();
    }

    let rep = t.join("rep@acme.example", "rep").await;
    let listed = agents::list(&t.w.deps, &rep.ctx).await.unwrap();
    assert_eq!(listed.len(), 1);
    let out = &listed[0];
    assert_eq!(out.id, connection);
    assert_eq!(out.api_key_id, key.id);
    assert_eq!(out.api_key_name, "CI bot");
    assert_eq!(out.client_name, "beta-agent");
    assert_eq!(out.client_version, "1.4");
    assert_eq!(out.protocol_version, "2025-06-18");
    assert_eq!(out.first_seen_at, T0);
    assert_eq!(out.last_seen_at, later);
    assert_eq!(out.tool_calls, 2);

    let nobody = Ctx {
        permissions: BTreeSet::new(),
        ..rep.ctx.clone()
    };
    let e = agents::list(&t.w.deps, &nobody).await.unwrap_err();
    assert_forbidden_permission(&e, "workspace.read");
}

#[tokio::test]
async fn whoami_reports_the_actor_role_and_permissions() {
    let t = team().await;
    let key = t
        .create_key(&t.owner_ctx, "Reader", &["workspace.read", "ledger.read"])
        .await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection_id = AgentConnectionId::new_v7();
    let ctx = api_keys::ctx_for_agent(&principal, connection_id, T0);

    let me = agents::whoami(&ctx).unwrap();
    assert_eq!(
        me,
        WhoAmI {
            actor: Actor::Agent {
                connection_id,
                user_id: t.owner,
            },
            workspace_id: t.ws,
            role_key: Some("owner".into()),
            permissions: vec!["workspace.read".into(), "ledger.read".into()],
        }
    );
    let wire: Value = serde_json::to_value(&me).unwrap();
    assert_eq!(wire["actor"]["kind"], "agent");
    assert_eq!(
        wire["permissions"],
        json!(["workspace.read", "ledger.read"])
    );

    let human = agents::whoami(&t.owner_ctx).unwrap();
    assert_eq!(human.actor, Actor::Human { user_id: t.owner });
    assert_eq!(human.role_key.as_deref(), Some("owner"));
    assert_eq!(human.permissions.len(), Permission::all().len());

    // It needs `workspace.read`, from a user as from an agent.
    let mut blind = ctx.clone();
    blind.permissions.remove(&Permission::WorkspaceRead);
    assert_forbidden_permission(&agents::whoami(&blind).unwrap_err(), "workspace.read");
}

#[tokio::test]
async fn ledger_payloads_never_contain_plaintext_or_hash() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("acme-agent", "2.1.0", "2025-06-18"),
        T0,
    )
    .await
    .unwrap();
    agents::touch_tool_call(&t.w.deps, t.ws, connection, T0)
        .await
        .unwrap();
    api_keys::revoke(&t.w.deps, &t.owner_ctx, key.id)
        .await
        .unwrap();

    let hash = t.w.key_row(key.id).key_hash;
    let token = key.plaintext.trim_start_matches("jt_live_");
    let ledger = t.w.ledger();
    for action in ["api_keys.create", "agent.connected", "api_keys.revoke"] {
        assert!(
            ledger.iter().any(|e| e.action.as_str() == action),
            "{action} is ledgered"
        );
    }
    let wire = serde_json::to_string(&ledger).unwrap();
    assert!(!wire.contains(token), "{wire}");
    assert!(!wire.contains(&hash), "{wire}");
    assert!(
        !wire.contains("plaintext") && !wire.contains("key_hash"),
        "{wire}"
    );
}

#[tokio::test]
async fn authenticate_touches_last_used_at_most_once_a_minute() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let first = T0 + Duration::minutes(1);
    api_keys::authenticate(&t.w.at(first), &key.plaintext)
        .await
        .unwrap();
    assert_eq!(t.w.key_row(key.id).last_used_at, Some(first));

    // Within a minute of the last touch the key authenticates without being written to.
    let soon = first + Duration::seconds(59);
    api_keys::authenticate(&t.w.at(soon), &key.plaintext)
        .await
        .unwrap();
    assert_eq!(t.w.key_row(key.id).last_used_at, Some(first));

    // A full minute later it is touched again.
    let minute = first + Duration::seconds(60);
    api_keys::authenticate(&t.w.at(minute), &key.plaintext)
        .await
        .unwrap();
    assert_eq!(t.w.key_row(key.id).last_used_at, Some(minute));
}

#[tokio::test]
async fn register_initialize_bounds_client_strings() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let long = "ğ".repeat(200);
    agents::register_initialize(
        &t.w.deps,
        &principal,
        client(&format!("  {long}  "), " \t ", "2025-06-18\n"),
        T0,
    )
    .await
    .unwrap();
    let row = &t.w.connections()[0];
    assert_eq!(row.client_name, "ğ".repeat(agents::CLIENT_FIELD_MAX));
    assert_eq!(agents::CLIENT_FIELD_MAX, 128);
    assert_eq!(row.client_version, "unknown", "blank becomes unknown");
    assert_eq!(row.protocol_version, "2025-06-18", "control characters go");
    let entry = &t.w.entries("agent.connected")[0];
    assert_eq!(entry.payload["client_version"], "unknown");
    assert_eq!(
        entry.payload["client_name"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        128
    );
}

#[tokio::test]
async fn record_tool_call_counts_the_call_and_ledgers_it() {
    let t = team().await;
    let key = t.create_key(&t.owner_ctx, "CI bot", &[]).await;
    let principal = api_keys::authenticate(&t.w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection = agents::register_initialize(
        &t.w.deps,
        &principal,
        client("acme-agent", "1.0", "2025-06-18"),
        T0,
    )
    .await
    .unwrap();
    let at = T0 + Duration::minutes(2);
    let ctx = api_keys::ctx_for_agent(&principal, connection, at);

    agents::record_tool_call(
        &t.w.deps,
        &ctx,
        agents::ToolCall {
            tool: "jeeta.team.list",
            risk: Some(Risk::Read),
            ok: true,
            duration_ms: 12,
            error_code: None,
        },
    )
    .await
    .unwrap();
    agents::record_tool_call(
        &t.w.deps,
        &ctx,
        agents::ToolCall {
            tool: &"x".repeat(300),
            risk: None,
            ok: false,
            duration_ms: 1,
            error_code: Some(ErrorCode::NotFound),
        },
    )
    .await
    .unwrap();

    let row = &t.w.connections()[0];
    assert_eq!(row.tool_calls, 2);
    assert_eq!(row.last_seen_at, at);
    let calls = t.w.entries("mcp.tool_call");
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].actor,
        Actor::Agent {
            connection_id: connection,
            user_id: t.owner,
        }
    );
    assert_eq!(calls[0].at, at);
    assert_eq!(
        calls[0].subject,
        Some(Subject {
            kind: "agent_connection".into(),
            id: connection.to_string(),
        })
    );
    assert_eq!(
        calls[0].payload,
        json!({ "tool": "jeeta.team.list", "risk": "read", "ok": true, "duration_ms": 12 })
    );
    assert_eq!(
        calls[1].payload,
        json!({
            "tool": "x".repeat(128),
            "risk": null,
            "ok": false,
            "duration_ms": 1,
            "error_code": "NOT_FOUND",
        })
    );

    // Only an agent's call can be recorded.
    let e = agents::record_tool_call(
        &t.w.deps,
        &t.owner_ctx,
        agents::ToolCall {
            tool: "jeeta.team.list",
            risk: Some(Risk::Read),
            ok: true,
            duration_ms: 0,
            error_code: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
}
