//! Scheduling a project output uses the existing posting engine in the same transaction.
//! A target date alone is a draft; only a canonical PlannedPost/Slot makes it scheduled.
use super::{
    files::{decode, encode, key},
    planner::stable_id,
    posts::{PackageProposalInput, PostOut, ProposedPost, posts_propose_locked},
    projects,
    work::gated,
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::production_projects::ProductionProject,
    usecases::{Deps, hash_token},
};
use jt_strategy::HypothesisId;
use jt_studio::{
    MAX_POST_MATERIALS, MaterialId, PackageHints, PackageRequest, PackageRequestId, PackageStatus,
    PackageTrigger, Subject,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectScheduleInput {
    pub project_id: Uuid,
    pub output_id: Uuid,
    pub expected_revision: u64,
    pub request_key: String,
    pub hypothesis_id: HypothesisId,
    #[serde(default)]
    pub content_type: Option<String>,
    pub material_ids: Vec<MaterialId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectScheduleOut {
    pub project: ProductionProject,
    pub publication: PostOut,
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field":field,"reason":reason}))
}

pub async fn project_schedule(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectScheduleInput,
) -> Result<ProjectScheduleOut, AppError> {
    ctx.require(Permission::StudioManage)?;
    key(&i.request_key)?;
    if i.material_ids.is_empty()
        || i.material_ids.len() > MAX_POST_MATERIALS
        || i.material_ids.iter().collect::<BTreeSet<_>>().len() != i.material_ids.len()
    {
        return Err(invalid("material_ids", "choose_distinct_project_materials"));
    }
    if i.content_type
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.chars().count() > 200 || s.chars().any(char::is_control))
    {
        return Err(invalid("content_type", "invalid_content_type"));
    }
    let payload = json!(hash_token(&encode(&i)?.to_string()));
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(r.as_mut(), ctx).await?;
    r.studio_control().lock_control().await?;
    // Check current tenant and archive state even for an idempotent replay. Replays do not
    // require the old project revision, which changed on the successful original request.
    projects::load(r.as_mut(), i.project_id, None, true).await?;
    if let Some(saved) = r
        .studio()
        .request_replay("studio.project_schedule", &i.request_key, &payload)
        .await?
    {
        return decode(saved);
    }
    let mut project =
        projects::load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    let index = project
        .outputs
        .iter()
        .position(|o| o.id == i.output_id)
        .ok_or_else(|| AppError::not_found("project output"))?;
    let output = &project.outputs[index];
    if output.slot_id.is_some() {
        return Err(super::chain::refuse("project_output_already_scheduled"));
    }
    let capability_id = output
        .capability_id
        .ok_or_else(|| invalid("capability_id", "project_output_channel_required"))?;
    let publish_at = output
        .target_at
        .ok_or_else(|| invalid("target_at", "project_output_time_required"))?;
    let available = projects::available_material_ids(r.as_mut(), &project).await?;
    if i.material_ids.iter().any(|id| !available.contains(id)) {
        return Err(invalid("material_ids", "material_not_in_project"));
    }
    for id in &i.material_ids {
        if let Some(source) = project.sources.iter().find(|s| s.material_id == *id) {
            let current = r
                .studio_materials()
                .get_material(*id)
                .await?
                .ok_or_else(|| AppError::not_found("material"))?;
            if current.erased_at.is_some() || current.revision != source.revision {
                return Err(super::chain::refuse("project_source_changed"));
            }
        }
    }
    let package_key = format!("project:{}:{}", project.id, output.id);
    let request = PackageRequest {
        id: PackageRequestId(stable_id(ctx.workspace_id, &package_key)),
        workspace_id: ctx.workspace_id,
        key: package_key.clone(),
        trigger: PackageTrigger::Project,
        status: PackageStatus::Open,
        olay_id: None,
        occasion: None,
        year: None,
        capability_id: Some(capability_id),
        material_ids: i.material_ids.clone(),
        best_formats: vec![],
        hints: PackageHints {
            max_posts: Some(1),
            subject: Some(Subject::Generic),
            hypothesis_id: Some(i.hypothesis_id),
            content_type: i.content_type.clone(),
            ..Default::default()
        },
        created_at: ctx.now,
        answered_at: None,
        closed_at: None,
    };
    request
        .validate()
        .map_err(|e| AppError::internal(format!("project package: {e}")))?;
    if !r
        .studio_posts()
        .insert_package_request(request.clone())
        .await?
    {
        return Err(super::chain::refuse("project_schedule_already_exists"));
    }
    let proposed = posts_propose_locked(
        d,
        ctx,
        r.as_mut(),
        &frame,
        PackageProposalInput {
            request_id: request.id,
            request_key: package_key,
            posts: vec![ProposedPost {
                format: output.format,
                capability_id,
                publish_at,
                material_ids: i.material_ids,
                subject: Subject::Generic,
                hypothesis_id: i.hypothesis_id,
                content_type: i.content_type,
            }],
        },
    )
    .await?;
    let publication = proposed
        .posts
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("project scheduling returned no post"))?;
    project.outputs[index].slot_id = Some(publication.slot.id);
    let project = projects::save(r.as_mut(), ctx, project, "studio.project.scheduled").await?;
    let out = ProjectScheduleOut {
        project,
        publication,
    };
    r.studio()
        .request_receipt(
            "studio.project_schedule",
            &i.request_key,
            &payload,
            &encode(&out)?,
        )
        .await?;
    r.commit().await?;
    Ok(out)
}

pub fn schema() -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    json!({
        "type":"object","additionalProperties":false,
        "properties":{
            "project_id":uuid,"output_id":uuid,"hypothesis_id":uuid,
            "expected_revision":{"type":"integer","minimum":1,"maximum":18446744073709551615_u64},
            "request_key":{"type":"string","minLength":1,"maxLength":200},
            "content_type":{"type":["string","null"],"minLength":1,"maxLength":200},
            "material_ids":{"type":"array","minItems":1,"maxItems":MAX_POST_MATERIALS,"uniqueItems":true,"items":uuid}
        },
        "required":["project_id","output_id","expected_revision","request_key","hypothesis_id","material_ids"]
    })
}
