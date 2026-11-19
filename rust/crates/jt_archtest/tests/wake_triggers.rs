//! The wake rule, structural half (`jt_app::usecases::wake`): every use case where a person's
//! own action gives an agent work records a wake request with its reason, for the work it gives,
//! in its own transaction (before its commit). The behavioural half (who is woken, when, how
//! often) lives in `jt_app/tests/wake.rs`.

use jt_archtest::workspace_dir;

/// (file under `crates/jt_app/src/usecases`, function, reason, need).
const TRIGGERS: &[(&str, &str, &str, &str)] = &[
    (
        "content/areas.rs",
        "area_redo",
        "ContentRevision",
        "CONTENT",
    ),
    (
        "studio/projects.rs",
        "project_create",
        "ContentRequested",
        "CONTENT",
    ),
    (
        "studio/projects.rs",
        "project_update",
        "ContentRequested",
        "CONTENT",
    ),
    (
        "studio/projects.rs",
        "project_request_update",
        "CaptureAnswered",
        "CONTENT",
    ),
    (
        "studio/library/productions.rs",
        "request_production_in",
        "ProductionRequested",
        "CONTENT",
    ),
    (
        "studio/library/items.rs",
        "material_add",
        "MaterialUploaded",
        "MATERIALS",
    ),
    (
        "studio/library/intelligence.rs",
        "material_analysis_retry",
        "AnalysisRetried",
        "MATERIALS",
    ),
    (
        "content/delivery.rs",
        "delivery_accept",
        "DeliveryAccepted",
        "SOCIAL",
    ),
    (
        "social/accounts.rs",
        "account_pause",
        "AccountResumed",
        "SOCIAL",
    ),
    ("ads/mod.rs", "campaign_open", "AdCampaignOpened", "ADS"),
    ("ads/mod.rs", "campaign_approve", "AdCampaignOpened", "ADS"),
    ("ads/mod.rs", "campaign_resume", "AdCampaignOpened", "ADS"),
    (
        "research.rs",
        "tasks_create",
        "ResearchRequested",
        "RESEARCH",
    ),
    (
        "inbox/conversations.rs",
        "mutate",
        "ConversationHanded",
        "INBOX",
    ),
    ("strategy.rs", "approve", "StrategyApproved", "SOCIAL"),
];

/// The body of `fn name(` in `source`: from its signature to the next item at the start of a
/// line.
fn body<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source
        .find(&format!("async fn {name}("))
        .unwrap_or_else(|| panic!("no fn {name}"));
    let rest = &source[start..];
    let end = rest[1..].find("\n}").map_or(rest.len(), |at| at + 3);
    &rest[..end]
}

#[test]
fn every_trigger_records_its_wake_before_it_commits() {
    let root = workspace_dir().join("crates/jt_app/src/usecases");
    for (file, name, reason, need) in TRIGGERS {
        let source = std::fs::read_to_string(root.join(file))
            .unwrap()
            .replace("\r\n", "\n");
        let body = body(&source, name);
        let at = body
            .find(&format!("WakeReason::{reason}"))
            .unwrap_or_else(|| panic!("{file} {name} records no {reason} wake"));
        assert!(
            body.contains(&format!("wake::{need}")),
            "{file} {name} wakes for the wrong work"
        );
        // A trigger with no commit of its own runs inside its caller's transaction.
        if let Some(commit) = body.rfind(".commit().await") {
            assert!(
                at < commit,
                "{file} {name} records its wake after it commits"
            );
        }
    }
}

#[test]
fn the_clocks_own_work_wakes_nobody() {
    // The planner and the jobs make work on a clock: the agent's own schedule is for it.
    let root = workspace_dir().join("crates/jt_app/src/usecases");
    for file in ["jobs.rs", "studio/planner.rs", "content/mod.rs"] {
        let path = root.join(file);
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        assert!(
            !source.contains("wake::request("),
            "{file} wakes an agent on a clock"
        );
    }
}
