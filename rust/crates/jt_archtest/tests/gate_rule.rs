//! The gate rule, structural half (spec §5, B1): only the use cases the Global Constraints list
//! may be `Exempt` from the strategy gate; every other use case is `Gated`. The inbox rows that
//! read or answer customers are listed one by one ([`EXEMPT_INBOX`]), so a new inbox row is
//! `Gated` until someone decides it answers customers. Separately, only
//! `auth.*`, `workspace.*` and `platform.*` use cases and the objections (a business's
//! do-not-contact and erasure) run whatever the workspace's status, and
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

/// The inbox rows that read or answer the workspace's own customers, which never waits for a
/// marketing strategy (owner decision of 2026-11-03). Listed one by one, never as a prefix: a
/// new inbox row stays `Gated` until it is added here. The one inbox row left out starts contact
/// nobody asked for: `inbox.send` writes to a person, not in a conversation, with commercial
/// intent only, and may open a conversation no customer started.
const EXEMPT_INBOX: &[&str] = &[
    "inbox.pending",
    "inbox.context",
    "inbox.conversations.list",
    "inbox.conversations.get",
    "inbox.messages.list",
    "inbox.take_over",
    "inbox.hand_to_agent",
    "inbox.snooze",
    "inbox.unsnooze",
    "inbox.close",
    "inbox.reply",
    "inbox.people.search",
    "inbox.people.get",
    "inbox.people.erase",
    "inbox.people.create",
    "inbox.people.set_kind",
    "inbox.identities.add",
    "inbox.journeys.open",
    "inbox.events.report",
    "inbox.lost_reasons.list",
    "inbox.lost_reasons.set",
    "inbox.journeys.get",
    "inbox.journeys.assign_owner",
    "inbox.status_labels.set",
    "inbox.merges.list",
    "inbox.merges.apply",
    "inbox.merges.undo",
    "inbox.merges.refuse",
    "inbox.tasks.create",
    "inbox.tasks.complete",
    "inbox.tasks.list",
    "inbox.notes.add",
    "inbox.consent.record",
    "inbox.consent.list",
    "inbox.suppressions.add",
    "inbox.suppressions.remove",
    "inbox.quotes.send",
    "inbox.quotes.accept",
    "inbox.quotes.list",
    "inbox.appointments.book",
    "inbox.appointments.cancel",
    "inbox.appointments.held",
    "inbox.commissions.list",
    "inbox.commissions.approve",
    "inbox.commissions.pay",
    "inbox.commission_rates.set",
    // Comments and marketplace questions: moderating, marking handled, reporting, and approving
    // or discarding a held answer are answering customers too.
    "inbox.public.hide",
    "inbox.public.delete",
    "inbox.public.mark_handled",
    "inbox.public.report",
    "inbox.public.approve",
    "inbox.public.discard",
    // Files to answer customers with, and the ones they sent (leads L6).
    "inbox.attachments_upload",
    "inbox.attachments_get",
];

/// Single use cases that may be exempt outside those prefixes. Of the ledger, only reading it is.
const EXEMPT_IDS: &[&str] = &[
    "ops.health",
    "billing.status",
    "billing.activate",
    "billing.report_payment",
    "ledger.list",
    "studio.brake",
    "studio.ledger",
    "studio.ledger_export",
    // The materials library: the owner gathers materials before and while the strategy is
    // worked out (spec 2026-11-03 D35), uploads included.
    "studio.file_upload",
    "studio.olays_list",
    "studio.olay_get",
    "studio.olay_create",
    "studio.olay_update",
    "studio.olay_confirm",
    "studio.materials_list",
    "studio.material_get",
    "studio.material_add",
    "studio.material_tag",
    "studio.material_permission",
    "studio.material_free",
    "studio.material_bind",
    "studio.material_delete",
    "studio.slot_materials",
    "studio.calendar_list",
    "studio.calendar_set",
    "studio.material_policy_set",
    "studio.shoot_list",
    "studio.shoot_request",
    "studio.shoot_resolve",
    "calls.policy_get",
    // The voice bridge's line is set up before any strategy.
    "calls.bridge.register",
    "calls.bridge.commands",
    "calls.bridge.events",
    // So are the phones the device bridge drives, and what an agent does with them.
    "devices.bridge.register",
    "devices.bridge.commands",
    "devices.bridge.results",
    "devices.bridge.files",
    "devices.list",
    "devices.observe",
    "devices.act",
    "devices.command_get",
    "devices.commands",
    // A business's objection and an erasure must always be recordable (leads spec D29).
    "prospects.do_not_contact",
    "prospects.erase",
];

fn may_be_exempt(id: &str) -> bool {
    EXEMPT_PREFIXES.iter().any(|p| id.starts_with(p))
        || EXEMPT_IDS.contains(&id)
        || EXEMPT_INBOX.contains(&id)
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
        if matches!(
            id,
            "billing.status" | "ops.health" | "prospects.do_not_contact" | "prospects.erase"
        ) || STATUS_EXEMPT_PREFIXES.iter().any(|p| id.starts_with(p))
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
    // Nine connection use cases (eight tools and the panel's OAuth callback) and three event
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
            "connector.set_pbx_policy",
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
    assert!(may_be_exempt("inbox.reply"));
    // An inbox row is exempt only by name: a new one, and outreach, are not.
    assert!(!may_be_exempt("inbox.send"));
    assert!(!may_be_exempt("inbox.broadcast"));
    assert!(!may_be_exempt("inboxes.list"));
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
fn the_inbox_answers_customers_without_a_strategy_but_outreach_stays_gated() {
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|uc| uc.id.starts_with("inbox."))
        .collect();
    assert_eq!(rows.len(), 55);
    for row in rows {
        // Exempt exactly when listed; a row nobody listed is gated.
        assert_eq!(
            row.gate,
            if EXEMPT_INBOX.contains(&row.id) {
                GateMode::Exempt
            } else {
                GateMode::Gated
            },
            "{}",
            row.id
        );
        // Only the strategy part changed: every inbox row, erasure and suppressions among them,
        // still answers WORKSPACE_INACTIVE unless the workspace is active.
        assert_eq!(row.status_exemption, StatusExemption::Never, "{}", row.id);
    }
    assert_eq!(
        jt_app::catalog::find("inbox.send").map(|uc| uc.gate),
        Some(GateMode::Gated)
    );
    for id in EXEMPT_INBOX {
        assert!(jt_app::catalog::find(id).is_some(), "{id} is a catalog row");
    }
}
