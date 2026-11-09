//! External-agent derivative requests. Original bytes remain untouched; completion records lineage
//! and preserves people/privacy obligations. Producing a file is not permission to publish it.
use super::{conflict, decider, invalid, is_agent, open, person_required};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        material_productions::*,
        materials::{Material, MaterialId, Origin, SharePermission},
    },
    usecases::{
        Deps, hash_token, ledger_entry,
        studio::files::{decode, encode, key},
    },
};
use jt_ledger::Actor;
use jt_tenancy::AgentConnectionId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialProductionRequestInput {
    pub request_key: String,
    pub kind: ProductionKind,
    pub instructions: String,
    pub sources: Vec<ProductionSource>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialProductionQuery {
    #[serde(default)]
    pub source_material_id: Option<MaterialId>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialProductionClaimInput {
    pub production_id: Uuid,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct MaterialProductionClaimOut {
    pub production: MaterialProduction,
    pub claim_token: String,
    #[serde(with = "jt_studio::time_compat")]
    pub lease_expires_at: OffsetDateTime,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialProductionCompleteInput {
    pub production_id: Uuid,
    pub expected_revision: u64,
    pub claim_token: String,
    pub output_material_id: MaterialId,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialProductionFailInput {
    pub production_id: Uuid,
    pub expected_revision: u64,
    pub claim_token: String,
    pub error_code: String,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    production_id: Uuid,
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
        "material production requires an agent connection",
    ))
}
async fn live(r: &mut dyn TenantRepos, id: MaterialId) -> Result<Material, AppError> {
    let m = r
        .studio_materials()
        .get_material(id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))?;
    if m.erased_at.is_some() {
        return Err(conflict("material_erased"));
    }
    Ok(m)
}
async fn load(
    r: &mut dyn TenantRepos,
    id: Uuid,
    revision: Option<u64>,
) -> Result<ProductionRecord, AppError> {
    let row = r
        .studio_productions()
        .get_production(id)
        .await?
        .ok_or_else(|| AppError::not_found("material production"))?;
    if revision.is_some_and(|v| v != row.production.revision) {
        return Err(conflict("production_revision_changed"));
    }
    Ok(row)
}
async fn sources(
    r: &mut dyn TenantRepos,
    p: &MaterialProduction,
) -> Result<Vec<Material>, AppError> {
    let mut out = Vec::new();
    for s in &p.sources {
        let m = live(r, s.material_id).await?;
        if m.revision != s.expected_revision {
            return Err(conflict("source_revision_changed"));
        }
        out.push(m);
    }
    Ok(out)
}
fn owns(row: &ProductionRecord, ctx: &Ctx, token: &str) -> Result<(), AppError> {
    let owner = agent(ctx)?;
    let lease = row
        .lease
        .as_ref()
        .ok_or_else(|| conflict("production_claim_invalid"))?;
    if row.production.status != ProductionStatus::Running
        || token.len() > 200
        || lease.owner != owner
        || lease.token_hash != hash_token(token)
    {
        return Err(conflict("production_claim_invalid"));
    }
    if lease.expires_at <= ctx.now {
        return Err(conflict("production_claim_expired"));
    }
    Ok(())
}
async fn save(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    mut row: ProductionRecord,
    action: &str,
) -> Result<MaterialProduction, AppError> {
    let previous = row.production.revision;
    row.production.revision += 1;
    row.production.updated_at = ctx.now;
    r.studio_productions()
        .save_production(row.clone(), Some(previous))
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            action,
            "studio_material_production",
            row.production.id,
            json!({"revision":row.production.revision,"status":row.production.status}),
        )?)
        .await?;
    Ok(row.production)
}

pub async fn material_production_list(
    d: &Deps,
    ctx: &Ctx,
    q: MaterialProductionQuery,
) -> Result<Vec<MaterialProduction>, AppError> {
    let mut r = open(d, ctx).await?;
    Ok(r.studio_productions()
        .list_productions()
        .await?
        .into_iter()
        .map(|r| r.production)
        .filter(|p| {
            q.source_material_id
                .is_none_or(|id| p.sources.iter().any(|s| s.material_id == id))
        })
        .collect())
}
pub async fn material_production_request(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialProductionRequestInput,
) -> Result<MaterialProduction, AppError> {
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let production = request_production_in(r.as_mut(), d, ctx, i).await?;
    r.commit().await?;
    Ok(production)
}
pub(crate) async fn request_production_in(
    r: &mut dyn TenantRepos,
    d: &Deps,
    ctx: &Ctx,
    i: MaterialProductionRequestInput,
) -> Result<MaterialProduction, AppError> {
    decider(ctx).ok_or_else(|| person_required("material_production"))?;
    key(&i.request_key)?;
    if i.instructions.trim().is_empty()
        || i.instructions.chars().count() > 2000
        || i.instructions
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::validation(
            "instructions must contain 1–2000 characters",
            json!({"field":"instructions"}),
        ));
    }
    if i.sources.is_empty()
        || i.sources.len() > 5
        || i.sources
            .iter()
            .map(|s| s.material_id)
            .collect::<BTreeSet<_>>()
            .len()
            != i.sources.len()
    {
        return Err(AppError::validation(
            "choose 1–5 distinct source materials",
            json!({"field":"sources"}),
        ));
    }
    let payload = json!(hash_token(&encode(&i)?.to_string()));
    if let Some(v) = r
        .studio()
        .request_replay(
            "studio.material_production_request",
            &i.request_key,
            &payload,
        )
        .await?
    {
        let receipt: Receipt = decode(v)?;
        return Ok(load(r, receipt.production_id, None).await?.production);
    }
    let production = MaterialProduction {
        id: d.ids.uuid(),
        workspace_id: ctx.workspace_id,
        kind: i.kind,
        instructions: i.instructions.trim().to_owned(),
        sources: i.sources,
        status: ProductionStatus::Pending,
        output_material_id: None,
        last_error_code: None,
        revision: 1,
        created_at: ctx.now,
        updated_at: ctx.now,
    };
    sources(r, &production).await?;
    r.studio_productions()
        .save_production(
            ProductionRecord {
                production: production.clone(),
                lease: None,
            },
            None,
        )
        .await?;
    r.studio()
        .request_receipt(
            "studio.material_production_request",
            &i.request_key,
            &payload,
            &encode(&Receipt {
                production_id: production.id,
            })?,
        )
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.production_requested",
            "studio_material_production",
            production.id,
            json!({"kind":production.kind,"source_count":production.sources.len()}),
        )?)
        .await?;
    Ok(production)
}
pub async fn material_production_claim(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialProductionClaimInput,
) -> Result<MaterialProductionClaimOut, AppError> {
    let owner = agent(ctx)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut row = load(r.as_mut(), i.production_id, Some(i.expected_revision)).await?;
    if !row.claimable(ctx.now) {
        return Err(conflict("production_not_pending"));
    }
    if let Err(error) = sources(r.as_mut(), &row.production).await {
        if !matches!(
            error.code,
            crate::error::ErrorCode::Conflict | crate::error::ErrorCode::NotFound
        ) {
            return Err(error);
        }
        row.production.status = ProductionStatus::Failed;
        row.production.last_error_code = Some("source_changed".into());
        row.lease = None;
        save(r.as_mut(), ctx, row, "studio.material.production_failed").await?;
        r.commit().await?;
        return Err(error);
    }
    let claim_token = d.tokens.token(32);
    let lease_expires_at = ctx.now + Duration::minutes(30);
    row.lease = Some(ProductionLease {
        owner,
        token_hash: hash_token(&claim_token),
        expires_at: lease_expires_at,
    });
    row.production.status = ProductionStatus::Running;
    row.production.last_error_code = None;
    let production = save(r.as_mut(), ctx, row, "studio.material.production_claimed").await?;
    r.commit().await?;
    Ok(MaterialProductionClaimOut {
        production,
        claim_token,
        lease_expires_at,
    })
}
pub async fn material_production_complete(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialProductionCompleteInput,
) -> Result<MaterialProduction, AppError> {
    agent(ctx)?;
    let mut r = open(d, ctx).await?;
    r.people().lock_workspace().await?;
    r.studio_control().lock_control().await?;
    let mut row = load(r.as_mut(), i.production_id, Some(i.expected_revision)).await?;
    owns(&row, ctx, &i.claim_token)?;
    let source_materials = match sources(r.as_mut(), &row.production).await {
        Ok(materials) => materials,
        Err(error) => {
            if !matches!(
                error.code,
                crate::error::ErrorCode::Conflict | crate::error::ErrorCode::NotFound
            ) {
                return Err(error);
            }
            row.production.status = ProductionStatus::Failed;
            row.production.last_error_code = Some("source_changed".into());
            row.lease = None;
            save(r.as_mut(), ctx, row, "studio.material.production_failed").await?;
            r.commit().await?;
            return Err(error);
        }
    };
    let mut output = live(r.as_mut(), i.output_material_id).await?;
    if !matches!(output.origin, Origin::AiGenerated { .. })
        || source_materials
            .iter()
            .any(|s| s.id == output.id || s.file_id == output.file_id)
        || output.created_at < row.production.created_at
    {
        return Err(conflict("output_must_be_new_derivative"));
    }
    if r.studio_productions()
        .list_productions()
        .await?
        .iter()
        .any(|p| p.production.output_material_id == Some(output.id))
    {
        return Err(conflict("output_already_linked"));
    }
    let previous = output.revision;
    for source in &source_materials {
        output.people.extend(source.people.iter().copied());
        output
            .tags
            .depicts
            .extend(source.tags.depicts.iter().copied());
    }
    // An agent's generated file must not silently inherit approval or claim capture authenticity.
    output.share = None;
    output.tags_reviewed_by = None;
    output.captured_at = None;
    output.revision += 1;
    super::check_people(r.as_mut(), output.people.iter().copied()).await?;
    output.validate().map_err(invalid)?;
    r.studio_materials()
        .update_material(output, previous)
        .await?;
    // The generated artifact is a new visual, not an authentic camera capture. Requeue its
    // analysis against this revision and invalidate any claim made before provenance was linked.
    let mut analysis = r
        .studio_materials()
        .get_intelligence(i.output_material_id)
        .await?
        .unwrap_or_else(|| {
            crate::ports::materials::MaterialAnalysisRecord::pending(
                i.output_material_id,
                ctx.now,
                crate::ports::materials::DateSource::Unknown,
            )
        });
    analysis.lease = None;
    analysis.intelligence.status = crate::ports::materials::AnalysisStatus::Pending;
    analysis.intelligence.date_source = crate::ports::materials::DateSource::Unknown;
    analysis
        .intelligence
        .manual_fields
        .insert("captured_at".into());
    analysis.intelligence.analyzed_revision = None;
    analysis.intelligence.analyzed_at = None;
    analysis.intelligence.last_error_code = None;
    analysis.intelligence.updated_at = ctx.now;
    r.studio_materials().save_intelligence(analysis).await?;
    invalidate_material_productions(r.as_mut(), i.output_material_id, ctx.now, false).await?;
    row.production.output_material_id = Some(i.output_material_id);
    row.production.status = ProductionStatus::Completed;
    row.lease = None;
    let production = save(r.as_mut(), ctx, row, "studio.material.production_completed").await?;
    r.commit().await?;
    Ok(production)
}
pub async fn material_production_fail(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialProductionFailInput,
) -> Result<MaterialProduction, AppError> {
    agent(ctx)?;
    if i.error_code.is_empty()
        || i.error_code.len() > 64
        || !i
            .error_code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(AppError::validation(
            "invalid error code",
            json!({"field":"error_code"}),
        ));
    }
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut row = load(r.as_mut(), i.production_id, Some(i.expected_revision)).await?;
    owns(&row, ctx, &i.claim_token)?;
    row.production.status = ProductionStatus::Failed;
    row.production.last_error_code = Some(i.error_code);
    row.lease = None;
    let production = save(r.as_mut(), ctx, row, "studio.material.production_failed").await?;
    r.commit().await?;
    Ok(production)
}

/// Under the existing Studio control fence: revoke derived approvals recursively when source
/// consent changes. Erasure additionally clears all derivative request text, including history.
pub async fn invalidate_material_productions(
    r: &mut dyn TenantRepos,
    id: MaterialId,
    now: OffsetDateTime,
    erase: bool,
) -> Result<Vec<jt_studio::FileId>, AppError> {
    let mut queue = vec![id];
    let mut seen = BTreeSet::new();
    let mut seen_requests = BTreeSet::new();
    let mut files = Vec::new();
    while let Some(id) = queue.pop() {
        if !seen.insert(id) {
            continue;
        }
        let rows = r.studio_productions().list_productions().await?;
        for mut row in rows {
            let source_changed = row.production.sources.iter().any(|s| s.material_id == id);
            // The caller already applied the change to `id`. Its own production record only
            // needs redaction when erased; revocation must flow to descendants, never back to
            // the same output and silently replace the caller's permission/revision.
            if !(source_changed || erase && row.production.output_material_id == Some(id)) {
                continue;
            }
            if !seen_requests.insert(row.production.id) {
                continue;
            }
            let previous = row.production.revision;
            row.lease = None;
            if erase {
                row.production.instructions.clear();
            }
            if row.production.status != ProductionStatus::Completed {
                row.production.status = ProductionStatus::Cancelled;
                row.production.last_error_code = Some(
                    if erase {
                        "source_erased"
                    } else {
                        "source_changed"
                    }
                    .into(),
                );
            }
            row.production.revision += 1;
            row.production.updated_at = now;
            if let Some(output_id) = row
                .production
                .output_material_id
                .filter(|output| *output != id)
            {
                queue.push(output_id);
                if let Some(mut output) = r.studio_materials().get_material(output_id).await?
                    && output.erased_at.is_none()
                {
                    let revision = output.revision;
                    if erase {
                        output = output.redacted(now);
                        files.push(output.file_id);
                        r.studio_materials().delete_intelligence(output.id).await?;
                    } else {
                        output.share = None;
                        output.tags_reviewed_by = None;
                        output.revision += 1;
                    }
                    r.studio_materials()
                        .update_material(output, revision)
                        .await?;
                }
            }
            r.studio_productions()
                .save_production(row, Some(previous))
                .await?;
        }
    }
    Ok(files)
}

/// Publication-time provenance fence: even a reapproved derivative cannot bypass a source's
/// current share restriction or erasure. Returns material IDs whose derived lineage is blocked.
pub async fn blocked_derivatives(
    r: &mut dyn TenantRepos,
) -> Result<BTreeSet<MaterialId>, AppError> {
    let rows = r.studio_productions().list_productions().await?;
    let materials = r.studio_materials().list_materials().await?;
    let mut blocked = BTreeSet::new();
    loop {
        let before = blocked.len();
        for row in &rows {
            if let Some(output) = row.production.output_material_id
                && row.production.sources.iter().any(|s| {
                    blocked.contains(&s.material_id)
                        || materials
                            .iter()
                            .find(|m| m.id == s.material_id)
                            .is_none_or(|m| {
                                m.erased_at.is_some()
                                    || m.share
                                        .as_ref()
                                        .is_none_or(|p| p.permission != SharePermission::Shareable)
                            })
                })
            {
                blocked.insert(output);
            }
        }
        if blocked.len() == before {
            break;
        }
    }
    Ok(blocked)
}
