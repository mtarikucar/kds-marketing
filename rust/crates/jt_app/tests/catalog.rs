use std::collections::BTreeSet;

use jt_app::catalog::{CATALOG, GateMode, Risk, StatusExemption, by_mcp_tool, find};

#[test]
fn ids_are_unique() {
    let mut seen = BTreeSet::new();
    for uc in CATALOG {
        assert!(seen.insert(uc.id), "duplicate use case id {}", uc.id);
    }
}

#[test]
fn every_use_case_but_the_one_surface_ones_has_both_surfaces() {
    for uc in CATALOG.iter().filter(|uc| !uc.panel_only && !uc.mcp_only) {
        assert!(uc.mcp_tool.is_some(), "{} has no MCP tool", uc.id);
        assert!(uc.panel_route.is_some(), "{} has no panel route", uc.id);
    }
}

#[test]
fn no_use_case_is_both_panel_only_and_mcp_only() {
    for uc in CATALOG {
        assert!(
            !(uc.panel_only && uc.mcp_only),
            "{} is both panel-only and MCP-only",
            uc.id
        );
    }
}

#[test]
fn mcp_only_use_cases_have_no_panel_route() {
    for uc in CATALOG.iter().filter(|uc| uc.mcp_only) {
        assert!(
            uc.panel_route.is_none(),
            "{} is MCP-only but has a panel route",
            uc.id
        );
        assert!(
            uc.mcp_tool.is_some(),
            "{} is MCP-only but has no MCP tool",
            uc.id
        );
    }
    // An agent-only tool has no human caller: the agent's check-in is the only one.
    let mcp_only: Vec<&str> = CATALOG
        .iter()
        .filter(|uc| uc.mcp_only)
        .map(|uc| uc.id)
        .collect();
    assert_eq!(mcp_only, ["work.checkin"]);
}

#[test]
fn panel_only_use_cases_have_no_mcp_tool() {
    for uc in CATALOG.iter().filter(|uc| uc.panel_only) {
        assert!(
            uc.mcp_tool.is_none(),
            "{} is panel-only but has an MCP tool",
            uc.id
        );
        assert!(
            uc.panel_route.is_some(),
            "{} is panel-only but has no panel route",
            uc.id
        );
    }
}

#[test]
fn mcp_tool_names_follow_prefix() {
    for (id, tool) in CATALOG
        .iter()
        .filter_map(|uc| uc.mcp_tool.map(|t| (uc.id, t)))
    {
        let parts: Vec<&str> = tool.split('.').collect();
        assert!(
            tool.starts_with("jeeta."),
            "{id}: {tool} lacks the jeeta. prefix"
        );
        assert_eq!(
            parts.len(),
            3,
            "{id}: {tool} is not jeeta.<domain>.<action>"
        );
        assert!(
            parts.iter().all(|p| !p.is_empty()),
            "{id}: {tool} has an empty part"
        );
    }
}

#[test]
fn panel_routes_are_unique() {
    let mut seen = BTreeSet::new();
    for (id, route) in CATALOG
        .iter()
        .filter_map(|uc| uc.panel_route.map(|r| (uc.id, r)))
    {
        assert!(seen.insert(route), "{id}: duplicate panel route {route:?}");
    }
}

// Beyond the brief: pins the details later crates rely on.

#[test]
#[rustfmt::skip]
fn catalog_is_the_release_table() {
    let rows: Vec<_> = CATALOG
        .iter()
        .map(|uc| (uc.id, uc.mcp_tool, uc.panel_route, uc.panel_only, uc.risk))
        .collect();
    let expected = [
        ("studio.overview", Some("jeeta.studio.overview"), Some(("GET", "/api/studio/overview")), false, Risk::Read),
        ("studio.ledger", Some("jeeta.studio.ledger"), Some(("GET", "/api/studio/ledger")), false, Risk::Read),
        ("studio.ledger_export", Some("jeeta.studio.ledger_export"), Some(("POST", "/api/studio/ledger/export")), false, Risk::Read),
        ("studio.adsets_list", Some("jeeta.studio.adsets_list"), Some(("GET", "/api/studio/adsets")), false, Risk::Read),
        ("studio.adset_bind", Some("jeeta.studio.adset_bind"), Some(("POST", "/api/studio/adsets/bind")), false, Risk::Write),
        ("studio.budget_move", Some("jeeta.studio.budget_move"), Some(("POST", "/api/studio/budget-moves")), false, Risk::Spend),
        ("studio.learned", Some("jeeta.studio.learned"), Some(("GET", "/api/studio/learned")), false, Risk::Read),
        ("studio.judgment_record", Some("jeeta.studio.judgment_record"), Some(("POST", "/api/studio/judgments")), false, Risk::Write),
        ("studio.file_upload", Some("jeeta.studio.file_upload"), Some(("POST", "/api/studio/files")), false, Risk::Write),
        ("studio.piece_submit", Some("jeeta.studio.piece_submit"), Some(("POST", "/api/studio/slots/{slot_id}/piece")), false, Risk::Write),
        ("studio.pending", Some("jeeta.studio.pending"), Some(("GET", "/api/studio/pending")), false, Risk::Read),
        ("studio.slot_get", Some("jeeta.studio.slot_get"), Some(("GET", "/api/studio/slots/{slot_id}")), false, Risk::Read),
        ("studio.slot_cancel", Some("jeeta.studio.slot_cancel"), Some(("POST", "/api/studio/slots/{slot_id}/cancel")), false, Risk::Write),
        ("studio.trend_record", Some("jeeta.studio.trend_record"), Some(("POST", "/api/studio/trends")), false, Risk::Write),
        ("studio.hypothesis_propose", Some("jeeta.studio.hypothesis_propose"), Some(("POST", "/api/studio/hypotheses/proposals")), false, Risk::Write),
        ("studio.brake", Some("jeeta.studio.brake"), Some(("POST", "/api/studio/brake")), false, Risk::Write),
        ("studio.policy_set", Some("jeeta.studio.policy_set"), Some(("PUT", "/api/studio/policy")), false, Risk::Write),
        ("studio.approve", Some("jeeta.studio.approve"), Some(("POST", "/api/studio/approvals")), false, Risk::Write),
        ("inbox.pending", Some("jeeta.inbox.pending"), Some(("GET", "/api/inbox/pending")), false, Risk::Read),
        ("inbox.context", Some("jeeta.inbox.context"), Some(("GET", "/api/inbox/conversations/{conversation_id}/context")), false, Risk::Read),
        ("inbox.conversations.list", Some("jeeta.inbox.conversations_list"), Some(("GET", "/api/inbox/conversations")), false, Risk::Read),
        ("inbox.conversations.get", Some("jeeta.inbox.conversations_get"), Some(("GET", "/api/inbox/conversations/{conversation_id}")), false, Risk::Read),
        ("inbox.messages.list", Some("jeeta.inbox.messages_list"), Some(("GET", "/api/inbox/conversations/{conversation_id}/messages")), false, Risk::Read),
        ("inbox.take_over", Some("jeeta.inbox.take_over"), Some(("POST", "/api/inbox/conversations/{conversation_id}/take-over")), false, Risk::Write),
        ("inbox.hand_to_agent", Some("jeeta.inbox.hand_to_agent"), Some(("POST", "/api/inbox/conversations/{conversation_id}/hand-to-agent")), false, Risk::Write),
        ("inbox.snooze", Some("jeeta.inbox.snooze"), Some(("POST", "/api/inbox/conversations/{conversation_id}/snooze")), false, Risk::Write),
        ("inbox.unsnooze", Some("jeeta.inbox.unsnooze"), Some(("POST", "/api/inbox/conversations/{conversation_id}/unsnooze")), false, Risk::Write),
        ("inbox.close", Some("jeeta.inbox.close"), Some(("POST", "/api/inbox/conversations/{conversation_id}/close")), false, Risk::Write),
        ("inbox.reply", Some("jeeta.inbox.reply"), Some(("POST", "/api/inbox/conversations/{conversation_id}/reply")), false, Risk::Write),
        ("inbox.people.search", Some("jeeta.inbox.people_search"), Some(("GET", "/api/inbox/people")), false, Risk::Read),
        ("inbox.people.get", Some("jeeta.inbox.people_get"), Some(("GET", "/api/inbox/people/{person_id}")), false, Risk::Read),
        ("inbox.people.erase", Some("jeeta.inbox.people_erase"), Some(("POST", "/api/inbox/people/{person_id}/erase")), false, Risk::Destructive),
        ("inbox.people.create", Some("jeeta.inbox.people_create"), Some(("POST", "/api/inbox/people")), false, Risk::Write),
        ("inbox.identities.add", Some("jeeta.inbox.identities_add"), Some(("POST", "/api/inbox/people/{person_id}/identities")), false, Risk::Write),
        ("inbox.journeys.open", Some("jeeta.inbox.journeys_open"), Some(("POST", "/api/inbox/people/{person_id}/journeys")), false, Risk::Write),
        ("inbox.events.report", Some("jeeta.inbox.events_report"), Some(("POST", "/api/inbox/journeys/{journey_id}/events")), false, Risk::Write),
        ("inbox.lost_reasons.list", Some("jeeta.inbox.lost_reasons_list"), Some(("GET", "/api/inbox/lost-reasons")), false, Risk::Read),
        ("inbox.lost_reasons.set", Some("jeeta.inbox.lost_reasons_set"), Some(("PUT", "/api/inbox/lost-reasons")), false, Risk::Write),
        ("inbox.journeys.get", Some("jeeta.inbox.journeys_get"), Some(("GET", "/api/inbox/journeys/{journey_id}")), false, Risk::Read),
        ("inbox.journeys.assign_owner", Some("jeeta.inbox.journeys_assign_owner"), Some(("POST", "/api/inbox/journeys/{journey_id}/owner")), false, Risk::Write),
        ("inbox.status_labels.set", Some("jeeta.inbox.status_labels_set"), Some(("PUT", "/api/inbox/status-labels")), false, Risk::Write),
        ("inbox.merges.list", Some("jeeta.inbox.merges_list"), Some(("GET", "/api/inbox/merges")), false, Risk::Read),
        ("inbox.merges.apply", Some("jeeta.inbox.merges_apply"), Some(("POST", "/api/inbox/merges/{merge_id}/apply")), false, Risk::Write),
        ("inbox.merges.undo", Some("jeeta.inbox.merges_undo"), Some(("POST", "/api/inbox/merges/{merge_id}/undo")), false, Risk::Destructive),
        ("inbox.merges.refuse", Some("jeeta.inbox.merges_refuse"), Some(("POST", "/api/inbox/merges/{merge_id}/refuse")), false, Risk::Write),
        ("inbox.tasks.create", Some("jeeta.inbox.tasks_create"), Some(("POST", "/api/inbox/journeys/{journey_id}/tasks")), false, Risk::Write),
        ("inbox.tasks.complete", Some("jeeta.inbox.tasks_complete"), Some(("POST", "/api/inbox/tasks/{task_id}/complete")), false, Risk::Write),
        ("inbox.tasks.list", Some("jeeta.inbox.tasks_list"), Some(("GET", "/api/inbox/tasks")), false, Risk::Read),
        ("inbox.notes.add", Some("jeeta.inbox.notes_add"), Some(("POST", "/api/inbox/journeys/{journey_id}/notes")), false, Risk::Write),
        ("inbox.consent.record", Some("jeeta.inbox.consent_record"), Some(("POST", "/api/inbox/people/{person_id}/consents")), false, Risk::Write),
        ("inbox.consent.list", Some("jeeta.inbox.consent_list"), Some(("GET", "/api/inbox/people/{person_id}/consents")), false, Risk::Read),
        ("inbox.suppressions.add", Some("jeeta.inbox.suppressions_add"), Some(("POST", "/api/inbox/people/{person_id}/suppressions")), false, Risk::Write),
        ("inbox.suppressions.remove", Some("jeeta.inbox.suppressions_remove"), Some(("DELETE", "/api/inbox/people/{person_id}/suppressions/{channel}/{reason}")), false, Risk::Write),
        ("inbox.send", Some("jeeta.inbox.send"), Some(("POST", "/api/inbox/people/{person_id}/send")), false, Risk::Write),
        ("inbox.quotes.send", Some("jeeta.inbox.quotes_send"), Some(("POST", "/api/inbox/journeys/{journey_id}/quotes")), false, Risk::Write),
        ("inbox.quotes.accept", Some("jeeta.inbox.quotes_accept"), Some(("POST", "/api/inbox/quotes/{id}/accept")), false, Risk::Write),
        ("inbox.quotes.list", Some("jeeta.inbox.quotes_list"), Some(("GET", "/api/inbox/journeys/{journey_id}/quotes")), false, Risk::Read),
        ("inbox.appointments.book", Some("jeeta.inbox.appointments_book"), Some(("POST", "/api/inbox/journeys/{journey_id}/appointments")), false, Risk::Write),
        ("inbox.appointments.cancel", Some("jeeta.inbox.appointments_cancel"), Some(("POST", "/api/inbox/appointments/{id}/cancel")), false, Risk::Write),
        ("inbox.appointments.held", Some("jeeta.inbox.appointments_held"), Some(("POST", "/api/inbox/appointments/{id}/held")), false, Risk::Write),
        ("inbox.commissions.list", Some("jeeta.inbox.commissions_list"), Some(("GET", "/api/inbox/commissions")), false, Risk::Read),
        ("inbox.commissions.approve", Some("jeeta.inbox.commissions_approve"), Some(("POST", "/api/inbox/commissions/{id}/approve")), false, Risk::Write),
        ("inbox.commissions.pay", Some("jeeta.inbox.commissions_pay"), Some(("POST", "/api/inbox/commissions/{id}/pay")), false, Risk::Write),
        ("inbox.commission_rates.set", Some("jeeta.inbox.commission_rates_set"), Some(("PUT", "/api/inbox/commission-rates")), false, Risk::Write),
        ("auth.register", None, Some(("POST", "/api/auth/register")), true, Risk::Write),
        ("auth.login", None, Some(("POST", "/api/auth/login")), true, Risk::Write),
        ("auth.logout", None, Some(("POST", "/api/auth/logout")), true, Risk::Write),
        ("auth.me", None, Some(("GET", "/api/auth/me")), true, Risk::Read),
        ("billing.status", None, Some(("GET", "/api/billing")), true, Risk::Read),
        ("billing.activate", None, Some(("POST", "/api/billing/activate")), true, Risk::Write),
        ("billing.report_payment", Some("jeeta.billing.report_payment"), Some(("POST", "/api/billing/payments")), false, Risk::Write),
        ("workspace.info", Some("jeeta.workspace.info"), Some(("GET", "/api/workspace")), false, Risk::Read),
        ("workspace.switch", None, Some(("POST", "/api/auth/switch-workspace")), true, Risk::Write),
        ("team.list", Some("jeeta.team.list"), Some(("GET", "/api/team")), false, Risk::Read),
        ("team.invite", Some("jeeta.team.invite"), Some(("POST", "/api/team/invites")), false, Risk::Write),
        ("team.accept_invite", None, Some(("POST", "/api/team/invites/accept")), true, Risk::Write),
        ("team.set_role", Some("jeeta.team.set_role"), Some(("PATCH", "/api/team/{membership_id}/role")), false, Risk::Write),
        ("team.remove", Some("jeeta.team.remove"), Some(("DELETE", "/api/team/{membership_id}")), false, Risk::Destructive),
        ("roles.list", Some("jeeta.roles.list"), Some(("GET", "/api/roles")), false, Risk::Read),
        ("roles.create", Some("jeeta.roles.create"), Some(("POST", "/api/roles")), false, Risk::Write),
        ("roles.update", Some("jeeta.roles.update"), Some(("PATCH", "/api/roles/{role_id}")), false, Risk::Write),
        ("roles.delete", Some("jeeta.roles.delete"), Some(("DELETE", "/api/roles/{role_id}")), false, Risk::Destructive),
        ("api_keys.create", Some("jeeta.api_keys.create"), Some(("POST", "/api/api-keys")), false, Risk::Write),
        ("api_keys.list", Some("jeeta.api_keys.list"), Some(("GET", "/api/api-keys")), false, Risk::Read),
        ("api_keys.revoke", Some("jeeta.api_keys.revoke"), Some(("DELETE", "/api/api-keys/{key_id}")), false, Risk::Destructive),
        ("agents.list", Some("jeeta.agents.list"), Some(("GET", "/api/agents")), false, Risk::Read),
        ("agents.whoami", Some("jeeta.agent.whoami"), Some(("GET", "/api/whoami")), false, Risk::Read),
        ("ledger.list", Some("jeeta.ledger.list"), Some(("GET", "/api/ledger")), false, Risk::Read),
        ("strategy.get", Some("jeeta.strategy.get"), Some(("GET", "/api/strategy")), false, Risk::Read),
        ("strategy.start_consultation", Some("jeeta.strategy.start_consultation"), Some(("POST", "/api/strategy/consultation")), false, Risk::Write),
        ("strategy.record", Some("jeeta.strategy.record"), Some(("POST", "/api/strategy/consultation/entries")), false, Risk::Write),
        ("strategy.write_section", Some("jeeta.strategy.write_section"), Some(("PUT", "/api/strategy/draft/sections/{section_key}")), false, Risk::Write),
        ("strategy.set_hypotheses", Some("jeeta.strategy.set_hypotheses"), Some(("PUT", "/api/strategy/draft/hypotheses")), false, Risk::Write),
        ("strategy.submit", Some("jeeta.strategy.submit"), Some(("POST", "/api/strategy/draft/submit")), false, Risk::Write),
        ("strategy.approve", Some("jeeta.strategy.approve"), Some(("POST", "/api/strategy/draft/approve")), false, Risk::Write),
        ("strategy.archive", Some("jeeta.strategy.archive"), Some(("POST", "/api/strategy/archive")), false, Risk::Destructive),
        ("strategy.list_versions", Some("jeeta.strategy.list_versions"), Some(("GET", "/api/strategy/versions")), false, Risk::Read),
        ("strategy.consultation", Some("jeeta.strategy.consultation"), Some(("GET", "/api/strategy/versions/{version_id}/consultation")), false, Risk::Read),
        ("capability.list", Some("jeeta.capability.list"), Some(("GET", "/api/capabilities")), false, Risk::Read),
        ("capability.get", Some("jeeta.capability.get"), Some(("GET", "/api/capabilities/{capability_id}")), false, Risk::Read),
        ("capability.declare", Some("jeeta.capability.declare"), Some(("POST", "/api/capabilities")), false, Risk::Write),
        ("capability.update", Some("jeeta.capability.update"), Some(("PATCH", "/api/capabilities/{capability_id}")), false, Risk::Write),
        ("capability.verify", Some("jeeta.capability.verify"), Some(("POST", "/api/capabilities/{capability_id}/verify")), false, Risk::Write),
        ("capability.mark_unreachable", Some("jeeta.capability.mark_unreachable"), Some(("POST", "/api/capabilities/{capability_id}/unreachable")), false, Risk::Write),
        ("capability.set_policy", Some("jeeta.capability.set_policy"), Some(("PUT", "/api/capabilities/{capability_id}/policy")), false, Risk::Write),
        ("capability.retire", Some("jeeta.capability.retire"), Some(("POST", "/api/capabilities/{capability_id}/retire")), false, Risk::Destructive),
        ("capability.link_budget", Some("jeeta.capability.link_budget"), Some(("POST", "/api/capabilities/{capability_id}/budget-links")), false, Risk::Write),
        ("capability.unlink_budget", Some("jeeta.capability.unlink_budget"), Some(("DELETE", "/api/capabilities/{capability_id}/budget-links/{budget_item_id}")), false, Risk::Write),
        ("capability.groups.list", Some("jeeta.capability.groups_list"), Some(("GET", "/api/capability-groups")), false, Risk::Read),
        ("capability.groups.create", Some("jeeta.capability.groups_create"), Some(("POST", "/api/capability-groups")), false, Risk::Write),
        ("capability.groups.rename", Some("jeeta.capability.groups_rename"), Some(("PATCH", "/api/capability-groups/{group_id}")), false, Risk::Write),
        ("capability.groups.delete", Some("jeeta.capability.groups_delete"), Some(("DELETE", "/api/capability-groups/{group_id}")), false, Risk::Destructive),
        ("capability.groups.add_member", Some("jeeta.capability.groups_add_member"), Some(("POST", "/api/capability-groups/{group_id}/members")), false, Risk::Write),
        ("capability.groups.remove_member", Some("jeeta.capability.groups_remove_member"), Some(("DELETE", "/api/capability-groups/{group_id}/members/{capability_id}")), false, Risk::Write),
        ("budget.items.list", Some("jeeta.budget.items_list"), Some(("GET", "/api/budget/items")), false, Risk::Read),
        ("budget.items.create", Some("jeeta.budget.items_create"), Some(("POST", "/api/budget/items")), false, Risk::Write),
        ("budget.items.update", Some("jeeta.budget.items_update"), Some(("PATCH", "/api/budget/items/{budget_item_id}")), false, Risk::Write),
        ("budget.items.retire", Some("jeeta.budget.items_retire"), Some(("POST", "/api/budget/items/{budget_item_id}/retire")), false, Risk::Destructive),
        ("budget.spend.record", Some("jeeta.budget.spend_record"), Some(("POST", "/api/budget/items/{budget_item_id}/spend")), false, Risk::Spend),
        ("budget.spend.list", Some("jeeta.budget.spend_list"), Some(("GET", "/api/budget/items/{budget_item_id}/spend")), false, Risk::Read),
        ("connector.start_oauth", Some("jeeta.connector.start_oauth"), Some(("POST", "/api/connectors/oauth/start")), false, Risk::Write),
        ("connector.complete_oauth", None, Some(("GET", "/api/connectors/oauth/callback/{provider}")), true, Risk::Write),
        ("connector.confirm_assets", Some("jeeta.connector.confirm_assets"), Some(("POST", "/api/connectors/oauth/{pending_id}/confirm")), false, Risk::Write),
        ("connector.set_credentials", Some("jeeta.connector.set_credentials"), Some(("POST", "/api/connectors/credentials")), false, Risk::Write),
        ("connector.probe", Some("jeeta.connector.probe"), Some(("POST", "/api/connectors/{capability_id}/probe")), false, Risk::Write),
        ("connector.health", Some("jeeta.connector.health"), Some(("GET", "/api/connectors/health")), false, Risk::Read),
        ("connector.reconnect", Some("jeeta.connector.reconnect"), Some(("POST", "/api/connectors/{capability_id}/reconnect")), false, Risk::Write),
        ("connector.hooks", Some("jeeta.connector.hooks"), Some(("GET", "/api/connectors/hooks")), false, Risk::Read),
        ("connector.set_pbx_policy", Some("jeeta.connector.set_pbx_policy"), Some(("PUT", "/api/connectors/{capability_id}/pbx-policy")), false, Risk::Write),
        ("events.pending", Some("jeeta.events.pending"), Some(("GET", "/api/events/pending")), false, Risk::Read),
        ("events.ack", Some("jeeta.events.ack"), Some(("POST", "/api/events/ack")), false, Risk::Write),
        ("events.list", Some("jeeta.events.list"), Some(("GET", "/api/events")), false, Risk::Read),
        ("work.pending", Some("jeeta.work.pending"), Some(("GET", "/api/work/pending")), false, Risk::Read),
        ("work.checkin", Some("jeeta.work.checkin"), None, false, Risk::Write),
        ("work.set_checkin_interval", Some("jeeta.work.set_checkin_interval"), Some(("PUT", "/api/work/checkin-interval")), false, Risk::Write),
        ("platform.login", None, Some(("POST", "/api/platform/login")), true, Risk::Write),
        ("platform.workspaces.list", None, Some(("GET", "/api/platform/workspaces")), true, Risk::Read),
        ("platform.payments.list", None, Some(("GET", "/api/platform/payments")), true, Risk::Read),
        ("platform.billing.confirm", None, Some(("POST", "/api/platform/workspaces/{workspace_id}/payments/{payment_id}/confirm")), true, Risk::Write),
        ("platform.billing.reissue", None, Some(("POST", "/api/platform/workspaces/{workspace_id}/payments/{payment_id}/reissue")), true, Risk::Write),
        ("platform.billing.revoke_activation", None, Some(("POST", "/api/platform/workspaces/{workspace_id}/revoke-activation")), true, Risk::Write),
        ("platform.workspaces.suspend", None, Some(("POST", "/api/platform/workspaces/{workspace_id}/suspend")), true, Risk::Write),
        ("platform.operators.reset_password", None, Some(("POST", "/api/platform/operators/{operator_id}/reset-password")), true, Risk::Write),
        ("ops.health", None, Some(("GET", "/api/platform/health")), true, Risk::Read),
        ("platform.workspaces.resume", None, Some(("POST", "/api/platform/workspaces/{workspace_id}/resume")), true, Risk::Write),
    ];
    assert_eq!(rows, expected);
    assert_eq!(CATALOG.len(), 145);
    for uc in CATALOG {
        assert_eq!(uc.gate, if (uc.id.starts_with("inbox.") && !["inbox.pending", "inbox.context"].contains(&uc.id)) || (uc.id.starts_with("studio.") && !["studio.brake", "studio.ledger", "studio.ledger_export"].contains(&uc.id)) { GateMode::Gated } else { GateMode::Exempt }, "{}", uc.id);
    }
    let exempt = |e: StatusExemption| -> Vec<&str> {
        CATALOG
            .iter()
            .filter(|uc| uc.status_exemption == e)
            .map(|uc| uc.id)
            .collect()
    };
    assert_eq!(
        exempt(StatusExemption::Always),
        [
            "auth.register",
            "auth.login",
            "auth.logout",
            "auth.me",
            "billing.status",
            "workspace.info",
            "workspace.switch",
            "platform.login",
            "platform.workspaces.list",
            "platform.payments.list",
            "platform.billing.confirm",
            "platform.billing.reissue",
            "platform.billing.revoke_activation",
            "platform.workspaces.suspend",
            "platform.operators.reset_password",
            "ops.health",
            "platform.workspaces.resume",
        ]
    );
    assert_eq!(
        exempt(StatusExemption::PendingPayment),
        [
            "billing.activate",
            "billing.report_payment",
            "strategy.get",
            "strategy.start_consultation",
            "strategy.record",
            "strategy.write_section",
            "strategy.set_hypotheses",
            "strategy.submit",
            "strategy.approve",
            "strategy.archive",
            "strategy.list_versions",
            "strategy.consultation",
            "work.pending",
            "work.checkin",
            "work.set_checkin_interval",
        ]
    );
}

#[test]
fn lookups_by_id_and_mcp_tool() {
    assert_eq!(
        find("team.invite").map(|uc| uc.mcp_tool),
        Some(Some("jeeta.team.invite"))
    );
    assert!(find("team.nope").is_none());
    assert_eq!(
        by_mcp_tool("jeeta.agent.whoami").map(|uc| uc.id),
        Some("agents.whoami")
    );
    assert!(by_mcp_tool("agents.whoami").is_none());
    assert_eq!(find("auth.me").map(|uc| uc.mcp_tool), Some(None));
    assert_eq!(
        by_mcp_tool("jeeta.work.checkin").map(|uc| (uc.id, uc.panel_route)),
        Some(("work.checkin", None))
    );
}

#[test]
fn gate_mode_and_risk_serialise_snake_case() {
    assert_eq!(serde_json::to_value(GateMode::Exempt).unwrap(), "exempt");
    assert_eq!(serde_json::to_value(GateMode::Gated).unwrap(), "gated");
    for (risk, name) in [
        (Risk::Read, "read"),
        (Risk::Write, "write"),
        (Risk::Spend, "spend"),
        (Risk::Destructive, "destructive"),
    ] {
        assert_eq!(serde_json::to_value(risk).unwrap(), name);
    }
}

#[path = "studio_contracts.rs"]
mod studio_contracts;
