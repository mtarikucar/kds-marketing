//! The gate in front of every use case: the workspace-status check, the strategy gate, then the
//! use case's module (its capability requirements, and whether it is installed).

use async_trait::async_trait;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

use crate::catalog::{GateMode, UseCase};
use crate::error::AppError;
use crate::usecases::modules::{ADS, CONTENT, INSTALL_GATED, MATERIALS, SOCIAL};

/// Answers whether a workspace has an approved strategy, and which capability requirements of a
/// module it leaves unmet.
#[async_trait]
pub trait StrategyGate: Send + Sync {
    async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError>;

    /// The unmet capability requirements of `module` in `ws` (spec
    /// 2026-11-10-module-capability-gating-design.md); empty when it is ready. The default holds
    /// every module ready, for gates over in-memory ports; the binary's gate answers from the
    /// database (`jt_pg::PgStrategyGate`).
    async fn missing_capabilities(
        &self,
        _ws: WorkspaceId,
        _module: &str,
    ) -> Result<Vec<String>, AppError> {
        Ok(Vec::new())
    }

    /// Whether `module` is installed in `ws`. Asked only for the modules whose removal stops them
    /// ([`INSTALL_GATED`]). The default holds every module installed, for gates over in-memory
    /// ports; the binary's gate answers from the database (`jt_pg::PgStrategyGate`).
    async fn module_installed(&self, _ws: WorkspaceId, _module: &str) -> Result<bool, AppError> {
        Ok(true)
    }
}

/// Use cases that stay open while their module is locked or removed: legal duties (erasure, consent and
/// opt-out records) and stopping what is already running (the studio brake, pausing or stopping
/// a campaign, ending or transferring a live call).
pub const CAPABILITY_EXEMPT: &[&str] = &[
    "inbox.people.erase",
    "inbox.consent.list",
    "inbox.consent.record",
    "inbox.suppressions.add",
    "inbox.suppressions.remove",
    "studio.brake",
    "outreach.campaigns_control",
    "outreach.enrollments_stop",
    "calls.end",
    "calls.transfer",
];

/// The module of a `studio.*` use case, since the Growth Studio became four modules (design
/// `2026-11-10-uc-modul-ve-panel-iskeleti-design.md` Ek A): the shared materials library, content
/// creation, social media, advertising. `None` for the use cases that belong to no single module:
/// the shared reads (`overview`, `pending`, `learned`, the ledger), what feeds the strategy
/// (judgments, trends, hypothesis proposals) and the controls that span lanes (`brake`,
/// `approve`).
pub fn studio_module(id: &str) -> Option<&'static str> {
    let action = id.strip_prefix("studio.")?;
    Some(match action {
        "file_upload"
        | "material_add"
        | "material_get"
        | "materials_list"
        | "material_preview"
        | "material_tag"
        | "material_bind"
        | "material_free"
        | "material_permission"
        | "material_delete"
        | "material_intelligence_get"
        | "material_intelligence_list"
        | "material_intelligence_update"
        | "material_analysis_claim"
        | "material_analysis_complete"
        | "material_analysis_fail"
        | "material_analysis_retry"
        | "olay_create"
        | "olay_update"
        | "olay_get"
        | "olays_list"
        | "olay_confirm"
        | "shoot_list"
        | "shoot_request"
        | "shoot_resolve"
        // Delivering a piece, finding its materials and releasing a check are what all three
        // modules do with the library, so they belong to it and not to one of them.
        | "piece_submit"
        | "slot_materials"
        | "material_check_release" => MATERIALS,
        "project_create"
        | "project_get"
        | "project_list"
        | "project_update"
        | "project_materials"
        | "project_request"
        | "project_request_update"
        | "project_production"
        | "material_production_request"
        | "material_production_list"
        | "material_production_claim"
        | "material_production_complete"
        | "material_production_fail"
        | "calendar_list"
        | "calendar_set"
        | "material_policy_set" => CONTENT,
        "project_publication"
        | "project_schedule"
        | "post_requests"
        | "posts_propose"
        | "posts_list"
        | "posting_policy_set"
        | "weekly_summary"
        | "slot_get"
        | "slot_cancel"
        | "tiktok_posting"
        | "tiktok_post"
        | "tiktok_metrics" => SOCIAL,
        "adsets_list" | "adset_bind" | "budget_move" => ADS,
        _ => return None,
    })
}

/// The module that gates use case `id`, if any: `inbox.*` (people records excepted: the People
/// module works without the inbox), each `studio.*` use case's own module ([`studio_module`]),
/// `outreach.*` and `calls.*` (the device bridge's `calls.bridge.*` plumbing excepted), less
/// [`CAPABILITY_EXEMPT`].
pub fn gating_module(id: &str) -> Option<&'static str> {
    if CAPABILITY_EXEMPT.contains(&id)
        || id.starts_with("calls.bridge.")
        || id.starts_with("inbox.people.")
    {
        return None;
    }
    match id.split('.').next()? {
        "inbox" => Some("inbox"),
        "studio" => studio_module(id),
        "content" => Some("content"),
        "social" => Some("social"),
        "ads" => Some("ads"),
        "materials" => Some("materials"),
        "outreach" => Some("outreach"),
        "calls" => Some("calls"),
        _ => None,
    }
}

/// A gate under which no workspace has an approved strategy, for tests over in-memory ports; the
/// binary serves the gate answered from the database (`jt_pg::PgStrategyGate`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoStrategyYet;

#[async_trait]
impl StrategyGate for NoStrategyYet {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(false)
    }
}

/// Lets `uc` run in workspace `ws` (whose status is `ws_status`) or refuses it. The caller must
/// already have been authenticated.
///
/// Two independent checks, in this order:
/// 1. The workspace must be `Active`, unless `uc`'s status exemption lets it run in `ws_status`
///    (`auth.*`, `workspace.*`, `platform.*` in every status; `strategy.*` and `work.*` while
///    `PendingPayment` too, never while `Suspended`); else `WORKSPACE_INACTIVE`
///    (`details.status`), whatever the strategy.
/// 2. A `Gated` use case needs an approved strategy, else `STRATEGY_REQUIRED`; `gate` is asked
///    only then.
/// 3. A use case of a module with capability requirements ([`gating_module`]) needs them met,
///    else `CAPABILITY_REQUIRED` (`details.module`, `details.missing`).
/// 4. A use case of a module whose removal stops it ([`INSTALL_GATED`]) needs the module
///    installed, else `MODULE_NOT_INSTALLED` (`details.module`).
pub async fn check_gate(
    uc: &UseCase,
    ws_status: WorkspaceStatus,
    gate: &dyn StrategyGate,
    ws: WorkspaceId,
) -> Result<(), AppError> {
    if !uc.status_exemption.allows(ws_status) {
        return Err(AppError::workspace_inactive(ws_status));
    }
    if uc.gate == GateMode::Gated && !gate.has_approved_strategy(ws).await? {
        return Err(AppError::strategy_required());
    }
    if let Some(module) = gating_module(uc.id) {
        let missing = gate.missing_capabilities(ws, module).await?;
        if !missing.is_empty() {
            return Err(AppError::capability_required(module, missing));
        }
        if INSTALL_GATED.contains(&module) && !gate.module_installed(ws, module).await? {
            return Err(AppError::module_not_installed(module));
        }
    }
    Ok(())
}
