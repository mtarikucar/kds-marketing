use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::{
        Deps,
        auth::{self, RegisterInput},
        billing::{self, ReportPaymentInput},
    },
};
use jt_tenancy::{Permission, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};
use std::sync::Arc;
use time::Duration;

async fn world() -> (InMemoryUow, Deps, Ctx, ReportPaymentInput) {
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    let registered = auth::register(
        &deps,
        RegisterInput {
            email: "owner@billing.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Billing".into(),
        },
    )
    .await
    .unwrap();
    let principal = auth::resolve_session(&deps, &registered.token)
        .await
        .unwrap();
    let ctx = auth::ctx_for(
        &principal,
        registered.me.current_workspace.unwrap(),
        FIXED_NOW,
    )
    .unwrap();
    let status = billing::status(&deps, &ctx).await.unwrap();
    let input = ReportPaymentInput {
        reference: status.payment_reference,
        amount_minor: 17,
        paid_at: FIXED_NOW - Duration::days(1),
        request_key: "one".into(),
    };
    (uow, deps, ctx, input)
}

#[tokio::test]
async fn report_does_not_activate_workspace() {
    let (_, deps, ctx, input) = world().await;
    let payment = billing::report_payment(&deps, &ctx, input).await.unwrap();
    assert!(!payment.confirmed);
    let status = billing::status(&deps, &ctx).await.unwrap();
    assert_eq!(status.workspace_status, WorkspaceStatus::PendingPayment);
    assert!(status.entitlement.is_none());
    assert_eq!(status.payment.unwrap(), payment);
}

#[tokio::test]
async fn report_idempotency_covers_reference_amount_paid_at() {
    let (uow, mut deps, ctx, input) = world().await;
    let first = billing::report_payment(&deps, &ctx, input.clone())
        .await
        .unwrap();
    deps.billing.price_currency = "USD".into();
    let mut normalized = input.clone();
    normalized.reference = format!(" {} ", input.reference.to_lowercase());
    assert_eq!(
        billing::report_payment(&deps, &ctx, normalized)
            .await
            .unwrap(),
        first
    );
    for field in ["reference", "amount", "time"] {
        let mut changed = input.clone();
        match field {
            "reference" => changed.reference.push('X'),
            "amount" => changed.amount_minor += 1,
            _ => changed.paid_at -= Duration::seconds(1),
        }
        assert_eq!(
            billing::report_payment(&deps, &ctx, changed)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.billing()
            .find_request("one")
            .await
            .unwrap()
            .unwrap()
            .currency,
        first.currency
    );
}

#[tokio::test]
async fn billing_instructions_and_reference_are_stable_read_only() {
    let (_, deps, ctx, _) = world().await;
    let a = billing::status(&deps, &ctx).await.unwrap();
    let b = billing::status(&deps, &ctx).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(a.price_minor, deps.billing.price_minor);
    assert_eq!(a.bank_instructions, deps.billing.bank_instructions);
    assert!(a.payment_reference.starts_with("JEETA-"));
}

#[tokio::test]
async fn owner_role_and_effective_scopes_required() {
    let (_, deps, mut ctx, input) = world().await;
    ctx.permissions.remove(&Permission::TeamManage);
    assert_eq!(
        billing::report_payment(&deps, &ctx, input.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    ctx.permissions.insert(Permission::TeamManage);
    // A stale caller-supplied role cannot replace current membership verification.
    let mut r = deps.uow.tenant(ctx.workspace_id).await.unwrap();
    let user = match ctx.actor {
        jt_ledger::Actor::Human { user_id } => user_id,
        _ => unreachable!(),
    };
    let m = r.memberships().find_by_user(user).await.unwrap().unwrap();
    let manager = r.roles().find_by_key("manager").await.unwrap().unwrap();
    r.memberships().set_role(m.id, manager.id).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        billing::report_payment(&deps, &ctx, input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn pending_can_report_suspended_cannot() {
    let (_, deps, ctx, input) = world().await;
    billing::report_payment(&deps, &ctx, input.clone())
        .await
        .unwrap();
    let mut r = deps.uow.tenant(ctx.workspace_id).await.unwrap();
    r.workspace()
        .set_status(
            ctx.workspace_id,
            WorkspaceStatus::Suspended,
            "test",
            &ctx.actor,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        billing::report_payment(&deps, &ctx, input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceInactive
    );
    assert_eq!(
        billing::status(&deps, &ctx).await.unwrap().workspace_status,
        WorkspaceStatus::Suspended
    );
}

#[tokio::test]
async fn payment_does_not_satisfy_strategy_gate() {
    let (_, deps, ctx, input) = world().await;
    billing::report_payment(&deps, &ctx, input).await.unwrap();
    let uc = jt_app::catalog::CATALOG
        .iter()
        .find(|u| u.id == "inbox.conversations.list")
        .unwrap();
    let err = jt_app::gate::check_gate(
        uc,
        WorkspaceStatus::Active,
        &jt_app::gate::NoStrategyYet,
        ctx.workspace_id,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::StrategyRequired);
}

#[tokio::test]
async fn billing_rows_do_not_open_team_keys_or_capabilities() {
    let (_, deps, ctx, input) = world().await;
    billing::report_payment(&deps, &ctx, input).await.unwrap();
    for uc in jt_app::catalog::CATALOG.iter().filter(|u| {
        ["team.", "api_keys.", "capability."]
            .iter()
            .any(|p| u.id.starts_with(p))
    }) {
        assert_eq!(
            jt_app::gate::check_gate(
                uc,
                WorkspaceStatus::PendingPayment,
                &jt_app::gate::NoStrategyYet,
                ctx.workspace_id
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::WorkspaceInactive
        );
    }
}

#[tokio::test]
async fn invalid_evidence_is_rejected_without_writes() {
    let (_, deps, ctx, input) = world().await;
    for case in 0..7 {
        let mut bad = input.clone();
        match case {
            0 => bad.amount_minor = 0,
            1 => bad.paid_at = FIXED_NOW + Duration::seconds(1),
            2 => bad.request_key = " ".into(),
            3 => bad.request_key = "x".repeat(129),
            4 => bad.reference = "foreign".into(),
            5 => bad.amount_minor = -1,
            _ => bad.paid_at += Duration::nanoseconds(1),
        }
        assert_eq!(
            billing::report_payment(&deps, &ctx, bad)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }
    assert!(
        billing::status(&deps, &ctx)
            .await
            .unwrap()
            .payment
            .is_none()
    );
}
