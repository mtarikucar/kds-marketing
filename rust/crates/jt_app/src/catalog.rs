//! The use-case catalog: every use case with its gate mode, its two surfaces and its risk.
//!
//! The twin rule: a use case has both an MCP tool and a panel route unless it is `panel_only`
//! (no MCP tool) or `mcp_only` (no panel route), never both.
//!
//! Two independent checks guard a use case ([`crate::gate::check_gate`]): the workspace-status
//! check (the workspace must be `active`), which every use case meets unless its
//! [`UseCase::status_exemption`] lets it run in the workspace's status, and the strategy gate,
//! which only [`GateMode::Gated`] use cases meet.

use jt_tenancy::WorkspaceStatus;
use serde::Serialize;

use GateMode::Exempt;
use Risk::{Destructive, Read, Spend, Write};

/// Whether the strategy gate applies to a use case. The workspace-status check is separate
/// ([`UseCase::status_exemption`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateMode {
    /// Runs without an approved strategy; the caller must still be authenticated.
    Exempt,
    /// Needs an approved strategy.
    Gated,
}

/// Which workspace statuses besides `active` a use case runs in: the workspace-status check of
/// [`crate::gate::check_gate`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusExemption {
    /// Only while the workspace is `active`: every use case but those below.
    Never,
    /// While it is `active` or `pending_payment`, never while it is `suspended`: the strategy
    /// (`strategy.*`) and the pending work (`work.*`), which may be prepared before payment.
    PendingPayment,
    /// Whatever its status: identity, the workspace itself and the platform (`auth.*`,
    /// `workspace.*`, `platform.*`).
    Always,
}

impl StatusExemption {
    /// Whether a use case with this exemption runs in a workspace whose status is `status`.
    pub const fn allows(self, status: WorkspaceStatus) -> bool {
        matches!(
            (self, status),
            (_, WorkspaceStatus::Active)
                | (StatusExemption::Always, _)
                | (
                    StatusExemption::PendingPayment,
                    WorkspaceStatus::PendingPayment
                )
        )
    }
}

/// How much harm a call can do; shown to agents with every tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Read,
    Write,
    Spend,
    Destructive,
}

/// One use case and how it is exposed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UseCase {
    /// Dotted id, e.g. `team.invite`.
    pub id: &'static str,
    pub gate: GateMode,
    /// The MCP tool name, `jeeta.<domain>.<action>`.
    pub mcp_tool: Option<&'static str>,
    /// HTTP method and path of the panel route, e.g. `("GET", "/api/team")`.
    pub panel_route: Option<(&'static str, &'static str)>,
    /// Reachable from the panel only; then `mcp_tool` is `None`.
    pub panel_only: bool,
    /// Reachable from the MCP gate only, for a call only an agent makes (its check-in); then
    /// `panel_route` is `None`. Never set together with `panel_only`.
    pub mcp_only: bool,
    /// Which statuses besides `active` it runs in. Identity, workspace and platform use cases
    /// (`auth.*`, `workspace.*`, `platform.*`) run in every status; the strategy and the pending
    /// work (`strategy.*`, `work.*`) also while the workspace is `pending_payment`, so the
    /// strategy may be worked out before payment and an agent may ask what is pending meanwhile,
    /// but not while it is `suspended`. Every other use case answers `WORKSPACE_INACTIVE` unless
    /// its workspace is `active`, whatever its [`GateMode`].
    pub status_exemption: StatusExemption,
    pub risk: Risk,
}

/// The id prefixes whose use cases run whatever the workspace's status
/// ([`StatusExemption::Always`]).
pub const STATUS_EXEMPT_PREFIXES: &[&str] = &["auth.", "workspace.", "platform."];

/// The id prefixes whose use cases also run while the workspace is `pending_payment`
/// ([`StatusExemption::PendingPayment`]), but not while it is `suspended`.
pub const PENDING_PAYMENT_EXEMPT_PREFIXES: &[&str] = &["strategy.", "work."];

/// The status exemption of use case `id`. The exact `billing.status` row is Always and
/// `billing.report_payment` and `billing.activate` are PendingPayment; no other billing name is exempt.
/// For other rows: [`StatusExemption::Always`] for one of
/// [`STATUS_EXEMPT_PREFIXES`], [`StatusExemption::PendingPayment`] for one of
/// [`PENDING_PAYMENT_EXEMPT_PREFIXES`], else [`StatusExemption::Never`].
pub const fn status_exemption(id: &str) -> StatusExemption {
    if equals(id, "ops.health")
        || equals(id, "billing.status")
        || starts_with_any(id, STATUS_EXEMPT_PREFIXES)
    {
        StatusExemption::Always
    } else if equals(id, "billing.activate")
        || equals(id, "billing.report_payment")
        || starts_with_any(id, PENDING_PAYMENT_EXEMPT_PREFIXES)
    {
        StatusExemption::PendingPayment
    } else {
        StatusExemption::Never
    }
}

/// Whether `id` starts with one of `prefixes`, usable in a constant.
const fn equals(a: &str, b: &str) -> bool {
    a.len() == b.len() && starts_with(a, b)
}

const fn starts_with_any(id: &str, prefixes: &[&str]) -> bool {
    let mut i = 0;
    while i < prefixes.len() {
        if starts_with(id, prefixes[i]) {
            return true;
        }
        i += 1;
    }
    false
}

/// `str::starts_with`, usable in a constant.
const fn starts_with(text: &str, prefix: &str) -> bool {
    let (text, prefix) = (text.as_bytes(), prefix.as_bytes());
    if text.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if text[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// A use case reachable from both the MCP gate and the panel.
const fn twin(
    id: &'static str,
    gate: GateMode,
    mcp_tool: &'static str,
    route: (&'static str, &'static str),
    risk: Risk,
) -> UseCase {
    UseCase {
        id,
        gate,
        mcp_tool: Some(mcp_tool),
        panel_route: Some(route),
        panel_only: false,
        mcp_only: false,
        status_exemption: status_exemption(id),
        risk,
    }
}

/// A use case reachable from the panel only.
const fn panel_only(
    id: &'static str,
    gate: GateMode,
    route: (&'static str, &'static str),
    risk: Risk,
) -> UseCase {
    UseCase {
        id,
        gate,
        mcp_tool: None,
        panel_route: Some(route),
        panel_only: true,
        mcp_only: false,
        status_exemption: status_exemption(id),
        risk,
    }
}

/// A use case reachable from the MCP gate only: a call no person makes.
const fn mcp_only(id: &'static str, gate: GateMode, mcp_tool: &'static str, risk: Risk) -> UseCase {
    UseCase {
        id,
        gate,
        mcp_tool: Some(mcp_tool),
        panel_route: None,
        panel_only: false,
        mcp_only: true,
        status_exemption: status_exemption(id),
        risk,
    }
}

/// Every use case of this release. Inbox operations require an approved strategy.
#[rustfmt::skip]
pub static CATALOG: &[UseCase] = &[
    twin("studio.overview", GateMode::Gated, "jeeta.studio.overview", ("GET", "/api/studio/overview"), Read),
    twin("studio.ledger", Exempt, "jeeta.studio.ledger", ("GET", "/api/studio/ledger"), Read),
    twin("studio.ledger_export", Exempt, "jeeta.studio.ledger_export", ("POST", "/api/studio/ledger/export"), Read),
    twin("studio.adsets_list", GateMode::Gated, "jeeta.studio.adsets_list", ("GET", "/api/studio/adsets"), Read),
    twin("studio.adset_bind", GateMode::Gated, "jeeta.studio.adset_bind", ("POST", "/api/studio/adsets/bind"), Write),
    twin("studio.budget_move", GateMode::Gated, "jeeta.studio.budget_move", ("POST", "/api/studio/budget-moves"), Spend),

    twin("studio.learned", GateMode::Gated, "jeeta.studio.learned", ("GET", "/api/studio/learned"), Read),
    twin("studio.judgment_record", GateMode::Gated, "jeeta.studio.judgment_record", ("POST", "/api/studio/judgments"), Write),
    twin("studio.file_upload", GateMode::Gated, "jeeta.studio.file_upload", ("POST", "/api/studio/files"), Write),
    twin("studio.piece_submit", GateMode::Gated, "jeeta.studio.piece_submit", ("POST", "/api/studio/slots/{slot_id}/piece"), Write),
    twin("studio.pending", GateMode::Gated, "jeeta.studio.pending", ("GET", "/api/studio/pending"), Read),
    twin("studio.slot_get", GateMode::Gated, "jeeta.studio.slot_get", ("GET", "/api/studio/slots/{slot_id}"), Read),
    twin("studio.slot_cancel", GateMode::Gated, "jeeta.studio.slot_cancel", ("POST", "/api/studio/slots/{slot_id}/cancel"), Write),
    twin("studio.trend_record", GateMode::Gated, "jeeta.studio.trend_record", ("POST", "/api/studio/trends"), Write),
    twin("studio.hypothesis_propose", GateMode::Gated, "jeeta.studio.hypothesis_propose", ("POST", "/api/studio/hypotheses/proposals"), Write),
    twin("studio.brake", Exempt, "jeeta.studio.brake", ("POST", "/api/studio/brake"), Write),
    twin("studio.policy_set", GateMode::Gated, "jeeta.studio.policy_set", ("PUT", "/api/studio/policy"), Write),
    twin("studio.approve", GateMode::Gated, "jeeta.studio.approve", ("POST", "/api/studio/approvals"), Write),
    // The TikTok posting screen: a human's alone (TikTok's Content Sharing Guidelines), so no agent tool.
    panel_only("studio.tiktok_posting", GateMode::Gated, ("GET", "/api/studio/slots/{slot_id}/tiktok"), Read),
    panel_only("studio.tiktok_post", GateMode::Gated, ("POST", "/api/studio/slots/{slot_id}/tiktok"), Write),
    // A published TikTok post's counters, beside the screen in the slot's detail.
    panel_only("studio.tiktok_metrics", GateMode::Gated, ("GET", "/api/studio/slots/{slot_id}/tiktok/metrics"), Read),
    twin("inbox.pending", GateMode::Exempt, "jeeta.inbox.pending", ("GET", "/api/inbox/pending"), Read),
    twin("inbox.context", GateMode::Exempt, "jeeta.inbox.context", ("GET", "/api/inbox/conversations/{conversation_id}/context"), Read),
    twin("inbox.conversations.list", GateMode::Gated, "jeeta.inbox.conversations_list", ("GET", "/api/inbox/conversations"), Read),
    twin("inbox.conversations.get", GateMode::Gated, "jeeta.inbox.conversations_get", ("GET", "/api/inbox/conversations/{conversation_id}"), Read),
    twin("inbox.messages.list", GateMode::Gated, "jeeta.inbox.messages_list", ("GET", "/api/inbox/conversations/{conversation_id}/messages"), Read),
    twin("inbox.take_over", GateMode::Gated, "jeeta.inbox.take_over", ("POST", "/api/inbox/conversations/{conversation_id}/take-over"), Write),
    twin("inbox.hand_to_agent", GateMode::Gated, "jeeta.inbox.hand_to_agent", ("POST", "/api/inbox/conversations/{conversation_id}/hand-to-agent"), Write),
    twin("inbox.snooze", GateMode::Gated, "jeeta.inbox.snooze", ("POST", "/api/inbox/conversations/{conversation_id}/snooze"), Write),
    twin("inbox.unsnooze", GateMode::Gated, "jeeta.inbox.unsnooze", ("POST", "/api/inbox/conversations/{conversation_id}/unsnooze"), Write),
    twin("inbox.close", GateMode::Gated, "jeeta.inbox.close", ("POST", "/api/inbox/conversations/{conversation_id}/close"), Write),
    twin("inbox.reply", GateMode::Gated, "jeeta.inbox.reply", ("POST", "/api/inbox/conversations/{conversation_id}/reply"), Write),
    twin("inbox.people.search", GateMode::Gated, "jeeta.inbox.people_search", ("GET", "/api/inbox/people"), Read),
    twin("inbox.people.get", GateMode::Gated, "jeeta.inbox.people_get", ("GET", "/api/inbox/people/{person_id}"), Read),
    twin("inbox.people.erase", GateMode::Gated, "jeeta.inbox.people_erase", ("POST", "/api/inbox/people/{person_id}/erase"), Destructive),
    twin("inbox.people.create", GateMode::Gated, "jeeta.inbox.people_create", ("POST", "/api/inbox/people"), Write),
    twin("inbox.identities.add", GateMode::Gated, "jeeta.inbox.identities_add", ("POST", "/api/inbox/people/{person_id}/identities"), Write),
    twin("inbox.journeys.open", GateMode::Gated, "jeeta.inbox.journeys_open", ("POST", "/api/inbox/people/{person_id}/journeys"), Write),
    twin("inbox.events.report", GateMode::Gated, "jeeta.inbox.events_report", ("POST", "/api/inbox/journeys/{journey_id}/events"), Write),
    twin("inbox.lost_reasons.list", GateMode::Gated, "jeeta.inbox.lost_reasons_list", ("GET", "/api/inbox/lost-reasons"), Read),
    twin("inbox.lost_reasons.set", GateMode::Gated, "jeeta.inbox.lost_reasons_set", ("PUT", "/api/inbox/lost-reasons"), Write),
    twin("inbox.journeys.get", GateMode::Gated, "jeeta.inbox.journeys_get", ("GET", "/api/inbox/journeys/{journey_id}"), Read),
    twin("inbox.journeys.assign_owner", GateMode::Gated, "jeeta.inbox.journeys_assign_owner", ("POST", "/api/inbox/journeys/{journey_id}/owner"), Write),
    twin("inbox.status_labels.set", GateMode::Gated, "jeeta.inbox.status_labels_set", ("PUT", "/api/inbox/status-labels"), Write),
    twin("inbox.merges.list", GateMode::Gated, "jeeta.inbox.merges_list", ("GET", "/api/inbox/merges"), Read),
    twin("inbox.merges.apply", GateMode::Gated, "jeeta.inbox.merges_apply", ("POST", "/api/inbox/merges/{merge_id}/apply"), Write),
    twin("inbox.merges.undo", GateMode::Gated, "jeeta.inbox.merges_undo", ("POST", "/api/inbox/merges/{merge_id}/undo"), Destructive),
    twin("inbox.merges.refuse", GateMode::Gated, "jeeta.inbox.merges_refuse", ("POST", "/api/inbox/merges/{merge_id}/refuse"), Write),
    twin("inbox.tasks.create", GateMode::Gated, "jeeta.inbox.tasks_create", ("POST", "/api/inbox/journeys/{journey_id}/tasks"), Write),
    twin("inbox.tasks.complete", GateMode::Gated, "jeeta.inbox.tasks_complete", ("POST", "/api/inbox/tasks/{task_id}/complete"), Write),
    twin("inbox.tasks.list", GateMode::Gated, "jeeta.inbox.tasks_list", ("GET", "/api/inbox/tasks"), Read),
    twin("inbox.notes.add", GateMode::Gated, "jeeta.inbox.notes_add", ("POST", "/api/inbox/journeys/{journey_id}/notes"), Write),
    twin("inbox.consent.record", GateMode::Gated, "jeeta.inbox.consent_record", ("POST", "/api/inbox/people/{person_id}/consents"), Write),
    twin("inbox.consent.list", GateMode::Gated, "jeeta.inbox.consent_list", ("GET", "/api/inbox/people/{person_id}/consents"), Read),
    twin("inbox.suppressions.add", GateMode::Gated, "jeeta.inbox.suppressions_add", ("POST", "/api/inbox/people/{person_id}/suppressions"), Write),
    twin("inbox.suppressions.remove", GateMode::Gated, "jeeta.inbox.suppressions_remove", ("DELETE", "/api/inbox/people/{person_id}/suppressions/{channel}/{reason}"), Write),
    twin("inbox.send", GateMode::Gated, "jeeta.inbox.send", ("POST", "/api/inbox/people/{person_id}/send"), Write),
    twin("inbox.quotes.send", GateMode::Gated, "jeeta.inbox.quotes_send", ("POST", "/api/inbox/journeys/{journey_id}/quotes"), Write),
    twin("inbox.quotes.accept", GateMode::Gated, "jeeta.inbox.quotes_accept", ("POST", "/api/inbox/quotes/{id}/accept"), Write),
    twin("inbox.quotes.list", GateMode::Gated, "jeeta.inbox.quotes_list", ("GET", "/api/inbox/journeys/{journey_id}/quotes"), Read),
    twin("inbox.appointments.book", GateMode::Gated, "jeeta.inbox.appointments_book", ("POST", "/api/inbox/journeys/{journey_id}/appointments"), Write),
    twin("inbox.appointments.cancel", GateMode::Gated, "jeeta.inbox.appointments_cancel", ("POST", "/api/inbox/appointments/{id}/cancel"), Write),
    twin("inbox.appointments.held", GateMode::Gated, "jeeta.inbox.appointments_held", ("POST", "/api/inbox/appointments/{id}/held"), Write),
    twin("inbox.commissions.list", GateMode::Gated, "jeeta.inbox.commissions_list", ("GET", "/api/inbox/commissions"), Read),
    twin("inbox.commissions.approve", GateMode::Gated, "jeeta.inbox.commissions_approve", ("POST", "/api/inbox/commissions/{id}/approve"), Write),
    twin("inbox.commissions.pay", GateMode::Gated, "jeeta.inbox.commissions_pay", ("POST", "/api/inbox/commissions/{id}/pay"), Write),
    twin("inbox.commission_rates.set", GateMode::Gated, "jeeta.inbox.commission_rates_set", ("PUT", "/api/inbox/commission-rates"), Write),

    panel_only("auth.register", Exempt, ("POST", "/api/auth/register"), Write),
    panel_only("auth.login", Exempt, ("POST", "/api/auth/login"), Write),
    panel_only("auth.logout", Exempt, ("POST", "/api/auth/logout"), Write),
    panel_only("auth.me", Exempt, ("GET", "/api/auth/me"), Read),
    panel_only("billing.status", Exempt, ("GET", "/api/billing"), Read),
    panel_only("billing.activate", Exempt, ("POST", "/api/billing/activate"), Write),
    twin("billing.report_payment", Exempt, "jeeta.billing.report_payment", ("POST", "/api/billing/payments"), Write),
    twin("workspace.info", Exempt, "jeeta.workspace.info", ("GET", "/api/workspace"), Read),
    panel_only("workspace.switch", Exempt, ("POST", "/api/auth/switch-workspace"), Write),
    twin("team.list", Exempt, "jeeta.team.list", ("GET", "/api/team"), Read),
    twin("team.invite", Exempt, "jeeta.team.invite", ("POST", "/api/team/invites"), Write),
    panel_only("team.accept_invite", Exempt, ("POST", "/api/team/invites/accept"), Write),
    twin("team.set_role", Exempt, "jeeta.team.set_role", ("PATCH", "/api/team/{membership_id}/role"), Write),
    twin("team.remove", Exempt, "jeeta.team.remove", ("DELETE", "/api/team/{membership_id}"), Destructive),
    twin("roles.list", Exempt, "jeeta.roles.list", ("GET", "/api/roles"), Read),
    twin("roles.create", Exempt, "jeeta.roles.create", ("POST", "/api/roles"), Write),
    twin("roles.update", Exempt, "jeeta.roles.update", ("PATCH", "/api/roles/{role_id}"), Write),
    twin("roles.delete", Exempt, "jeeta.roles.delete", ("DELETE", "/api/roles/{role_id}"), Destructive),
    twin("api_keys.create", Exempt, "jeeta.api_keys.create", ("POST", "/api/api-keys"), Write),
    twin("api_keys.list", Exempt, "jeeta.api_keys.list", ("GET", "/api/api-keys"), Read),
    twin("api_keys.revoke", Exempt, "jeeta.api_keys.revoke", ("DELETE", "/api/api-keys/{key_id}"), Destructive),
    twin("agents.list", Exempt, "jeeta.agents.list", ("GET", "/api/agents"), Read),
    twin("agents.whoami", Exempt, "jeeta.agent.whoami", ("GET", "/api/whoami"), Read),
    twin("ledger.list", Exempt, "jeeta.ledger.list", ("GET", "/api/ledger"), Read),
    twin("strategy.get", Exempt, "jeeta.strategy.get", ("GET", "/api/strategy"), Read),
    twin("strategy.start_consultation", Exempt, "jeeta.strategy.start_consultation", ("POST", "/api/strategy/consultation"), Write),
    twin("strategy.record", Exempt, "jeeta.strategy.record", ("POST", "/api/strategy/consultation/entries"), Write),
    twin("strategy.write_section", Exempt, "jeeta.strategy.write_section", ("PUT", "/api/strategy/draft/sections/{section_key}"), Write),
    twin("strategy.set_hypotheses", Exempt, "jeeta.strategy.set_hypotheses", ("PUT", "/api/strategy/draft/hypotheses"), Write),
    twin("strategy.submit", Exempt, "jeeta.strategy.submit", ("POST", "/api/strategy/draft/submit"), Write),
    twin("strategy.approve", Exempt, "jeeta.strategy.approve", ("POST", "/api/strategy/draft/approve"), Write),
    // Body and arguments `{ version_id, confirm }`: the call names the approved version it archives.
    twin("strategy.archive", Exempt, "jeeta.strategy.archive", ("POST", "/api/strategy/archive"), Destructive),
    twin("strategy.list_versions", Exempt, "jeeta.strategy.list_versions", ("GET", "/api/strategy/versions"), Read),
    twin("strategy.consultation", Exempt, "jeeta.strategy.consultation", ("GET", "/api/strategy/versions/{version_id}/consultation"), Read),
    // Capabilities, their groups and the budget are exempt from the strategy gate (the
    // consultation needs to know what the workspace has), but not from the status check.
    twin("capability.list", Exempt, "jeeta.capability.list", ("GET", "/api/capabilities"), Read),
    twin("capability.get", Exempt, "jeeta.capability.get", ("GET", "/api/capabilities/{capability_id}"), Read),
    twin("capability.declare", Exempt, "jeeta.capability.declare", ("POST", "/api/capabilities"), Write),
    // Body and arguments `{ name?, description?, external_id? }`: at least one.
    twin("capability.update", Exempt, "jeeta.capability.update", ("PATCH", "/api/capabilities/{capability_id}"), Write),
    twin("capability.verify", Exempt, "jeeta.capability.verify", ("POST", "/api/capabilities/{capability_id}/verify"), Write),
    twin("capability.mark_unreachable", Exempt, "jeeta.capability.mark_unreachable", ("POST", "/api/capabilities/{capability_id}/unreachable"), Write),
    twin("capability.set_policy", Exempt, "jeeta.capability.set_policy", ("PUT", "/api/capabilities/{capability_id}/policy"), Write),
    // Body and arguments `{ confirm }`.
    twin("capability.retire", Exempt, "jeeta.capability.retire", ("POST", "/api/capabilities/{capability_id}/retire"), Destructive),
    twin("capability.link_budget", Exempt, "jeeta.capability.link_budget", ("POST", "/api/capabilities/{capability_id}/budget-links"), Write),
    twin("capability.unlink_budget", Exempt, "jeeta.capability.unlink_budget", ("DELETE", "/api/capabilities/{capability_id}/budget-links/{budget_item_id}"), Write),
    twin("capability.groups.list", Exempt, "jeeta.capability.groups_list", ("GET", "/api/capability-groups"), Read),
    twin("capability.groups.create", Exempt, "jeeta.capability.groups_create", ("POST", "/api/capability-groups"), Write),
    twin("capability.groups.rename", Exempt, "jeeta.capability.groups_rename", ("PATCH", "/api/capability-groups/{group_id}"), Write),
    twin("capability.groups.delete", Exempt, "jeeta.capability.groups_delete", ("DELETE", "/api/capability-groups/{group_id}"), Destructive),
    twin("capability.groups.add_member", Exempt, "jeeta.capability.groups_add_member", ("POST", "/api/capability-groups/{group_id}/members"), Write),
    twin("capability.groups.remove_member", Exempt, "jeeta.capability.groups_remove_member", ("DELETE", "/api/capability-groups/{group_id}/members/{capability_id}"), Write),
    twin("budget.items.list", Exempt, "jeeta.budget.items_list", ("GET", "/api/budget/items"), Read),
    twin("budget.items.create", Exempt, "jeeta.budget.items_create", ("POST", "/api/budget/items"), Write),
    // Body and arguments `{ name?, cap?, period? }`: at least one; the kind and unit never change.
    twin("budget.items.update", Exempt, "jeeta.budget.items_update", ("PATCH", "/api/budget/items/{budget_item_id}"), Write),
    // Body and arguments `{ confirm }`.
    twin("budget.items.retire", Exempt, "jeeta.budget.items_retire", ("POST", "/api/budget/items/{budget_item_id}/retire"), Destructive),
    twin("budget.spend.record", Exempt, "jeeta.budget.spend_record", ("POST", "/api/budget/items/{budget_item_id}/spend"), Spend),
    twin("budget.spend.list", Exempt, "jeeta.budget.spend_list", ("GET", "/api/budget/items/{budget_item_id}/spend"), Read),
    // Connecting accounts: exempt from the strategy gate (the consultation needs the accounts),
    // not from the status check (a workspace awaiting payment connects nothing). The provider's
    // OAuth callback is the signed-in owner's browser coming back: panel only.
    twin("connector.start_oauth", Exempt, "jeeta.connector.start_oauth", ("POST", "/api/connectors/oauth/start"), Write),
    panel_only("connector.complete_oauth", Exempt, ("GET", "/api/connectors/oauth/callback/{provider}"), Write),
    twin("connector.confirm_assets", Exempt, "jeeta.connector.confirm_assets", ("POST", "/api/connectors/oauth/{pending_id}/confirm"), Write),
    twin("connector.set_credentials", Exempt, "jeeta.connector.set_credentials", ("POST", "/api/connectors/credentials"), Write),
    twin("connector.probe", Exempt, "jeeta.connector.probe", ("POST", "/api/connectors/{capability_id}/probe"), Write),
    twin("connector.health", Exempt, "jeeta.connector.health", ("GET", "/api/connectors/health"), Read),
    twin("connector.reconnect", Exempt, "jeeta.connector.reconnect", ("POST", "/api/connectors/{capability_id}/reconnect"), Write),
    // The webhook addresses to register at the providers; the NetGSM ones carry the workspace's
    // hook tokens, so `capabilities.manage` reads them.
    twin("connector.hooks", Exempt, "jeeta.connector.hooks", ("GET", "/api/connectors/hooks"), Read),
    // A PBX's call policy (call mode, whether calls are recorded): reserved public keys only this
    // writes, with a ledger entry.
    twin("connector.set_pbx_policy", Exempt, "jeeta.connector.set_pbx_policy", ("PUT", "/api/connectors/{capability_id}/pbx-policy"), Write),
    // Phone calls (voice V0): gated by the strategy, except reading the policy. Placing a call
    // spends the PBX tariff.
    twin("calls.policy_get", Exempt, "jeeta.calls.policy_get", ("GET", "/api/calls/policy"), Read),
    twin("calls.policy_set", GateMode::Gated, "jeeta.calls.policy_set", ("PUT", "/api/calls/policy"), Write),
    twin("calls.place", GateMode::Gated, "jeeta.calls.place", ("POST", "/api/calls"), Spend),
    twin("calls.get", GateMode::Gated, "jeeta.calls.get", ("GET", "/api/calls/{call_id}"), Read),
    twin("calls.list", GateMode::Gated, "jeeta.calls.list", ("GET", "/api/calls"), Read),
    twin("calls.end", GateMode::Gated, "jeeta.calls.end", ("POST", "/api/calls/{call_id}/end"), Write),
    // What the connections brought in: observation, not planned work, so exempt from the
    // strategy gate; not from the status check. Acknowledging needs `capabilities.manage`.
    twin("events.pending", Exempt, "jeeta.events.pending", ("GET", "/api/events/pending"), Read),
    twin("events.ack", Exempt, "jeeta.events.ack", ("POST", "/api/events/ack"), Write),
    twin("events.list", Exempt, "jeeta.events.list", ("GET", "/api/events"), Read),
    // What is pending (B11): exempt from the strategy gate, and from the status check while the
    // workspace awaits payment, since an agent asks it before any strategy exists. Checking in is
    // an agent's call only.
    twin("work.pending", Exempt, "jeeta.work.pending", ("GET", "/api/work/pending"), Read),
    mcp_only("work.checkin", Exempt, "jeeta.work.checkin", Write),
    twin("work.set_checkin_interval", Exempt, "jeeta.work.set_checkin_interval", ("PUT", "/api/work/checkin-interval"), Write),
    panel_only("platform.login", Exempt, ("POST", "/api/platform/login"), Write),
    panel_only("platform.workspaces.list", Exempt, ("GET", "/api/platform/workspaces"), Read),
    panel_only("platform.payments.list", Exempt, ("GET", "/api/platform/payments"), Read),
    panel_only("platform.billing.confirm", Exempt, ("POST", "/api/platform/workspaces/{workspace_id}/payments/{payment_id}/confirm"), Write),
    panel_only("platform.billing.reissue", Exempt, ("POST", "/api/platform/workspaces/{workspace_id}/payments/{payment_id}/reissue"), Write),
    panel_only("platform.billing.revoke_activation", Exempt, ("POST", "/api/platform/workspaces/{workspace_id}/revoke-activation"), Write),
    panel_only("platform.workspaces.suspend", Exempt, ("POST", "/api/platform/workspaces/{workspace_id}/suspend"), Write),
    panel_only("platform.operators.reset_password", Exempt, ("POST", "/api/platform/operators/{operator_id}/reset-password"), Write),
    panel_only("ops.health", Exempt, ("GET", "/api/platform/health"), Read),
    panel_only("platform.workspaces.resume", Exempt, ("POST", "/api/platform/workspaces/{workspace_id}/resume"), Write),
];

/// The use case with this id.
pub fn find(id: &str) -> Option<&'static UseCase> {
    CATALOG.iter().find(|uc| uc.id == id)
}

/// The use case exposed as this MCP tool.
pub fn by_mcp_tool(name: &str) -> Option<&'static UseCase> {
    CATALOG.iter().find(|uc| uc.mcp_tool == Some(name))
}
