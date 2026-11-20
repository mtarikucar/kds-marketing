//! The files a person attaches to work, and the work that waits for them (design 2026-11-19
//! "Paylaşımlar and Bilgi bankası" §3.4.4, D5).
//!
//! A file a person attaches for a post (the composer, a capture answer, a need answer, a special
//! day) carries [`UploadFor`] and is listed as pending: in its content's `pending_files`, or found
//! by what it was attached for (a need's, a day's). Its share stays unset at upload. Once an
//! analysis made with `sensitive_checked` finds no face, child, name, client logo, corporate
//! reference or named person and keeps it publishable, the share is set **by rule**
//! ([`share_by_rule`]); otherwise a person decides (`İzin ver`). Every time a pending file gets its
//! share, leaves a content's sources or is deleted, [`left`] takes it off the lists in the same
//! transaction and lets the waiting work go on: the content's agent is woken once its list is
//! empty, a need is answered with its first shared file, a special day's calendar trigger runs.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{TenantRepos, production_projects::*},
    usecases::{
        Deps, ledger_entry,
        studio::{library, planner, projects},
        wake,
    },
};
use jt_ledger::Actor;
use jt_studio::{
    Material, PERSON_UPLOAD_RULE, Quality, ShareDecision, SharePermission, ShootStatus, UploadFor,
};
use jt_tenancy::UserId;
use serde_json::json;
use time::OffsetDateTime;

/// Whether an analysis may share `m` by the person-upload rule: a real material a person
/// attached to work, its share unset, analysed with `sensitive_checked`, showing no person and
/// no mark, and publishable.
pub(crate) fn rule_applies(m: &Material, sensitive_checked: bool) -> bool {
    sensitive_checked
        && m.upload_for.is_some()
        && m.share.is_none()
        && m.erased_at.is_none()
        && !m.is_ai()
        && !m.needs_human_permission()
        && m.tags.quality == Some(Quality::Publishable)
}

/// The rule's share: shareable, by no one (`by: None`, so a face a later analysis finds makes the
/// publish gate refuse it again), at `at`.
pub(crate) fn share_by_rule(at: OffsetDateTime) -> ShareDecision {
    ShareDecision {
        permission: SharePermission::Shareable,
        by: None,
        at,
        rule: Some(PERSON_UPLOAD_RULE.into()),
    }
}

/// How a pending file left its lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Left {
    /// It got its share, by rule or by a person.
    Shared,
    /// A person deleted it. (A person taking it out of a content's sources, `Bu dosya olmadan
    /// devam et`, is `studio.project_materials`' own.)
    Deleted,
    /// It was redacted by a person's erasure (KVKK): nothing waits for it any more, and it stays
    /// a source as the erasure leaves it (what was produced of it is invalidated there).
    Erased,
}

/// Who the work that a pending file held goes on for: the person in person, else the person who
/// attached it (or asked for the content) on whose behalf the system or an agent acts.
fn on_behalf(ctx: &Ctx, m: &Material, p: Option<&ProductionProject>) -> Option<(UserId, bool)> {
    if let Some(user) = library::person(ctx) {
        return Some((user, true));
    }
    m.upload_for
        .as_ref()
        .map(|u| u.by)
        .or_else(|| p.and_then(|p| p.requested_by))
        .map(|u| (u, false))
}

/// Records a wake for `needs` with `reason` in person or on `user`'s behalf.
async fn wake_for(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    needs: &[wake::Need],
    reason: wake::WakeReason,
    who: Option<(UserId, bool)>,
) -> Result<(), AppError> {
    match who {
        Some((_, true)) => wake::request(r, ctx, needs, reason).await,
        Some((user, false)) => wake::request_for(r, ctx, needs, reason, user).await,
        None => Ok(()),
    }
}

/// After material `m` left the pending lists (`how`), in the caller's transaction, which holds
/// the Studio control lock: every live content listing it (and, for a deletion, holding it as a
/// source) is saved without it; a content whose list empties is woken (`content_requested`, or
/// `capture_answered` when a capture answer was the file); a need is answered `done` with its
/// first shared file; a special day's calendar trigger runs once a file of it is shared.
///
/// Only live areas are walked: an archived one is pruned when it is brought back ([`prune`]).
pub(crate) async fn left(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    m: &Material,
    how: Left,
) -> Result<(), AppError> {
    for mut p in r.studio_projects().list_live_areas().await? {
        let pending = p.pending_files.contains(&m.id);
        let source = how == Left::Deleted && p.sources.iter().any(|s| s.material_id == m.id);
        if !pending && !source {
            continue;
        }
        p.pending_files.retain(|id| *id != m.id);
        if how == Left::Deleted {
            p.sources.retain(|s| s.material_id != m.id);
        }
        let emptied = pending && p.pending_files.is_empty();
        let capture = p
            .requests
            .iter()
            .any(|q| q.status == RequestStatus::Done && q.material_ids.contains(&m.id));
        let who = on_behalf(ctx, m, Some(&p));
        let p = projects::save(r, ctx, p, "content.area.files_settled").await?;
        if emptied && p.needs_agent(ctx.now) {
            let reason = if capture {
                wake::WakeReason::CaptureAnswered
            } else {
                wake::WakeReason::ContentRequested
            };
            wake_for(r, ctx, &[wake::CONTENT], reason, who).await?;
        }
    }
    let shared = how == Left::Shared
        && m.share.as_ref().is_some_and(|s| {
            matches!(
                s.permission,
                SharePermission::Shareable | SharePermission::ProductOnly
            )
        });
    if !shared {
        return Ok(());
    }
    let Some(upload) = m.upload_for.clone() else {
        return Ok(());
    };
    if let Some(id) = upload.shoot_request_id
        && let Some(q) = r.studio_materials().get_shoot_request(id).await?
        && q.status == ShootStatus::Open
    {
        resolve_done(r, ctx, q, upload.by).await?;
    }
    if let Some(day) = &upload.day {
        let key = jt_studio::season_request_key(&day.key, day.year);
        let opened = planner::calendar_for(d, r, ctx, &day.key, day.year).await?;
        if let Some(q) = r
            .studio_materials()
            .list_shoot_requests()
            .await?
            .into_iter()
            .find(|q| q.key == key && q.status == ShootStatus::Open)
        {
            resolve_done(r, ctx, q, upload.by).await?;
        }
        if opened {
            let who = on_behalf(ctx, m, None);
            wake_for(
                r,
                ctx,
                &[wake::CONTENT],
                wake::WakeReason::ContentRequested,
                who,
            )
            .await?;
        }
    }
    Ok(())
}

/// Whether pending file `m` (`None`: no longer stored) no longer waits: it has its share or was
/// erased.
fn settled(m: Option<&Material>) -> bool {
    m.is_none_or(|m| m.share.is_some() || m.erased_at.is_some())
}

/// Drops from `p.pending_files` every file that no longer waits ([`settled`]); whether any was
/// dropped. What an archived area missed while [`left`] walked only the live ones (a file
/// shared, deleted or erased meanwhile) is caught up when it is brought back.
pub(crate) async fn prune(
    r: &mut dyn TenantRepos,
    p: &mut ProductionProject,
) -> Result<bool, AppError> {
    if p.pending_files.is_empty() {
        return Ok(false);
    }
    let stored = r.studio_materials().get_materials(&p.pending_files).await?;
    let before = p.pending_files.len();
    p.pending_files
        .retain(|id| !settled(stored.iter().find(|m| m.id == *id)));
    Ok(p.pending_files.len() != before)
}

/// After an analysis or a person's tags cleared the share of `m` (a face, a child, a name found
/// later), in the caller's transaction: a person's file waits for its share again in every live
/// content still being made that holds it as a source, so the row asks `İzin ver` and no agent
/// is offered the content meanwhile (§3.4.4).
pub(crate) async fn reopened(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    m: &Material,
) -> Result<(), AppError> {
    if m.upload_for.is_none() || m.share.is_some() || m.erased_at.is_some() {
        return Ok(());
    }
    for mut p in r.studio_projects().list_live_areas().await? {
        if p.done_at().is_some()
            || p.pending_files.contains(&m.id)
            || !p.sources.iter().any(|s| s.material_id == m.id)
        {
            continue;
        }
        p.pending_files.push(m.id);
        projects::save(r, ctx, p, "content.area.files_reopened").await?;
    }
    Ok(())
}

/// Resolves the çekim listesi's request `q` done, on behalf of `uploader` (`shoot_resolve`'s
/// internals): its file arrived and is usable.
pub(crate) async fn resolve_done(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    q: jt_studio::ShootRequest,
    uploader: UserId,
) -> Result<(), AppError> {
    let request = jt_studio::ShootRequest {
        status: ShootStatus::Done,
        resolved_by: Some(Actor::Human { user_id: uploader }),
        resolved_at: Some(ctx.now),
        ..q
    };
    request.validate().map_err(library::invalid)?;
    r.studio_materials()
        .update_shoot_request(request.clone())
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.shoot.resolved",
            "studio_shoot_request",
            request.id,
            json!({"status":"done","system":request.reason.is_system(),"by":"person_upload"}),
        )?)
        .await?;
    Ok(())
}

/// The [`UploadFor`] of a person's attachment.
pub(crate) fn upload_for(by: UserId, at: OffsetDateTime) -> UploadFor {
    UploadFor {
        area_id: None,
        shoot_request_id: None,
        day: None,
        by,
        at,
    }
}

/// The ledger entry of a share given by the rule (the pattern of O7's `confirmed_by_rule`).
pub(crate) async fn ledger_shared_by_rule(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    m: &Material,
) -> Result<(), AppError> {
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.shared_by_rule",
            "studio_material",
            m.id,
            json!({"rule": PERSON_UPLOAD_RULE,
                   "uploaded_by": m.upload_for.as_ref().map(|u| u.by),
                   "revision": m.revision}),
        )?)
        .await?;
    Ok(())
}
