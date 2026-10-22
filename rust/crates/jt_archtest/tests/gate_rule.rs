//! The gate rule, structural half (spec §5, B1): only the use cases the Global Constraints list
//! may be `Exempt` from the strategy gate; every other use case is `Gated`. The behavioural half
//! (a gated use case answers `STRATEGY_REQUIRED` / `WORKSPACE_INACTIVE`) lives in the adapters'
//! tests.

use jt_app::catalog::{CATALOG, GateMode};

/// Id prefixes whose use cases may be exempt: identity, workspace and team administration, keys
/// and agents, and the platform console.
const EXEMPT_PREFIXES: &[&str] = &[
    "auth.",
    "workspace.",
    "team.",
    "roles.",
    "api_keys.",
    "agents.",
    "platform.",
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

#[test]
fn the_exempt_list_rejects_other_use_cases() {
    assert!(may_be_exempt("team.invite"));
    assert!(may_be_exempt("ledger.list"));
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
