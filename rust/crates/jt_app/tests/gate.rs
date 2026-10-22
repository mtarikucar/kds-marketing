use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use async_trait::async_trait;
use jt_app::catalog::{CATALOG, GateMode, Risk, UseCase, is_status_exempt};
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

const fn use_case(gate: GateMode, status_exempt: bool) -> UseCase {
    UseCase {
        id: "test.use_case",
        gate,
        mcp_tool: Some("jeeta.test.use_case"),
        panel_route: Some(("POST", "/api/test")),
        panel_only: false,
        mcp_only: false,
        status_exempt,
        risk: Risk::Write,
    }
}

const GATED: UseCase = use_case(GateMode::Gated, false);
/// Exempt from the strategy gate, but not from the workspace-status check (e.g. `team.list`).
const EXEMPT: UseCase = use_case(GateMode::Exempt, false);
/// Exempt from both (e.g. `workspace.info`).
const FREE: UseCase = use_case(GateMode::Exempt, true);
/// Gated by strategy, but running whatever the workspace's status.
const GATED_STATUS_EXEMPT: UseCase = use_case(GateMode::Gated, true);

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
        assert!(result.is_ok(), "{}: {result:?}", uc.status_exempt);
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
fn only_auth_workspace_and_platform_use_cases_are_status_exempt() {
    for id in ["auth.me", "workspace.info", "platform.workspaces.list"] {
        assert!(is_status_exempt(id), "{id}");
    }
    for id in [
        "team.list",
        "team.accept_invite",
        "roles.update",
        "api_keys.create",
        "agents.whoami",
        "ledger.list",
        "authority.x",
        "workspaces.x",
        "",
    ] {
        assert!(!is_status_exempt(id), "{id}");
    }
    for uc in CATALOG {
        assert_eq!(uc.status_exempt, is_status_exempt(uc.id), "{}", uc.id);
    }
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
