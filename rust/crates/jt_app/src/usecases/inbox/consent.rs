//! Immutable consent decisions and independent channel suppressions.
use super::record;
use crate::{ctx::Ctx, error::AppError, ports::TenantRepos, usecases::Deps};
use jt_inbox::*;
pub use jt_inbox::{Channel, SuppressionReason};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordInput {
    pub channel: Channel,
    pub kind: ConsentKind,
    pub source: ConsentSource,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}
#[derive(Debug, Serialize)]
pub struct ListOut {
    pub consents: Vec<Consent>,
    pub suppressions: Vec<Suppression>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuppressionInput {
    pub channel: Channel,
    pub reason: SuppressionReason,
}
pub(crate) async fn active_person(r: &mut dyn TenantRepos, id: PersonId) -> Result<(), AppError> {
    let p = r
        .people()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    if p.erased_at.is_some() || p.merged_into.is_some() {
        return Err(AppError::conflict("person is erased or merged"));
    }
    Ok(())
}
pub async fn record_consent(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
    input: RecordInput,
) -> Result<Consent, AppError> {
    ctx.require(Permission::InboxWork)?;
    if input.at > ctx.now {
        return Err(AppError::validation(
            "consent cannot be future dated",
            json!({"field":"at"}),
        ));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    active_person(r.as_mut(), person).await?;
    let row = Consent {
        id: ConsentId::from(deps.ids.uuid()),
        person_id: person,
        channel: input.channel,
        kind: input.kind,
        source: input.source,
        at: input.at,
        sync_state: SyncState::Pending,
        attempts: 0,
    };
    r.consents().insert(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.consent.recorded",
        "person",
        person,
        json!({"person_id":person,"consent_id":row.id,"channel":row.channel,"kind":row.kind}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn list(deps: &Deps, ctx: &Ctx, person: PersonId) -> Result<ListOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people()
        .get(person)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    history(r.as_mut(), person).await
}
pub async fn add_suppression(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
    input: SuppressionInput,
) -> Result<Suppression, AppError> {
    ctx.require(Permission::InboxManage)?;
    if input.reason != SuppressionReason::Manual {
        return Err(AppError::validation(
            "only manual suppression may be added",
            json!({"field":"reason"}),
        ));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    active_person(r.as_mut(), person).await?;
    let row = Suppression {
        person_id: person,
        channel: input.channel,
        reason: input.reason,
    };
    r.suppressions().insert(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.suppression.added",
        "person",
        person,
        json!({"person_id":person,"channel":row.channel,"reason":row.reason}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}
pub async fn remove_suppression(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
    input: SuppressionInput,
) -> Result<(), AppError> {
    ctx.require(Permission::InboxManage)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    active_person(r.as_mut(), person).await?;
    let inherited = history(r.as_mut(), person).await?;
    for row in inherited
        .suppressions
        .into_iter()
        .filter(|s| s.channel == input.channel && s.reason == input.reason)
    {
        r.suppressions()
            .remove(row.person_id, input.channel, input.reason)
            .await?;
    }
    record(
        r.as_mut(),
        ctx,
        "inbox.suppression.removed",
        "person",
        person,
        json!({"person_id":person,"channel":input.channel,"reason":input.reason}),
    )
    .await?;
    r.commit().await
}

// Keep immutable records on their original person so merge undo needs no copied history.
// Applied aliases remain part of the survivor's compliance history until that merge is undone.
pub(super) async fn history(
    r: &mut dyn TenantRepos,
    person: PersonId,
) -> Result<ListOut, AppError> {
    let mut pending = vec![person];
    let mut seen = std::collections::BTreeSet::new();
    let mut out = ListOut {
        consents: vec![],
        suppressions: vec![],
    };
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        out.consents.extend(r.consents().list(id).await?);
        out.suppressions.extend(r.suppressions().list(id).await?);
        for m in r.merges().list(id).await? {
            if m.status == "applied"
                && m.target_id == id
                && r.people()
                    .get(m.source_id)
                    .await?
                    .is_some_and(|p| p.merged_into == Some(id))
            {
                pending.push(m.source_id);
            }
        }
    }
    out.consents.sort_by_key(|c| (c.at, c.id));
    Ok(out)
}
