use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use async_trait::async_trait;
use jt_app::catalog::{CATALOG, GateMode, Risk, StatusExemption, UseCase, status_exemption};
use jt_app::error::{AppError, ErrorCode};
use jt_app::gate::{NoStrategyYet, StrategyGate, check_gate};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

/// Drives a future that never waits; every gate future in these tests resolves on first poll.
fn ready<F: Future>(fut: F) -> F::Output {
    let mut fut = pin!(fut);
    match fut.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(out) => out,
        Poll::Pending => panic!("gate future unexpectedly pending"),
    }
}

const fn use_case(gate: GateMode, status_exemption: StatusExemption) -> UseCase {
    UseCase {
        id: "test.use_case",
        gate,
        mcp_tool: Some("jeeta.test.use_case"),
        panel_route: Some(("POST", "/api/test")),
        panel_only: false,
        mcp_only: false,
        status_exemption,
        risk: Risk::Write,
    }
}

const GATED: UseCase = use_case(GateMode::Gated, StatusExemption::Never);
/// Exempt from the strategy gate, but not from the workspace-status check (e.g. `team.list`).
const EXEMPT: UseCase = use_case(GateMode::Exempt, StatusExemption::Never);
/// Exempt from both in every status (e.g. `workspace.info`).
const FREE: UseCase = use_case(GateMode::Exempt, StatusExemption::Always);
/// Exempt from the strategy gate, and from the status check only while the workspace awaits
/// payment (e.g. `strategy.get`, `work.pending`).
const PREPARED: UseCase = use_case(GateMode::Exempt, StatusExemption::PendingPayment);
/// Gated by strategy, but running whatever the workspace's status.
const GATED_STATUS_EXEMPT: UseCase = use_case(GateMode::Gated, StatusExemption::Always);

const INACTIVE: [WorkspaceStatus; 2] =
    [WorkspaceStatus::PendingPayment, WorkspaceStatus::Suspended];

struct ApprovedStrategy;

#[async_trait]
impl StrategyGate for ApprovedStrategy {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(true)
    }
}

fn code(result: Result<(), AppError>) -> ErrorCode {
    result.expect_err("gate let the call through").code
}

#[test]
fn gated_on_active_workspace_without_strategy_is_strategy_required() {
    let ws = WorkspaceId::new_v7();
    let result = ready(check_gate(
        &GATED,
        WorkspaceStatus::Active,
        &NoStrategyYet,
        ws,
    ));
    assert_eq!(code(result), ErrorCode::StrategyRequired);
}

#[test]
fn gated_on_pending_payment_workspace_is_workspace_inactive() {
    let ws = WorkspaceId::new_v7();
    let result = ready(check_gate(
        &GATED,
        WorkspaceStatus::PendingPayment,
        &NoStrategyYet,
        ws,
    ));
    assert_eq!(code(result), ErrorCode::WorkspaceInactive);
}

#[test]
fn exempt_passes_on_an_active_workspace_without_strategy() {
    let ws = WorkspaceId::new_v7();
    for uc in [&EXEMPT, &FREE] {
        let result = ready(check_gate(uc, WorkspaceStatus::Active, &NoStrategyYet, ws));
        assert!(result.is_ok(), "{:?}: {result:?}", uc.status_exemption);
    }
}

#[test]
fn exempt_but_not_status_exempt_is_workspace_inactive_on_an_inactive_workspace() {
    let ws = WorkspaceId::new_v7();
    for status in INACTIVE {
        let err = ready(check_gate(&EXEMPT, status, &ApprovedStrategy, ws)).unwrap_err();
        assert_eq!(err.code, ErrorCode::WorkspaceInactive, "{status:?}");
        assert_eq!(err.details["status"], status.key());
    }
}

#[test]
fn status_exempt_and_exempt_passes_in_every_state() {
    let ws = WorkspaceId::new_v7();
    for status in [
        WorkspaceStatus::Active,
        WorkspaceStatus::PendingPayment,
        WorkspaceStatus::Suspended,
    ] {
        let result = ready(check_gate(&FREE, status, &NoStrategyYet, ws));
        assert!(result.is_ok(), "{status:?}: {result:?}");
    }
}

#[test]
fn status_exemption_does_not_lift_the_strategy_gate() {
    let ws = WorkspaceId::new_v7();
    for status in INACTIVE {
        let result = ready(check_gate(&GATED_STATUS_EXEMPT, status, &NoStrategyYet, ws));
        assert_eq!(code(result), ErrorCode::StrategyRequired, "{status:?}");
        let result = ready(check_gate(
            &GATED_STATUS_EXEMPT,
            status,
            &ApprovedStrategy,
            ws,
        ));
        assert!(result.is_ok(), "{status:?}: {result:?}");
    }
}

#[test]
fn suspended_blocks_strategy_and_work_too() {
    let ws = WorkspaceId::new_v7();
    // Awaiting payment, the strategy and the pending work run ...
    for status in [WorkspaceStatus::Active, WorkspaceStatus::PendingPayment] {
        let result = ready(check_gate(&PREPARED, status, &NoStrategyYet, ws));
        assert!(result.is_ok(), "{status:?}: {result:?}");
    }
    // ... but a suspended workspace closes them as it closes everything else.
    let err = ready(check_gate(
        &PREPARED,
        WorkspaceStatus::Suspended,
        &ApprovedStrategy,
        ws,
    ))
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::WorkspaceInactive);
    assert_eq!(err.details, serde_json::json!({ "status": "suspended" }));
    // So does the catalog: every strategy and work use case.
    for uc in CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("strategy.") || uc.id.starts_with("work."))
    {
        assert_eq!(
            uc.status_exemption,
            StatusExemption::PendingPayment,
            "{}",
            uc.id
        );
        let err = ready(check_gate(
            uc,
            WorkspaceStatus::Suspended,
            &ApprovedStrategy,
            ws,
        ));
        assert_eq!(code(err), ErrorCode::WorkspaceInactive, "{}", uc.id);
    }
}

#[test]
fn only_auth_workspace_and_platform_use_cases_are_status_exempt_in_every_status() {
    for id in ["auth.me", "workspace.info", "platform.workspaces.list"] {
        assert_eq!(status_exemption(id), StatusExemption::Always, "{id}");
    }
    for id in [
        "strategy.get",
        "strategy.approve",
        "work.pending",
        "work.checkin",
    ] {
        assert_eq!(
            status_exemption(id),
            StatusExemption::PendingPayment,
            "{id}"
        );
    }
    for id in [
        "team.list",
        "team.accept_invite",
        "roles.update",
        "api_keys.create",
        "agents.whoami",
        "ledger.list",
        "capability.declare",
        "budget.items.create",
        "authority.x",
        "workspaces.x",
        "strategies.x",
        "works.x",
        "",
    ] {
        assert_eq!(status_exemption(id), StatusExemption::Never, "{id}");
    }
    for uc in CATALOG {
        assert_eq!(uc.status_exemption, status_exemption(uc.id), "{}", uc.id);
    }
}

#[test]
fn each_exemption_allows_exactly_its_statuses() {
    use WorkspaceStatus::{Active, PendingPayment, Suspended};
    let allowed = |e: StatusExemption| {
        [Active, PendingPayment, Suspended]
            .into_iter()
            .filter(|s| e.allows(*s))
            .collect::<Vec<_>>()
    };
    assert_eq!(allowed(StatusExemption::Never), [Active]);
    assert_eq!(
        allowed(StatusExemption::PendingPayment),
        [Active, PendingPayment]
    );
    assert_eq!(
        allowed(StatusExemption::Always),
        [Active, PendingPayment, Suspended]
    );
}

#[test]
fn approved_strategy_lets_gated_pass_on_active() {
    let ws = WorkspaceId::new_v7();
    let result = ready(check_gate(
        &GATED,
        WorkspaceStatus::Active,
        &ApprovedStrategy,
        ws,
    ));
    assert!(result.is_ok(), "{result:?}");
}

// Beyond the brief: pins the details later crates rely on.

#[test]
fn inactive_wins_even_with_an_approved_strategy() {
    let ws = WorkspaceId::new_v7();
    for status in INACTIVE {
        let err = ready(check_gate(&GATED, status, &ApprovedStrategy, ws)).unwrap_err();
        assert_eq!(err.code, ErrorCode::WorkspaceInactive);
        assert_eq!(err.details["status"], status.key());
    }
}

#[test]
fn gate_errors_serialise_as_structured_errors() {
    let ws = WorkspaceId::new_v7();
    let err = ready(check_gate(
        &GATED,
        WorkspaceStatus::Active,
        &NoStrategyYet,
        ws,
    ))
    .unwrap_err();
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["code"], "STRATEGY_REQUIRED");
    assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()));
    assert!(v["details"].is_object());
}
