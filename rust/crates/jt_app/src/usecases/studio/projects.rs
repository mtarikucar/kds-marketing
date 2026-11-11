//! Durable production workspaces; target dates are drafts until linked to canonical post slots.
use super::library;
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        material_productions::{MaterialProduction, ProductionKind, ProductionStatus},
        materials::Material,
        production_projects::*,
    },
    usecases::{
        Deps, hash_token, ledger_entry,
        studio::files::{decode, encode, key},
    },
};
use jt_capability::CapabilityId;
use jt_studio::{MaterialId, PlannedPost, PostFormat, Slot, SlotId};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;
const MAX_SOURCES: usize = 100;
const MAX_REQUESTS: usize = 50;
const MAX_OUTPUTS: usize = 20;
const MAX_PRODUCTIONS: usize = 100;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectQuery {
    #[serde(default)]
    pub archived: bool,
    pub before: Option<Uuid>,
    pub scope: Option<AreaScope>,
    pub done_before: Option<String>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AreaScope {
    Open,
    Done,
}
#[derive(Debug, Serialize)]
pub struct ProjectListOut {
    pub projects: Vec<ProductionProject>,
    pub next_cursor: Option<Uuid>,
    pub next_done_before: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectIdInput {
    pub project_id: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCreateInput {
    pub request_key: String,
    pub title: Option<String>,
    pub brief: String,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub start_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub formats: Vec<PostFormat>,
    #[serde(default)]
    pub capability_ids: Vec<CapabilityId>,
    #[serde(default)]
    pub material_ids: Vec<MaterialId>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    pub title: String,
    pub format: PostFormat,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub target_at: Option<OffsetDateTime>,
    pub capability_id: Option<CapabilityId>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectUpdateInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub title: Option<String>,
    pub brief: Option<String>,
    pub archived: Option<bool>,
    pub outputs: Option<Vec<OutputInput>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMaterialsInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
    #[serde(default)]
    pub add: Vec<MaterialId>,
    #[serde(default)]
    pub remove: Vec<MaterialId>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRequestInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub request_key: String,
    pub text: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRequestUpdateInput {
    pub project_id: Uuid,
    pub request_id: Uuid,
    pub expected_revision: u64,
    pub status: RequestStatus,
    #[serde(default)]
    pub material_ids: Vec<MaterialId>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectProductionInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub request_key: String,
    pub kind: ProductionKind,
    pub instructions: String,
    pub material_ids: Vec<MaterialId>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectPublicationInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub output_id: Uuid,
    pub slot_id: SlotId,
}
#[derive(Debug, Serialize)]
pub struct ProjectPublication {
    pub output_id: Uuid,
    pub slot: Slot,
    pub post: Option<PlannedPost>,
}
#[derive(Debug, Serialize)]
pub struct ProjectDetail {
    pub project: ProductionProject,
    pub materials: Vec<Material>,
    pub productions: Vec<MaterialProduction>,
    pub publications: Vec<ProjectPublication>,
}
#[derive(Debug, Serialize)]
pub struct ProjectProductionOut {
    pub project: ProductionProject,
    pub production: MaterialProduction,
}

fn invalid(field: &str, message: &str) -> AppError {
    AppError::validation(message, json!({"field":field}))
}
pub(crate) fn text(
    value: &str,
    field: &str,
    max: usize,
    required: bool,
) -> Result<String, AppError> {
    let v = value.trim();
    if (required && v.is_empty())
        || v.chars().count() > max
        || v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(invalid(
            field,
            "text is empty, too long or contains control characters",
        ));
    }
    Ok(v.to_owned())
}
fn ids(values: &[MaterialId], field: &str, max: usize) -> Result<(), AppError> {
    if values.len() > max
        || values.iter().map(|x| x.0).collect::<BTreeSet<_>>().len() != values.len()
        || values.iter().any(|x| x.0.is_nil())
    {
        return Err(invalid(field, "too many, duplicate or invalid materials"));
    }
    Ok(())
}
fn write(ctx: &Ctx) -> Result<(), AppError> {
    ctx.require(Permission::ContentManage)
}
/// A tenant bundle of an active workspace for a use case whose own permission check has run.
async fn open_checked(d: &Deps, ctx: &Ctx) -> Result<Box<dyn TenantRepos>, AppError> {
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    super::chain::active(r.as_mut()).await?;
    Ok(r)
}
pub(crate) async fn load(
    r: &mut dyn TenantRepos,
    id: Uuid,
    expected: Option<u64>,
    editable: bool,
) -> Result<ProductionProject, AppError> {
    let p = r
        .studio_projects()
        .get_project(id)
        .await?
        .ok_or_else(|| AppError::not_found("production project"))?;
    if expected.is_some_and(|v| v != p.revision) {
        return Err(AppError::conflict("project revision changed"));
    }
    if editable && p.archived {
        return Err(AppError::conflict("project archived"));
    }
    Ok(p)
}
pub(crate) async fn material(
    r: &mut dyn TenantRepos,
    id: MaterialId,
) -> Result<Material, AppError> {
    let m = r
        .studio_materials()
        .get_material(id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))?;
    if m.erased_at.is_some() {
        return Err(AppError::conflict("material erased"));
    }
    Ok(m)
}
pub(crate) async fn save(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    mut p: ProductionProject,
    action: &str,
) -> Result<ProductionProject, AppError> {
    let previous = p.revision;
    p.revision = p
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::conflict("project revision overflow"))?;
    p.updated_at = ctx.now;
    p = p.present(ctx.now);
    r.studio_projects()
        .save_project(p.clone(), Some(previous))
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            action,
            "production_project",
            p.id,
            json!({"revision":p.revision}),
        )?)
        .await?;
    Ok(p)
}
pub(crate) async fn available_material_ids(
    r: &mut dyn TenantRepos,
    p: &ProductionProject,
) -> Result<BTreeSet<MaterialId>, AppError> {
    let mut ids: BTreeSet<_> = p.sources.iter().map(|s| s.material_id).collect();
    for id in &p.production_ids {
        if let Some(row) = r.studio_productions().get_production(*id).await?
            && row.production.status == ProductionStatus::Completed
            && !p.invalidated_production_ids.contains(id)
            && let Some(output) = row.production.output_material_id
        {
            ids.insert(output);
        }
    }
    Ok(ids)
}
/// Cancels active work and marks completed results historical when their project context changed.
async fn invalidate(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    p: &mut ProductionProject,
    changed: Option<BTreeSet<MaterialId>>,
    reason: &str,
    include_completed: bool,
) -> Result<(), AppError> {
    let all = changed.is_none();
    let mut affected = changed.unwrap_or_default();
    let mut rows = Vec::new();
    for id in &p.production_ids {
        if let Some(row) = r.studio_productions().get_production(*id).await? {
            rows.push(row);
        }
    }
    // Propagate through derivative chains regardless of insertion order.
    let mut selected = BTreeSet::new();
    loop {
        let before = selected.len();
        for row in &rows {
            let job = &row.production;
            if all
                || job
                    .sources
                    .iter()
                    .any(|s| affected.contains(&s.material_id))
            {
                selected.insert(job.id);
                if let Some(out) = job.output_material_id {
                    affected.insert(out);
                }
            }
        }
        if before == selected.len() {
            break;
        }
    }
    for mut row in rows {
        if !selected.contains(&row.production.id) {
            continue;
        }
        let active = matches!(
            row.production.status,
            ProductionStatus::Pending | ProductionStatus::Running
        );
        if (active || include_completed)
            && !p.invalidated_production_ids.contains(&row.production.id)
        {
            p.invalidated_production_ids.push(row.production.id);
        }
        if active {
            let previous = row.production.revision;
            row.production.revision = previous
                .checked_add(1)
                .ok_or_else(|| AppError::conflict("production revision overflow"))?;
            row.production.updated_at = ctx.now;
            row.production.status = ProductionStatus::Cancelled;
            row.production.last_error_code = Some(reason.into());
            row.lease = None;
            let id = row.production.id;
            r.studio_productions()
                .save_production(row, Some(previous))
                .await?;
            r.ledger()
                .append(ledger_entry(
                    ctx,
                    "studio.material.production_cancelled",
                    "studio_material_production",
                    id,
                    json!({"reason":reason}),
                )?)
                .await?;
        }
    }
    Ok(())
}
pub(crate) async fn detail(
    r: &mut dyn TenantRepos,
    p: ProductionProject,
) -> Result<ProjectDetail, AppError> {
    let mut material_ids: BTreeSet<_> = p.sources.iter().map(|s| s.material_id).collect();
    for id in &p.production_ids {
        if let Some(row) = r.studio_productions().get_production(*id).await?
            && let Some(out) = row.production.output_material_id
        {
            material_ids.insert(out);
        }
    }
    let mut materials = Vec::new();
    for id in material_ids {
        if let Some(m) = r.studio_materials().get_material(id).await?
            && m.erased_at.is_none()
        {
            materials.push(m);
        }
    }
    let mut productions = Vec::new();
    for id in &p.production_ids {
        if let Some(row) = r.studio_productions().get_production(*id).await? {
            productions.push(row.production);
        }
    }
    let mut publications = Vec::new();
    for out in &p.outputs {
        if let Some(id) = out.slot_id
            && let Some(slot) = r.studio().get_slot(id).await?
        {
            let post = r.studio_posts().get_post(id).await?;
            publications.push(ProjectPublication {
                output_id: out.id,
                slot,
                post,
            });
        }
    }
    Ok(ProjectDetail {
        project: p,
        materials,
        productions,
        publications,
    })
}
pub async fn project_list(
    d: &Deps,
    ctx: &Ctx,
    q: ProjectQuery,
) -> Result<ProjectListOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_list",
    ))?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::ContentWork).await?;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let cursor = q
        .done_before
        .as_deref()
        .map(|v| {
            let bytes = URL_SAFE_NO_PAD
                .decode(v)
                .map_err(|_| invalid("done_before", "invalid cursor"))?;
            serde_json::from_slice::<DoneCursor>(&bytes)
                .map_err(|_| invalid("done_before", "invalid cursor"))
        })
        .transpose()?;
    if q.done_before.is_some() && !matches!(q.scope, Some(AreaScope::Done)) {
        return Err(invalid("done_before", "cursor requires done scope"));
    }
    let mut rows = match q.scope {
        None => {
            r.studio_projects()
                .list_projects(q.archived, q.before)
                .await?
        }
        Some(scope) => {
            r.studio_projects()
                .list_areas(matches!(scope, AreaScope::Done), cursor)
                .await?
        }
    };
    let limit = match q.scope {
        None => 100,
        Some(AreaScope::Open) => 200,
        Some(AreaScope::Done) => 50,
    };
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if more && q.scope.is_none() {
        rows.last().map(|p| p.id)
    } else {
        None
    };
    let next_done_before = if more && matches!(q.scope, Some(AreaScope::Done)) {
        rows.last()
            .and_then(|p| p.done_at().map(|at| DoneCursor { at, id: p.id }))
            .map(|c| serde_json::to_vec(&c).map(|b| URL_SAFE_NO_PAD.encode(b)))
            .transpose()
            .map_err(|_| AppError::internal("cursor encoding"))?
    } else {
        None
    };
    Ok(ProjectListOut {
        projects: rows.into_iter().map(|p| p.present(ctx.now)).collect(),
        next_cursor,
        next_done_before,
    })
}
pub async fn project_get(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectIdInput,
) -> Result<ProjectDetail, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_get",
    ))?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::ContentWork).await?;
    let p = load(r.as_mut(), i.project_id, None, false).await?;
    detail(r.as_mut(), p.present(ctx.now)).await
}
fn payload<T: Serialize>(i: &T) -> Result<Value, AppError> {
    Ok(json!(hash_token(&encode(i)?.to_string())))
}
async fn replay(
    r: &mut dyn TenantRepos,
    action: &str,
    k: &str,
    payload: &Value,
) -> Result<Option<Uuid>, AppError> {
    r.studio()
        .request_replay(action, k, payload)
        .await?
        .map(decode)
        .transpose()
}
async fn receipt(
    r: &mut dyn TenantRepos,
    action: &str,
    k: &str,
    payload: &Value,
    id: Uuid,
) -> Result<(), AppError> {
    r.studio()
        .request_receipt(action, k, payload, &encode(&id)?)
        .await
}
pub async fn project_create(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectCreateInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_create",
    ))?;
    write(ctx)?;
    key(&i.request_key)?;
    let brief = text(&i.brief, "brief", MAX_GOAL_CHARS, true)?;
    let title = match &i.title {
        Some(t) => text(t, "title", 160, true)?,
        None => goal_title(&brief),
    };
    let start_at = whole_micros(i.start_at.unwrap_or(ctx.now));
    if start_at > ctx.now + time::Duration::days(365) {
        return Err(invalid("start_at", "at most a year ahead"));
    }
    if i.formats.len() > 5 || i.capability_ids.len() > 100 {
        return Err(invalid("hints", "too many hints"));
    }
    if i.capability_ids.iter().collect::<BTreeSet<_>>().len() != i.capability_ids.len()
        || i.formats
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != i.formats.len()
    {
        return Err(invalid("hints", "duplicate hints"));
    }
    ids(&i.material_ids, "material_ids", MAX_SOURCES)?;
    let hash = payload(&i)?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::ContentManage).await?;
    r.studio_control().lock_control().await?;
    if let Some(id) = replay(r.as_mut(), "studio.project_create", &i.request_key, &hash).await? {
        return Ok(load(r.as_mut(), id, None, false).await?.present(ctx.now));
    }
    for cap in &i.capability_ids {
        validate_account(d, r.as_mut(), ctx, *cap, None).await?;
    }
    let mut sources = Vec::new();
    for id in i.material_ids {
        let m = material(r.as_mut(), id).await?;
        sources.push(ProjectSource {
            material_id: id,
            revision: m.revision,
        });
    }
    let p = ProductionProject {
        id: d.ids.uuid(),
        workspace_id: ctx.workspace_id,
        title,
        brief,
        revision: 1,
        archived: false,
        sources,
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        start_at: Some(start_at),
        opened_by: Default::default(),
        hints: AreaHints {
            formats: i.formats,
            capability_ids: i.capability_ids,
        },
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
        created_at: ctx.now,
        updated_at: ctx.now,
    }
    .present(ctx.now);
    r.studio_projects().save_project(p.clone(), None).await?;
    receipt(
        r.as_mut(),
        "studio.project_create",
        &i.request_key,
        &hash,
        p.id,
    )
    .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.project.created",
            "production_project",
            p.id,
            json!({"source_count":p.sources.len()}),
        )?)
        .await?;
    r.commit().await?;
    Ok(p)
}
pub async fn project_update(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectUpdateInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_update",
    ))?;
    write(ctx)?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::ContentManage).await?;
    r.studio_control().lock_control().await?;
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), false).await?;
    if p.archived
        && (i.archived != Some(false)
            || i.title.is_some()
            || i.brief.is_some()
            || i.outputs.is_some())
    {
        return Err(AppError::conflict("unarchive project before editing"));
    }
    if i.title.as_ref().is_some_and(|t| t.trim() != p.title)
        || i.brief.as_ref().is_some_and(|t| t.trim() != p.brief)
    {
        invalidate(r.as_mut(), ctx, &mut p, None, "project_brief_changed", true).await?;
    }
    if i.archived == Some(true) && !p.archived {
        invalidate(r.as_mut(), ctx, &mut p, None, "project_archived", false).await?;
    }
    if let Some(title) = i.title {
        p.title = text(&title, "title", 160, true)?;
    }
    if let Some(brief) = i.brief {
        p.brief = text(&brief, "brief", MAX_GOAL_CHARS, true)?;
    }
    if let Some(outputs) = i.outputs {
        if outputs.len() > MAX_OUTPUTS {
            return Err(invalid("outputs", "at most 20 outputs"));
        }
        let mut next = Vec::new();
        let mut seen = BTreeSet::new();
        for out in outputs {
            let id = out.id.unwrap_or_else(|| d.ids.uuid());
            if id.is_nil() || !seen.insert(id) {
                return Err(invalid("outputs", "invalid or duplicate output id"));
            }
            let title = text(&out.title, "title", 160, true)?;
            if let Some(cap) = out.capability_id {
                r.capabilities()
                    .find(cap)
                    .await?
                    .ok_or_else(|| AppError::not_found("capability"))?;
            }
            let old = p.outputs.iter().find(|o| o.id == id);
            if let Some(old) = old.filter(|o| o.slot_id.is_some())
                && (old.title != title
                    || old.format != out.format
                    || old.target_at != out.target_at
                    || old.capability_id != out.capability_id)
            {
                return Err(AppError::conflict(
                    "linked output cannot be edited; use canonical publication",
                ));
            }
            next.push(ProjectOutput {
                id,
                title,
                format: out.format,
                target_at: out.target_at,
                capability_id: out.capability_id,
                slot_id: old.and_then(|o| o.slot_id),
            });
        }
        if p.outputs
            .iter()
            .any(|o| o.slot_id.is_some() && !seen.contains(&o.id))
        {
            return Err(AppError::conflict("linked output cannot be removed"));
        }
        p.outputs = next;
    }
    if let Some(archived) = i.archived {
        p.archived = archived;
    }
    let p = save(r.as_mut(), ctx, p, "studio.project.updated").await?;
    r.commit().await?;
    Ok(p)
}
pub async fn project_materials(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectMaterialsInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_materials",
    ))?;
    // Whoever works an area adds to it; taking a chosen source out is the manager's decision.
    if !i.remove.is_empty() {
        write(ctx)?;
    }
    ids(&i.add, "add", MAX_SOURCES)?;
    ids(&i.remove, "remove", MAX_SOURCES)?;
    if i.add.iter().any(|id| i.remove.contains(id)) {
        return Err(invalid("add", "cannot add and remove same material"));
    }
    let mut r = open_checked(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    // Linked publications retain their exact source context; changing project membership cannot silently unlink it.
    for out in &p.outputs {
        if let Some(slot) = out.slot_id
            && let Some(post) = r.studio_posts().get_post(slot).await?
            && post.material_ids.iter().any(|id| i.remove.contains(id))
        {
            return Err(AppError::conflict("material used by linked publication"));
        }
    }
    invalidate(
        r.as_mut(),
        ctx,
        &mut p,
        Some(i.remove.iter().copied().collect()),
        "project_source_removed",
        true,
    )
    .await?;
    p.sources.retain(|s| !i.remove.contains(&s.material_id));
    for id in i.add {
        let m = material(r.as_mut(), id).await?;
        if p.sources
            .iter()
            .any(|s| s.material_id == id && s.revision != m.revision)
        {
            invalidate(
                r.as_mut(),
                ctx,
                &mut p,
                Some([id].into_iter().collect()),
                "project_source_changed",
                true,
            )
            .await?;
        }
        p.sources.retain(|s| s.material_id != id);
        p.sources.push(ProjectSource {
            material_id: id,
            revision: m.revision,
        });
    }
    if p.sources.len() > MAX_SOURCES {
        return Err(invalid("add", "at most 100 project sources"));
    }
    let p = save(r.as_mut(), ctx, p, "studio.project.materials_changed").await?;
    r.commit().await?;
    Ok(p)
}
pub async fn project_request(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectRequestInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_request",
    ))?;
    key(&i.request_key)?;
    let text = text(&i.text, "text", 2000, true)?;
    let hash = payload(&i)?;
    let mut r = open_checked(d, ctx).await?;
    r.studio_control().lock_control().await?;
    if let Some(id) = replay(r.as_mut(), "studio.project_request", &i.request_key, &hash).await? {
        return Ok(load(r.as_mut(), id, None, false).await?.present(ctx.now));
    }
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    if p.requests.len() >= MAX_REQUESTS {
        return Err(invalid("requests", "at most 50 requests"));
    }
    p.requests.push(ProjectMaterialRequest {
        id: d.ids.uuid(),
        text,
        status: RequestStatus::Open,
        material_ids: vec![],
        created_at: ctx.now,
        resolved_at: None,
    });
    let p = save(r.as_mut(), ctx, p, "studio.project.material_requested").await?;
    receipt(
        r.as_mut(),
        "studio.project_request",
        &i.request_key,
        &hash,
        p.id,
    )
    .await?;
    r.commit().await?;
    Ok(p)
}
pub async fn project_request_update(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectRequestUpdateInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_request_update",
    ))?;
    ids(&i.material_ids, "material_ids", MAX_SOURCES)?;
    if i.status == RequestStatus::Done && i.material_ids.is_empty() {
        return Err(invalid(
            "material_ids",
            "completed request needs a material",
        ));
    }
    if i.status != RequestStatus::Done && !i.material_ids.is_empty() {
        return Err(invalid(
            "material_ids",
            "only completed requests take deliveries",
        ));
    }
    let mut r = open_checked(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    let index = p
        .requests
        .iter()
        .position(|q| q.id == i.request_id)
        .ok_or_else(|| AppError::not_found("material request"))?;
    for id in &i.material_ids {
        let m = material(r.as_mut(), *id).await?;
        if p.sources
            .iter()
            .any(|s| s.material_id == *id && s.revision != m.revision)
        {
            invalidate(
                r.as_mut(),
                ctx,
                &mut p,
                Some([*id].into_iter().collect()),
                "project_source_changed",
                true,
            )
            .await?;
        }
        p.sources.retain(|s| s.material_id != *id);
        p.sources.push(ProjectSource {
            material_id: *id,
            revision: m.revision,
        });
    }
    if p.sources.len() > MAX_SOURCES {
        return Err(invalid("material_ids", "at most 100 project sources"));
    }
    p.requests[index].status = i.status;
    p.requests[index].material_ids = i.material_ids;
    p.requests[index].resolved_at = (i.status != RequestStatus::Open).then_some(ctx.now);
    let p = save(r.as_mut(), ctx, p, "studio.project.request_updated").await?;
    r.commit().await?;
    Ok(p)
}
pub async fn project_production(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectProductionInput,
) -> Result<ProjectProductionOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_production",
    ))?;
    write(ctx)?;
    library::decider(ctx).ok_or_else(|| library::person_required("material_production"))?;
    key(&i.request_key)?;
    ids(&i.material_ids, "material_ids", 5)?;
    let hash = payload(&i)?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::ContentManage).await?;
    r.studio_control().lock_control().await?;
    if let Some(id) = replay(
        r.as_mut(),
        "studio.project_production",
        &i.request_key,
        &hash,
    )
    .await?
    {
        let p = load(r.as_mut(), i.project_id, None, false).await?;
        let row = r
            .studio_productions()
            .get_production(id)
            .await?
            .ok_or_else(|| AppError::not_found("production"))?;
        return Ok(ProjectProductionOut {
            project: p,
            production: row.production,
        });
    }
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    if p.production_ids.len() >= MAX_PRODUCTIONS {
        return Err(invalid("productions", "at most 100 production jobs"));
    }
    let available = available_material_ids(r.as_mut(), &p).await?;
    let mut sources = Vec::new();
    for id in i.material_ids {
        if !available.contains(&id) {
            return Err(invalid("material_ids", "source is not part of project"));
        }
        let m = material(r.as_mut(), id).await?;
        if p.sources
            .iter()
            .any(|s| s.material_id == id && s.revision != m.revision)
        {
            return Err(super::chain::refuse("project_source_changed"));
        }
        sources.push(crate::ports::material_productions::ProductionSource {
            material_id: id,
            expected_revision: m.revision,
        });
    }
    let production = library::request_production_in(
        r.as_mut(),
        d,
        ctx,
        library::MaterialProductionRequestInput {
            request_key: format!("project:{}", hash_token(&i.request_key)),
            kind: i.kind,
            instructions: i.instructions,
            sources,
        },
    )
    .await?;
    p.production_ids.push(production.id);
    let p = save(r.as_mut(), ctx, p, "studio.project.production_requested").await?;
    receipt(
        r.as_mut(),
        "studio.project_production",
        &i.request_key,
        &hash,
        production.id,
    )
    .await?;
    r.commit().await?;
    Ok(ProjectProductionOut {
        project: p,
        production,
    })
}
pub async fn project_publication(
    d: &Deps,
    ctx: &Ctx,
    i: ProjectPublicationInput,
) -> Result<ProductionProject, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.project_publication",
    ))?;
    let mut r = library::open(d, ctx, jt_tenancy::Permission::SocialWork).await?;
    r.studio_control().lock_control().await?;
    let mut p = load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    let slot = r
        .studio()
        .get_slot(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    let post = r
        .studio_posts()
        .get_post(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("planned post"))?;
    let available = available_material_ids(r.as_mut(), &p).await?;
    if post.material_ids.is_empty() || post.material_ids.iter().any(|id| !available.contains(id)) {
        return Err(invalid(
            "slot_id",
            "publication materials are not in project",
        ));
    }
    for id in &post.material_ids {
        material(r.as_mut(), *id).await?;
    }
    if p.outputs
        .iter()
        .any(|o| o.id != i.output_id && o.slot_id == Some(i.slot_id))
    {
        return Err(AppError::conflict(
            "publication already linked to another output",
        ));
    }
    let out = p
        .outputs
        .iter_mut()
        .find(|o| o.id == i.output_id)
        .ok_or_else(|| AppError::not_found("output"))?;
    if out.slot_id.is_some() && out.slot_id != Some(i.slot_id) {
        return Err(AppError::conflict("output already linked"));
    }
    if out.format != post.format
        || out.capability_id.is_some_and(|v| v != slot.capability_id)
        || out.target_at.is_some_and(|v| v != slot.scheduled_at)
    {
        return Err(AppError::conflict(
            "planned publication does not match output",
        ));
    }
    out.slot_id = Some(i.slot_id);
    out.capability_id = Some(slot.capability_id);
    out.target_at = Some(slot.scheduled_at);
    let p = save(r.as_mut(), ctx, p, "studio.project.publication_linked").await?;
    r.commit().await?;
    Ok(p)
}

/// Strict MCP schemas mirror HTTP DTOs; target dates never imply scheduling.
pub fn schema(name: &str) -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    let string = json!({"type":"string"});
    let rev = json!({"type":"integer","minimum":1});
    let ids = json!({"type":"array","items":uuid,"maxItems":100,"uniqueItems":true});
    let output = json!({"type":"object","additionalProperties":false,"properties":{"id":uuid,"title":{"type":"string","minLength":1,"maxLength":160},"format":{"type":"string","enum":["story","feed_post","carousel","reel","tiktok_video"]},"target_at":{"type":["string","null"],"format":"date-time"},"capability_id":{"type":["string","null"],"format":"uuid"}},"required":["title","format"]});
    let (properties, required) = match name {
        "list" => (
            json!({"archived":{"type":"boolean"},"before":uuid,"scope":{"enum":["open","done"]},"done_before":string}),
            vec![],
        ),
        "get" => (json!({"project_id":uuid}), vec!["project_id"]),
        "create" => (
            json!({"request_key":string,"title":{"type":"string","minLength":1,"maxLength":160},"brief":{"type":"string","minLength":1,"maxLength":2000},"material_ids":ids,"start_at":{"type":["string","null"],"format":"date-time"},"formats":{"type":"array","items":{"enum":["story","feed_post","carousel","reel","tiktok_video"]},"maxItems":5,"uniqueItems":true},"capability_ids":ids}),
            vec!["request_key", "brief"],
        ),
        "update" => (
            json!({"project_id":uuid,"expected_revision":rev,"title":{"type":"string","minLength":1,"maxLength":160},"brief":{"type":"string","minLength":1,"maxLength":2000},"archived":{"type":"boolean"},"outputs":{"type":"array","items":output,"maxItems":20}}),
            vec!["project_id", "expected_revision"],
        ),
        "materials" => (
            json!({"project_id":uuid,"expected_revision":rev,"add":ids,"remove":ids}),
            vec!["project_id", "expected_revision"],
        ),
        "request" => (
            json!({"project_id":uuid,"expected_revision":rev,"request_key":string,"text":{"type":"string","minLength":1,"maxLength":2000}}),
            vec!["project_id", "expected_revision", "request_key", "text"],
        ),
        "request_update" => (
            json!({"project_id":uuid,"request_id":uuid,"expected_revision":rev,"status":{"type":"string","enum":["open","done","dismissed"]},"material_ids":ids}),
            vec!["project_id", "request_id", "expected_revision", "status"],
        ),
        "publication" => (
            json!({"project_id":uuid,"expected_revision":rev,"output_id":uuid,"slot_id":uuid}),
            vec!["project_id", "expected_revision", "output_id", "slot_id"],
        ),
        _ => panic!("unknown production project schema"),
    };
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}

/// `at` without what the database does not keep: the stored column holds microseconds, and an
/// area's start and delivery times are mirrored into columns that must equal the document's.
pub(crate) fn whole_micros(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_nanosecond(at.nanosecond() / 1_000 * 1_000)
        .unwrap_or(at)
}
/// An area's title when the person gave none: the goal itself when it is short, else its first
/// words (up to 60 characters, cut at a word) with an ellipsis.
pub(crate) fn goal_title(goal: &str) -> String {
    const MAX: usize = 60;
    if goal.chars().count() <= MAX {
        return goal.to_owned();
    }
    let prefix: String = goal.chars().take(MAX).collect();
    let cut = prefix
        .rsplit_once(char::is_whitespace)
        .map_or(prefix.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches(|c: char| !c.is_alphanumeric()))
}
pub(crate) async fn validate_account(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: CapabilityId,
    format: Option<PostFormat>,
) -> Result<(), AppError> {
    let c = r
        .capabilities()
        .find(id)
        .await?
        .ok_or_else(|| invalid("capability_ids", "unknown account"))?;
    if !super::chain::ORGANIC_KINDS.contains(&c.kind_key.as_str())
        || !super::posts::postable(d, &c, ctx.now)
    {
        return Err(invalid(
            "capability_ids",
            "account is not a live social account",
        ));
    }
    if format.is_some_and(|f| !jt_studio::supported_formats(&c.kind_key).contains(&f)) {
        return Err(invalid("format", "format_unsupported"));
    }
    Ok(())
}
