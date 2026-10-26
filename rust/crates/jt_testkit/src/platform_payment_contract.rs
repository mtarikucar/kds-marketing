//! Operator payment behavior shared by the transactional fake and real PostgreSQL.
use crate::{
    billing_contract::{Fixture, fixture, payment},
    fakes::{FIXED_NOW, deps},
};
use jt_app::{
    ctx::{Ctx, PlatformCtx},
    error::ErrorCode,
    ports::{LedgerFilter, UnitOfWork, billing::*},
    usecases::{Deps, platform, platform_payments},
};
use jt_ledger::Actor;
use jt_tenancy::{MembershipId, RoleDef, RoleId, SystemRole, WorkspaceStatus};
use std::sync::Arc;
use time::Duration;

pub struct World {
    pub deps: Deps,
    pub f: Fixture,
    pub ctx: PlatformCtx,
    pub payment: PaymentNotification,
}
impl World {
    pub async fn new(uow: Arc<dyn UnitOfWork>) -> Self {
        let f = fixture(uow.as_ref()).await;
        let mut r = uow.user().await.unwrap();
        let roles = [SystemRole::Owner, SystemRole::Manager, SystemRole::Rep].map(|role| RoleDef {
            id: RoleId::new_v7(),
            key: role.key().into(),
            name: role.key().into(),
            permissions: role.permissions(),
            is_system: true,
        });
        r.roles_create_system(f.ws, &roles).await.unwrap();
        r.memberships_insert_active(MembershipId::new_v7(), f.ws, f.user, roles[0].id, FIXED_NOW)
            .await
            .unwrap();
        r.commit().await.unwrap();
        let deps = Deps {
            ids: Arc::new(jt_app::std_impls::UuidV7Gen),
            tokens: Arc::new(jt_app::std_impls::RandTokenGen),
            ..deps(uow)
        };
        let ctx = PlatformCtx {
            operator_id: f.operator,
            now: FIXED_NOW,
        };
        let mut p = payment(&f);
        p.reference_sealed = deps.seal.seal(f.ws, b"SYNTHETIC-BANK-REFERENCE").unwrap();
        let mut r = deps.uow.tenant(f.ws).await.unwrap();
        r.billing().insert_payment(p.clone()).await.unwrap();
        r.commit().await.unwrap();
        Self {
            deps,
            f,
            ctx,
            payment: p,
        }
    }
    pub async fn entries(&self) -> Vec<jt_ledger::LedgerEntry> {
        let mut r = self.deps.uow.tenant(self.f.ws).await.unwrap();
        r.ledger()
            .list(LedgerFilter {
                action_prefix: None,
                actor_kind: None,
                agent_connection_id: None,
                limit: 100,
                before_id: None,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.entry)
            .collect()
    }
    pub fn owner(&self) -> Ctx {
        Ctx {
            workspace_id: self.f.ws,
            actor: Actor::Human {
                user_id: self.f.user,
            },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: FIXED_NOW,
            agent_connection_id: None,
        }
    }
    pub async fn activate(&self, code: &str) {
        jt_app::usecases::billing::activate(
            &self.deps,
            &self.owner(),
            jt_app::usecases::billing::ActivateInput { code: code.into() },
        )
        .await
        .unwrap();
    }
}

pub async fn confirmation_never_activates(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let out = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_eq!(out.workspace.status, WorkspaceStatus::PendingPayment);
    assert_eq!(out.entitlement.source, EntitlementSource::Paid);
    assert_eq!(out.entitlement.payment_id, Some(w.payment.id));
    assert!(out.entitlement.activated_at.is_none());
    let delivery = out.activation.unwrap();
    assert_eq!(delivery.code.len(), 8);
    assert!(
        delivery
            .code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    );
    assert_eq!(delivery.expires_at, FIXED_NOW + Duration::hours(72));
    let mut r = w.deps.uow.platform().await.unwrap();
    let grant = r.entitlement_get(w.f.ws).await.unwrap().unwrap();
    assert_eq!(grant.confirmed_by, Some(w.f.operator));
    let code = r
        .activation_code_lock_current_by_workspace(w.f.ws)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code.digest.len(), 32);
    assert_ne!(code.digest, delivery.code.as_bytes());
    assert_eq!(code.attempts, 0);
    assert_eq!(code.issued_by, w.f.operator);
    drop(r);
    let entries = w.entries().await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action.as_str(), "billing.confirmed");
    assert_eq!(
        entries[0].actor,
        Actor::System {
            component: format!("platform_operator:{}", w.f.operator)
        }
    );
    let audit = serde_json::to_string(&entries).unwrap();
    assert!(!audit.contains(&delivery.code));
    assert!(!audit.contains("SYNTHETIC-BANK-REFERENCE"));
    let retry = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_eq!(retry.entitlement, out.entitlement);
    assert!(retry.activation.is_none());
    assert_eq!(w.entries().await.len(), 1);
    let listed = platform_payments::list(&w.deps, &w.ctx).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].reference, "SYNTHETIC-BANK-REFERENCE");
    assert_eq!(listed[0].amount_minor, 123);
    assert_eq!(listed[0].currency, "TRY");
    assert_eq!(listed[0].paid_at, w.payment.paid_at);
    assert_eq!(listed[0].entitlement, Some(out.entitlement));
}

pub async fn concurrent_confirmation_creates_one_grant(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let (a, b) = tokio::join!(
        platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id),
        platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.entitlement, b.entitlement);
    assert_ne!(a.activation.is_some(), b.activation.is_some());
    assert_eq!(w.entries().await.len(), 1);
}

pub async fn confirmation_retry_after_suspend_does_not_reactivate(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let out = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    w.activate(&out.activation.unwrap().code).await;
    platform::suspend(&w.deps, &w.ctx, w.f.ws, "  operator hold  ")
        .await
        .unwrap();
    let before = w.entries().await;
    let retry = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_eq!(retry.workspace.status, WorkspaceStatus::Suspended);
    assert!(retry.activation.is_none());
    assert_eq!(retry.entitlement.activated_at, Some(FIXED_NOW));
    assert_eq!(w.entries().await, before);
    assert_eq!(
        platform_payments::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    let mut other = w.payment.clone();
    other.id = PaymentId::new_v7();
    other.request_key = "another".into();
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    r.billing().insert_payment(other.clone()).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, other.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
}

pub async fn reconfirm_same_payment_preserves_history(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let a = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    w.activate(&a.activation.unwrap().code).await;
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, " refund out of band ")
        .await
        .unwrap();
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    let closed = r.billing().latest_entitlement().await.unwrap().unwrap();
    assert_eq!(closed.id, a.entitlement.id);
    assert_eq!(closed.revoked_at, Some(FIXED_NOW));
    assert_eq!(closed.reason.as_deref(), Some("refund out of band"));
    assert_eq!(
        r.billing().get_payment(w.payment.id).await.unwrap(),
        Some(w.payment.clone())
    );
    drop(r);
    let b = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_ne!(a.entitlement.id, b.entitlement.id);
    assert!(b.activation.is_some());
    let c = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_eq!(b.entitlement, c.entitlement);
    assert!(c.activation.is_none());
    assert_eq!(w.entries().await.len(), 6);
}

pub async fn revoke_pending_challenge_invalidates_code(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    let out = platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "cancel confirmation")
        .await
        .unwrap();
    assert_eq!(out.status, WorkspaceStatus::PendingPayment);
    let mut r = w.deps.uow.platform().await.unwrap();
    assert!(r.entitlement_get(w.f.ws).await.unwrap().is_none());
    assert!(
        r.activation_code_lock_current_by_workspace(w.f.ws)
            .await
            .unwrap()
            .is_none()
    );
    drop(r);
    let entries = w.entries().await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].action.as_str(), "billing.activation_revoked");
}

pub async fn reason_required_and_repeated_transition_is_noop(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    for reason in ["".to_string(), "  \n ".into(), "ü".repeat(501)] {
        assert_eq!(
            platform::suspend(&w.deps, &w.ctx, w.f.ws, &reason)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Validation
        );
        assert_eq!(
            platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, &reason)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Validation
        );
    }
    assert_eq!(
        platform::suspend(&w.deps, &w.ctx, w.f.ws, "hold")
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        platform::resume(&w.deps, &w.ctx, w.f.ws)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "nothing to revoke")
        .await
        .unwrap();
    assert!(w.entries().await.is_empty());
    let a = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    w.activate(&a.activation.unwrap().code).await;
    platform::suspend(&w.deps, &w.ctx, w.f.ws, "  hold  ")
        .await
        .unwrap();
    let before = w.entries().await;
    assert_eq!(before.len(), 4);
    assert_eq!(before[0].payload["reason"], "hold");
    platform::suspend(&w.deps, &w.ctx, w.f.ws, "another reason")
        .await
        .unwrap();
    assert_eq!(w.entries().await, before);
    platform::resume(&w.deps, &w.ctx, w.f.ws).await.unwrap();
    platform::resume(&w.deps, &w.ctx, w.f.ws).await.unwrap();
    assert_eq!(w.entries().await.len(), 5);
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, &"ü".repeat(500))
        .await
        .unwrap();
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "again")
        .await
        .unwrap();
    assert_eq!(w.entries().await.len(), 7);
}

pub async fn resume_preserves_paid_and_grandfathered_entitlement(uow: Arc<dyn UnitOfWork>) {
    for paid in [true, false] {
        let w = World::new(uow.clone()).await;
        if paid {
            let a = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
                .await
                .unwrap();
            w.activate(&a.activation.unwrap().code).await;
        } else {
            let mut r = w.deps.uow.platform().await.unwrap();
            r.entitlement_insert(WorkspaceEntitlement {
                id: EntitlementId::new_v7(),
                workspace_id: w.f.ws,
                source: EntitlementSource::Grandfathered,
                payment_id: None,
                confirmed_by: None,
                confirmed_at: FIXED_NOW,
                activated_at: Some(FIXED_NOW),
                redeemed_by: None,
                revoked_at: None,
                reason: None,
            })
            .await
            .unwrap();
            r.workspace_set_status(
                w.f.ws,
                WorkspaceStatus::Active,
                "grandfathered fixture",
                &Actor::System {
                    component: "fixture".into(),
                },
            )
            .await
            .unwrap();
            r.commit().await.unwrap();
        }
        let mut r = w.deps.uow.platform().await.unwrap();
        let before = r.entitlement_get(w.f.ws).await.unwrap();
        drop(r);
        platform::suspend(&w.deps, &w.ctx, w.f.ws, "hold")
            .await
            .unwrap();
        assert_eq!(
            platform::resume(&w.deps, &w.ctx, w.f.ws)
                .await
                .unwrap()
                .status,
            WorkspaceStatus::Active
        );
        let mut r = w.deps.uow.platform().await.unwrap();
        assert_eq!(r.entitlement_get(w.f.ws).await.unwrap(), before);
    }
}

pub async fn wrong_workspace_payment_is_not_found(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow.clone()).await;
    let other = fixture(uow.as_ref()).await;
    assert_eq!(
        platform_payments::confirm(&w.deps, &w.ctx, other.ws, w.payment.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        platform_payments::reissue(&w.deps, &w.ctx, other.ws, w.payment.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::NotFound
    );
    assert!(w.entries().await.is_empty());
}

pub async fn reissue_invalidates_old_code_and_resets_attempts(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let a = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    let old = a.activation.unwrap();
    let mut r = w.deps.uow.platform().await.unwrap();
    for _ in 0..5 {
        r.activation_code_record_failed_attempt(w.f.ws, old.id)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let ctx = PlatformCtx {
        now: FIXED_NOW + Duration::hours(73),
        ..w.ctx
    };
    let b = platform_payments::reissue(&w.deps, &ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert_eq!(a.entitlement, b.entitlement);
    let new = b.activation.unwrap();
    assert_ne!(old.id, new.id);
    assert_ne!(old.code, new.code);
    assert_eq!(new.expires_at, ctx.now + Duration::hours(72));
    let mut r = w.deps.uow.platform().await.unwrap();
    let current = r
        .activation_code_lock_current_by_workspace(w.f.ws)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.id, new.id);
    assert_eq!(current.attempts, 0);
    assert_eq!(
        r.activation_code_consume(w.f.ws, old.id, ctx.now, w.f.user)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(r);
    let entries = w.entries().await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].action.as_str(), "billing.code_reissued");
    let audit = serde_json::to_string(&entries).unwrap();
    assert!(!audit.contains(&old.code));
    assert!(!audit.contains(&new.code));
    let owner = Ctx {
        now: ctx.now,
        ..w.owner()
    };
    assert_eq!(
        jt_app::usecases::billing::activate(
            &w.deps,
            &owner,
            jt_app::usecases::billing::ActivateInput { code: old.code }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Validation
    );
    let out = jt_app::usecases::billing::activate(
        &w.deps,
        &owner,
        jt_app::usecases::billing::ActivateInput { code: new.code },
    )
    .await
    .unwrap();
    assert_eq!(out.workspace_status, WorkspaceStatus::Active);
}

pub async fn confirmation_failure_rolls_back_every_effect(uow: Arc<dyn UnitOfWork>) {
    struct FixedId(uuid::Uuid);
    impl jt_app::ports::IdGen for FixedId {
        fn uuid(&self) -> uuid::Uuid {
            self.0
        }
    }
    let w = World::new(uow).await;
    let first = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    let old = first.activation.unwrap();
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "recheck")
        .await
        .unwrap();
    let before = w.entries().await;
    // The grant insert succeeds, then the code PK collides with the historical challenge.
    let broken = Deps {
        ids: Arc::new(FixedId(old.id.0)),
        ..w.deps.clone()
    };
    assert_eq!(
        platform_payments::confirm(&broken, &w.ctx, w.f.ws, w.payment.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    let mut r = w.deps.uow.platform().await.unwrap();
    assert!(r.entitlement_get(w.f.ws).await.unwrap().is_none());
    assert!(
        r.activation_code_lock_current_by_workspace(w.f.ws)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        r.payment_get(w.f.ws, w.payment.id).await.unwrap(),
        Some(w.payment.clone())
    );
    assert_eq!(
        r.workspace_get(w.f.ws).await.unwrap().unwrap().status,
        WorkspaceStatus::PendingPayment
    );
    drop(r);
    assert_eq!(w.entries().await, before);
    let recovered = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    assert!(recovered.activation.is_some());
    assert_ne!(recovered.entitlement.id, first.entitlement.id);
}

pub async fn first_confirmation_and_reissue_require_pending_and_matching_grant(
    uow: Arc<dyn UnitOfWork>,
) {
    let w = World::new(uow).await;
    assert_eq!(
        platform_payments::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    for status in [WorkspaceStatus::Active, WorkspaceStatus::Suspended] {
        let mut r = w.deps.uow.platform().await.unwrap();
        r.workspace_set_status(
            w.f.ws,
            status,
            "fixture",
            &Actor::System {
                component: "fixture".into(),
            },
        )
        .await
        .unwrap();
        r.commit().await.unwrap();
        assert_eq!(
            platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            platform_payments::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Conflict
        );
    }
    assert_eq!(
        platform::resume(&w.deps, &w.ctx, w.f.ws)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    let mut r = w.deps.uow.platform().await.unwrap();
    assert!(r.entitlement_get(w.f.ws).await.unwrap().is_none());
}
