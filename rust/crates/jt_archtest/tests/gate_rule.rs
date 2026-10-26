//! The gate rule, structural half (spec §5, B1): only the use cases the Global Constraints list
//! may be `Exempt` from the strategy gate; every other use case is `Gated`. Separately, only
//! `auth.*`, `workspace.*` and `platform.*` use cases run whatever the workspace's status, and
//! `strategy.*` and `work.*` ones also while it awaits payment (never while it is suspended).
//! The behavioural half (a gated use case answers `STRATEGY_REQUIRED` / `WORKSPACE_INACTIVE`)
//! lives in the adapters' tests.

use jt_app::catalog::{CATALOG, GateMode, StatusExemption};

/// Id prefixes whose use cases may be exempt: identity, workspace and team administration, keys
/// and agents, the platform console, the strategy itself (it is what opens the gate), the
/// capabilities and budget items (the consultation needs to know what the workspace has, spec
/// §5), the pending work (an agent asks what is pending before any strategy exists), connecting
/// accounts (part of the consultation's prerequisites, M1b) and the inbound events (observation,
/// not planned work, M1b).
const EXEMPT_PREFIXES: &[&str] = &[
    "auth.",
    "workspace.",
    "team.",
    "roles.",
    "api_keys.",
    "agents.",
    "platform.",
    "strategy.",
    "capability.",
    "budget.",
    "work.",
    "connector.",
    "events.",
];

/// Single use cases that may be exempt outside those prefixes. Of the ledger, only reading it is.
const EXEMPT_IDS: &[&str] = &[
    "ops.health",
    "billing.status",
    "billing.activate",
    "billing.report_payment",
    "ledger.list",
    "inbox.pending",
    "inbox.context",
    "studio.brake",
    "studio.ledger",
    "studio.ledger_export",
];

fn may_be_exempt(id: &str) -> bool {
    EXEMPT_PREFIXES.iter().any(|p| id.starts_with(p)) || EXEMPT_IDS.contains(&id)
}

#[test]
fn only_listed_use_cases_are_exempt() {
    let offenders: Vec<&str> = CATALOG
        .iter()
        .filter(|uc| uc.gate == GateMode::Exempt && !may_be_exempt(uc.id))
        .map(|uc| uc.id)
        .collect();
    assert!(
        offenders.is_empty(),
        "use cases exempt from the gate without being on the exempt list (make them Gated): \
         {offenders:?}"
    );
}

/// Id prefixes whose use cases run whatever the workspace's status, as the Global Constraints
/// list them; written out here rather than read from `jt_app`, so a change there fails this test.
const STATUS_EXEMPT_PREFIXES: &[&str] = &["auth.", "workspace.", "platform."];

/// Id prefixes whose use cases also run while the workspace awaits payment (the strategy may be
/// worked out before payment, and an agent may ask what is pending meanwhile), but not while it
/// is suspended.
const PENDING_PAYMENT_EXEMPT_PREFIXES: &[&str] = &["strategy.", "work."];

#[test]
fn only_auth_workspace_and_platform_run_while_suspended_and_strategy_and_work_while_unpaid() {
    let expected = |id: &str| {
        if matches!(id, "billing.status" | "ops.health")
            || STATUS_EXEMPT_PREFIXES.iter().any(|p| id.starts_with(p))
        {
            StatusExemption::Always
        } else if id == "billing.activate"
            || id == "billing.report_payment"
            || PENDING_PAYMENT_EXEMPT_PREFIXES
                .iter()
                .any(|p| id.starts_with(p))
        {
            StatusExemption::PendingPayment
        } else {
            StatusExemption::Never
        }
    };
    let wrong: Vec<(&str, StatusExemption)> = CATALOG
        .iter()
        .filter(|uc| uc.status_exemption != expected(uc.id))
        .map(|uc| (uc.id, uc.status_exemption))
        .collect();
    assert!(
        wrong.is_empty(),
        "status_exemption must be Always exactly for auth.*, workspace.* and platform.*, \
         PendingPayment exactly for strategy.* and work.*, else Never: {wrong:?}"
    );
    assert_eq!(
        jt_app::catalog::STATUS_EXEMPT_PREFIXES,
        STATUS_EXEMPT_PREFIXES
    );
    assert_eq!(
        jt_app::catalog::PENDING_PAYMENT_EXEMPT_PREFIXES,
        PENDING_PAYMENT_EXEMPT_PREFIXES
    );
}

/// Connecting accounts and reading the inbound events (M1b) are part of the consultation's
/// prerequisites and observation, not planned work: every `connector.*` and `events.*` use case
/// is exempt from the strategy gate, and none is exempt from the workspace-status check (a
/// workspace awaiting payment or suspended connects nothing and acknowledges nothing).
#[test]
fn connection_and_event_use_cases_are_strategy_exempt_but_status_checked() {
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("connector.") || uc.id.starts_with("events."))
        .collect();
    // Eight connection use cases (seven tools and the panel's OAuth callback) and three event
    // ones: not vacuous.
    let ids: Vec<&str> = rows.iter().map(|uc| uc.id).collect();
    assert_eq!(
        ids,
        [
            "connector.start_oauth",
            "connector.complete_oauth",
            "connector.confirm_assets",
            "connector.set_credentials",
            "connector.probe",
            "connector.health",
            "connector.reconnect",
            "connector.hooks",
            "events.pending",
            "events.ack",
            "events.list",
        ]
    );
    for uc in rows {
        assert_eq!(uc.gate, GateMode::Exempt, "{} is strategy-exempt", uc.id);
        assert_eq!(
            uc.status_exemption,
            StatusExemption::Never,
            "{} is subject to the workspace-status check",
            uc.id
        );
    }
}

#[test]
fn the_exempt_list_rejects_other_use_cases() {
    assert!(may_be_exempt("team.invite"));
    assert!(may_be_exempt("ledger.list"));
    assert!(may_be_exempt("strategy.approve"));
    assert!(may_be_exempt("capability.groups.create"));
    assert!(may_be_exempt("budget.spend.record"));
    assert!(may_be_exempt("work.pending"));
    assert!(may_be_exempt("connector.probe"));
    assert!(may_be_exempt("events.ack"));
    assert!(!may_be_exempt("connectors.list"));
    assert!(!may_be_exempt("event.list"));
    assert!(!may_be_exempt("strategies.list"));
    assert!(!may_be_exempt("capabilities.list"));
    assert!(!may_be_exempt("budgets.list"));
    assert!(!may_be_exempt("ledger.export"));
    assert!(!may_be_exempt("mail.send"));
    assert!(!may_be_exempt("teams.list"));
    assert!(!may_be_exempt("works.list"));
}

/// `segment(.segment)+`, each segment `[a-z][a-z0-9_]*`.
fn is_dotted_lowercase(id: &str) -> bool {
    let segments: Vec<&str> = id.split('.').collect();
    segments.len() >= 2
        && segments.iter().all(|s| {
            let mut chars = s.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}

#[test]
fn catalog_ids_are_dotted_lowercase() {
    assert!(is_dotted_lowercase("platform.workspaces.suspend"));
    assert!(!is_dotted_lowercase("team"));
    assert!(!is_dotted_lowercase("Team.list"));
    assert!(!is_dotted_lowercase("team..list"));
    assert!(!is_dotted_lowercase("team.list-all"));
    assert!(!is_dotted_lowercase("team.1list"));

    for uc in CATALOG {
        assert!(
            is_dotted_lowercase(uc.id),
            "use case id `{}` is not dotted lowercase",
            uc.id
        );
    }
}

#[test]
fn inbox_core_keeps_exact_read_exemptions_and_status_gate() {
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("inbox."))
        .collect();
    assert_eq!(rows.len(), 46);
    for row in rows {
        assert_eq!(
            row.gate,
            if ["inbox.pending", "inbox.context"].contains(&row.id) {
                GateMode::Exempt
            } else {
                GateMode::Gated
            }
        );
        assert_eq!(row.status_exemption, StatusExemption::Never);
    }
}

#[test]
fn only_pending_and_context_are_exempt_inbox_reads() {
    for row in CATALOG.iter().filter(|r| r.id.starts_with("inbox.")) {
        assert_eq!(
            row.gate,
            if ["inbox.pending", "inbox.context"].contains(&row.id) {
                GateMode::Exempt
            } else {
                GateMode::Gated
            }
        );
        assert_eq!(row.status_exemption, StatusExemption::Never);
    }
}
