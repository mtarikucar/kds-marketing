//! The authentication use cases end to end through Postgres: with the production port
//! implementations (Argon2id, random tokens, UUIDv7 ids, the system clock), and side by side with
//! the in-memory fakes, which must answer exactly as the database does.

use std::fmt::Debug;
use std::sync::Arc;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{LedgerFilter, UnitOfWork};
use jt_app::std_impls::{Argon2Hasher, RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::auth::{self, LoginInput, RegisterInput};
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_app::usecases::{Deps, hash_token};
use jt_ledger::Actor;
use jt_pg::PgUnitOfWork;
use jt_tenancy::{MembershipId, SystemRole, WorkspaceId, WorkspaceStatus};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox,
    RecordingTenantHosts, ScriptedRegistry, SeqIdGen,
};
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const PASSWORD: &str = "correct horse battery";

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

fn ledger_filter() -> LedgerFilter {
    LedgerFilter {
        action_prefix: None,
        actor_kind: None,
        agent_connection_id: None,
        limit: 10,
        before_id: None,
    }
}

#[tokio::test]
async fn register_login_resolve_and_switch_through_postgres() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let deps = Deps {
        uow: Arc::new(uow.clone()),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(Argon2Hasher::default()),
        seal: Arc::new(PlainSecretBox),
        channels: Arc::new(NoChannelsYet),
        file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
        media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
        files: Arc::new(jt_app::ports::files::UnavailableFileStore),
        transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(RecordingTenantHosts::new()),
        apps: Arc::new(FakeAppConfig::default()),
        connectors: Arc::new(ScriptedRegistry::new()),
        ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
        ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
        device_uploads: std::sync::Arc::new(
            jt_app::usecases::devices::uploads::UploadTurns::default(),
        ),
        bridge_signals: std::sync::Arc::new(jt_app::std_impls::LocalBridgeSignals::default()),
        billing: jt_app::usecases::billing::BillingConfig {
            price_minor: 123,
            price_currency: "TRY".into(),
            bank_instructions: "Synthetic bank instructions".into(),
        },
        job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
    };

    // Registration.
    let alpha = auth::register(&deps, input("Owner@Alpha.example", "Alpha Ajans"))
        .await
        .unwrap();
    assert_eq!(alpha.token.len(), 43, "32 random bytes, base64url");
    let ws_a = alpha.me.current_workspace.unwrap();
    assert_eq!(alpha.me.email.as_str(), "owner@alpha.example");
    let view = &alpha.me.memberships[0];
    assert_eq!(view.workspace_id, ws_a);
    assert!(
        view.workspace_slug.starts_with("alpha-ajans-") && view.workspace_slug.len() == 16,
        "{}",
        view.workspace_slug
    );
    assert_eq!(view.workspace_status, WorkspaceStatus::PendingPayment);
    assert_eq!(view.role_key, "owner");
    assert_eq!(view.permissions, SystemRole::Owner.permissions());

    // Stored: an Argon2id hash of the password, and only the hash of the session token.
    let mut u = uow.user().await.unwrap();
    let user = u
        .users()
        .find_by_email(&alpha.me.email)
        .await
        .unwrap()
        .unwrap();
    assert!(user.password_hash.starts_with("$argon2id$"));
    let session = u
        .sessions()
        .find_by_token_hash(&hash_token(&alpha.token))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.current_workspace_id, Some(ws_a));
    assert_eq!(session.expires_at - session.created_at, Duration::days(30));
    assert!(
        u.sessions()
            .find_by_token_hash(&alpha.token)
            .await
            .unwrap()
            .is_none()
    );
    drop(u);

    // The registration and its ledger entry are one transaction.
    let mut t = uow.tenant(ws_a).await.unwrap();
    let entries = t.ledger().list(ledger_filter()).await.unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0].entry;
    assert_eq!(entry.action.as_str(), "auth.register");
    assert_eq!(
        entry.actor,
        Actor::Human {
            user_id: alpha.me.user_id
        }
    );
    assert_eq!(
        entry.payload,
        json!({ "email": "owner@alpha.example", "workspace_id": ws_a.to_string() })
    );
    let roles: Vec<String> = t
        .roles()
        .list()
        .await
        .unwrap()
        .into_iter()
        .map(|r| format!("{}:{}", r.key, r.name))
        .collect();
    assert_eq!(roles, ["owner:Sahip", "manager:Yönetici", "rep:Temsilci"]);
    drop(t);

    let principal = auth::resolve_session(&deps, &alpha.token).await.unwrap();
    assert_eq!(auth::me(&deps, &principal), alpha.me);

    let dup = err(auth::register(&deps, input("owner@ALPHA.example", "Again")).await);
    assert_eq!(dup.code, ErrorCode::Conflict);

    // Login, in any case; one answer for a wrong password and an unknown email.
    let session = auth::login(&deps, login("  OWNER@alpha.EXAMPLE", PASSWORD))
        .await
        .unwrap();
    assert_ne!(session.token, alpha.token);
    assert_eq!(session.me.current_workspace, Some(ws_a));
    let wrong = err(auth::login(&deps, login("owner@alpha.example", "not the password")).await);
    let unknown = err(auth::login(&deps, login("nobody@alpha.example", PASSWORD)).await);
    assert_eq!(wrong.code, ErrorCode::Unauthenticated);
    assert_eq!(unknown.code, ErrorCode::Unauthenticated);
    assert_eq!(wrong.message, unknown.message);

    // Switching: Alpha's owner joins Beta as a rep, then works there.
    let beta = auth::register(&deps, input("owner@beta.example", "Beta"))
        .await
        .unwrap();
    let ws_b = beta.me.current_workspace.unwrap();
    let rep = {
        let mut t = uow.tenant(ws_b).await.unwrap();
        t.roles().find_by_key("rep").await.unwrap().unwrap()
    };
    let mut u = uow.user().await.unwrap();
    u.memberships_insert_active(
        MembershipId::new_v7(),
        ws_b,
        alpha.me.user_id,
        rep.id,
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    u.commit().await.unwrap();

    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    assert_eq!(principal.memberships.len(), 2);
    auth::switch_workspace(&deps, &principal, ws_b)
        .await
        .unwrap();
    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    assert_eq!(principal.current_workspace, Some(ws_b));
    let ctx = auth::ctx_for(&principal, ws_b, OffsetDateTime::now_utc()).unwrap();
    assert_eq!(ctx.permissions, SystemRole::Rep.permissions());
    let stranger = err(auth::switch_workspace(&deps, &principal, WorkspaceId::new_v7()).await);
    assert_eq!(stranger.code, ErrorCode::Forbidden);
    let first = auth::resolve_session(&deps, &alpha.token).await.unwrap();
    assert_eq!(
        first.current_workspace,
        Some(ws_a),
        "the other session stays"
    );

    // Logout revokes that session only, and repeats harmlessly.
    auth::logout(&deps, &session.token).await.unwrap();
    auth::logout(&deps, &session.token).await.unwrap();
    let revoked = err(auth::resolve_session(&deps, &session.token).await);
    assert_eq!(revoked.code, ErrorCode::Unauthenticated);
    assert!(auth::resolve_session(&deps, &alpha.token).await.is_ok());

    // Thirty days later the registration session has expired.
    let later = Deps {
        clock: Arc::new(FixedClock(
            OffsetDateTime::now_utc() + Duration::days(30) + Duration::seconds(1),
        )),
        ..deps.clone()
    };
    let expired = err(auth::resolve_session(&later, &alpha.token).await);
    assert_eq!(expired.code, ErrorCode::Unauthenticated);
}

/// Deterministic ports over `uow`, so a fake and a database run produce identical values.
fn scripted(uow: Arc<dyn UnitOfWork>) -> Deps {
    Deps {
        uow,
        clock: Arc::new(FixedClock(datetime!(2026-10-22 09:00 UTC))),
        ids: Arc::new(SeqIdGen::new()),
        tokens: Arc::new(FixedTokenGen::new(["ab12", "s1", "s2"])),
        hasher: Arc::new(PlainHasher),
        seal: Arc::new(PlainSecretBox),
        channels: Arc::new(NoChannelsYet),
        file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
        media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
        files: Arc::new(jt_app::ports::files::UnavailableFileStore),
        transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(RecordingTenantHosts::new()),
        apps: Arc::new(FakeAppConfig::default()),
        connectors: Arc::new(ScriptedRegistry::new()),
        ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
        ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
        device_uploads: std::sync::Arc::new(
            jt_app::usecases::devices::uploads::UploadTurns::default(),
        ),
        bridge_signals: std::sync::Arc::new(jt_app::std_impls::LocalBridgeSignals::default()),
        billing: jt_app::usecases::billing::BillingConfig {
            price_minor: 123,
            price_currency: "TRY".into(),
            bank_instructions: "Synthetic bank instructions".into(),
        },
        job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
    }
}

#[tokio::test]
async fn the_fakes_answer_exactly_as_postgres_does() {
    let db = TestDb::new().await;
    let fake_uow = InMemoryUow::new();
    let pg_uow = PgUnitOfWork::new(db.pool.clone());
    let fake = scripted(Arc::new(fake_uow.clone()));
    let pg = scripted(Arc::new(pg_uow.clone()));

    let on_fake = auth::register(&fake, input("Owner@Example.com", "Çiçek Bahçesi"))
        .await
        .unwrap();
    let on_pg = auth::register(&pg, input("Owner@Example.com", "Çiçek Bahçesi"))
        .await
        .unwrap();
    assert_eq!(on_fake, on_pg);
    assert_eq!(
        serde_json::to_value(&on_fake.me).unwrap(),
        serde_json::to_value(&on_pg.me).unwrap()
    );
    let ws = on_pg.me.current_workspace.unwrap();

    let fake_ledger = fake_uow.snapshot().ledger;
    let pg_ledger = pg_uow
        .tenant(ws)
        .await
        .unwrap()
        .ledger()
        .list(ledger_filter())
        .await
        .unwrap();
    assert_eq!(fake_ledger, pg_ledger);

    assert_eq!(
        auth::resolve_session(&fake, "s1").await.unwrap(),
        auth::resolve_session(&pg, "s1").await.unwrap()
    );
    assert_eq!(
        auth::login(&fake, login("owner@example.com", PASSWORD))
            .await
            .unwrap(),
        auth::login(&pg, login("owner@example.com", PASSWORD))
            .await
            .unwrap()
    );

    let fake_dup = err(auth::register(&fake, input("OWNER@example.com", "Other")).await);
    let pg_dup = err(auth::register(&pg, input("OWNER@example.com", "Other")).await);
    assert_eq!(
        (fake_dup.code, fake_dup.message),
        (pg_dup.code, pg_dup.message)
    );
    let fake_wrong = err(auth::login(&fake, login("owner@example.com", "wrong password")).await);
    let pg_wrong = err(auth::login(&pg, login("owner@example.com", "wrong password")).await);
    assert_eq!(
        (fake_wrong.code, fake_wrong.message),
        (pg_wrong.code, pg_wrong.message)
    );
}
