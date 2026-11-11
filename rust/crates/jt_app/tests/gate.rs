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
    for id in [
        "auth.me",
        "workspace.info",
        "platform.workspaces.list",
        // An objection must always be recordable.
        "prospects.do_not_contact",
        "prospects.erase",
    ] {
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
        "prospects.create",
        "prospects.dnc_lift",
        "prospects.do_not_contact_x",
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

/// Owner decision of 2026-11-03: reading and answering customers never waits for a marketing
/// strategy, which keeps gating the growth work (the Studio here), and the one inbox row that
/// starts commercial contact. The workspace-status check is unchanged for every inbox row.
#[test]
fn the_inbox_runs_without_a_strategy_while_the_studio_and_outreach_do_not() {
    let ws = WorkspaceId::new_v7();
    let inbox: Vec<&UseCase> = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("inbox."))
        .collect();
    assert_eq!(inbox.len(), 49);
    for uc in &inbox {
        let result = ready(check_gate(uc, WorkspaceStatus::Active, &NoStrategyYet, ws));
        if uc.id == "inbox.send" {
            assert_eq!(code(result), ErrorCode::StrategyRequired, "{}", uc.id);
        } else {
            assert!(result.is_ok(), "{}: {result:?}", uc.id);
        }
        // Erasure and suppressions included: an inactive workspace closes every inbox row,
        // whatever the strategy.
        for status in INACTIVE {
            let result = ready(check_gate(uc, status, &ApprovedStrategy, ws));
            assert_eq!(
                code(result),
                ErrorCode::WorkspaceInactive,
                "{} {status:?}",
                uc.id
            );
        }
    }
    for id in [
        "inbox.conversations.list",
        "inbox.messages.list",
        "inbox.reply",
        "inbox.people.erase",
        "inbox.suppressions.add",
    ] {
        assert!(inbox.iter().any(|uc| uc.id == id), "{id}");
    }
    let studio = jt_app::catalog::find("studio.overview").unwrap();
    let result = ready(check_gate(
        studio,
        WorkspaceStatus::Active,
        &NoStrategyYet,
        ws,
    ));
    assert_eq!(code(result), ErrorCode::StrategyRequired);
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

/// Approved strategy; every module but strategy lacks its capability.
struct NothingConnected;

#[async_trait]
impl StrategyGate for NothingConnected {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(true)
    }
    async fn missing_capabilities(
        &self,
        _ws: WorkspaceId,
        module: &str,
    ) -> Result<Vec<String>, AppError> {
        Ok(vec![format!("{module}-needs")])
    }
}

#[test]
fn a_locked_module_refuses_its_use_cases_on_both_transports_but_never_legal_or_stopping_duties() {
    use jt_app::catalog::find;
    use jt_app::gate::{CAPABILITY_EXEMPT, gating_module};
    let ws = WorkspaceId::new_v7();
    for (id, module) in [
        ("inbox.conversations.list", "inbox"),
        ("inbox.reply", "inbox"),
        ("studio.posts_list", "social"),
        ("studio.adsets_list", "ads"),
        ("studio.project_list", "content"),
        ("studio.materials_list", "materials"),
        ("outreach.campaigns_list", "outreach"),
        ("calls.place", "calls"),
    ] {
        let uc = find(id).unwrap_or_else(|| panic!("{id} is a catalog row"));
        let err = ready(check_gate(
            uc,
            WorkspaceStatus::Active,
            &NothingConnected,
            ws,
        ))
        .expect_err("a locked module refuses");
        assert_eq!(err.code, ErrorCode::CapabilityRequired, "{id}");
        assert_eq!(err.details["module"], module, "{id}");
        assert_eq!(err.details["missing"][0], format!("{module}-needs"), "{id}");
    }
    for id in CAPABILITY_EXEMPT {
        let uc = find(id).unwrap_or_else(|| panic!("{id} is a catalog row"));
        assert_eq!(gating_module(id), None, "{id}");
        assert!(
            ready(check_gate(
                uc,
                WorkspaceStatus::Active,
                &NothingConnected,
                ws
            ))
            .is_ok(),
            "{id}"
        );
    }
    // Strategy, the workspace and the device bridge's plumbing never wait for a module.
    for uc in CATALOG.iter().filter(|uc| {
        [
            "strategy.",
            "workspace.",
            "modules.",
            "capability.",
            "calls.bridge.",
        ]
        .iter()
        .any(|p| uc.id.starts_with(p))
    }) {
        assert_eq!(gating_module(uc.id), None, "{}", uc.id);
    }
    // The workspace-status check still comes first.
    let inbox = find("inbox.conversations.list").unwrap();
    assert_eq!(
        code(ready(check_gate(
            inbox,
            WorkspaceStatus::Suspended,
            &NothingConnected,
            ws
        ))),
        ErrorCode::WorkspaceInactive
    );
}

/// Approved strategy, every capability connected; one module is removed from the workspace.
struct Removed(&'static str);

#[async_trait]
impl StrategyGate for Removed {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(true)
    }
    async fn module_installed(&self, _ws: WorkspaceId, module: &str) -> Result<bool, AppError> {
        Ok(module != self.0)
    }
}

/// The five groups of `studio.*` use cases since the Growth Studio became four modules (design
/// 2026-11-10 Ek A): the shared library, content, social media, advertising, and the ones that
/// belong to no single module.
#[test]
fn every_studio_use_case_has_a_module_or_is_listed_cross_module() {
    use jt_app::gate::{gating_module, studio_module};
    use std::collections::BTreeMap;
    const CROSS_MODULE: [&str; 10] = [
        "studio.overview",
        "studio.pending",
        "studio.learned",
        "studio.ledger",
        "studio.ledger_export",
        "studio.judgment_record",
        "studio.trend_record",
        "studio.hypothesis_propose",
        "studio.brake",
        "studio.approve",
    ];
    let mut groups: BTreeMap<&str, usize> = BTreeMap::new();
    for uc in CATALOG.iter().filter(|uc| uc.id.starts_with("studio.")) {
        match studio_module(uc.id) {
            Some(module) => {
                *groups.entry(module).or_default() += 1;
                assert_eq!(gating_module(uc.id), Some(module), "{}", uc.id);
            }
            None => {
                assert!(CROSS_MODULE.contains(&uc.id), "{} has no module", uc.id);
                *groups.entry("none").or_default() += 1;
                assert_eq!(gating_module(uc.id), None, "{}", uc.id);
            }
        }
    }
    assert_eq!(
        groups,
        BTreeMap::from([
            ("materials", 28),
            ("content", 16),
            ("social", 12),
            ("ads", 3),
            ("none", 10),
        ])
    );
    for id in CROSS_MODULE {
        assert!(jt_app::catalog::find(id).is_some(), "{id} is a catalog row");
    }
    // Only `studio.*` ids have a Studio module.
    assert_eq!(studio_module("inbox.reply"), None);
    assert_eq!(studio_module("studio.no_such_action"), None);
}

#[test]
fn a_removed_module_refuses_its_use_cases_and_nothing_else() {
    use jt_app::catalog::find;
    let ws = WorkspaceId::new_v7();
    let gate = |id: &str, removed: &'static str| {
        let uc = find(id).unwrap_or_else(|| panic!("{id} is a catalog row"));
        ready(check_gate(
            uc,
            WorkspaceStatus::Active,
            &Removed(removed),
            ws,
        ))
    };
    for (id, module) in [
        ("studio.adset_bind", "ads"),
        ("studio.budget_move", "ads"),
        ("studio.posts_propose", "social"),
        ("studio.project_create", "content"),
        ("studio.material_add", "materials"),
        ("studio.piece_submit", "materials"),
    ] {
        let err = gate(id, module).expect_err("a removed module refuses");
        assert_eq!(err.code, ErrorCode::ModuleNotInstalled, "{id}");
        assert_eq!(err.details["module"], module, "{id}");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "MODULE_NOT_INSTALLED", "{id}");
        // Another module's removal does not touch it.
        let other = if module == "ads" { "social" } else { "ads" };
        assert!(gate(id, other).is_ok(), "{id} while {other} is removed");
    }
    // What belongs to no single module, and stopping what runs, stays open whatever is removed.
    for removed in ["content", "social", "ads", "materials"] {
        for id in [
            "studio.overview",
            "studio.pending",
            "studio.learned",
            "studio.brake",
            "studio.approve",
        ] {
            assert!(gate(id, removed).is_ok(), "{id} while {removed} is removed");
        }
    }
    // The older modules keep their rule: removal is navigation only, the gate does not ask.
    for (id, removed) in [
        ("inbox.reply", "inbox"),
        ("outreach.campaigns_list", "outreach"),
        ("calls.place", "calls"),
    ] {
        assert!(gate(id, removed).is_ok(), "{id}");
    }
    // The workspace-status check and the strategy gate still come first.
    let uc = find("studio.adset_bind").unwrap();
    assert_eq!(
        code(ready(check_gate(
            uc,
            WorkspaceStatus::Suspended,
            &Removed("ads"),
            ws
        ))),
        ErrorCode::WorkspaceInactive
    );
}

/// People records are `inbox.*` use cases, and the People module works without the inbox
/// (design 2026-11-10 §4.4): no module gates them.
#[test]
fn people_records_never_wait_for_the_inbox() {
    use jt_app::gate::gating_module;
    let ws = WorkspaceId::new_v7();
    let people: Vec<&UseCase> = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("inbox.people."))
        .collect();
    assert!(people.len() >= 4);
    for uc in people {
        assert_eq!(gating_module(uc.id), None, "{}", uc.id);
        assert!(
            ready(check_gate(
                uc,
                WorkspaceStatus::Active,
                &NothingConnected,
                ws
            ))
            .is_ok(),
            "{}",
            uc.id
        );
    }
    assert_eq!(gating_module("inbox.reply"), Some("inbox"));
}
