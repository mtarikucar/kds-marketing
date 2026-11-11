//! Checked delivery of an area's content package (design 2026-11-10 §5.4, §6.5): every platform
//! version passes the material gate and the truth check, or nothing is stored. Nobody approves a
//! package; a refusal goes back to the agent with what to fix, and the third in a row holds the
//! area for a person.
use super::areas::{self, AreaOut};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::production_projects::*,
    usecases::{
        Deps, hash_token,
        studio::{files, library, materials, projects, work},
    },
};
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::{Binding, MaterialId, PostFormat, Subject};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;

/// One platform version as the agent delivers it; the server gives it its id.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionInput {
    pub format: PostFormat,
    /// The account it is made for, when the agent chose one.
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
    pub text: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub link: Option<String>,
    /// The area's materials it shows, in display order.
    pub material_ids: Vec<MaterialId>,
    pub hypothesis_id: HypothesisId,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliverInput {
    pub project_id: Uuid,
    pub claim_token: String,
    pub request_key: String,
    pub summary: String,
    pub versions: Vec<VersionInput>,
}

fn invalid(field: &str, message: &str) -> AppError {
    AppError::validation(message, json!({"field":field}))
}

/// One version's shape, before anything is read. A malformed version is the caller's mistake
/// (`VALIDATION` naming `versions[n].field`) and does not count as a refused delivery.
fn shaped(index: usize, v: VersionInput) -> Result<VersionInput, AppError> {
    let field = |name: &str| format!("versions[{index}].{name}");
    // Line ends as a platform shows them, whatever the agent's tools wrote.
    let text = v.text.replace("\r\n", "\n");
    let text = projects::text(&text, &field("text"), MAX_VERSION_TEXT_CHARS, false)?;
    let title = v
        .title
        .as_deref()
        .map(|t| projects::text(t, &field("title"), MAX_VERSION_TITLE_CHARS, true))
        .transpose()?;
    if v.tags.len() > MAX_TAGS {
        return Err(invalid(&field("tags"), "a version takes at most 30 tags"));
    }
    let tags = v
        .tags
        .iter()
        .map(|t| projects::text(t, &field("tags"), MAX_TAG_CHARS, true))
        .collect::<Result<Vec<_>, _>>()?;
    let link = v
        .link
        .as_deref()
        .map(|l| public_link(l, &field("link")))
        .transpose()?;
    let content_type = v
        .content_type
        .as_deref()
        .map(|c| projects::text(c, &field("content_type"), MAX_CONTENT_TYPE_CHARS, true))
        .transpose()?;
    let distinct: BTreeSet<_> = v.material_ids.iter().collect();
    if v.material_ids.is_empty()
        || v.material_ids.len() > jt_studio::MAX_POST_MATERIALS
        || distinct.len() != v.material_ids.len()
    {
        return Err(invalid(
            &field("material_ids"),
            "a version shows 1 to 10 distinct materials",
        ));
    }
    Ok(VersionInput {
        text,
        title,
        tags,
        link,
        content_type,
        ..v
    })
}

/// A public web address: http or https, a host, no credentials.
fn public_link(link: &str, field: &str) -> Result<String, AppError> {
    let link = link.trim();
    let ok = link.chars().count() <= MAX_LINK_CHARS
        && url::Url::parse(link).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        });
    if ok {
        Ok(link.to_owned())
    } else {
        Err(invalid(field, "link must be a public http(s) address"))
    }
}

/// What a version speaks about. It names no subject of its own: it speaks about the one olay its
/// materials come from, and about nothing specific when they come from none or from several.
/// The same rule gives the subject of the planned post made of it.
pub(crate) fn subject_of(materials: &[jt_studio::Material]) -> Subject {
    let olays: BTreeSet<_> = materials
        .iter()
        .filter_map(|m| match m.binding {
            Binding::Olay { olay_id } => Some(olay_id),
            Binding::Genel => None,
        })
        .collect();
    match olays.first() {
        Some(olay_id) if olays.len() == 1 => Subject::Olay { olay_id: *olay_id },
        _ => Subject::Generic,
    }
}

/// What holds each of `versions` in area `p`, as `[{"index": n, "findings": [...]}]`; empty:
/// every version passes. A finding is `{"code", ...}`; one of the material gate carries
/// `"kind":"material"`, one of the truth check `"kind":"text"` (the only kind a person may
/// release, spec 2026-11-03 D19).
async fn held_versions(
    d: &Deps,
    r: &mut dyn crate::ports::TenantRepos,
    ctx: &Ctx,
    strategy: jt_strategy::StrategyVersionId,
    p: &ProductionProject,
    versions: &[PackageVersion],
) -> Result<Vec<Value>, AppError> {
    let available = projects::available_material_ids(r, p).await?;
    let hypotheses = r.hypotheses().list(strategy).await?;
    let mut held = Vec::new();
    for (index, v) in versions.iter().enumerate() {
        let mut findings: Vec<Value> = Vec::new();
        if !hypotheses.iter().any(|h| h.id == v.hypothesis_id) {
            findings.push(json!({"code":"hypothesis_not_in_approved_strategy"}));
        }
        let mut channel = None;
        if let Some(id) = v.capability_id {
            match projects::validate_account(d, r, ctx, id, Some(v.format)).await {
                Ok(()) => channel = r.capabilities().find(id).await?.map(|c| c.kind_key),
                Err(e) if e.code == ErrorCode::Validation => {
                    findings.push(json!({"code":"account_refused","message":e.message}));
                }
                Err(e) => return Err(e),
            }
        }
        if !jt_studio::media_count_ok(v.format, v.material_ids.len()) {
            findings.push(json!({"code":"media_count"}));
        }
        let mut shown = Vec::new();
        for id in &v.material_ids {
            if !available.contains(id) {
                findings.push(json!({"code":"material_not_in_area","material_id":id}));
                continue;
            }
            match r.studio_materials().get_material(*id).await? {
                None => findings.push(json!({"code":"material_not_found","material_id":id})),
                Some(m) => shown.push(m),
            }
        }
        if let Some(kind) = channel {
            let mimes: Vec<_> = shown.iter().map(|m| m.mime.as_str()).collect();
            if !jt_studio::media_types_ok(v.format, &kind, &mimes) {
                findings.push(json!({"code":"media_type"}));
            }
        }
        let subject = subject_of(&shown);
        // What is checked is what goes out. A story's text never does (Instagram takes no
        // caption for one), as the publisher's own check has it.
        let mut texts = Vec::new();
        if v.format != PostFormat::Story {
            texts.push(v.text.as_str());
            texts.extend(v.title.as_deref());
            texts.extend(v.tags.iter().map(String::as_str));
        }
        let (hard, truth) = materials::check_content(r, &shown, &subject, &texts, ctx.now).await?;
        findings.extend(
            hard.into_iter()
                .map(|f| json!({"kind":"material","code":f.code,"material_id":f.material_id})),
        );
        findings.extend(truth.into_iter().map(|f| {
            json!({"kind":"text","code":f.code.code(),"material_id":f.material_id,
                   "olay_id":f.olay_id,"matched":f.matched})
        }));
        if !findings.is_empty() {
            held.push(json!({"index":index,"findings":findings}));
        }
    }
    Ok(held)
}

/// The next package of `p`, appended; the document keeps the newest [`MAX_PACKAGES`] (the ledger
/// keeps every delivery). The area is finished with it: no claim, no refusal, nothing counted.
fn accept(p: &mut ProductionProject, package: ContentPackage) {
    p.packages.push(package);
    if p.packages.len() > MAX_PACKAGES {
        let extra = p.packages.len() - MAX_PACKAGES;
        p.packages.drain(..extra);
    }
    p.claim = None;
    p.refused = 0;
    p.refusal = None;
}

fn next_revision(p: &ProductionProject) -> Result<u32, AppError> {
    p.packages
        .last()
        .map_or(Some(1), |last| last.revision.checked_add(1))
        .ok_or_else(|| AppError::conflict("package revision overflow"))
}

/// `content.area_deliver`: the claim's agent delivers the area's platform versions.
///
/// Every version's materials are the area's (a source, or something produced in it), live and
/// eligible to be shared; its texts pass the truth check against them; its hypothesis is one of
/// the strategy in force; a named account is a live social account that takes the format. All
/// versions pass or none becomes a package: a refusal answers `CONFLICT` with
/// `details: {"reason":"package_refused","versions":[{"index","findings"}]}`, counts in
/// `refused`, and is kept as the area's `refusal` for the person who may have to look. An
/// accepted package ends the claim; it also answers a redo the agent saw when it took the area,
/// and leaves a later one standing. Replayed by `request_key`, refusals included.
pub async fn area_deliver(d: &Deps, ctx: &Ctx, i: DeliverInput) -> Result<AreaOut, AppError> {
    ctx.require(Permission::ContentWork)?;
    let by = areas::agent(ctx)?;
    files::key(&i.request_key)?;
    let summary = projects::text(&i.summary, "summary", MAX_GOAL_CHARS, true)?;
    if i.versions.is_empty() || i.versions.len() > MAX_VERSIONS {
        return Err(invalid("versions", "a package takes 1 to 12 versions"));
    }
    let payload = json!(hash_token(&files::encode(&i)?.to_string()));
    let versions = i
        .versions
        .into_iter()
        .enumerate()
        .map(|(index, v)| shaped(index, v))
        .collect::<Result<Vec<_>, _>>()?;
    let mut r = library::open(d, ctx, Permission::ContentWork).await?;
    let frame = work::gated(r.as_mut(), ctx, &[Permission::ContentWork]).await?;
    r.studio_control().lock_control().await?;
    // The agent is part of the replay identity: another agent cannot replay this one's request.
    let action = format!("content.area_deliver:{by}");
    if let Some(receipt) = r
        .studio()
        .request_replay(&action, &i.request_key, &payload)
        .await?
    {
        if let Some(details) = receipt.get("refusal") {
            return Err(refusal(details.clone()));
        }
        let id: Uuid = files::decode(receipt)?;
        let p = projects::load(r.as_mut(), id, None, false).await?;
        return Ok(AreaOut {
            project: p.present(ctx.now),
        });
    }
    let mut p = projects::load(r.as_mut(), i.project_id, None, true).await?;
    let seen = areas::claim(&p, ctx, &i.claim_token)?.redo_seen.clone();
    let versions: Vec<PackageVersion> = versions
        .into_iter()
        .map(|v| PackageVersion {
            id: d.ids.uuid(),
            format: v.format,
            capability_id: v.capability_id,
            text: v.text,
            title: v.title,
            tags: v.tags,
            link: v.link,
            material_ids: v.material_ids,
            hypothesis_id: v.hypothesis_id,
            content_type: v.content_type,
            slot_id: None,
        })
        .collect();
    let held = held_versions(d, r.as_mut(), ctx, frame.id, &p, &versions).await?;
    if !held.is_empty() {
        p.refused = p.refused.saturating_add(1);
        p.refusal = Some(RefusedDelivery {
            at: ctx.now,
            by,
            summary,
            versions,
            findings: json!(held),
        });
        projects::save(r.as_mut(), ctx, p, "content.package.refused").await?;
        let details = json!({"reason":"package_refused","versions":held});
        r.studio()
            .request_receipt(
                &action,
                &i.request_key,
                &payload,
                &json!({"refusal":details}),
            )
            .await?;
        r.commit().await?;
        return Err(refusal(details));
    }
    let package = ContentPackage {
        revision: next_revision(&p)?,
        delivered_at: projects::whole_micros(ctx.now),
        by,
        summary,
        versions,
        released: None,
    };
    accept(&mut p, package);
    if p.redo == seen {
        p.redo = None;
    }
    let project = projects::save(r.as_mut(), ctx, p, "content.package.delivered").await?;
    r.studio()
        .request_receipt(&action, &i.request_key, &payload, &json!(project.id))
        .await?;
    r.commit().await?;
    Ok(AreaOut { project })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
}

/// `content.delivery_accept`: a person accepts the delivery that holds an area (design B9).
/// Panel-only and a person's in person, for an area held after three refusals. The checks run
/// again on the kept delivery: what the truth check alone holds is released and becomes the
/// area's package, recorded with who released it; anything else (a material that may not be
/// shared, an account that does not take the format, a hypothesis no longer in the strategy) is
/// never released and answers `CONFLICT` `not_releasable` with what holds it.
pub async fn delivery_accept(
    d: &Deps,
    ctx: &Ctx,
    i: ReleaseInput,
) -> Result<projects::ProjectDetail, AppError> {
    ctx.require(Permission::ContentManage)?;
    let by =
        library::person(ctx).ok_or_else(|| AppError::forbidden("a release requires a human"))?;
    let mut r = library::open(d, ctx, Permission::ContentManage).await?;
    let frame = work::gated(r.as_mut(), ctx, &[Permission::ContentManage]).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    let Some(kept) = p
        .refusal
        .clone()
        .filter(|_| p.state(ctx.now) == AreaState::Held)
    else {
        return Err(AppError::conflict("the area holds no delivery to release"));
    };
    let held = held_versions(d, r.as_mut(), ctx, frame.id, &p, &kept.versions).await?;
    let text_only = |finding: &Value| finding["kind"] == "text";
    let blocking: Vec<Value> = held
        .iter()
        .filter_map(|v| {
            let rest: Vec<&Value> = v["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|f| !text_only(f))
                .collect();
            (!rest.is_empty()).then(|| json!({"index":v["index"],"findings":rest}))
        })
        .collect();
    if !blocking.is_empty() {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "the delivery is held by more than its text".into(),
            details: json!({"reason":"not_releasable","versions":blocking}),
        });
    }
    let package = ContentPackage {
        revision: next_revision(&p)?,
        delivered_at: projects::whole_micros(ctx.now),
        by: kept.by,
        summary: kept.summary,
        versions: kept.versions,
        released: Some(PackageRelease {
            by,
            at: ctx.now,
            findings: json!(held),
        }),
    };
    accept(&mut p, package);
    // The person decided the content stands as it is: a note asking for a change is answered.
    p.redo = None;
    let p = projects::save(r.as_mut(), ctx, p, "content.package.released").await?;
    let out = projects::detail(r.as_mut(), p).await?;
    r.commit().await?;
    Ok(out)
}

fn refusal(details: Value) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: "content package refused".into(),
        details,
    }
}
