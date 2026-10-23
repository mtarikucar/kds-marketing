//! Explicit, transactional merges with private restoration snapshots and guarded undo.
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        inbox::{MergeRow, MergeSnapshot},
    },
    usecases::{Deps, invalid},
};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::Permission;
use serde::Deserialize;
use serde_json::json;
use time::Duration;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyInput {
    pub keep: PersonId,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoInput {
    #[serde(default)]
    pub confirm: bool,
}
fn conflict(reason: &str) -> AppError {
    AppError {
        code: crate::error::ErrorCode::Conflict,
        message: reason.replace('_', " "),
        details: json!({"reason":reason}),
    }
}
async fn locked(r: &mut dyn TenantRepos, id: MergeId) -> Result<MergeRow, AppError> {
    // Workspace lock precedes this row and both person locks on every public path.
    r.merges()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such merge"))
}
async fn people(r: &mut dyn TenantRepos, row: &MergeRow) -> Result<(Person, Person), AppError> {
    let mut ids = [row.source_id, row.target_id];
    ids.sort();
    let a = r
        .people()
        .lock(ids[0])
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    let b = r
        .people()
        .lock(ids[1])
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    Ok((a, b))
}
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<MergeRow>, AppError> {
    ctx.require(Permission::InboxManage)?;
    deps.uow
        .tenant(ctx.workspace_id)
        .await?
        .merges()
        .list_all()
        .await
}
pub async fn apply(
    deps: &Deps,
    ctx: &Ctx,
    id: MergeId,
    input: ApplyInput,
) -> Result<MergeRow, AppError> {
    ctx.require(Permission::InboxManage)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut row = locked(r.as_mut(), id).await?;
    if row.status != "suggested" {
        return Err(conflict("merge_not_suggested"));
    }
    if input.keep != row.source_id && input.keep != row.target_id {
        return Err(invalid("keep", "keeper must be one of the merge people"));
    }
    let (a, b) = people(r.as_mut(), &row).await?;
    if a.merged_into.is_some()
        || b.merged_into.is_some()
        || a.erased_at.is_some()
        || b.erased_at.is_some()
    {
        return Err(conflict("person_unavailable"));
    }
    if r.journeys().open_for(a.id).await?.is_some() && r.journeys().open_for(b.id).await?.is_some()
    {
        return Err(conflict("two_open_journeys"));
    }
    let snapshot = r.merges().snapshot(a.id, b.id).await?;
    let at = ctx
        .now
        .max(snapshot.latest_write_at + Duration::microseconds(1));
    r.merges().apply_snapshot(&snapshot, input.keep, at).await?;
    let source = if a.id == input.keep { b.id } else { a.id };
    r.people().mark_merged(source, Some(input.keep), at).await?;
    row.source_id = source;
    row.target_id = input.keep;
    row.status = "applied".into();
    row.at = at;
    row.applied_by = match ctx.actor {
        Actor::Human { user_id } => Some(user_id),
        _ => None,
    };
    row.moved_snapshot = serde_json::to_value(snapshot)?;
    r.merges().save(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.merge.applied",
        "merge",
        id,
        json!({"source_id":source,"target_id":input.keep}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn undo(
    deps: &Deps,
    ctx: &Ctx,
    id: MergeId,
    input: UndoInput,
) -> Result<MergeRow, AppError> {
    ctx.require(Permission::InboxManage)?;
    if !input.confirm {
        return Err(invalid("confirm", "confirm must be true to undo a merge"));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let mut row = locked(r.as_mut(), id).await?;
    if row.status != "applied" {
        return Err(conflict("merge_not_applied"));
    }
    if ctx.now > row.at + Duration::days(30) {
        return Err(conflict("undo_expired"));
    }
    let (a, b) = people(r.as_mut(), &row).await?;
    if a.erased_at.is_some() || b.erased_at.is_some() {
        return Err(conflict("person_unavailable"));
    }
    let source = if a.id == row.source_id { &a } else { &b };
    let target = if a.id == row.target_id { &a } else { &b };
    if source.merged_into != Some(row.target_id) || target.merged_into.is_some() {
        return Err(conflict("edited_after_merge"));
    }
    // Lock child aggregates before reading the guard and restoring their graph.
    let current = r.merges().snapshot(row.source_id, row.target_id).await?;
    if r.merges().edited_since(row.target_id, row.at).await? {
        return Err(conflict("edited_after_merge"));
    }
    let snapshot: MergeSnapshot = serde_json::from_value(row.moved_snapshot.clone())
        .map_err(|_| AppError::internal("invalid merge snapshot"))?;
    if snapshot.version != 1 {
        return Err(AppError::internal("unsupported merge snapshot"));
    }
    let at = ctx
        .now
        .max(current.latest_write_at + Duration::microseconds(1));
    r.merges().restore_snapshot(&snapshot, at).await?;
    r.people().mark_merged(row.source_id, None, at).await?;
    r.merges().mark_undone(id, at).await?;
    row.status = "undone".into();
    row.undone_at = Some(at);
    record(
        r.as_mut(),
        ctx,
        "inbox.merge.undone",
        "merge",
        id,
        json!({"source_id":row.source_id,"target_id":row.target_id}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn refuse(deps: &Deps, ctx: &Ctx, id: MergeId) -> Result<MergeRow, AppError> {
    ctx.require(Permission::InboxManage)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let mut row = locked(r.as_mut(), id).await?;
    if row.status != "suggested" {
        return Err(conflict("merge_not_suggested"));
    }
    row.status = "refused".into();
    r.merges().save(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.merge.refused",
        "merge",
        id,
        json!({}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
