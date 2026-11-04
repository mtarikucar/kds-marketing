//! Outreach (spec 2026-10-30-leads-pool-outreach-design.md §3.10–§3.14, §7.1 `outreach.*`):
//! plain-text email templates, campaigns of one to six steps with revision-bound approval, the
//! audience a campaign reaches, and the workspace's outreach settings. The rules are
//! `jt_outreach`'s; these use cases read the facts, check who may act and write the rows.
//!
//! **Cold email is locked.** A launch (and a resume) refuses while the platform switch
//! `JEETA_OUTREACH_ENABLED` is off (`outreach_disabled_on_platform`, D24) and while the footer's
//! sender identity is not configured (`sender_identity_missing`); the business-recipient basis
//! counts only with the switch on and a human owner's recorded counsel confirmation (D17, D53).
//!
//! Rules every use case here keeps:
//! - Errors are `FORBIDDEN {reason}` for fences and roles, `CONFLICT {reason, ...}` for states,
//!   stale revisions and duplicates, `VALIDATION {field, reason}` for input; the reason keys are
//!   the snake_case names of the spec.
//! - Ledger payloads carry ids, revisions, counts, reasons and field names, never a template's
//!   text, a recipient's value or an address.
//! - The leads policy is read without a lock (`workspace_policy().read()`); only `settings_set`
//!   writes it, key by key (`patch_leads`).
//! - A request key stores the id it recorded (`{template_id}`, `{campaign_id}`), never the
//!   answer: a replay reads the row again.

pub mod audience;
pub mod campaigns;
pub mod settings;
pub mod templates;

pub use audience::{BasisCounts, PreviewInput, PreviewOut, audience_preview};
pub use campaigns::{
    ApproveInput, CampaignListInput, CampaignListOut, CampaignOut, CampaignSaveInput,
    ControlAction, ControlInput, LaunchInput, campaigns_approve, campaigns_control, campaigns_get,
    campaigns_launch, campaigns_list, campaigns_save,
};
pub use settings::{LegalAckInput, SettingsInput, SettingsOut, settings_get, settings_set};
pub use templates::{
    TemplateListInput, TemplateListOut, TemplateOut, TemplateSaveInput, templates_archive,
    templates_list, templates_save,
};

use jt_outreach::{CampaignError, OutreachPolicy, OutreachRefusal, TemplateError};
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::usecases::invalid;

/// The longest request key, in characters.
pub(crate) const MAX_REQUEST_KEY_CHARS: usize = 128;

/// A refusal with `details.reason = reason` and the `extra` details beside it.
pub(crate) fn refused(code: ErrorCode, reason: &str, message: &str, extra: Value) -> AppError {
    crate::usecases::prospects::refused(code, reason, message, extra)
}

/// `FORBIDDEN {reason}` for an outreach fence's refusal.
pub(crate) fn fenced(r: OutreachRefusal) -> AppError {
    refused(
        ErrorCode::Forbidden,
        r.key(),
        &format!("outreach refused: {}", r.key()),
        json!({}),
    )
}

/// `VALIDATION {field, reason}` for a campaign rule's refusal of a definition, `CONFLICT` for a
/// move the state machine refuses (`{reason: invalid_transition, from, event}`), a stale
/// approval (`stale_revision`) or a start time not reached (`not_yet`).
pub(crate) fn campaign_error(e: CampaignError) -> AppError {
    match e {
        CampaignError::Invalid { field, reason } => AppError::validation(
            format!("{field}: {reason}"),
            json!({ "field": field, "reason": reason }),
        ),
        CampaignError::Transition { from, event } => refused(
            ErrorCode::Conflict,
            "invalid_transition",
            &format!("a {from} campaign cannot be {event}"),
            json!({ "from": from, "event": event }),
        ),
        CampaignError::StaleRevision => refused(
            ErrorCode::Conflict,
            "stale_revision",
            "the revision is not the campaign's current one",
            json!({}),
        ),
        CampaignError::NotYet => refused(
            ErrorCode::Conflict,
            "not_yet",
            "the campaign's start time has not come",
            json!({}),
        ),
    }
}

/// `VALIDATION {field, reason}` for a template rule's refusal; an unknown variable also names
/// the variable (the template's own text, never a recipient's).
pub(crate) fn template_error(e: TemplateError) -> AppError {
    let mut details = json!({ "field": e.field(), "reason": e.reason() });
    if let TemplateError::UnknownVariable { name, .. } = &e {
        details["name"] = json!(name);
    }
    AppError::validation(e.to_string(), details)
}

/// `CONFLICT {reason: stale_revision, revision}`: the stored revision is not the expected one.
pub(crate) fn stale(current: u32) -> AppError {
    refused(
        ErrorCode::Conflict,
        "stale_revision",
        "the row changed since it was read",
        json!({ "revision": current }),
    )
}

/// The workspace's outreach policy (its defaults while none is stored), read without a lock.
pub(crate) async fn outreach_policy(r: &mut dyn TenantRepos) -> Result<OutreachPolicy, AppError> {
    Ok(r.workspace_policy().read().await?.leads.outreach)
}

/// `raw` as a request key under `prefix`: trimmed, `1..=MAX_REQUEST_KEY_CHARS` characters.
pub(crate) fn request_key(prefix: &str, raw: Option<&str>) -> Result<Option<String>, AppError> {
    match raw.map(str::trim) {
        None => Ok(None),
        Some(k) if (1..=MAX_REQUEST_KEY_CHARS).contains(&k.chars().count()) => {
            Ok(Some(format!("{prefix}{k}")))
        }
        Some(_) => Err(invalid(
            "request_key",
            &format!("request_key is 1 to {MAX_REQUEST_KEY_CHARS} characters"),
        )),
    }
}

/// Writes outreach's ledger entry `action` about the `kind` with this `id`, under the strategy
/// version in force.
pub(crate) async fn record(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    kind: &str,
    id: impl std::fmt::Display,
    payload: Value,
) -> Result<(), AppError> {
    let version = crate::usecases::capabilities::version_in_force(r).await?;
    crate::usecases::capabilities::append(r, ctx, action, kind, id, version, payload).await
}
