//! The gate rule, structural half (spec §5, B1): only the use cases the Global Constraints list
//! may be `Exempt` from the strategy gate; every other use case is `Gated`. Separately, only
//! `auth.*`, `workspace.*`, `platform.*` and `strategy.*` use cases are exempt from the
//! workspace-status check.
//! The behavioural half (a gated use case answers `STRATEGY_REQUIRED` / `WORKSPACE_INACTIVE`)
//! lives in the adapters' tests.

use jt_app::catalog::{CATALOG, GateMode};

/// Id prefixes whose use cases may be exempt: identity, workspace and team administration, keys
/// and agents, the platform console, the strategy itself (it is what opens the gate), and the
/// capabilities and budget items (the consultation needs to know what the workspace has, spec
/// §5).
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
];

/// Single use cases that may be exempt outside those prefixes. Of the ledger, only reading it is.
const EXEMPT_IDS: &[&str] = &["ledger.list"];

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
/// list them (the strategy may be worked out before payment); written out here rather than read
/// from `jt_app`, so a change there fails this test.
const STATUS_EXEMPT_PREFIXES: &[&str] = &["auth.", "workspace.", "platform.", "strategy."];

#[test]
fn only_auth_workspace_platform_and_strategy_use_cases_are_status_exempt() {
    let wrong: Vec<(&str, bool)> = CATALOG
        .iter()
        .filter(|uc| {
            uc.status_exempt != STATUS_EXEMPT_PREFIXES.iter().any(|p| uc.id.starts_with(p))
        })
        .map(|uc| (uc.id, uc.status_exempt))
        .collect();
    assert!(
        wrong.is_empty(),
        "status_exempt must be set exactly for auth.*, workspace.*, platform.* and strategy.* \
         use cases: {wrong:?}"
    );
    assert_eq!(
        jt_app::catalog::STATUS_EXEMPT_PREFIXES,
        STATUS_EXEMPT_PREFIXES
    );
}

#[test]
fn the_exempt_list_rejects_other_use_cases() {
    assert!(may_be_exempt("team.invite"));
    assert!(may_be_exempt("ledger.list"));
    assert!(may_be_exempt("strategy.approve"));
    assert!(may_be_exempt("capability.groups.create"));
    assert!(may_be_exempt("budget.spend.record"));
    assert!(!may_be_exempt("strategies.list"));
    assert!(!may_be_exempt("capabilities.list"));
    assert!(!may_be_exempt("budgets.list"));
    assert!(!may_be_exempt("ledger.export"));
    assert!(!may_be_exempt("mail.send"));
    assert!(!may_be_exempt("teams.list"));
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
    assert!(is_dotted_lowercase("platform.workspaces.set_status"));
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
