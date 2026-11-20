//! Paylaşımlar's writes (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §3.4, §3.7): the
//! composer "Ne paylaşalım?" (`content.post_request`), files a person adds to what waits for them
//! (`content.files_add`), skipping a special day this year (`content.special_day_skip`),
//! cancelling a version that has no planned post (`content.version_cancel`) and letting a failed
//! post or a TikTok draft go (`content.post_dismiss`). Each is a person's, in person, in one
//! transaction under the Studio control lock.
use super::pending::{self, Left};
use super::posts::{self, FilesTarget, PostRow, SpecialDayLine, Stop};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        TenantRepos,
        files::StoredFile,
        materials::{CalendarEntry, DateSource},
        production_projects::*,
    },
    usecases::{
        Deps, hash_token, ledger_entry,
        studio::{
            files::{decode, encode, key},
            library, materials, projects,
        },
        wake,
    },
};
use jt_studio::{
    Binding, Calendar, FileId, HumanMark, Material, MaterialId, OccasionKind, Olay, OlayId,
    OlayKind, OlayStatus, Origin, Quality, SharePermission, ShootStatus, SlotId, Tags, UploadDay,
};
use jt_tenancy::{Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

/// The most files one write attaches.
pub const MAX_FILES: usize = 10;
/// What an empty cancellation reason is saved as.
pub const DEFAULT_CANCEL_REASON: &str = "Sahibi iptal etti";

fn invalid(field: &str, reason: &str, message: &str) -> AppError {
    AppError::validation(message, json!({"field": field, "reason": reason}))
}

fn conflict(reason: &str, message: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: message.into(),
        details: json!({"reason": reason}),
    }
}

// ---------------------------------------------------------------------------------------------
// A person's files
// ---------------------------------------------------------------------------------------------

/// `file_ids` as a write takes them: `min..=10`, distinct.
fn file_ids(ids: &[FileId], min: usize) -> Result<(), AppError> {
    if ids.len() < min || ids.len() > MAX_FILES {
        return Err(invalid(
            "file_ids",
            "too_many",
            "a request takes at most 10 files",
        ));
    }
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(invalid("file_ids", "duplicate", "each file once"));
    }
    Ok(())
}

/// Whether a stored file is something a post can show: an image, or an MP4 video.
fn media(mime: &str) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    mime.starts_with("image/") || mime == "video/mp4"
}

/// The stored file of `id`, `NOT_FOUND` naming its index.
async fn stored(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    index: usize,
    id: FileId,
) -> Result<StoredFile, AppError> {
    let file = r
        .studio()
        .get_file(id)
        .await?
        .filter(|f| f.workspace_id == ctx.workspace_id && f.deleted_at.is_none())
        .ok_or_else(|| AppError {
            code: ErrorCode::NotFound,
            message: "file not found".into(),
            details: json!({"field": "file_ids", "index": index}),
        })?;
    if !media(&file.mime) {
        return Err(AppError::validation(
            "a post shows images and MP4 videos only",
            json!({"field": "file_ids", "index": index, "reason": "file_not_media"}),
        ));
    }
    Ok(file)
}

/// What was read of a person's files before the transaction: each stored file and when its
/// bytes say it was taken (read outside any transaction, as `material_add` does, D41).
struct Prepared {
    file: StoredFile,
    captured_at: Option<OffsetDateTime>,
}

async fn prepare(d: &Deps, ctx: &Ctx, ids: &[FileId]) -> Result<Vec<Prepared>, AppError> {
    let mut files = Vec::new();
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        for (index, id) in ids.iter().enumerate() {
            files.push(stored(r.as_mut(), ctx, index, *id).await?);
        }
    }
    let mut out = Vec::new();
    for file in files {
        let captured_at = library::capture_time_of(d, &file).await?;
        out.push(Prepared { file, captured_at });
    }
    Ok(out)
}

/// The material a person's file becomes: `binding` (genel is freed by the person), real, its
/// share unset, publishable (the person chose it to post), attached for `upload`. Bytes that are a
/// live material already are that material (filed and attached the same way when it was not);
/// bytes of a material that was refused, deleted or erased are refused (D36, D37).
async fn attach(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    d: &Deps,
    files: &[Prepared],
    binding: Binding,
    upload: &jt_studio::UploadFor,
) -> Result<(Vec<Material>, usize), AppError> {
    let person = upload.by;
    let mut out = Vec::new();
    let mut created = 0;
    for (index, f) in files.iter().enumerate() {
        // Checked again under the lock: the file may have gone meanwhile.
        let file = stored(r, ctx, index, f.file.id).await?;
        let existing = match r.studio_materials().material_by_file(file.id).await? {
            Some(m) => Some(m),
            None => {
                r.studio_materials()
                    .material_by_sha256(&file.sha256)
                    .await?
            }
        };
        if let Some(mut m) = existing {
            let refused = m.erased_at.is_some()
                || m.share
                    .as_ref()
                    .is_some_and(|s| s.permission == SharePermission::NotShareable);
            if refused {
                return Err(AppError {
                    code: ErrorCode::Conflict,
                    message: "duplicate_material_file".into(),
                    details: json!({"reason": "duplicate_material_file", "index": index,
                                    "material_id": m.id}),
                });
            }
            let expected = m.revision;
            let mut changed = false;
            if m.is_unfiled() {
                m.binding = binding;
                if binding == Binding::Genel && !m.is_ai() && m.freed.is_none() {
                    m.freed = Some(HumanMark {
                        by: person,
                        at: ctx.now,
                    });
                }
                changed = true;
            }
            if m.share.is_none() && m.upload_for.is_none() {
                m.upload_for = Some(upload.clone());
                changed = true;
            }
            if changed {
                m.revision = m
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| AppError::conflict("revision overflow"))?;
                m.validate().map_err(library::invalid)?;
                r.studio_materials()
                    .update_material(m.clone(), expected)
                    .await?;
            }
            out.push(m);
            continue;
        }
        let material = Material {
            id: MaterialId(d.ids.uuid()),
            workspace_id: ctx.workspace_id,
            file_id: file.id,
            mime: file.mime.clone(),
            title: String::new(),
            origin: Origin::Real,
            binding,
            freed: (binding == Binding::Genel).then_some(HumanMark {
                by: person,
                at: ctx.now,
            }),
            share: None,
            tags: Tags {
                quality: Some(Quality::Publishable),
                ..Tags::default()
            },
            tags_reviewed_by: None,
            people: BTreeSet::new(),
            captured_at: f.captured_at,
            created_by: ctx.actor.clone(),
            revision: 1,
            created_at: ctx.now,
            erased_at: None,
            upload_for: Some(upload.clone()),
        };
        material.validate().map_err(library::invalid)?;
        r.studio_materials()
            .insert_material(material.clone())
            .await?;
        library::enqueue_material_analysis(
            r,
            &material,
            ctx.now,
            if f.captured_at.is_some() {
                DateSource::Exif
            } else {
                DateSource::Unknown
            },
        )
        .await?;
        r.ledger()
            .append(ledger_entry(
                ctx,
                "studio.material.added",
                "studio_material",
                material.id,
                json!({"file_id": material.file_id, "binding": match binding {
                           Binding::Olay { .. } => "olay", Binding::Genel => "genel",
                           Binding::Unfiled => "unfiled" },
                       "olay_id": material.olay_id(), "origin": "real", "share": null,
                       "freed": material.freed.is_some(), "quality": "publishable",
                       "person_upload": true, "revision": material.revision}),
            )?)
            .await?;
        created += 1;
        out.push(material);
    }
    Ok((out, created))
}

/// The person in person, or `FORBIDDEN` `human_required`.
fn person(ctx: &Ctx, field: &str) -> Result<UserId, AppError> {
    library::person(ctx).ok_or_else(|| library::person_required(field))
}

/// A tenant bundle of an active workspace for a caller whose permission check has run.
async fn tenant(d: &Deps, ctx: &Ctx) -> Result<Box<dyn TenantRepos>, AppError> {
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    crate::usecases::studio::chain::active(r.as_mut()).await?;
    Ok(r)
}

// ---------------------------------------------------------------------------------------------
// content.post_request
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostRequestInput {
    /// 1..=128; a replay answers the same row.
    pub request_key: String,
    /// The owner's words, 1..=2000 characters.
    pub text: String,
    /// 0..=10, distinct, uploaded with `studio.file_upload`.
    #[serde(default)]
    pub file_ids: Vec<FileId>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PostRequestOut {
    pub row: PostRow,
    pub stops: Vec<Stop>,
}

const POST_REQUEST: &str = "content.post_request";

/// The answer for area `id`: its row and the composer's stops, read in `r`.
async fn post_answer(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: Uuid,
) -> Result<PostRequestOut, AppError> {
    let row_id = format!("content:{id}");
    let row = match posts::row_in(d, r, ctx, &row_id).await? {
        Some(row) => row,
        None => {
            // Delivered already (a replay after the agent finished): its first row.
            posts::row_of_area(d, r, ctx, id)
                .await?
                .ok_or_else(|| AppError::not_found("post"))?
        }
    };
    Ok(PostRequestOut {
        row,
        stops: posts::stops_in(d, r, ctx).await?,
    })
}

/// `content.post_request` (panel; `content.manage`, `materials.work` with files; a person in
/// person): the composer. The owner's words become a content (an area) asked for in person, with
/// no platform named (P3: the agent chooses among every connected account; a platform in the text
/// is the owner's choice). Each file becomes a material genel freed by the person, publishable,
/// its share unset and pending (§3.4.4): the agent is not offered the content until each file has
/// its share, by rule or by the person. Text only wakes the content agent; with files the
/// materials agent is woken for their analysis first. Replayed by `request_key`.
pub async fn post_request(
    d: &Deps,
    ctx: &Ctx,
    i: PostRequestInput,
) -> Result<PostRequestOut, AppError> {
    ctx.require(Permission::ContentManage)?;
    let by = person(ctx, "text")?;
    if !i.file_ids.is_empty() {
        ctx.require(Permission::MaterialsWork)?;
    }
    key(&i.request_key)?;
    if i.request_key.chars().count() > 128 {
        return Err(invalid(
            "request_key",
            "too_long",
            "request key is 1 to 128 characters",
        ));
    }
    let text = projects::text(&i.text, "text", MAX_GOAL_CHARS, true)?;
    file_ids(&i.file_ids, 0)?;
    let payload = json!(hash_token(&encode(&i)?.to_string()));
    {
        let mut r = library::open(d, ctx, Permission::ContentManage).await?;
        if let Some(v) = r
            .studio()
            .request_replay(POST_REQUEST, &i.request_key, &payload)
            .await?
        {
            let id: Uuid = decode(v)?;
            return post_answer(d, r.as_mut(), ctx, id).await;
        }
    }
    let files = prepare(d, ctx, &i.file_ids).await?;
    let mut r = library::open(d, ctx, Permission::ContentManage).await?;
    r.studio_control().lock_control().await?;
    if let Some(v) = r
        .studio()
        .request_replay(POST_REQUEST, &i.request_key, &payload)
        .await?
    {
        let id: Uuid = decode(v)?;
        return post_answer(d, r.as_mut(), ctx, id).await;
    }
    let id = d.ids.uuid();
    let mut upload = pending::upload_for(by, ctx.now);
    upload.area_id = Some(id);
    let (shown, created) = attach(r.as_mut(), ctx, d, &files, Binding::Genel, &upload).await?;
    let mut sources: Vec<ProjectSource> = Vec::new();
    for m in &shown {
        if !sources.iter().any(|s| s.material_id == m.id) {
            sources.push(ProjectSource {
                material_id: m.id,
                revision: m.revision,
            });
        }
    }
    let pending_files: Vec<MaterialId> = shown
        .iter()
        .filter(|m| m.share.is_none())
        .map(|m| m.id)
        .collect();
    let p = ProductionProject {
        id,
        workspace_id: ctx.workspace_id,
        title: projects::goal_title(&text),
        brief: text,
        revision: 1,
        archived: false,
        sources,
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        pending_files,
        olay_id: None,
        steps: vec![],
        start_at: Some(projects::whole_micros(ctx.now)),
        opened_by: Default::default(),
        requested_by: Some(by),
        hints: AreaHints::default(),
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
        created_at: ctx.now,
        updated_at: ctx.now,
    };
    r.studio_projects().save_project(p.clone(), None).await?;
    r.studio()
        .request_receipt(POST_REQUEST, &i.request_key, &payload, &json!(id))
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "content.post_requested",
            "production_project",
            id,
            json!({"area_id": id, "files": shown.len()}),
        )?)
        .await?;
    if p.pending_files.is_empty() {
        wake::request(
            r.as_mut(),
            ctx,
            &[wake::CONTENT],
            wake::WakeReason::ContentRequested,
        )
        .await?;
    } else if created > 0 || !p.pending_files.is_empty() {
        wake::request(
            r.as_mut(),
            ctx,
            &[wake::MATERIALS],
            wake::WakeReason::MaterialUploaded,
        )
        .await?;
    }
    let out = post_answer(d, r.as_mut(), ctx, id).await?;
    r.commit().await?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// content.files_add
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilesAddInput {
    pub request_key: String,
    pub target: FilesTarget,
    /// 1..=10, distinct.
    pub file_ids: Vec<FileId>,
}

/// `content.files_add`'s answer: the row it changed, or the special day's line (absent once the
/// day has a usable file and its content shows as a row).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FilesAddOut {
    pub row: Option<PostRow>,
    pub day: Option<SpecialDayLine>,
}

const FILES_ADD: &str = "content.files_add";

/// The season year of olay `o` of occasion `key` in `calendar`.
fn season_year(calendar: &Calendar, o: &Olay) -> Option<i32> {
    o.occasion
        .as_deref()
        .and_then(|k| calendar.season_year(k, o.starts_on))
}

/// The confirmed olay of special day `entry`, made confirmed by the person when there is none
/// (`olay_create` internals).
async fn day_olay(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    by: UserId,
    entry: &CalendarEntry,
    calendar: &Calendar,
    olays: &[Olay],
) -> Result<OlayId, AppError> {
    if let Some(o) = olays.iter().find(|o| {
        o.is_confirmed()
            && o.occasion.as_deref() == Some(entry.key.as_str())
            && season_year(calendar, o) == Some(entry.year)
    }) {
        return Ok(o.id);
    }
    let (start, end) = entry
        .window()
        .ok_or_else(|| AppError::not_found("special day"))?;
    let olay = Olay {
        id: OlayId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        kind: match entry.kind {
            OccasionKind::Season => OlayKind::Season,
            OccasionKind::SpecialDay => OlayKind::SpecialDay,
        },
        title: entry.name.clone(),
        starts_on: start,
        ends_on: end,
        place: None,
        client: None,
        notes: String::new(),
        occasion: Some(entry.key.clone()),
        status: OlayStatus::Confirmed,
        confirmed: Some(HumanMark { by, at: ctx.now }),
        revision: 1,
        created_at: ctx.now,
    };
    olay.validate().map_err(library::invalid)?;
    r.studio_materials().insert_olay(olay.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.olay.created",
            "studio_olay",
            olay.id,
            json!({"olay_id":olay.id,"kind":olay.kind,"status":olay.status,
                   "occasion":olay.occasion,"revision":olay.revision,"by":"files_add"}),
        )?)
        .await?;
    Ok(olay.id)
}

/// `content.files_add` (panel; an owner or manager in person with `materials.work`; a capture also
/// `content.work` or `content.manage`): a person's files for what waits for them (§3.7.1). Each
/// becomes a material attached for its target, its share by the person-upload rule (§3.4.4):
///
/// - `special_day {key, year}`: bound to the day's confirmed olay (made confirmed by the person
///   when there is none); once a file is shared and the day's preparation started, its calendar
///   trigger runs in that same write and the content agent is woken.
/// - `need {shoot_request_id}`: genel, freed by the person; the request is answered `done` with
///   its first shared file.
/// - `capture {project_id, request_id}`: bound to the content's olay, or genel freed; the
///   content's sources and pending files; the capture answered `done`. The content goes back to
///   its agent only once its files are shared.
pub async fn files_add(d: &Deps, ctx: &Ctx, i: FilesAddInput) -> Result<FilesAddOut, AppError> {
    ctx.require(Permission::MaterialsWork)?;
    if matches!(i.target, FilesTarget::Capture { .. }) {
        ctx.require_any(&[Permission::ContentWork, Permission::ContentManage])?;
    }
    let by = crate::usecases::studio::control::human_approver(ctx)?;
    key(&i.request_key)?;
    file_ids(&i.file_ids, 1)?;
    let payload = json!(hash_token(&encode(&i)?.to_string()));
    {
        let mut r = library::open(d, ctx, Permission::MaterialsWork).await?;
        if r.studio()
            .request_replay(FILES_ADD, &i.request_key, &payload)
            .await?
            .is_some()
        {
            return files_answer(d, r.as_mut(), ctx, &i.target).await;
        }
    }
    let files = prepare(d, ctx, &i.file_ids).await?;
    let mut r = library::open(d, ctx, Permission::MaterialsWork).await?;
    r.studio_control().lock_control().await?;
    if r.studio()
        .request_replay(FILES_ADD, &i.request_key, &payload)
        .await?
        .is_some()
    {
        return files_answer(d, r.as_mut(), ctx, &i.target).await;
    }
    let mut upload = pending::upload_for(by, ctx.now);
    let (shown, created) = match &i.target {
        FilesTarget::SpecialDay { key, year } => {
            let lib = materials::library(r.as_mut(), ctx.now).await?;
            let entry = lib
                .calendar
                .entries
                .iter()
                .find(|e| e.key == *key && e.year == *year && e.window().is_some())
                .cloned()
                .ok_or_else(|| AppError::not_found("special day"))?;
            let olay = day_olay(d, r.as_mut(), ctx, by, &entry, &lib.calendar, &lib.olays).await?;
            upload.day = Some(UploadDay {
                key: key.clone(),
                year: *year,
            });
            attach(
                r.as_mut(),
                ctx,
                d,
                &files,
                Binding::Olay { olay_id: olay },
                &upload,
            )
            .await?
        }
        FilesTarget::Need { shoot_request_id } => {
            let q = r
                .studio_materials()
                .get_shoot_request(*shoot_request_id)
                .await?
                .ok_or_else(|| AppError::not_found("shoot request"))?;
            if q.status != ShootStatus::Open {
                return Err(conflict(
                    "already_resolved",
                    "the request is answered already",
                ));
            }
            upload.shoot_request_id = Some(q.id);
            attach(r.as_mut(), ctx, d, &files, Binding::Genel, &upload).await?
        }
        FilesTarget::Capture {
            project_id,
            request_id,
        } => {
            let p = projects::load(r.as_mut(), *project_id, None, true).await?;
            let index = p
                .requests
                .iter()
                .position(|q| q.id == *request_id && q.status == RequestStatus::Open)
                .ok_or_else(|| AppError::not_found("material request"))?;
            let binding = match p.olay_id {
                Some(olay_id) if r.studio_materials().get_olay(olay_id).await?.is_some() => {
                    Binding::Olay { olay_id }
                }
                _ => Binding::Genel,
            };
            upload.area_id = Some(p.id);
            let (shown, created) = attach(r.as_mut(), ctx, d, &files, binding, &upload).await?;
            let mut p = p;
            for m in &shown {
                p.sources.retain(|s| s.material_id != m.id);
                p.sources.push(ProjectSource {
                    material_id: m.id,
                    revision: m.revision,
                });
                if m.share.is_none() && !p.pending_files.contains(&m.id) {
                    p.pending_files.push(m.id);
                }
            }
            if p.sources.len() > 100 {
                return Err(invalid("file_ids", "too_many", "at most 100 sources"));
            }
            p.requests[index].status = RequestStatus::Done;
            p.requests[index].material_ids = shown.iter().map(|m| m.id).collect();
            p.requests[index].resolved_at = Some(ctx.now);
            let p = projects::save(r.as_mut(), ctx, p, "studio.project.request_updated").await?;
            // The capture answered gives the content back to its agent once nothing waits for
            // its share (§3.4.4).
            if p.needs_agent(ctx.now) {
                wake::request(
                    r.as_mut(),
                    ctx,
                    &[wake::CONTENT],
                    wake::WakeReason::CaptureAnswered,
                )
                .await?;
            }
            (shown, created)
        }
    };
    // A file that is shared already (a live material used again) settles its need or day now.
    if !matches!(i.target, FilesTarget::Capture { .. }) {
        for m in shown.iter().filter(|m| {
            m.share.as_ref().is_some_and(|s| {
                matches!(
                    s.permission,
                    SharePermission::Shareable | SharePermission::ProductOnly
                )
            })
        }) {
            let mut m = m.clone();
            m.upload_for = Some(upload.clone());
            pending::left(d, r.as_mut(), ctx, &m, Left::Shared).await?;
        }
    }
    r.ledger()
        .append(ledger_entry(
            ctx,
            "content.files_added",
            "studio_material",
            shown.first().map_or(Uuid::nil(), |m| m.id.0),
            json!({"target": target_kind(&i.target), "files": shown.len()}),
        )?)
        .await?;
    r.studio()
        .request_receipt(FILES_ADD, &i.request_key, &payload, &json!(true))
        .await?;
    if created > 0 {
        wake::request(
            r.as_mut(),
            ctx,
            &[wake::MATERIALS],
            wake::WakeReason::MaterialUploaded,
        )
        .await?;
    }
    let out = files_answer(d, r.as_mut(), ctx, &i.target).await?;
    r.commit().await?;
    Ok(out)
}

fn target_kind(t: &FilesTarget) -> &'static str {
    match t {
        FilesTarget::Capture { .. } => "capture",
        FilesTarget::Need { .. } => "need",
        FilesTarget::SpecialDay { .. } => "special_day",
    }
}

async fn files_answer(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    target: &FilesTarget,
) -> Result<FilesAddOut, AppError> {
    Ok(match target {
        FilesTarget::Capture { project_id, .. } => FilesAddOut {
            row: posts::row_of_area(d, r, ctx, *project_id).await?,
            day: None,
        },
        FilesTarget::Need { shoot_request_id } => FilesAddOut {
            row: posts::row_in(d, r, ctx, &format!("need:{shoot_request_id}")).await?,
            day: None,
        },
        FilesTarget::SpecialDay { key, year } => FilesAddOut {
            row: None,
            day: posts::day_in(d, r, ctx, key, *year).await?,
        },
    })
}

// ---------------------------------------------------------------------------------------------
// content.special_day_skip
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecialDaySkipInput {
    pub key: String,
    pub year: i32,
}

/// `content.special_day_skip` (panel; `content.work` or `materials.work`, an owner or manager in
/// person): "Bu yıl geç". The year's effective entry is saved disabled (`calendar_set`'s
/// internals, every other field as the effective entry has it) and its open `season:` request
/// dismissed, in one transaction. `Geri al` is `studio.calendar_set` with `enabled: true`.
pub async fn special_day_skip(
    d: &Deps,
    ctx: &Ctx,
    i: SpecialDaySkipInput,
) -> Result<CalendarEntry, AppError> {
    ctx.require_any(&[Permission::ContentWork, Permission::MaterialsWork])?;
    crate::usecases::studio::control::human_approver(ctx)?;
    if !(2000..=2100).contains(&i.year) {
        return Err(invalid(
            "year",
            "out_of_range",
            "the year must be 2000 to 2100",
        ));
    }
    let mut r = tenant(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let rows: Vec<CalendarEntry> = r.studio_materials().calendar_rows().await?;
    let entry = Calendar::effective(i.year..=i.year, &rows)
        .entries
        .into_iter()
        .find(|e| e.key == i.key && e.year == i.year)
        .ok_or_else(|| AppError::not_found("special day"))?;
    let row = CalendarEntry {
        enabled: false,
        ..entry
    };
    row.validate().map_err(library::invalid)?;
    r.studio_materials().save_calendar_row(row.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.calendar.set",
            "studio_calendar",
            format!("{}:{}", row.key, row.year),
            json!({"key":row.key,"year":row.year,"kind":row.kind,"enabled":row.enabled,
                "dated":row.window_start.is_some(),"lead_days":row.lead_days}),
        )?)
        .await?;
    let season = jt_studio::season_request_key(&row.key, row.year);
    if let Some(q) = r
        .studio_materials()
        .list_shoot_requests()
        .await?
        .into_iter()
        .find(|q| q.key == season && q.status == ShootStatus::Open)
    {
        let request = jt_studio::ShootRequest {
            status: ShootStatus::Dismissed,
            resolved_by: Some(ctx.actor.clone()),
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
                json!({"status":"dismissed","system":request.reason.is_system()}),
            )?)
            .await?;
    }
    r.ledger()
        .append(ledger_entry(
            ctx,
            "content.special_day.skipped",
            "studio_calendar",
            format!("{}:{}", row.key, row.year),
            json!({"key":row.key,"year":row.year}),
        )?)
        .await?;
    r.commit().await?;
    Ok(row)
}

// ---------------------------------------------------------------------------------------------
// content.version_cancel
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionCancelInput {
    pub project_id: Uuid,
    pub version_id: Uuid,
    /// The revision of the area's current package as the person saw it.
    pub package_revision: u32,
    /// What the person wrote; empty: [`DEFAULT_CANCEL_REASON`].
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct VersionCancelOut {
    pub project: ProductionProject,
    /// Nothing of the content was left to go out: it was archived with this version.
    pub archived: bool,
}

/// `content.version_cancel` (panel; `content.manage` or `social.manage`, a person in person): a
/// version of the current package that has no planned post is never planned (§3.7.3). The version
/// is marked cancelled with no slot ([`VersionCancel`]); the content is archived when nothing of
/// it is left to go out (every other version cancelled, nothing went out).
pub async fn version_cancel(
    d: &Deps,
    ctx: &Ctx,
    i: VersionCancelInput,
) -> Result<VersionCancelOut, AppError> {
    ctx.require_any(&[Permission::ContentManage, Permission::SocialManage])?;
    let by = person(ctx, "version_id")?;
    let reason = match i.reason.trim() {
        "" => DEFAULT_CANCEL_REASON.to_owned(),
        _ => projects::text(&i.reason, "reason", MAX_GOAL_CHARS, true)?,
    };
    let mut r = tenant(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, None, true).await?;
    let package = p
        .packages
        .last()
        .ok_or_else(|| AppError::not_found("content package"))?;
    if package.revision != i.package_revision {
        return Err(AppError::conflict("the area's package changed"));
    }
    let index = package
        .versions
        .iter()
        .position(|v| v.id == i.version_id)
        .ok_or_else(|| AppError::not_found("package version"))?;
    let version = &package.versions[index];
    if version.cancelled.is_some() {
        return Err(conflict("version_cancelled", "the version was cancelled"));
    }
    if version.slot_id.is_some() {
        return Err(conflict(
            "version_scheduled",
            "the version has a planned post: cancel it with studio.slot_cancel",
        ));
    }
    let rest_cancelled = package
        .versions
        .iter()
        .enumerate()
        .all(|(n, v)| n == index || v.cancelled.is_some());
    let slots: Vec<SlotId> = p.posts().iter().map(|x| x.slot_id).collect();
    let archive = rest_cancelled && r.studio().publications_of(&slots).await?.is_empty();
    if let Some(k) = p.packages.last_mut() {
        k.versions[index].cancelled = Some(VersionCancel {
            by,
            at: ctx.now,
            reason,
            slot_id: None,
        });
    }
    if archive {
        projects::invalidate(r.as_mut(), ctx, &mut p, None, "project_archived", false).await?;
        p.archived = true;
    }
    let p = projects::save(r.as_mut(), ctx, p, "content.version.cancelled").await?;
    if archive {
        r.ledger()
            .append(ledger_entry(
                ctx,
                "content.area.archived",
                "production_project",
                p.id,
                json!({"reason":"every_version_cancelled","version_id":i.version_id,
                       "revision":p.revision}),
            )?)
            .await?;
    }
    r.commit().await?;
    Ok(VersionCancelOut {
        project: p,
        archived: archive,
    })
}

// ---------------------------------------------------------------------------------------------
// content.post_dismiss
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostDismissInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PostDismissOut {
    pub slot_id: SlotId,
    /// `failed` (`Bırak`) or `tiktok_draft` (`Tamamladım`).
    pub kind: &'static str,
    pub acknowledged: jt_studio::PostAck,
}

/// `content.post_dismiss` (panel; `content.manage` or `social.manage`, a person in person): a
/// person acknowledges a failed post (`Bırak`) or a TikTok draft (`Tamamladım`) (§3.7.4). The
/// post records who and when; nothing is sent, cancelled or redone, and the row stops waiting.
pub async fn post_dismiss(
    d: &Deps,
    ctx: &Ctx,
    i: PostDismissInput,
) -> Result<PostDismissOut, AppError> {
    ctx.require_any(&[Permission::ContentManage, Permission::SocialManage])?;
    let by = person(ctx, "slot_id")?;
    let mut r = tenant(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let slot = r
        .studio()
        .get_slot(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    if slot.revision != i.expected_revision {
        return Err(conflict(
            "slot_changed",
            "the post changed since it was read",
        ));
    }
    let post = r
        .studio_posts()
        .get_post(slot.id)
        .await?
        .ok_or_else(|| AppError::not_found("post"))?;
    let reads = super::pipeline::PostReads::load(r.as_mut(), &[slot.id]).await?;
    let fact = reads
        .facts(&[AreaPost {
            version_id: Uuid::nil(),
            slot_id: slot.id,
            current: true,
        }])
        .into_iter()
        .next();
    let draft = fact.as_ref().is_some_and(|f| {
        f.publication.published_at.is_some()
            && reads
                .receipt(slot.id)
                .and_then(|a| a.tiktok.as_ref())
                .is_some_and(|t| t.is_draft())
    });
    let failed = fact.as_ref().is_some_and(|f| f.publication.failed);
    let kind = match (draft, failed) {
        (true, _) => "tiktok_draft",
        (false, true) => "failed",
        _ => {
            return Err(conflict(
                "not_acknowledgeable",
                "the post neither failed nor is a TikTok draft",
            ));
        }
    };
    if post.acknowledged.is_some() {
        return Err(conflict(
            "not_acknowledgeable",
            "the post was acknowledged already",
        ));
    }
    let ack = jt_studio::PostAck { by, at: ctx.now };
    if !r.studio_posts().acknowledge_post(slot.id, ack).await? {
        return Err(conflict(
            "not_acknowledgeable",
            "the post was acknowledged already",
        ));
    }
    r.ledger()
        .append(ledger_entry(
            ctx,
            "content.post.dismissed",
            "studio_slot",
            slot.id,
            json!({"slot_id": slot.id, "kind": kind}),
        )?)
        .await?;
    r.commit().await?;
    Ok(PostDismissOut {
        slot_id: slot.id,
        kind,
        acknowledged: ack,
    })
}
