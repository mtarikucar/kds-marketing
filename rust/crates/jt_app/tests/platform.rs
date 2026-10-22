//! The platform operator over the in-memory fakes: bootstrapping the first operator, logging in
//! and resolving an operator session, listing every workspace and changing a workspace's status.

use std::fmt::Debug;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use jt_app::ctx::PlatformCtx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{LedgerFilter, PasswordHasher, UnitOfWork};
use jt_app::usecases::auth::{self, LoginInput, RegisterInput};
use jt_app::usecases::platform::{self, PLATFORM_SESSION_LIFETIME};
use jt_app::usecases::{Deps, hash_token};
use jt_ledger::Actor;
use jt_tenancy::{Email, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{
    FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox, SeqIdGen,
};
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const T0: OffsetDateTime = datetime!(2026-10-22 09:00 UTC);
const OPERATOR_PASSWORD: &str = "operator passphrase";
const TENANT_PASSWORD: &str = "correct horse battery";

/// `PlainHasher` that counts how often it hashes or verifies.
#[derive(Default)]
struct CountingHasher {
    calls: AtomicUsize,
}

impl CountingHasher {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl PasswordHasher for CountingHasher {
    async fn hash(&self, pw: &str) -> Result<String, AppError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        PlainHasher.hash(pw).await
    }

    async fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        PlainHasher.verify(pw, hash).await
    }
}

/// The fakes behind one `Deps`, with the clock at `T0`.
struct World {
    uow: InMemoryUow,
    hasher: Arc<CountingHasher>,
    deps: Deps,
}

impl World {
    /// A world whose token generator hands out `tokens` in order.
    fn new(tokens: &[&str]) -> World {
        let uow = InMemoryUow::new();
        let hasher = Arc::new(CountingHasher::default());
        let deps = Deps {
            uow: Arc::new(uow.clone()),
            clock: Arc::new(FixedClock(T0)),
            ids: Arc::new(SeqIdGen::new()),
            tokens: Arc::new(FixedTokenGen::new(tokens.iter().copied())),
            hasher: hasher.clone(),
            seal: Arc::new(PlainSecretBox),
        };
        World { uow, hasher, deps }
    }

    /// The same world with its clock at `now`.
    fn at(&self, now: OffsetDateTime) -> Deps {
        Deps {
            clock: Arc::new(FixedClock(now)),
            ..self.deps.clone()
        }
    }

    /// Bootstraps the operator `ops@jeeta.test`, logs them in (taking the next token) and
    /// resolves their session.
    async fn operator(&self) -> PlatformCtx {
        platform::bootstrap(&self.deps, "ops@jeeta.test", OPERATOR_PASSWORD)
            .await
            .unwrap();
        let session = platform::login(&self.deps, login("ops@jeeta.test", OPERATOR_PASSWORD))
            .await
            .unwrap();
        platform::resolve(&self.deps, &session.token).await.unwrap()
    }

    /// Registers a tenant owner with a new workspace at `now`; returns the workspace.
    async fn register(&self, now: OffsetDateTime, email: &str, workspace: &str) -> WorkspaceId {
        let out = auth::register(
            &self.at(now),
            RegisterInput {
                email: email.into(),
                password: TENANT_PASSWORD.into(),
                display_name: "Owner".into(),
                workspace_name: workspace.into(),
            },
        )
        .await
        .unwrap();
        out.me.current_workspace.unwrap()
    }

    /// Every ledger entry of `ws` with this action, newest first.
    async fn entries(&self, ws: WorkspaceId, action: &str) -> Vec<jt_ledger::LedgerEntry> {
        let mut t = self.uow.tenant(ws).await.unwrap();
        t.ledger()
            .list(LedgerFilter {
                action_prefix: Some(action.into()),
                actor_kind: None,
                limit: 100,
                before_id: None,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.entry)
            .filter(|e| e.action.as_str() == action)
            .collect()
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
async fn bootstrap_creates_once() {
    let w = World::new(&[]);

    // Refusals come first and store nothing.
    let bad_email = err(platform::bootstrap(&w.deps, "not-an-email", OPERATOR_PASSWORD).await);
    assert_eq!(bad_email.code, ErrorCode::Validation);
    assert_eq!(bad_email.details, json!({ "field": "email" }));
    let short = err(platform::bootstrap(&w.deps, "ops@jeeta.test", "elevenchars").await);
    assert_eq!(short.code, ErrorCode::Validation);
    assert_eq!(short.details, json!({ "field": "password" }));
    assert!(w.uow.snapshot().operators.is_empty());

    // Twelve characters is enough; the email is normalised and only the hash is stored.
    assert!(
        platform::bootstrap(&w.deps, "  Ops@Jeeta.TEST ", "twelve chars")
            .await
            .unwrap()
    );
    let operators = w.uow.snapshot().operators;
    assert_eq!(operators.len(), 1);
    assert_eq!(operators[0].email, Email::parse("ops@jeeta.test").unwrap());
    assert_eq!(operators[0].password_hash, "plain:twelve chars");
    assert_eq!(operators[0].created_at, T0);

    // Once an operator exists, bootstrapping is a no-op, whoever it names.
    assert!(
        !platform::bootstrap(&w.deps, "ops@jeeta.test", "twelve chars")
            .await
            .unwrap()
    );
    assert!(
        !platform::bootstrap(&w.deps, "other@jeeta.test", OPERATOR_PASSWORD)
            .await
            .unwrap()
    );
    assert_eq!(w.uow.snapshot().operators, operators);
}

#[tokio::test]
async fn login_and_resolve() {
    let w = World::new(&["p1", "aaaa", "tenant-1", "p2"]);
    assert!(
        platform::bootstrap(&w.deps, "ops@jeeta.test", OPERATOR_PASSWORD)
            .await
            .unwrap()
    );
    let operator_id = w.uow.snapshot().operators[0].id;

    // Login with any case; a 12-hour session whose token is stored only as its hash.
    let login_at = T0 + Duration::hours(1);
    let session = platform::login(&w.at(login_at), login(" OPS@jeeta.test", OPERATOR_PASSWORD))
        .await
        .unwrap();
    assert_eq!(session.token, "p1");
    assert_eq!(PLATFORM_SESSION_LIFETIME, Duration::hours(12));
    let expires = login_at + Duration::hours(12);
    assert_eq!(session.expires_at, expires);
    assert!(
        !format!("{session:?}").contains("p1"),
        "Debug masks the token"
    );
    let stored = w.uow.snapshot().platform_sessions;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].operator_id, operator_id);
    assert_eq!(stored[0].token_hash, hash_token("p1"));
    assert_eq!(stored[0].created_at, login_at);
    assert_eq!(stored[0].expires_at, expires);

    // The session resolves until the second it expires.
    let just_before = expires - Duration::seconds(1);
    assert_eq!(
        platform::resolve(&w.at(just_before), "p1").await.unwrap(),
        PlatformCtx {
            operator_id,
            now: just_before,
        }
    );
    let expired = err(platform::resolve(&w.at(expires), "p1").await);
    let unknown = err(platform::resolve(&w.deps, "no-such-token").await);
    for e in [&expired, &unknown] {
        assert_eq!(e.code, ErrorCode::Unauthenticated);
        assert_eq!(e.message, expired.message);
    }

    // A tenant's session is not an operator's.
    w.register(T0, "owner@example.com", "Acme").await;
    assert!(auth::resolve_session(&w.deps, "tenant-1").await.is_ok());
    let tenant = err(platform::resolve(&w.deps, "tenant-1").await);
    assert_eq!(tenant.code, ErrorCode::Unauthenticated);

    // Wrong password, unknown email and malformed email are answered identically, and an
    // unknown email still costs one password hash.
    let before = w.hasher.calls();
    let unknown =
        err(platform::login(&w.deps, login("nobody@jeeta.test", OPERATOR_PASSWORD)).await);
    assert_eq!(w.hasher.calls(), before + 1, "unknown email spends a hash");
    let wrong = err(platform::login(&w.deps, login("ops@jeeta.test", "wrong passphrase")).await);
    let malformed = err(platform::login(&w.deps, login("not-an-email", OPERATOR_PASSWORD)).await);
    // The tenant's credentials do not open an operator session either.
    let tenant = err(platform::login(&w.deps, login("owner@example.com", TENANT_PASSWORD)).await);
    for e in [&unknown, &wrong, &malformed, &tenant] {
        assert_eq!(e.code, ErrorCode::Unauthenticated);
        assert_eq!(e.message, "invalid credentials");
        assert_eq!(e.details, json!({}));
    }
    assert_eq!(
        w.uow.snapshot().platform_sessions.len(),
        1,
        "failed logins open no session"
    );

    // A second login opens a second session; both stay valid.
    let again = platform::login(&w.deps, login("ops@jeeta.test", OPERATOR_PASSWORD))
        .await
        .unwrap();
    assert_eq!(again.token, "p2");
    assert!(platform::resolve(&w.deps, "p1").await.is_ok());
    assert!(platform::resolve(&w.deps, "p2").await.is_ok());
}

#[tokio::test]
async fn list_workspaces_newest_first_with_owner_and_member_count() {
    let w = World::new(&["aaaa", "t1", "bbbb", "t2", "p1"]);
    let older = w.register(T0, "owner@alpha.example", "Alpha").await;
    let newer = w
        .register(T0 + Duration::hours(1), "owner@beta.example", "Beta")
        .await;
    let pctx = w.operator().await;

    let listed = platform::list_workspaces(&w.deps, &pctx).await.unwrap();
    let ids: Vec<WorkspaceId> = listed.iter().map(|x| x.id).collect();
    assert_eq!(ids, vec![newer, older]);
    let beta = &listed[0];
    assert_eq!(beta.name, "Beta");
    assert_eq!(beta.slug, "beta-bbbb");
    assert_eq!(beta.status, WorkspaceStatus::PendingPayment);
    assert_eq!(beta.created_at, T0 + Duration::hours(1));
    assert_eq!(
        beta.owner_email,
        Some(Email::parse("owner@beta.example").unwrap())
    );
    assert_eq!(beta.member_count, 1);

    // Serialised as the platform console receives it.
    let json = serde_json::to_value(beta).unwrap();
    assert_eq!(
        json,
        json!({
            "id": newer,
            "name": "Beta",
            "slug": "beta-bbbb",
            "status": "pending_payment",
            "created_at": "2026-10-22T10:00:00Z",
            "owner_email": "owner@beta.example",
            "member_count": 1,
        })
    );
}

#[tokio::test]
async fn set_status_activates_and_ledgers() {
    let w = World::new(&["aaaa", "t1", "p1"]);
    let ws = w.register(T0, "owner@alpha.example", "Alpha").await;
    let pctx = w.operator().await;
    let actor = Actor::System {
        component: format!("platform_operator:{}", pctx.operator_id),
    };

    let out = platform::set_status(&w.deps, &pctx, ws, WorkspaceStatus::Active)
        .await
        .unwrap();
    assert_eq!(out.id, ws);
    assert_eq!(out.status, WorkspaceStatus::Active);
    assert_eq!(
        out.owner_email,
        Some(Email::parse("owner@alpha.example").unwrap())
    );
    assert_eq!(out.member_count, 1);
    let stored = w.uow.snapshot();
    assert_eq!(stored.workspaces[0].status, WorkspaceStatus::Active);

    // The ledger of the workspace itself records the change, by the operator as a system actor.
    let entries = w.entries(ws, "platform.workspace_status").await;
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.workspace_id, ws);
    assert_eq!(entry.actor, actor);
    assert_eq!(entry.at, pctx.now);
    assert_eq!(
        entry.payload,
        json!({ "from": "pending_payment", "to": "active" })
    );
    let subject = entry.subject.as_ref().unwrap();
    assert_eq!(
        (subject.kind.as_str(), subject.id.clone()),
        ("workspace", ws.to_string())
    );

    // The tenant sees the workspace active.
    let principal = auth::resolve_session(&w.deps, "t1").await.unwrap();
    assert_eq!(
        principal.memberships[0].workspace_status,
        WorkspaceStatus::Active
    );

    // Setting the same status again changes nothing and writes no entry.
    let same = platform::set_status(&w.deps, &pctx, ws, WorkspaceStatus::Active)
        .await
        .unwrap();
    assert_eq!(same, out);
    assert_eq!(w.entries(ws, "platform.workspace_status").await.len(), 1);

    // Suspending is another change, with its own entry.
    let suspended = platform::set_status(&w.deps, &pctx, ws, WorkspaceStatus::Suspended)
        .await
        .unwrap();
    assert_eq!(suspended.status, WorkspaceStatus::Suspended);
    let entries = w.entries(ws, "platform.workspace_status").await;
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].payload,
        json!({ "from": "active", "to": "suspended" })
    );
    assert_eq!(entries[0].actor, actor);

    // An unknown workspace is not found, and nothing is written.
    let before = w.uow.snapshot().ledger.len();
    let missing = err(platform::set_status(
        &w.deps,
        &pctx,
        WorkspaceId::new_v7(),
        WorkspaceStatus::Active,
    )
    .await);
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert_eq!(w.uow.snapshot().ledger.len(), before);
}
