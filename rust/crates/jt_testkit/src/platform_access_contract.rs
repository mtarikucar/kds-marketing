//! Password recovery contracts shared by the fake and PostgreSQL.
use crate::fakes::{FIXED_NOW, PlainHasher, deps};
use jt_app::{
    ctx::PlatformCtx,
    error::ErrorCode,
    ports::{OperatorRow, PasswordHasher, UnitOfWork},
    usecases::{Deps, auth::LoginInput, platform},
};
use jt_tenancy::{Email, OperatorId};
use std::sync::Arc;

const OLD: &str = "synthetic old password";
const NEW: &str = "synthetic new password";
fn input(password: &str) -> LoginInput {
    LoginInput {
        email: "operator@example.test".into(),
        password: password.into(),
    }
}
fn world(uow: Arc<dyn UnitOfWork>) -> Deps {
    Deps {
        ids: Arc::new(jt_app::std_impls::UuidV7Gen),
        tokens: Arc::new(jt_app::std_impls::RandTokenGen),
        ..deps(uow)
    }
}
async fn seed(d: &Deps) -> OperatorId {
    platform::bootstrap(d, "operator@example.test", OLD)
        .await
        .unwrap();
    let s = platform::login(d, input(OLD)).await.unwrap();
    platform::resolve(d, &s.token).await.unwrap().operator_id
}
async fn second(d: &Deps) -> PlatformCtx {
    let id = OperatorId::new_v7();
    let mut r = d.uow.platform().await.unwrap();
    r.operators()
        .insert(OperatorRow {
            id,
            email: Email::parse("second@example.test").unwrap(),
            password_hash: PlainHasher.hash(OLD).await.unwrap(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    PlatformCtx {
        operator_id: id,
        now: FIXED_NOW,
    }
}
pub async fn operator_reset_revokes_all_sessions(uow: Arc<dyn UnitOfWork>) {
    let d = world(uow);
    let id = seed(&d).await;
    let a = platform::login(&d, input(OLD)).await.unwrap();
    let b = platform::login(&d, input(OLD)).await.unwrap();
    let actor = second(&d).await;
    let self_ctx = PlatformCtx {
        operator_id: id,
        now: FIXED_NOW,
    };
    assert_eq!(
        platform::reset_password(&d, &self_ctx, id, NEW)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        platform::reset_password(&d, &actor, id, "short")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let other = platform::login(
        &d,
        LoginInput {
            email: "second@example.test".into(),
            password: OLD.into(),
        },
    )
    .await
    .unwrap();
    platform::reset_password(&d, &actor, id, NEW).await.unwrap();
    for token in [&a.token, &b.token] {
        assert!(platform::resolve(&d, token).await.is_err());
    }
    assert!(platform::resolve(&d, &other.token).await.is_ok());
    assert!(platform::login(&d, input(OLD)).await.is_err());
    assert!(platform::login(&d, input(NEW)).await.is_ok());
}
pub async fn sole_operator_bootstrap_reset_changes_password(uow: Arc<dyn UnitOfWork>) {
    let d = world(uow);
    seed(&d).await;
    let s = platform::login(&d, input(OLD)).await.unwrap();
    assert!(
        platform::bootstrap_reset(&d, "operator@example.test", "short")
            .await
            .is_err()
    );
    platform::bootstrap_reset(&d, "operator@example.test", NEW)
        .await
        .unwrap();
    assert!(platform::resolve(&d, &s.token).await.is_err());
    assert!(platform::login(&d, input(OLD)).await.is_err());
    assert!(platform::login(&d, input(NEW)).await.is_ok());
}
pub async fn bootstrap_reset_rejects_zero_multiple_or_wrong_operator(uow: Arc<dyn UnitOfWork>) {
    let d = world(uow);
    assert!(
        platform::bootstrap_reset(&d, "operator@example.test", NEW)
            .await
            .is_err()
    );
    seed(&d).await;
    assert!(
        platform::bootstrap_reset(&d, "wrong@example.test", NEW)
            .await
            .is_err()
    );
    second(&d).await;
    assert!(
        platform::bootstrap_reset(&d, "operator@example.test", NEW)
            .await
            .is_err()
    );
    assert!(platform::login(&d, input(OLD)).await.is_ok());
    assert!(platform::login(&d, input(NEW)).await.is_err());
}
struct PausingHasher {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl PasswordHasher for PausingHasher {
    async fn hash(&self, p: &str) -> Result<String, jt_app::error::AppError> {
        PlainHasher.hash(p).await
    }
    async fn verify(&self, p: &str, h: &str) -> Result<bool, jt_app::error::AppError> {
        self.entered.notify_one();
        self.release.notified().await;
        PlainHasher.verify(p, h).await
    }
}
pub async fn reset_and_inflight_login_serialize(uow: Arc<dyn UnitOfWork>) {
    let d = world(uow);
    seed(&d).await;
    let pause = Arc::new(PausingHasher {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let login_deps = Deps {
        hasher: pause.clone(),
        ..d.clone()
    };
    let login = tokio::spawn(async move { platform::login(&login_deps, input(OLD)).await });
    pause.entered.notified().await;
    let reset_deps = d.clone();
    let mut reset = tokio::spawn(async move {
        platform::bootstrap_reset(&reset_deps, "operator@example.test", NEW).await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut reset)
            .await
            .is_err(),
        "reset must wait for password verification and session insertion"
    );
    pause.release.notify_one();
    let s = login.await.unwrap().unwrap();
    reset.await.unwrap().unwrap();
    assert!(platform::resolve(&d, &s.token).await.is_err());
    // Reverse order: a login queued behind reset sees the replacement hash.
    let mut r = d.uow.platform().await.unwrap();
    r.operators().lock_all().await.unwrap();
    let queued_deps = d.clone();
    let mut queued = tokio::spawn(async move { platform::login(&queued_deps, input(NEW)).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut queued)
            .await
            .is_err()
    );
    let rows = r.operators().lock_all().await.unwrap();
    r.operators()
        .set_password(rows[0].id, &PlainHasher.hash(OLD).await.unwrap())
        .await
        .unwrap();
    r.platform_sessions().revoke_all(rows[0].id).await.unwrap();
    r.commit().await.unwrap();
    assert!(queued.await.unwrap().is_err());
}

pub async fn recovery_lock_serializes_operator_insert(uow: Arc<dyn UnitOfWork>) {
    let d = world(uow);
    seed(&d).await;
    let mut r = d.uow.platform().await.unwrap();
    assert_eq!(r.operators().lock_all().await.unwrap().len(), 1);
    let other = d.clone();
    let mut insert = tokio::spawn(async move { second(&other).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut insert)
            .await
            .is_err(),
        "operator insertion must wait for the recovery predicate lock"
    );
    r.commit().await.unwrap();
    insert.await.unwrap();
    assert_eq!(
        d.uow
            .platform()
            .await
            .unwrap()
            .operators()
            .count()
            .await
            .unwrap(),
        2
    );
}
