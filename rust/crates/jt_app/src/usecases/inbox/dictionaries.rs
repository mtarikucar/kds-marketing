//! Workspace dictionaries; loss events keep a historical copy of their chosen label.
use super::record;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::inbox::LostReasonRow,
    usecases::{Deps, required},
};
use jt_tenancy::Permission;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LostReasonInput {
    pub key: String,
    pub label: String,
    pub active: bool,
}
pub async fn list_lost_reasons(deps: &Deps, ctx: &Ctx) -> Result<Vec<LostReasonRow>, AppError> {
    ctx.require(Permission::InboxWork)?;
    deps.uow
        .tenant(ctx.workspace_id)
        .await?
        .lost_reasons()
        .list()
        .await
}
pub async fn set_lost_reason(
    deps: &Deps,
    ctx: &Ctx,
    input: LostReasonInput,
) -> Result<LostReasonRow, AppError> {
    ctx.require(Permission::InboxManage)?;
    let key = required("key", &input.key)?;
    let label = required("label", &input.label)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let old = r.lost_reasons().list().await?;
    if !input.active && !old.iter().any(|row| row.key != key && row.active) {
        return Err(AppError::conflict(
            "the last active lost reason cannot be deactivated",
        ));
    }
    let row = LostReasonRow {
        workspace_id: ctx.workspace_id,
        seeded: old.iter().any(|row| row.key == key && row.seeded),
        key,
        label,
        active: input.active,
    };
    r.lost_reasons().set(row.clone()).await?;
    record(
        r.as_mut(),
        ctx,
        "inbox.lost_reason.set",
        "workspace",
        ctx.workspace_id,
        json!({"active":row.active}),
    )
    .await?;
    r.commit().await?;
    Ok(row)
}

/// Labels may rename the fixed stages, never add a funnel status.
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct StatusLabelsInput {
    pub labels: std::collections::BTreeMap<String, String>,
}
impl StatusLabelsInput {
    pub fn validate(&self) -> Result<(), AppError> {
        for (key, label) in &self.labels {
            if !crate::ports::inbox::INBOX_STATUS_KEYS.contains(&key.as_str()) {
                return Err(crate::usecases::invalid("labels", "unknown journey status"));
            }
            required("labels", label)?;
        }
        Ok(())
    }
}

/// Replace label overrides without changing the workspace's other policies.
pub async fn set_status_labels(
    deps: &Deps,
    ctx: &Ctx,
    input: StatusLabelsInput,
) -> Result<StatusLabelsInput, AppError> {
    ctx.require(Permission::InboxManage)?;
    input.validate()?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut policy = repos.workspace_policy().get().await?;
    policy.inbox.status_labels = input.labels.clone();
    repos.workspace_policy().set(policy, ctx.now).await?;
    record(
        repos.as_mut(),
        ctx,
        "inbox.status_labels.set",
        "workspace",
        ctx.workspace_id,
        json!({"keys": input.labels.keys().collect::<Vec<_>>()}),
    )
    .await?;
    repos.commit().await?;
    Ok(input)
}

/// Fixed Turkish defaults with workspace display-label overrides. Keys remain domain statuses.
pub(crate) async fn effective_status_labels(
    repos: &mut dyn crate::ports::TenantRepos,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    let mut labels: std::collections::BTreeMap<String, String> = [
        ("new", "Yeni"),
        ("contacted", "İletişim kuruldu"),
        ("unreachable", "Ulaşılamadı"),
        ("appointment", "Randevu"),
        ("met", "Görüşüldü"),
        ("quoted", "Teklif verildi"),
        ("pending", "Beklemede"),
        ("won", "Kazanıldı"),
        ("lost", "Kaybedildi"),
    ]
    .into_iter()
    .map(|(key, label)| (key.into(), label.into()))
    .collect();
    labels.extend(repos.workspace_policy().get().await?.inbox.status_labels);
    Ok(labels)
}
