//! The use-case catalog: every use case with its gate mode, its two surfaces and its risk.
//!
//! The twin rule: a use case has both an MCP tool and a panel route unless it is `panel_only`
//! (no MCP tool) or `mcp_only` (no panel route), never both.
//!
//! Two independent checks guard a use case ([`crate::gate::check_gate`]): the workspace-status
//! check (the workspace must be `active`), which every use case meets unless it is
//! [`UseCase::status_exempt`], and the strategy gate, which only [`GateMode::Gated`] use cases
//! meet.

use serde::Serialize;

use GateMode::Exempt;
use Risk::{Destructive, Read, Spend, Write};

/// Whether the strategy gate applies to a use case. The workspace-status check is separate
/// ([`UseCase::status_exempt`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateMode {
    /// Runs without an approved strategy; the caller must still be authenticated.
    Exempt,
    /// Needs an approved strategy.
    Gated,
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
    /// Runs whatever the workspace's status. Only identity, workspace, platform, strategy and
    /// pending-work use cases (`auth.*`, `workspace.*`, `platform.*`, `strategy.*`, `work.*`)
    /// are; every other one answers `WORKSPACE_INACTIVE` while its workspace is
    /// `pending_payment` or `suspended`, whatever its [`GateMode`]. The strategy may be worked
    /// out before payment, and an agent may ask what is pending meanwhile; nothing else may run.
    pub status_exempt: bool,
    pub risk: Risk,
}

/// The id prefixes whose use cases are [`UseCase::status_exempt`].
pub const STATUS_EXEMPT_PREFIXES: &[&str] =
    &["auth.", "workspace.", "platform.", "strategy.", "work."];

/// Whether use case `id` runs whatever its workspace's status: whether it starts with one of
/// [`STATUS_EXEMPT_PREFIXES`].
pub const fn is_status_exempt(id: &str) -> bool {
    let mut i = 0;
    while i < STATUS_EXEMPT_PREFIXES.len() {
        if starts_with(id, STATUS_EXEMPT_PREFIXES[i]) {
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
        status_exempt: is_status_exempt(id),
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
        status_exempt: is_status_exempt(id),
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
        status_exempt: is_status_exempt(id),
        risk,
    }
}

/// Every use case of this release. None is `Gated` yet.
#[rustfmt::skip]
pub static CATALOG: &[UseCase] = &[
    panel_only("auth.register", Exempt, ("POST", "/api/auth/register"), Write),
    panel_only("auth.login", Exempt, ("POST", "/api/auth/login"), Write),
    panel_only("auth.logout", Exempt, ("POST", "/api/auth/logout"), Write),
    panel_only("auth.me", Exempt, ("GET", "/api/auth/me"), Read),
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
    twin("budget.spend.record", Exempt, "jeeta.budget.spend_record", ("POST", "/api/budget/items/{budget_item_id}/spend"), Spend),
    twin("budget.spend.list", Exempt, "jeeta.budget.spend_list", ("GET", "/api/budget/items/{budget_item_id}/spend"), Read),
    // What is pending (B11): exempt from the strategy gate and the status check, since an agent
    // asks it before any strategy exists. Checking in is an agent's call only.
    twin("work.pending", Exempt, "jeeta.work.pending", ("GET", "/api/work/pending"), Read),
    mcp_only("work.checkin", Exempt, "jeeta.work.checkin", Write),
    twin("work.set_checkin_interval", Exempt, "jeeta.work.set_checkin_interval", ("PUT", "/api/work/checkin-interval"), Write),
    panel_only("platform.login", Exempt, ("POST", "/api/platform/login"), Write),
    panel_only("platform.workspaces.list", Exempt, ("GET", "/api/platform/workspaces"), Read),
    panel_only("platform.workspaces.set_status", Exempt, ("PATCH", "/api/platform/workspaces/{workspace_id}/status"), Write),
];

/// The use case with this id.
pub fn find(id: &str) -> Option<&'static UseCase> {
    CATALOG.iter().find(|uc| uc.id == id)
}

/// The use case exposed as this MCP tool.
pub fn by_mcp_tool(name: &str) -> Option<&'static UseCase> {
    CATALOG.iter().find(|uc| uc.mcp_tool == Some(name))
}
