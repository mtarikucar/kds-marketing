//! Campaigns (spec §3.10, §3.13; §7.1 `outreach.campaigns_*`): a definition saved while draft or
//! paused (each save is the next revision and voids the approval), launched through the fences,
//! approved by a person, paused, resumed and canceled. The moves are `jt_outreach::campaign_next`'s.
//!
//! - **Launch** (and resume) refuses while the platform switch is off and while the sender
//!   identity is missing (`launch_fence`: F2, then F10). When approval is required (the outreach
//!   policy says so, or the mailbox requires human approval) the campaign waits in
//!   `awaiting_approval`, unless the caller is a person with `outreach.manage`, whose launch
//!   approves the revision it launches.
//! - **Snapshots**: launch and resume copy each step's template (revision, subject, body,
//!   links, language) into the step, where it has none; a save clears them (the definition is
//!   replaced), so later template edits never reach a running campaign and an edited campaign
//!   sends what was approved after the edit.
//! - **Approve** is a person's act with `outreach.manage` (`human_required` otherwise), bound to
//!   the revision it names (`stale_revision`).
//! - **Cancel** needs `outreach.manage` and stops every active enrollment (`campaign_canceled`).

use jt_capability::{Capability, CapabilityId};
use jt_ledger::Actor;
use jt_outreach::{
    Approval, ApprovalChange, CampaignEvent, CampaignId, CampaignStatus, Definition, PauseReason,
    StepSnapshot, StopReason, campaign_next, launch_fence, requires_approval,
    validate_campaign_name, validate_definition,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::format_description::well_known::Rfc3339;

use super::templates::page_limit;
use super::{campaign_error, fenced, outreach_policy, record, refused, request_key, stale};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::outreach::{CampaignCursor, CampaignQuery, CampaignRow};
use crate::usecases::{Deps, invalid, keyset_cursor};

/// The prefix that keeps a campaign creation's request keys apart from every other operation's.
pub const REQUEST_KEY_PREFIX: &str = "outreach.campaigns_save:";

/// `jeeta.outreach.campaigns_save`'s input: a new draft (no `campaign_id`), or the next revision
/// of a draft or paused campaign (`campaign_id` and the `expected_revision` it was read at).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignSaveInput {
    #[serde(default)]
    pub campaign_id: Option<CampaignId>,
    #[serde(default)]
    pub expected_revision: Option<u32>,
    pub name: String,
    /// A `mailbox` capability of the workspace: the sender.
    pub mailbox_id: CapabilityId,
    /// Snapshots in it are dropped: launch and resume take them.
    pub definition: Definition,
    /// Replays a creation for 24 hours (the id only is stored).
    #[serde(default)]
    pub request_key: Option<String>,
}

/// A campaign, whether a launch or resume of it now waits for approval, and its active
/// enrollments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CampaignOut {
    pub campaign: CampaignRow,
    pub approval_required: bool,
    pub active_enrollments: u32,
}

/// `NOT_FOUND` for a campaign that is not the workspace's.
pub(crate) fn no_such_campaign() -> AppError {
    AppError::not_found("no such campaign")
}

/// The sending mailbox: a `mailbox` capability of the workspace (`VALIDATION mailbox_id:
/// not_a_mailbox` for another kind, `NOT_FOUND` for none).
pub(crate) async fn mailbox(
    r: &mut dyn TenantRepos,
    id: CapabilityId,
) -> Result<Capability, AppError> {
    let cap = r
        .capabilities()
        .find(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such mailbox"))?;
    if cap.kind_key != "mailbox" {
        return Err(AppError::validation(
            "the sender is a mailbox capability",
            json!({ "field": "mailbox_id", "reason": "not_a_mailbox" }),
        ));
    }
    Ok(cap)
}

/// Every step's template exists in the workspace and is not archived.
async fn check_templates(r: &mut dyn TenantRepos, d: &Definition) -> Result<(), AppError> {
    for s in &d.steps {
        match r.outreach_templates().get(s.template_id).await? {
            None => {
                return Err(AppError::validation(
                    "a step names no template of the workspace",
                    json!({ "field": "definition.steps.template_id", "reason": "unknown_template" }),
                ));
            }
            Some(t) if t.template.archived => {
                return Err(AppError::validation(
                    "a step names an archived template",
                    json!({ "field": "definition.steps.template_id", "reason": "archived_template" }),
                ));
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// Takes a snapshot for every step without one: the template as it is now.
async fn snapshot(r: &mut dyn TenantRepos, d: &mut Definition) -> Result<(), AppError> {
    check_templates(r, d).await?;
    for s in &mut d.steps {
        if s.snapshot.is_some() {
            continue;
        }
        let t = r
            .outreach_templates()
            .get(s.template_id)
            .await?
            .ok_or_else(|| AppError::internal("a checked template disappeared"))?
            .template;
        let facts = jt_outreach::validate_template(&t.subject, &t.body)
            .map_err(|_| AppError::internal("a stored template no longer parses"))?;
        s.snapshot = Some(StepSnapshot {
            template_revision: t.revision,
            subject: t.subject,
            body: t.body,
            links: facts.links,
            language: t.language,
        });
    }
    Ok(())
}

/// Whether a launch or resume of a campaign sending from `mailbox` needs a person's approval.
pub(crate) async fn approval_needed(
    r: &mut dyn TenantRepos,
    mailbox: &Capability,
) -> Result<bool, AppError> {
    let policy = outreach_policy(r).await?;
    Ok(requires_approval(
        policy.requires_approval,
        mailbox.policy.requires_human_approval,
    ))
}

async fn campaign_out(
    r: &mut dyn TenantRepos,
    campaign: CampaignRow,
) -> Result<CampaignOut, AppError> {
    let cap = r.capabilities().find(campaign.mailbox_id).await?;
    let approval_required = match &cap {
        Some(cap) => approval_needed(r, cap).await?,
        None => outreach_policy(r).await?.requires_approval,
    };
    let active_enrollments = r.outreach_enrollments().count_active(campaign.id).await?;
    Ok(CampaignOut {
        campaign,
        approval_required,
        active_enrollments,
    })
}

/// `jeeta.outreach.campaigns_save`: creates a draft (revision 1) under the approved strategy in
/// force, or writes the next revision of a draft or paused campaign, voiding its approval and
/// its snapshots. The definition is checked (`validate_definition`), its templates must exist and
/// not be archived, and the sender must be a mailbox.
pub async fn campaigns_save(
    deps: &Deps,
    ctx: &Ctx,
    input: CampaignSaveInput,
) -> Result<CampaignOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    validate_campaign_name(&input.name).map_err(campaign_error)?;
    let mut definition = input.definition;
    validate_definition(&definition).map_err(campaign_error)?;
    for s in &mut definition.steps {
        s.snapshot = None;
    }
    definition.sender_name = definition.sender_name.trim().to_owned();
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(id) = input.campaign_id else {
        if input.expected_revision.is_some() {
            return Err(invalid(
                "expected_revision",
                "expected_revision comes with campaign_id",
            ));
        }
        let key = request_key(REQUEST_KEY_PREFIX, input.request_key.as_deref())?;
        if let Some(key) = &key
            && let Some(stored) = r.request_keys().get(key, ctx.now).await?
        {
            let id: CampaignId = serde_json::from_value(stored["campaign_id"].clone())
                .map_err(|_| AppError::internal("a stored request key names no campaign"))?;
            let row = r
                .outreach_campaigns()
                .get(id)
                .await?
                .ok_or_else(no_such_campaign)?;
            return campaign_out(r.as_mut(), row).await;
        }
        mailbox(r.as_mut(), input.mailbox_id).await?;
        check_templates(r.as_mut(), &definition).await?;
        let version = r.strategy().current_approved().await?.ok_or_else(|| {
            refused(
                ErrorCode::Forbidden,
                "strategy_required",
                "a campaign is made under an approved strategy",
                json!({}),
            )
        })?;
        let row = CampaignRow {
            id: CampaignId::from(deps.ids.uuid()),
            name: input.name.trim().to_owned(),
            mailbox_id: input.mailbox_id,
            status: CampaignStatus::Draft,
            definition,
            revision: 1,
            approval: None,
            pause_reason: None,
            strategy_version_id: version.id,
            created_by: ctx.actor.clone(),
            created_at: ctx.now,
            updated_at: ctx.now,
            launched_at: None,
            completed_at: None,
        };
        r.outreach_campaigns().insert(&row).await?;
        saved(r.as_mut(), ctx, &row).await?;
        if let Some(key) = &key
            && !r
                .request_keys()
                .store(key, json!({ "campaign_id": row.id }), ctx.now)
                .await?
        {
            return Err(AppError::conflict("request key changed while recording"));
        }
        let out = campaign_out(r.as_mut(), row).await?;
        r.commit().await?;
        return Ok(out);
    };
    if input.request_key.is_some() {
        return Err(invalid(
            "request_key",
            "a request key replays a creation; an edit is revision-checked",
        ));
    }
    let expected = input.expected_revision.ok_or_else(|| {
        invalid(
            "expected_revision",
            "an edit names the revision it was read at",
        )
    })?;
    let mut row = r
        .outreach_campaigns()
        .lock(id)
        .await?
        .ok_or_else(no_such_campaign)?;
    campaign_next(
        row.status,
        row.approval.as_ref(),
        row.revision,
        row.definition.schedule.start_at,
        &CampaignEvent::Edit,
    )
    .map_err(campaign_error)?;
    if row.revision != expected {
        return Err(stale(row.revision));
    }
    mailbox(r.as_mut(), input.mailbox_id).await?;
    check_templates(r.as_mut(), &definition).await?;
    row.name = input.name.trim().to_owned();
    row.mailbox_id = input.mailbox_id;
    row.definition = definition;
    row.revision = expected + 1;
    row.approval = None;
    row.updated_at = ctx.now;
    if !r.outreach_campaigns().update(&row, expected).await? {
        return Err(stale(expected));
    }
    saved(r.as_mut(), ctx, &row).await?;
    let out = campaign_out(r.as_mut(), row).await?;
    r.commit().await?;
    Ok(out)
}

async fn saved(r: &mut dyn TenantRepos, ctx: &Ctx, c: &CampaignRow) -> Result<(), AppError> {
    record(
        r,
        ctx,
        "outreach.campaign_saved",
        "outreach_campaign",
        c.id,
        json!({ "campaign_id": c.id, "revision": c.revision, "steps": c.definition.steps.len() }),
    )
    .await
}

/// `jeeta.outreach.campaigns_get`.
pub async fn campaigns_get(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
) -> Result<CampaignOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let row = r
        .outreach_campaigns()
        .get(id)
        .await?
        .ok_or_else(no_such_campaign)?;
    campaign_out(r.as_mut(), row).await
}

/// `jeeta.outreach.campaigns_list`'s input: a page, newest first.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignListInput {
    #[serde(default)]
    pub status: Option<CampaignStatus>,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<CampaignId>,
}

/// Where the next page of campaigns starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CampaignNext {
    pub before_at: String,
    pub before_id: CampaignId,
}

/// A page of campaigns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CampaignListOut {
    pub items: Vec<CampaignRow>,
    pub next: Option<CampaignNext>,
}

/// `jeeta.outreach.campaigns_list`.
pub async fn campaigns_list(
    deps: &Deps,
    ctx: &Ctx,
    input: CampaignListInput,
) -> Result<CampaignListOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let limit = page_limit(input.limit)?;
    let before = keyset_cursor(input.before_at.as_deref(), input.before_id)?
        .map(|(created_at, id)| CampaignCursor { created_at, id });
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let page = r
        .outreach_campaigns()
        .list(&CampaignQuery {
            status: input.status,
            limit,
            before,
        })
        .await?;
    let next = match page.next {
        Some(c) => Some(CampaignNext {
            before_at: c
                .created_at
                .format(&Rfc3339)
                .map_err(|_| AppError::internal("a creation time does not format"))?,
            before_id: c.id,
        }),
        None => None,
    };
    Ok(CampaignListOut {
        items: page.items,
        next,
    })
}

/// `jeeta.outreach.campaigns_launch`'s input: the revision the caller read and launches.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchInput {
    pub expected_revision: u32,
}

/// Whether the caller is a person with `outreach.manage`: their launch or resume approves.
fn approver(ctx: &Ctx) -> Option<jt_tenancy::UserId> {
    match ctx.actor {
        Actor::Human { user_id } if ctx.permissions.contains(&Permission::OutreachManage) => {
            Some(user_id)
        }
        _ => None,
    }
}

/// Launches from draft, or resumes from paused: the fences, the approval rule, the snapshots,
/// and the write. Answers the new row, whether the caller's act approved it, and the
/// approval-required flag.
async fn go(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    row: &mut CampaignRow,
    resume: bool,
) -> Result<bool, AppError> {
    let policy = outreach_policy(r).await?;
    launch_fence(
        deps.apps.outreach_enabled(),
        policy.sender_identity_complete(),
    )
    .map_err(fenced)?;
    let cap = mailbox(r, row.mailbox_id).await?;
    let approval_required = approval_needed(r, &cap).await?;
    let own_approval = match approver(ctx) {
        Some(by)
            if approval_required
                && row
                    .approval
                    .as_ref()
                    .is_none_or(|a| a.revision != row.revision) =>
        {
            Some(Approval {
                revision: row.revision,
                by,
                at: ctx.now,
            })
        }
        _ => None,
    };
    let event = if resume {
        CampaignEvent::Resume {
            approval_required,
            now: ctx.now,
        }
    } else {
        CampaignEvent::Launch {
            approval_required,
            now: ctx.now,
        }
    };
    let (to, change) = campaign_next(
        row.status,
        own_approval.as_ref().or(row.approval.as_ref()),
        row.revision,
        row.definition.schedule.start_at,
        &event,
    )
    .map_err(campaign_error)?;
    snapshot(r, &mut row.definition).await?;
    if change == ApprovalChange::Void {
        row.approval = None;
    }
    let approved_now = own_approval.is_some();
    if let Some(a) = own_approval {
        row.approval = Some(a);
    }
    row.status = to;
    row.pause_reason = None;
    if matches!(to, CampaignStatus::Scheduled | CampaignStatus::Running)
        && row.launched_at.is_none()
    {
        row.launched_at = Some(ctx.now);
    }
    row.updated_at = ctx.now;
    Ok(approved_now)
}

/// `jeeta.outreach.campaigns_launch`: launches a draft at the revision the caller read (see the
/// module docs). `scheduled` when its start is ahead, `running` from now, `awaiting_approval`
/// when a person's approval is required and the caller cannot give it.
pub async fn campaigns_launch(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
    input: LaunchInput,
) -> Result<CampaignOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut row = r
        .outreach_campaigns()
        .lock(id)
        .await?
        .ok_or_else(no_such_campaign)?;
    if row.revision != input.expected_revision {
        return Err(stale(row.revision));
    }
    let expected = row.revision;
    let approved = go(deps, ctx, r.as_mut(), &mut row, false).await?;
    if !r.outreach_campaigns().update(&row, expected).await? {
        return Err(stale(expected));
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.campaign_launched",
        "outreach_campaign",
        id,
        json!({ "campaign_id": id, "revision": row.revision, "status": row.status.key() }),
    )
    .await?;
    if approved {
        approved_entry(r.as_mut(), ctx, &row).await?;
    }
    let out = campaign_out(r.as_mut(), row).await?;
    r.commit().await?;
    Ok(out)
}

async fn approved_entry(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    c: &CampaignRow,
) -> Result<(), AppError> {
    record(
        r,
        ctx,
        "outreach.campaign_approved",
        "outreach_campaign",
        c.id,
        json!({ "campaign_id": c.id, "revision": c.revision }),
    )
    .await
}

/// `jeeta.outreach.campaigns_approve`'s input: the revision the person read and approves.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveInput {
    pub expected_revision: u32,
}

/// `jeeta.outreach.campaigns_approve`: a person with `outreach.manage` approves the revision they
/// read (`human_required` for anyone else, `stale_revision` for another revision). An approval
/// that starts the campaign passes the launch fences first; one while paused keeps it paused.
pub async fn campaigns_approve(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
    input: ApproveInput,
) -> Result<CampaignOut, AppError> {
    ctx.require(Permission::OutreachManage)?;
    let Actor::Human { user_id } = ctx.actor else {
        return Err(refused(
            ErrorCode::Forbidden,
            "human_required",
            "only a person approves a campaign",
            json!({}),
        ));
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut row = r
        .outreach_campaigns()
        .lock(id)
        .await?
        .ok_or_else(no_such_campaign)?;
    let (to, _) = campaign_next(
        row.status,
        row.approval.as_ref(),
        row.revision,
        row.definition.schedule.start_at,
        &CampaignEvent::Approve {
            revision: input.expected_revision,
            now: ctx.now,
        },
    )
    .map_err(campaign_error)?;
    if matches!(to, CampaignStatus::Scheduled | CampaignStatus::Running) {
        let policy = outreach_policy(r.as_mut()).await?;
        launch_fence(
            deps.apps.outreach_enabled(),
            policy.sender_identity_complete(),
        )
        .map_err(fenced)?;
        if row.launched_at.is_none() {
            row.launched_at = Some(ctx.now);
        }
    }
    let expected = row.revision;
    row.status = to;
    row.approval = Some(Approval {
        revision: row.revision,
        by: user_id,
        at: ctx.now,
    });
    row.updated_at = ctx.now;
    if !r.outreach_campaigns().update(&row, expected).await? {
        return Err(stale(expected));
    }
    approved_entry(r.as_mut(), ctx, &row).await?;
    let out = campaign_out(r.as_mut(), row).await?;
    r.commit().await?;
    Ok(out)
}

/// What `jeeta.outreach.campaigns_control` does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Pause,
    Resume,
    Cancel,
}

/// `jeeta.outreach.campaigns_control`'s input.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlInput {
    pub action: ControlAction,
}

/// `jeeta.outreach.campaigns_control`: pause (a scheduled or running campaign), resume (a paused
/// one, through the launch fences and the approval rule at its current revision) or cancel (any
/// campaign not completed or canceled; `outreach.manage`; every active enrollment stops with
/// `campaign_canceled`).
pub async fn campaigns_control(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
    input: ControlInput,
) -> Result<CampaignOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    if input.action == ControlAction::Cancel {
        ctx.require(Permission::OutreachManage)?;
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut row = r
        .outreach_campaigns()
        .lock(id)
        .await?
        .ok_or_else(no_such_campaign)?;
    let expected = row.revision;
    let (action, payload) = match input.action {
        ControlAction::Pause => {
            let (to, _) = campaign_next(
                row.status,
                row.approval.as_ref(),
                row.revision,
                row.definition.schedule.start_at,
                &CampaignEvent::Pause {
                    reason: PauseReason::Manual,
                },
            )
            .map_err(campaign_error)?;
            row.status = to;
            row.pause_reason = Some(PauseReason::Manual);
            row.updated_at = ctx.now;
            (
                "outreach.campaign_paused",
                json!({ "campaign_id": id, "reason": PauseReason::Manual.key() }),
            )
        }
        ControlAction::Resume => {
            let approved = go(deps, ctx, r.as_mut(), &mut row, true).await?;
            if approved {
                approved_entry(r.as_mut(), ctx, &row).await?;
            }
            (
                "outreach.campaign_resumed",
                json!({ "campaign_id": id, "status": row.status.key() }),
            )
        }
        ControlAction::Cancel => {
            let (to, _) = campaign_next(
                row.status,
                row.approval.as_ref(),
                row.revision,
                row.definition.schedule.start_at,
                &CampaignEvent::Cancel,
            )
            .map_err(campaign_error)?;
            row.status = to;
            row.pause_reason = None;
            row.updated_at = ctx.now;
            let stopped = r
                .outreach_enrollments()
                .stop_campaign(id, &StopReason::CampaignCanceled, ctx.now)
                .await?;
            (
                "outreach.campaign_canceled",
                json!({ "campaign_id": id, "stopped": stopped }),
            )
        }
    };
    if !r.outreach_campaigns().update(&row, expected).await? {
        return Err(stale(expected));
    }
    record(r.as_mut(), ctx, action, "outreach_campaign", id, payload).await?;
    let out = campaign_out(r.as_mut(), row).await?;
    r.commit().await?;
    Ok(out)
}
