//! Durable analysis claimed by an external agent. No model invocation, inferred event creation,
//! permission grant, or agent wake-up happens in these use cases.
use super::{
    MaterialIdInput, conflict, invalid, is_agent, nullable, open, person, person_required,
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{TenantRepos, materials::*},
    usecases::{Deps, hash_token, ledger_entry},
};
use jt_ledger::Actor;
use jt_tenancy::AgentConnectionId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use time::{Duration, OffsetDateTime};

const LEASE_MINUTES: i64 = 10;

#[derive(Clone, Debug, Serialize)]
pub struct MaterialIntelligenceOut {
    pub material: Material,
    pub intelligence: MaterialIntelligence,
}
#[derive(Clone, Debug, Serialize)]
pub struct MaterialPreview {
    pub url: String,
    #[serde(with = "jt_studio::time_compat")]
    pub expires_at: OffsetDateTime,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialAnalysisClaimInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct MaterialAnalysisClaimOut {
    pub material: Material,
    pub intelligence: MaterialIntelligence,
    pub claim_token: String,
    pub expected_revision: u64,
    #[serde(with = "jt_studio::time_compat")]
    pub lease_expires_at: OffsetDateTime,
    pub preview: MaterialPreview,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialAnalysisCompleteInput {
    pub material_id: MaterialId,
    pub claim_token: String,
    pub expected_revision: u64,
    #[serde(default)]
    pub title: Option<String>,
    pub description: String,
    pub labels: Vec<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub captured_at: Option<OffsetDateTime>,
    pub date_source: DateSource,
    #[serde(default)]
    pub quality: Option<Quality>,
    #[serde(default)]
    pub depicts: Option<BTreeSet<Depicts>>,
    /// Where an unfiled material goes (design 2026-11-18 §3); absent: it stays unfiled and a
    /// person files it.
    #[serde(default)]
    pub filing: Option<MaterialFiling>,
}

/// The agent's filing decision for an unfiled material: exactly one of an existing olay, a new
/// olay, or genel.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialFiling {
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    #[serde(default)]
    pub new_olay: Option<NewOlay>,
    #[serde(default)]
    pub genel: bool,
}

/// The olay a filing opens: what the agent can tell from the files. It names no client: linking
/// a person is a person's decision.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewOlay {
    pub kind: OlayKind,
    pub title: String,
    #[serde(with = "jt_studio::time_compat::date")]
    pub starts_on: time::Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub ends_on: time::Date,
    #[serde(default)]
    pub place: Option<String>,
    #[serde(default)]
    pub occasion: Option<String>,
    #[serde(default)]
    pub notes: String,
}

/// `studio.material_analysis_complete`'s answer: the material, its analysis, and the olay the
/// filing named (the new one, or the existing one), if any.
#[derive(Clone, Debug, Serialize)]
pub struct MaterialAnalysisCompleteOut {
    pub material: Material,
    pub intelligence: MaterialIntelligence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub olay: Option<Olay>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialAnalysisFailInput {
    pub material_id: MaterialId,
    pub claim_token: String,
    pub expected_revision: u64,
    /// A bounded machine code, never model output, customer text or a provider error body.
    pub error_code: String,
}

fn agent(ctx: &Ctx) -> Result<AgentConnectionId, AppError> {
    if is_agent(ctx) {
        if let Some(id) = ctx.agent_connection_id {
            return Ok(id);
        }
        if let Actor::Agent { connection_id, .. } = ctx.actor {
            return Ok(connection_id);
        }
    }
    Err(AppError::forbidden(
        "material analysis requires an agent connection",
    ))
}

fn bounded(value: &str, max: usize, empty: bool, field: &str) -> Result<String, AppError> {
    let text = value.trim();
    if (!empty && text.is_empty())
        || text.chars().count() > max
        || text
            .chars()
            .any(|c| c.is_control() && !(field == "description" && matches!(c, '\n' | '\t')))
    {
        return Err(AppError::validation(
            "invalid analysis field",
            json!({"field":field}),
        ));
    }
    Ok(text.to_owned())
}

async fn live(
    r: &mut dyn TenantRepos,
    id: MaterialId,
    revision: Option<u64>,
) -> Result<Material, AppError> {
    let material = r
        .studio_materials()
        .get_material(id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))?;
    if material.erased_at.is_some() {
        return Err(conflict("material_erased"));
    }
    if revision.is_some_and(|revision| revision != material.revision) {
        return Err(conflict("material_revision_changed"));
    }
    Ok(material)
}
/// Older materials have no provenance record. Preserve populated fields as existing intent,
/// without falsely labelling an unknown historical capture source as manual or EXIF.
fn legacy_record(material: &Material, now: OffsetDateTime) -> MaterialAnalysisRecord {
    let mut row = MaterialAnalysisRecord::pending(material.id, now, DateSource::Unknown);
    for (field, populated) in [
        ("title", !material.title.trim().is_empty()),
        ("labels", !material.tags.labels.is_empty()),
        ("quality", material.tags.quality.is_some()),
        ("captured_at", material.captured_at.is_some()),
    ] {
        if populated {
            row.intelligence.manual_fields.insert(field.into());
        }
    }
    row
}

/// The public analysis of `material`: its record's, or what a material from before the analysis
/// records reads as (pending, its filled fields kept as a person's).
pub(crate) fn intelligence_of(
    material: &Material,
    row: Option<&MaterialAnalysisRecord>,
    now: OffsetDateTime,
) -> MaterialIntelligence {
    row.map(|r| r.intelligence.clone())
        .unwrap_or_else(|| legacy_record(material, now).intelligence)
}

pub(super) async fn record(
    r: &mut dyn TenantRepos,
    material: &Material,
    now: OffsetDateTime,
) -> Result<MaterialAnalysisRecord, AppError> {
    Ok(r.studio_materials()
        .get_intelligence(material.id)
        .await?
        .unwrap_or_else(|| legacy_record(material, now)))
}

/// Called by material_add in its transaction after insert, under the Studio control lock.
/// Request replay must not call this again or reset an already completed analysis.
pub async fn enqueue_material_analysis(
    r: &mut dyn TenantRepos,
    material: &Material,
    now: OffsetDateTime,
    date_source: DateSource,
) -> Result<(), AppError> {
    if r.studio_materials()
        .get_intelligence(material.id)
        .await?
        .is_none()
    {
        let mut row = MaterialAnalysisRecord::pending(material.id, now, date_source);
        if date_source == DateSource::Manual {
            row.intelligence.manual_fields.insert("captured_at".into());
        }
        r.studio_materials().save_intelligence(row).await?;
    }
    Ok(())
}

pub async fn material_intelligence_get(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialIdInput,
) -> Result<MaterialIntelligenceOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_intelligence_get",
    ))?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    let material = live(r.as_mut(), i.material_id, None).await?;
    let row = record(r.as_mut(), &material, ctx.now).await?;
    Ok(MaterialIntelligenceOut {
        material,
        intelligence: row.intelligence,
    })
}

async fn preview(d: &Deps, ctx: &Ctx, material: &Material) -> Result<MaterialPreview, AppError> {
    let expires_at = ctx.now + Duration::minutes(LEASE_MINUTES);
    let url = d
        .files
        .device_url(ctx.workspace_id, material.file_id, expires_at)
        .await?;
    Ok(MaterialPreview {
        url: url.to_string(),
        expires_at,
    })
}
async fn check_file(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    material: &Material,
) -> Result<(), AppError> {
    r.studio()
        .get_file(material.file_id)
        .await?
        .filter(|f| f.workspace_id == ctx.workspace_id && f.deleted_at.is_none())
        .ok_or_else(|| AppError::not_found("file"))?;
    Ok(())
}
pub async fn material_preview(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialIdInput,
) -> Result<MaterialPreview, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_preview",
    ))?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    let material = live(r.as_mut(), i.material_id, None).await?;
    check_file(r.as_mut(), ctx, &material).await?;
    drop(r);
    preview(d, ctx, &material).await
}

pub async fn material_analysis_claim(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialAnalysisClaimInput,
) -> Result<MaterialAnalysisClaimOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_analysis_claim",
    ))?;
    let owner = agent(ctx)?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    let material = live(r.as_mut(), i.material_id, Some(i.expected_revision)).await?;
    let mut row = record(r.as_mut(), &material, ctx.now).await?;
    if !row.claimable(ctx.now) {
        return Err(conflict("analysis_not_pending"));
    }
    check_file(r.as_mut(), ctx, &material).await?;
    let preview = preview(d, ctx, &material).await?;
    let token = d.tokens.token(32);
    let expires_at = ctx.now + Duration::minutes(LEASE_MINUTES);
    row.lease = Some(MaterialAnalysisLease {
        token_hash: hash_token(&token),
        owner,
        material_revision: material.revision,
        expires_at,
    });
    row.intelligence.status = AnalysisStatus::Running;
    row.intelligence.attempts = row.intelligence.attempts.saturating_add(1);
    row.intelligence.updated_at = ctx.now;
    row.intelligence.last_error_code = None;
    r.studio_materials().save_intelligence(row.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.analysis_claimed",
            "studio_material",
            material.id,
            json!({"revision":material.revision,"attempt":row.intelligence.attempts}),
        )?)
        .await?;
    r.commit().await?;
    Ok(MaterialAnalysisClaimOut {
        expected_revision: material.revision,
        material,
        intelligence: row.intelligence,
        claim_token: token,
        lease_expires_at: expires_at,
        preview,
    })
}

fn owns(
    row: &MaterialAnalysisRecord,
    ctx: &Ctx,
    token: &str,
    revision: u64,
) -> Result<(), AppError> {
    let owner = agent(ctx)?;
    let lease = row
        .lease
        .as_ref()
        .ok_or_else(|| conflict("analysis_claim_invalid"))?;
    if row.intelligence.status != AnalysisStatus::Running
        || lease.owner != owner
        || token.len() > 200
        || lease.token_hash != hash_token(token)
        || lease.material_revision != revision
    {
        return Err(conflict("analysis_claim_invalid"));
    }
    if lease.expires_at <= ctx.now {
        return Err(conflict("analysis_claim_expired"));
    }
    Ok(())
}

/// Where a filing puts the material, before anything is read: one of the three, or `VALIDATION`.
enum Filing {
    Olay(OlayId),
    New(NewOlay),
    Genel,
}

fn filing(f: MaterialFiling) -> Result<Filing, AppError> {
    match (f.olay_id, f.new_olay, f.genel) {
        (Some(id), None, false) => Ok(Filing::Olay(id)),
        (None, Some(o), false) => Ok(Filing::New(o)),
        (None, None, true) => Ok(Filing::Genel),
        _ => Err(AppError::validation(
            "a filing names exactly one of olay_id, new_olay or genel",
            json!({"field":"filing","reason":"one_filing"}),
        )),
    }
}

/// Files the unfiled `material` as `f` says, in the caller's transaction (design 2026-11-18 §3).
/// A new olay is confirmed by the owner's rule when the material is a real one a person uploaded
/// ([`Material::upload_confirms_olay`]): its confirmation names that person, and the ledger says
/// it was the rule, from that upload, not a click. Otherwise it is proposed, as an agent's olay
/// always is. Filing into an existing olay never confirms it; a real material goes genel only by
/// a person, who frees it (spec 2026-11-03 D8).
async fn file(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    material: &mut Material,
    f: Filing,
) -> Result<Option<Olay>, AppError> {
    if !material.is_unfiled() {
        return Err(conflict("material_already_filed"));
    }
    let (binding, olay) = match f {
        Filing::Olay(id) => {
            let o = r
                .studio_materials()
                .get_olay(id)
                .await?
                .ok_or_else(|| AppError::not_found("olay"))?;
            (Binding::Olay { olay_id: id }, Some(o))
        }
        Filing::Genel if material.is_ai() => (Binding::Genel, None),
        Filing::Genel => return Err(person_required("filing")),
        Filing::New(n) => {
            let by = material.upload_confirms_olay();
            let o = Olay {
                id: OlayId(d.ids.uuid()),
                workspace_id: ctx.workspace_id,
                kind: n.kind,
                title: n.title,
                starts_on: n.starts_on,
                ends_on: n.ends_on,
                place: n.place,
                client: None,
                notes: n.notes,
                occasion: n.occasion,
                status: if by.is_some() {
                    OlayStatus::Confirmed
                } else {
                    OlayStatus::Proposed
                },
                confirmed: by.map(|by| HumanMark { by, at: ctx.now }),
                revision: 1,
                created_at: ctx.now,
            };
            o.validate().map_err(invalid)?;
            r.studio_materials().insert_olay(o.clone()).await?;
            let mut payload = super::olays::summary(&o);
            payload["opened_by"] = json!("material_filing");
            payload["material_id"] = json!(material.id);
            // Truthfully: confirmed by the rule, because this person uploaded the files.
            payload["confirmed_by_rule"] = match by {
                Some(user) => json!({"rule":"person_upload","uploaded_by":user}),
                None => serde_json::Value::Null,
            };
            r.ledger()
                .append(ledger_entry(
                    ctx,
                    "studio.olay.created",
                    "studio_olay",
                    o.id,
                    payload,
                )?)
                .await?;
            (Binding::Olay { olay_id: o.id }, Some(o))
        }
    };
    material.binding = binding;
    Ok(olay)
}

pub async fn material_analysis_complete(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialAnalysisCompleteInput,
) -> Result<MaterialAnalysisCompleteOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_analysis_complete",
    ))?;
    agent(ctx)?;
    let description = bounded(&i.description, 4000, false, "description")?;
    let title = i
        .title
        .as_deref()
        .map(|v| bounded(v, 120, true, "title"))
        .transpose()?;
    let group_name = i
        .group_name
        .as_deref()
        .map(|v| bounded(v, 120, false, "group_name"))
        .transpose()?;
    let labels = jt_studio::normalize_material_labels(&i.labels).map_err(invalid)?;
    let filing_decision = i.filing.clone().map(filing).transpose()?;
    if i.date_source == DateSource::Manual
        || (i.captured_at.is_some() && i.date_source == DateSource::Unknown)
        || i.captured_at
            .is_some_and(|at| !(1970..=2100).contains(&at.year()))
    {
        return Err(AppError::validation(
            "invalid analysis date source",
            json!({"field":"date_source"}),
        ));
    }
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    let mut material = live(r.as_mut(), i.material_id, Some(i.expected_revision)).await?;
    let mut row = record(r.as_mut(), &material, ctx.now).await?;
    owns(&row, ctx, &i.claim_token, i.expected_revision)?;
    let locked = row.intelligence.manual_fields.clone();
    if !locked.contains("title")
        && let Some(title) = title
    {
        material.title = title;
    }
    if !locked.contains("labels") {
        material.tags.labels = labels;
    }
    if !locked.contains("quality")
        && let Some(quality) = i.quality
    {
        material.tags.quality = Some(quality);
    }
    let mut share_cleared = false;
    if let Some(depicts) = i.depicts {
        // An agent may add privacy findings, never erase a person's corrections/markers.
        if !depicts.is_subset(&material.tags.depicts) {
            share_cleared = material.share.is_some();
            material.share = None;
        }
        material.tags.depicts.extend(depicts);
    }
    // Existing authoritative capture dates are never replaced by a model inference.
    if let Some(at) = i.captured_at.filter(|_| !locked.contains("captured_at")) {
        if matches!(
            row.intelligence.date_source,
            DateSource::Exif | DateSource::Manual
        ) && material.captured_at != Some(at)
        {
            return Err(conflict("analysis_date_authoritative"));
        }
        material.captured_at = Some(at);
        if !matches!(
            row.intelligence.date_source,
            DateSource::Exif | DateSource::Manual
        ) {
            row.intelligence.date_source = i.date_source;
        }
    }
    material.tags_reviewed_by = None;
    let filed = match filing_decision {
        Some(f) => Some(file(d, r.as_mut(), ctx, &mut material, f).await?),
        None => None,
    };
    material.revision = material
        .revision
        .checked_add(1)
        .ok_or_else(|| conflict("revision_overflow"))?;
    material.validate().map_err(invalid)?;
    row.intelligence.status = AnalysisStatus::Completed;
    if !locked.contains("description") {
        row.intelligence.description = description;
    }
    if !locked.contains("group_name") {
        row.intelligence.group_name = group_name;
    }
    row.intelligence.analyzed_at = Some(ctx.now);
    row.intelligence.analyzed_revision = Some(material.revision);
    row.intelligence.updated_at = ctx.now;
    row.intelligence.last_error_code = None;
    row.lease = None;
    r.studio_materials()
        .update_material(material.clone(), i.expected_revision)
        .await?;
    r.studio_materials().save_intelligence(row.clone()).await?;
    if share_cleared {
        super::invalidate_material_productions(r.as_mut(), material.id, ctx.now, false).await?;
    }
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.analyzed",
            "studio_material",
            material.id,
            json!({"revision":material.revision,"labels_count":material.tags.labels.len()}),
        )?)
        .await?;
    if filed.is_some() {
        r.ledger()
            .append(ledger_entry(
                ctx,
                "studio.material.filed",
                "studio_material",
                material.id,
                json!({"revision":material.revision,
                       "binding": if material.olay_id().is_some() { "olay" } else { "genel" },
                       "olay_id": material.olay_id(),
                       "by":"analysis"}),
            )?)
            .await?;
    }
    r.commit().await?;
    Ok(MaterialAnalysisCompleteOut {
        material,
        intelligence: row.intelligence,
        olay: filed.flatten(),
    })
}

pub async fn material_analysis_fail(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialAnalysisFailInput,
) -> Result<MaterialIntelligenceOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_analysis_fail",
    ))?;
    agent(ctx)?;
    if i.error_code.is_empty()
        || i.error_code.len() > 64
        || !i
            .error_code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(AppError::validation(
            "invalid failure code",
            json!({"field":"error_code"}),
        ));
    }
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    let material = live(r.as_mut(), i.material_id, Some(i.expected_revision)).await?;
    let mut row = record(r.as_mut(), &material, ctx.now).await?;
    owns(&row, ctx, &i.claim_token, i.expected_revision)?;
    row.intelligence.status = AnalysisStatus::Failed;
    row.intelligence.last_error_code = Some(i.error_code.clone());
    row.intelligence.updated_at = ctx.now;
    row.lease = None;
    r.studio_materials().save_intelligence(row.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.analysis_failed",
            "studio_material",
            material.id,
            json!({"code":i.error_code}),
        )?)
        .await?;
    r.commit().await?;
    Ok(MaterialIntelligenceOut {
        material,
        intelligence: row.intelligence,
    })
}

pub async fn material_analysis_retry(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialAnalysisClaimInput,
) -> Result<MaterialIntelligenceOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_analysis_retry",
    ))?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    let material = live(r.as_mut(), i.material_id, Some(i.expected_revision)).await?;
    let mut row = record(r.as_mut(), &material, ctx.now).await?;
    if row
        .lease
        .as_ref()
        .is_some_and(|lease| lease.expires_at > ctx.now)
    {
        return Err(conflict("analysis_in_progress"));
    }
    row.intelligence.status = AnalysisStatus::Pending;
    row.intelligence.last_error_code = None;
    row.intelligence.updated_at = ctx.now;
    row.lease = None;
    r.studio_materials().save_intelligence(row.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.analysis_requested",
            "studio_material",
            material.id,
            json!({"revision":material.revision}),
        )?)
        .await?;
    r.commit().await?;
    Ok(MaterialIntelligenceOut {
        material,
        intelligence: row.intelligence,
    })
}

/// Mark explicit human corrections in the caller's existing material-write transaction.
/// The revision change revokes an in-flight claim and makes it claimable again immediately.
pub async fn mark_material_intelligence_manual(
    r: &mut dyn TenantRepos,
    material: &Material,
    fields: &[&str],
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut row = record(r, material, now).await?;
    for field in fields {
        if ![
            "title",
            "description",
            "group_name",
            "captured_at",
            "labels",
            "quality",
        ]
        .contains(field)
        {
            return Err(AppError::internal("unknown manual intelligence field"));
        }
        row.intelligence.manual_fields.insert((*field).into());
        if *field == "captured_at" {
            row.intelligence.date_source = DateSource::Manual;
        }
    }
    if row.intelligence.status == AnalysisStatus::Running {
        row.intelligence.status = AnalysisStatus::Pending;
        row.lease = None;
    }
    row.intelligence.updated_at = now;
    r.studio_materials().save_intelligence(row).await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialIntelligenceUpdateInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub group_name: Option<Option<String>>,
}

pub async fn material_intelligence_update(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialIntelligenceUpdateInput,
) -> Result<MaterialIntelligenceOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_intelligence_update",
    ))?;
    if person(ctx).is_none() {
        return Err(super::person_required("intelligence"));
    }
    if i.description.is_none() && i.group_name.is_none() {
        return Err(AppError::validation(
            "no fields supplied",
            json!({"field":"input"}),
        ));
    }
    let description = i
        .description
        .as_deref()
        .map(|v| bounded(v, 4000, true, "description"))
        .transpose()?;
    let group_name = i
        .group_name
        .map(|group| {
            group
                .as_deref()
                .map(|v| bounded(v, 120, false, "group_name"))
                .transpose()
        })
        .transpose()?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    let mut material = live(r.as_mut(), i.material_id, Some(i.expected_revision)).await?;
    let mut row = record(r.as_mut(), &material, ctx.now).await?;
    let mut fields = Vec::new();
    if let Some(value) = description {
        row.intelligence.description = value;
        fields.push("description");
    }
    if let Some(value) = group_name {
        row.intelligence.group_name = value;
        fields.push("group_name");
    }
    material.revision = material
        .revision
        .checked_add(1)
        .ok_or_else(|| conflict("revision_overflow"))?;
    r.studio_materials()
        .update_material(material.clone(), i.expected_revision)
        .await?;
    r.studio_materials().save_intelligence(row).await?;
    mark_material_intelligence_manual(r.as_mut(), &material, &fields, ctx.now).await?;
    let row = record(r.as_mut(), &material, ctx.now).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.intelligence_updated",
            "studio_material",
            material.id,
            json!({"revision":material.revision,"fields":fields}),
        )?)
        .await?;
    r.commit().await?;
    Ok(MaterialIntelligenceOut {
        material,
        intelligence: row.intelligence,
    })
}

/// Batch read for library grouping, without one network request per material.
pub async fn material_intelligence_list(
    d: &Deps,
    ctx: &Ctx,
) -> Result<Vec<MaterialIntelligenceOut>, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_intelligence_list",
    ))?;
    let mut r = open(d, ctx, jt_tenancy::Permission::MaterialsWork).await?;
    let materials = r.studio_materials().list_materials().await?;
    let rows = r.studio_materials().list_intelligence().await?;
    Ok(materials
        .into_iter()
        .filter(|m| m.erased_at.is_none())
        .map(|material| {
            let intelligence = rows
                .iter()
                .find(|row| row.material_id == material.id)
                .map(|row| row.intelligence.clone())
                .unwrap_or_else(|| legacy_record(&material, ctx.now).intelligence);
            MaterialIntelligenceOut {
                material,
                intelligence,
            }
        })
        .collect())
}
