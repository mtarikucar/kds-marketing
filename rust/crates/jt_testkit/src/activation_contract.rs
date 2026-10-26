//! Redemption contracts shared by the transactional fake and PostgreSQL.
use crate::{
    fakes::{FIXED_NOW, FixedTokenGen},
    platform_payment_contract::World,
};
use jt_app::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{UnitOfWork, billing::*},
    usecases::{
        billing::{self, ActivateInput, BillingStatusOut},
        platform, platform_payments,
    },
};
use jt_ledger::Actor;
use jt_tenancy::{MembershipId, SystemRole, WorkspaceStatus};
use std::sync::Arc;
use time::Duration;

pub async fn confirmed(uow: Arc<dyn UnitOfWork>) -> (World, String) {
    let w = World::new(uow).await;
    let out = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap();
    (w, out.activation.unwrap().code)
}
/// Redeems with the server clock reading the request's own time, as a prompt request would.
pub async fn redeem(w: &World, ctx: &Ctx, code: &str) -> Result<BillingStatusOut, AppError> {
    redeem_at(w, ctx, ctx.now, code).await
}
/// Redeems with a server clock that differs from the time the request was authenticated.
pub async fn redeem_at(
    w: &World,
    ctx: &Ctx,
    clock: time::OffsetDateTime,
    code: &str,
) -> Result<BillingStatusOut, AppError> {
    let deps = jt_app::usecases::Deps {
        clock: Arc::new(crate::fakes::FixedClock(clock)),
        ..w.deps.clone()
    };
    billing::activate(&deps, ctx, ActivateInput { code: code.into() }).await
}
pub async fn challenge(w: &World) -> ActivationCodeRow {
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    r.activation_codes()
        .lock_current_by_workspace()
        .await
        .unwrap()
        .unwrap()
}

pub async fn five_distinct_wrong_guesses_lock_challenge(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow).await;
    let before = w.entries().await;
    // Invalid alphabet/length, empty input and a well-formed wrong value all spend attempts.
    for (i, guess) in ["", "bad", "!!!!!!!!", "TOO-LONG-CODE", "00000000"]
        .iter()
        .enumerate()
    {
        let error = redeem(&w, &w.owner(), guess).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Validation);
        assert_eq!(error.details, serde_json::json!({"field":"code"}));
        assert_eq!(challenge(&w).await.attempts, i as i32 + 1);
    }
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Validation
    );
    assert_eq!(challenge(&w).await.attempts, 5);
    let status = billing::status(&w.deps, &w.owner()).await.unwrap();
    assert_eq!(status.workspace_status, WorkspaceStatus::PendingPayment);
    assert!(status.entitlement.unwrap().activated_at.is_none());
    assert_eq!(w.entries().await, before);
}

pub async fn concurrent_wrong_guesses_stop_at_five(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow).await;
    let ctx = w.owner();
    let guesses = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let results = tokio::join!(
        redeem(&w, &ctx, guesses[0]),
        redeem(&w, &ctx, guesses[1]),
        redeem(&w, &ctx, guesses[2]),
        redeem(&w, &ctx, guesses[3]),
        redeem(&w, &ctx, guesses[4]),
        redeem(&w, &ctx, guesses[5]),
        redeem(&w, &ctx, guesses[6]),
        redeem(&w, &ctx, guesses[7])
    );
    for result in [
        results.0, results.1, results.2, results.3, results.4, results.5, results.6, results.7,
    ] {
        assert_eq!(result.unwrap_err().code, ErrorCode::Validation);
    }
    assert_eq!(challenge(&w).await.attempts, 5);
    assert!(redeem(&w, &ctx, &code).await.is_err());
    assert_eq!(challenge(&w).await.attempts, 5);
    assert_eq!(w.entries().await.len(), 1);
}

pub async fn activation_expiry_at_72_hours(uow: Arc<dyn UnitOfWork>) {
    for delta in [
        Duration::hours(72) - Duration::microseconds(1),
        Duration::hours(72),
        Duration::hours(73),
    ] {
        let (w, code) = confirmed(uow.clone()).await;
        let ctx = Ctx {
            now: FIXED_NOW + delta,
            ..w.owner()
        };
        let before = challenge(&w).await;
        let result = redeem(&w, &ctx, &code).await;
        if delta < Duration::hours(72) {
            assert_eq!(result.unwrap().workspace_status, WorkspaceStatus::Active);
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::Validation);
            assert_eq!(challenge(&w).await, before);
            assert_eq!(w.entries().await.len(), 1);
        }
    }
}

/// A request authenticated before expiry but holding the locks after it is refused unchanged.
pub async fn stale_request_time_cannot_redeem_after_expiry(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow).await;
    let ctx = Ctx {
        now: FIXED_NOW + Duration::hours(71),
        ..w.owner()
    };
    let before = challenge(&w).await;
    let result = redeem_at(&w, &ctx, FIXED_NOW + Duration::hours(72), &code).await;
    assert_eq!(result.unwrap_err().code, ErrorCode::Validation);
    assert_eq!(challenge(&w).await, before);
    assert_eq!(w.entries().await.len(), 1);
    // Activation time and audit time come from the clock read under the lock.
    let at = FIXED_NOW + Duration::hours(10);
    let (w, code) = confirmed(w.deps.uow.clone()).await;
    let ctx = Ctx {
        now: FIXED_NOW + Duration::hours(9),
        ..w.owner()
    };
    let out = redeem_at(&w, &ctx, at, &code).await.unwrap();
    assert_eq!(out.entitlement.unwrap().activated_at, Some(at));
    let entries = w.entries().await;
    let activated = entries
        .iter()
        .find(|e| e.action.as_str() == "billing.activated")
        .unwrap();
    assert_eq!(activated.at, at);
}

pub async fn activation_binding_and_replay(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow.clone()).await;
    let (other, _) = confirmed(uow).await;
    assert_eq!(
        redeem(&other, &other.owner(), &code)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    assert_eq!(challenge(&w).await.attempts, 0);
    let current = challenge(&w).await;
    assert_ne!(
        billing::codes::activation_digest(&w.deps, w.f.ws, EntitlementId::new_v7(), &code).unwrap(),
        current.digest
    );
    let out = redeem(&w, &w.owner(), &code).await.unwrap();
    assert_eq!(out.workspace_status, WorkspaceStatus::Active);
    assert_eq!(out.entitlement.unwrap().activated_at, Some(FIXED_NOW));
    let consumed = challenge(&w).await;
    assert_eq!(consumed.consumed_at, Some(FIXED_NOW));
    assert_eq!(consumed.redeemed_by, Some(w.f.user));
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        r.billing()
            .entitlement()
            .await
            .unwrap()
            .unwrap()
            .redeemed_by,
        Some(w.f.user)
    );
    drop(r);
    let entries = w.entries().await;
    assert_eq!(entries.len(), 3);
    let activated = entries
        .iter()
        .find(|e| e.action.as_str() == "billing.activated")
        .unwrap();
    assert_eq!(activated.actor, w.owner().actor);
    assert_eq!(
        activated.payload,
        serde_json::json!({"entitlement_id":current.entitlement_id,"payment_id":w.payment.id,"activation_code_id":current.id,"redeemed_by":w.f.user})
    );
    assert!(!serde_json::to_string(&entries).unwrap().contains(&code));
    assert!(!format!("{:?}", ActivateInput { code: code.clone() }).contains(&code));
    assert!(redeem(&w, &w.owner(), &code).await.is_err());
    assert_eq!(challenge(&w).await, consumed);
    assert_eq!(w.entries().await, entries);
    assert_eq!(
        billing::status(&w.deps, &w.owner())
            .await
            .unwrap()
            .workspace_status,
        WorkspaceStatus::Active
    );
}

pub async fn current_owner_can_redeem_after_ownership_change(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow.clone()).await;
    let next = crate::billing_contract::fixture(uow.as_ref()).await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let old = r
        .memberships()
        .find_by_user(w.f.user)
        .await
        .unwrap()
        .unwrap();
    let owner = r.roles().find_by_key("owner").await.unwrap().unwrap();
    let manager = r.roles().find_by_key("manager").await.unwrap().unwrap();
    drop(r);
    let mut r = uow.user().await.unwrap();
    r.memberships_insert_active(
        MembershipId::new_v7(),
        w.f.ws,
        next.user,
        owner.id,
        FIXED_NOW,
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    r.memberships().set_role(old.id, manager.id).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(challenge(&w).await.attempts, 0);
    let ctx = Ctx {
        actor: Actor::Human { user_id: next.user },
        ..w.owner()
    };
    assert_eq!(
        redeem(&w, &ctx, &code).await.unwrap().workspace_status,
        WorkspaceStatus::Active
    );
    assert_eq!(challenge(&w).await.redeemed_by, Some(next.user));
}

pub async fn agent_cannot_activate_even_with_valid_code(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow).await;
    let mut ctx = w.owner();
    ctx.agent_connection_id = Some(jt_tenancy::AgentConnectionId::new_v7());
    assert_eq!(
        redeem(&w, &ctx, &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    ctx.agent_connection_id = None;
    ctx.actor = Actor::Agent {
        connection_id: jt_tenancy::AgentConnectionId::new_v7(),
        user_id: w.f.user,
    };
    assert_eq!(
        redeem(&w, &ctx, &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    ctx = w.owner();
    ctx.permissions = SystemRole::Rep.permissions();
    assert_eq!(
        redeem(&w, &ctx, &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(challenge(&w).await.attempts, 0);
    w.activate(&code).await;
}

pub async fn activate_suspend_resume_revoke_reconfirm_activate(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow).await;
    w.activate(&code).await;
    platform::suspend(&w.deps, &w.ctx, w.f.ws, "hold")
        .await
        .unwrap();
    assert!(redeem(&w, &w.owner(), &code).await.is_err());
    platform::resume(&w.deps, &w.ctx, w.f.ws).await.unwrap();
    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "refund externally")
        .await
        .unwrap();
    assert!(redeem(&w, &w.owner(), &code).await.is_err());
    let next = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap()
        .activation
        .unwrap();
    assert!(redeem(&w, &w.owner(), &code).await.is_err());
    w.activate(&next.code).await;
    assert_eq!(challenge(&w).await.attempts, 1);
    assert_eq!(
        w.entries()
            .await
            .iter()
            .filter(|e| e.action.as_str() == "billing.activated")
            .count(),
        2
    );
}

pub async fn issuance_rejects_every_historical_digest(uow: Arc<dyn UnitOfWork>) {
    let mut w = World::new(uow).await;
    w.deps.tokens = Arc::new(FixedTokenGen::new([
        "AAAAAAAA", "BBBBBBBB", "AAAAAAAA", "CCCCCCCC",
    ]));
    let first = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap()
        .activation
        .unwrap();
    let second = platform_payments::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap()
        .activation
        .unwrap();
    let third = platform_payments::reissue(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap()
        .activation
        .unwrap();
    assert_eq!(first.code, "AAAAAAAA");
    assert_eq!(second.code, "BBBBBBBB");
    assert_eq!(third.code, "CCCCCCCC");
    assert!(redeem(&w, &w.owner(), &first.code).await.is_err());
    assert!(redeem(&w, &w.owner(), &second.code).await.is_err());
    w.activate(&third.code).await;
}

pub async fn activation_consume_status_and_ledger_roll_back_together(uow: Arc<dyn UnitOfWork>) {
    use crate::activation_control::ControlledUow;
    let (mut w, code) = confirmed(uow.clone()).await;
    let before = challenge(&w).await;
    let entries = w.entries().await;
    w.deps.uow = Arc::new(ControlledUow {
        inner: uow.clone(),
        tenant_hold: None,
        platform_hold: None,
        fail_activation_audit: true,
    });
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Internal
    );
    assert_eq!(challenge(&w).await, before);
    let status = billing::status(&w.deps, &w.owner()).await.unwrap();
    assert_eq!(status.workspace_status, WorkspaceStatus::PendingPayment);
    assert!(status.entitlement.unwrap().activated_at.is_none());
    assert_eq!(w.entries().await, entries);
    w.deps.uow = uow;
    w.activate(&code).await;
}

pub async fn activation_suspend_revoke_serialize(uow: Arc<dyn UnitOfWork>) {
    use crate::activation_control::{ControlledUow, Hold};
    for revoke in [false, true] {
        for activation_first in [false, true] {
            let (mut w, code) = confirmed(uow.clone()).await;
            let hold = Arc::new(Hold::default());
            w.deps.uow = Arc::new(ControlledUow {
                inner: uow.clone(),
                tenant_hold: activation_first.then(|| hold.clone()),
                platform_hold: (!activation_first).then(|| hold.clone()),
                fail_activation_audit: false,
            });
            let ctx = w.owner();
            let activation = redeem(&w, &ctx, &code);
            let operator = async {
                if revoke {
                    platform_payments::revoke_activation(&w.deps, &w.ctx, w.f.ws, "refund").await
                } else {
                    platform::suspend(&w.deps, &w.ctx, w.f.ws, "hold").await
                }
            };
            tokio::pin!(activation, operator);
            // Poll the first use case until the decorator observes its real workspace lock.
            if activation_first {
                tokio::select! {biased; _=hold.reached.notified()=>{}, result=&mut activation=>panic!("completed before lock hold: {result:?}")}
            } else {
                tokio::select! {biased; _=hold.reached.notified()=>{}, result=&mut operator=>panic!("completed before lock hold: {result:?}")}
            }
            // The competing use case must actually wait while that database/fake lock is held.
            let blocked = std::time::Duration::from_millis(25);
            if activation_first {
                assert!(tokio::time::timeout(blocked, &mut operator).await.is_err());
            } else {
                assert!(
                    tokio::time::timeout(blocked, &mut activation)
                        .await
                        .is_err()
                );
            }
            hold.release.notify_one();
            let (activated, operated) = tokio::join!(activation, operator);
            if revoke {
                assert!(operated.is_ok());
                assert_eq!(activated.is_ok(), activation_first);
            } else {
                assert!(activated.is_ok());
                if activation_first {
                    assert!(operated.is_ok());
                } else {
                    assert_eq!(operated.unwrap_err().code, ErrorCode::Conflict);
                }
            }
            let status = billing::status(&w.deps, &ctx).await.unwrap();
            assert_eq!(
                status.workspace_status,
                if revoke {
                    WorkspaceStatus::PendingPayment
                } else if activation_first {
                    WorkspaceStatus::Suspended
                } else {
                    WorkspaceStatus::Active
                }
            );
            assert!(redeem(&w, &ctx, &code).await.is_err());
            if revoke {
                let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
                assert!(r.billing().entitlement().await.unwrap().is_none());
                assert!(
                    r.activation_codes()
                        .lock_current_by_workspace()
                        .await
                        .unwrap()
                        .is_none()
                );
            }
        }
    }
}

pub async fn strategy_approval_and_existing_confirm_actions_need_no_code(uow: Arc<dyn UnitOfWork>) {
    use jt_app::usecases::{capabilities, strategy};
    use serde_json::json;
    let (mut w, _code) = confirmed(uow).await;
    let ctx = w.owner();
    w.deps.channels = Arc::new(crate::fakes::FixedChannelCatalog(
        ["instagram".into()].into(),
    ));
    strategy::start_consultation(&w.deps, &ctx).await.unwrap();
    for (key, value) in [
        (
            "identity",
            json!({"product":"Coffee","voice":"warm","positioning":"local","usp":"fresh"}),
        ),
        (
            "audience",
            json!([{"key":"students","name":"Students","description":"campus"}]),
        ),
        (
            "channels",
            json!([{"channel":"instagram","rationale":"audience"}]),
        ),
        (
            "goals",
            json!({"objective":"50 DM","kpis":[{"name":"dm","target":"50"}]}),
        ),
        (
            "budget_frame",
            json!({"lanes":[{"lane":"organic","period":"monthly","cap_minor":0,"currency":"TRY"}]}),
        ),
        ("prohibitions", json!(["competitors"])),
        (
            "cadence",
            json!({"per_week":3,"channel_mix":[{"channel":"instagram","share_pct":100}]}),
        ),
        ("paid_enabled", json!(false)),
    ] {
        strategy::write_section(&w.deps, &ctx, key.into(), value)
            .await
            .unwrap();
    }
    strategy::set_hypotheses(&w.deps,&ctx,json!([{"title":"Exam week","segment_key":"students","angle":"late","channel":"instagram","metric":"dm","prior_confidence":0.6}])).await.unwrap();
    let submitted = strategy::submit(&w.deps, &ctx).await.unwrap();
    let approved = strategy::approve(
        &w.deps,
        &ctx,
        strategy::ApproveInput {
            version_id: submitted.id,
            submitted_at: submitted.submitted_at.unwrap(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        strategy::archive(
            &w.deps,
            &ctx,
            strategy::ArchiveInput {
                version_id: approved.id,
                confirm: false
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Validation
    );
    strategy::archive(
        &w.deps,
        &ctx,
        strategy::ArchiveInput {
            version_id: approved.id,
            confirm: true,
        },
    )
    .await
    .unwrap();
    let declared = capabilities::declare(
        &w.deps,
        &ctx,
        serde_json::from_value(json!({"kind_key":"phone","name":"Phone","connector_public":{}}))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        capabilities::retire(&w.deps, &ctx, declared.capability.id, false)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    capabilities::retire(&w.deps, &ctx, declared.capability.id, true)
        .await
        .unwrap();
    let c = challenge(&w).await;
    assert_eq!(c.attempts, 0);
    assert!(c.consumed_at.is_none());
    assert_eq!(
        billing::status(&w.deps, &ctx)
            .await
            .unwrap()
            .workspace_status,
        WorkspaceStatus::PendingPayment
    );
}

pub async fn membership_and_role_changes_wait_for_authorization_lock(uow: Arc<dyn UnitOfWork>) {
    let (w, code) = confirmed(uow.clone()).await;
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    r.workspace().lock().await.unwrap();
    let member = r
        .memberships()
        .lock_by_user(w.f.user)
        .await
        .unwrap()
        .unwrap();
    let manager = r.roles().find_by_key("manager").await.unwrap().unwrap();
    let change = async {
        let mut other = uow.tenant(w.f.ws).await.unwrap();
        other
            .memberships()
            .set_role(member.id, manager.id)
            .await
            .unwrap();
        other.commit().await.unwrap();
    };
    tokio::pin!(change);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut change)
            .await
            .is_err()
    );
    r.commit().await.unwrap();
    change.await;
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(challenge(&w).await.attempts, 0);
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    let owner = r.roles().find_by_key("owner").await.unwrap().unwrap();
    r.memberships().set_role(member.id, owner.id).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(w.f.ws).await.unwrap();
    r.memberships().lock_by_user(w.f.user).await.unwrap();
    let change = async {
        let mut other = uow.tenant(w.f.ws).await.unwrap();
        other
            .roles()
            .update_permissions(owner.id, SystemRole::Rep.permissions())
            .await
            .unwrap();
        other.commit().await.unwrap();
    };
    tokio::pin!(change);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(25), &mut change)
            .await
            .is_err()
    );
    r.commit().await.unwrap();
    change.await;
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(challenge(&w).await.attempts, 0);
}

pub async fn absent_and_invalidated_challenges_change_nothing(uow: Arc<dyn UnitOfWork>) {
    let w = World::new(uow).await;
    let before = w.entries().await;
    assert_eq!(
        redeem(&w, &w.owner(), "BAD").await.unwrap_err().code,
        ErrorCode::Validation
    );
    assert_eq!(w.entries().await, before);
    let code = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
        .await
        .unwrap()
        .activation
        .unwrap()
        .code;
    let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
    r.workspace().lock().await.unwrap();
    r.activation_codes()
        .invalidate_current(FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let before = w.entries().await;
    assert_eq!(
        redeem(&w, &w.owner(), &code).await.unwrap_err().code,
        ErrorCode::Validation
    );
    assert_eq!(w.entries().await, before);
    let status = billing::status(&w.deps, &w.owner()).await.unwrap();
    assert_eq!(status.workspace_status, WorkspaceStatus::PendingPayment);
    assert!(status.entitlement.unwrap().activated_at.is_none());
}
