//! A campaign's enrollments (spec §3.10; §7.1 `outreach.enrollments_list`,
//! `outreach.enrollments_stop`): read a page of them, and stop one by hand (`manual`). A stopped
//! enrollment never restarts; the person may be enrolled again in another campaign.

use jt_outreach::{CampaignId, EnrollmentId, EnrollmentStatus, StopReason};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::campaigns::no_such_campaign;
use super::templates::page_limit;
use super::{record, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::outreach::{EnrollmentQuery, EnrollmentRow};
use crate::usecases::Deps;

/// `jeeta.outreach.enrollments_list`'s input: a page of the campaign's enrollments by id, of one
/// status or all.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentListInput {
    #[serde(default)]
    pub status: Option<EnrollmentStatus>,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    /// The previous page's `next`.
    #[serde(default)]
    pub after: Option<EnrollmentId>,
}

/// A page of enrollments; `next` is passed back as `after`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EnrollmentListOut {
    pub items: Vec<EnrollmentRow>,
    pub next: Option<EnrollmentId>,
}

/// `jeeta.outreach.enrollments_list`. Needs `outreach.work`.
pub async fn enrollments_list(
    deps: &Deps,
    ctx: &Ctx,
    campaign: CampaignId,
    input: EnrollmentListInput,
) -> Result<EnrollmentListOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let limit = page_limit(input.limit)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.outreach_campaigns()
        .get(campaign)
        .await?
        .ok_or_else(no_such_campaign)?;
    let page = r
        .outreach_enrollments()
        .list(
            campaign,
            &EnrollmentQuery {
                status: input.status,
                limit,
                after: input.after,
            },
        )
        .await?;
    Ok(EnrollmentListOut {
        items: page.items,
        next: page.next,
    })
}

/// `jeeta.outreach.enrollments_stop`'s input: nothing (the stop reason is `manual`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopInput {}

/// `jeeta.outreach.enrollments_stop`: stops an active enrollment (`manual`, ledger
/// `outreach.enrollment_stopped`) and answers it. One that is not active is `CONFLICT
/// {reason: not_active, status}`; one that is not the workspace's `NOT_FOUND`. Needs
/// `outreach.work`.
pub async fn enrollments_stop(
    deps: &Deps,
    ctx: &Ctx,
    id: EnrollmentId,
    StopInput {}: StopInput,
) -> Result<EnrollmentRow, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let e = r
        .outreach_enrollments()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such enrollment"))?;
    if e.status != EnrollmentStatus::Active
        || !r
            .outreach_enrollments()
            .stop(id, &StopReason::Manual, ctx.now)
            .await?
    {
        return Err(refused(
            ErrorCode::Conflict,
            "not_active",
            "only an active enrollment stops",
            json!({ "status": e.status.key() }),
        ));
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.enrollment_stopped",
        "outreach_enrollment",
        id,
        json!({ "enrollment_id": id, "campaign_id": e.campaign_id, "reason": StopReason::Manual.key() }),
    )
    .await?;
    let stopped = r
        .outreach_enrollments()
        .get(id)
        .await?
        .ok_or_else(|| AppError::internal("a stopped enrollment is gone"))?;
    r.commit().await?;
    Ok(stopped)
}
