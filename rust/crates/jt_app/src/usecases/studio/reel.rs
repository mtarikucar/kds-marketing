//! Photo reels (`studio.reel_render`): a vertical MP4 the server makes of 3 to 8 of the
//! workspace's own analysed photos, each slowly panning and zooming under its caption, with an
//! optional title card and closing card in the brand tokens (`jt_studio::compose::reel`).
//!
//! A reel is a composed material exactly as a rendered slide is (`render`): stored as a Studio
//! file and added to the library at once, its origin the server's (AI-generated, generator
//! `jeeta-reel`, when any source is), its `composition` naming the renderer, role `reel` and every
//! source (photos in order, the logo last). So every rule that follows a composition follows a
//! reel: the cascades of its sources (erasure, retention, un-sharing, late person and `depicts`
//! marks, an unusable quality), the publication fence, area membership by its photos, created
//! analysed and never analysis work, never a "new material" of any trigger.
use super::files::{Staging, available, decode, encode, key};
use super::library::{check_people, conflict, open, refused};
use super::render::{Cause, compose_error, derive, in_area, logo_source, overflow, source};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        compose::{ReelJob, ReelPhoto, RenderedReel, SourceImage},
        files::StoredFile,
        materials::{Material, MaterialId, Origin},
    },
    usecases::{Deps, ledger_entry},
};
use jt_studio::compose::{
    BrandFallback, BrandTokens, Composition, Frame, REEL_AI_GENERATOR, REEL_RENDERER, Role,
    SlotSpec, TextRefusal, check_text, reel, template,
};
use jt_studio::{MAX_MATERIAL_TITLE_CHARS, MediaUpload};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The most a reel's sources (its photos and the logo) may take stored, together: they are read
/// before the render, and each is dropped once decoded.
pub const REEL_SOURCES_BYTES_LIMIT: u64 = 100_000_000;

const USE_CASE: &str = "studio.reel_render";

/// One photo of a reel, in order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReelPhotoRef {
    pub material_id: MaterialId,
    /// The caption drawn over it, exactly as given.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub focus_x: Option<f32>,
    #[serde(default)]
    pub focus_y: Option<f32>,
}

/// The closing card's texts; the card is drawn when any is given.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReelClosing {
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub site: Option<String>,
    #[serde(default)]
    pub slogan: Option<String>,
}

/// `studio.reel_render`'s input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReelRenderInput {
    pub request_key: String,
    /// 3 to 8 photos, each a different material, shown in this order.
    pub photos: Vec<ReelPhotoRef>,
    /// The opening title card's title; no title card without it.
    #[serde(default)]
    pub title_text: Option<String>,
    #[serde(default)]
    pub closing: Option<ReelClosing>,
    /// How long each photo shows, 2500 to 4000 ms (3000 by default).
    #[serde(default)]
    pub photo_ms: Option<u32>,
    /// The content area (`project_id`) this reel is for: every photo must be one of its materials.
    #[serde(default)]
    pub project_id: Option<uuid::Uuid>,
    /// The material's title; "reel · photo_reel" by default.
    #[serde(default)]
    pub title: Option<String>,
}

/// `studio.reel_render`'s answer: what the next call needs.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReelRenderOut {
    /// The stored file: a piece names `file.id`.
    pub file: StoredFile,
    /// The library material made of it: a post proposal and an area delivery name `material.id`.
    pub material: Material,
    pub ai_generated: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: u32,
    pub duration_ms: u64,
    /// The post formats it is a medium of.
    pub formats: Vec<String>,
    #[serde(default)]
    pub brand_fallbacks: Vec<BrandFallback>,
    /// The same reel was rendered before: its material is answered, nothing new is stored.
    #[serde(default)]
    pub reused: bool,
    pub next: String,
}

/// What the request key keeps: ids and the video's facts, never the texts.
#[derive(Serialize, Deserialize)]
struct ReelReceipt {
    material_id: MaterialId,
    frames: u32,
    duration_ms: u64,
    brand_fallbacks: Vec<BrandFallback>,
    reused: bool,
}

const NEXT: &str = "Content area: jeeta.content.area_deliver with versions [{format: \"reel\" (Instagram) or \"tiktok_video\" (TikTok), material_ids: [material.id], ...}] (render with the area's project_id). Post request: jeeta.studio.posts_propose with posts [{format: \"reel\" or \"tiktok_video\", material_ids: [material.id], ...}]. Planned slot (reel or TikTok video): jeeta.studio.piece_submit with media [{\"kind\": \"file\", \"id\": file.id}]. The video has no audio track: the owner adds music in the app when posting.";

fn slot(key: &str) -> Result<SlotSpec, AppError> {
    template(Role::Reel, reel::VARIANT)
        .and_then(|t| t.slot(key).cloned())
        .ok_or_else(|| AppError::internal("the reel template is missing"))
}

/// Checks a text for `field` against `slot` before anything is read.
fn text(field: &str, slot: &SlotSpec, value: &str) -> Result<(), AppError> {
    check_text(slot, value).map_err(|e| match e {
        TextRefusal::TooLong => overflow(field, slot.max_chars, slot.max_lines, Cause::TooLong),
        TextRefusal::ControlCharacter => refused(
            field,
            "invalid_text",
            "a text holds no control character but a line feed",
        ),
        TextRefusal::Empty => refused(field, "empty_text", "leave an empty text out"),
    })
}

/// The checked input: the photos' count, distinctness, focus and every text's length.
fn checked(i: &ReelRenderInput) -> Result<u32, AppError> {
    let n = i.photos.len();
    if !(reel::MIN_PHOTOS..=reel::MAX_PHOTOS).contains(&n) {
        return Err(AppError::validation(
            format!(
                "a reel takes {} to {} photos",
                reel::MIN_PHOTOS,
                reel::MAX_PHOTOS
            ),
            json!({"field":"photos","reason":"photo_count","min":reel::MIN_PHOTOS,
                   "max":reel::MAX_PHOTOS,"given":n}),
        ));
    }
    let mut seen = BTreeSet::new();
    for (at, p) in i.photos.iter().enumerate() {
        if !seen.insert(p.material_id) {
            return Err(AppError::validation(
                "each photo of a reel is a different material",
                json!({"field": format!("photos.{at}.material_id"), "reason":"duplicate_photo",
                       "material_id": p.material_id}),
            ));
        }
        for f in [p.focus_x, p.focus_y].into_iter().flatten() {
            if !(0.0..=1.0).contains(&f) {
                return Err(refused(
                    &format!("photos.{at}.focus"),
                    "focus_out_of_range",
                    "a focus is 0 to 1",
                ));
            }
        }
    }
    let caption = slot(reel::CAPTION)?;
    for (at, p) in i.photos.iter().enumerate() {
        if let Some(t) = &p.text {
            text(&format!("photos.{at}.text"), &caption, t)?;
        }
    }
    if let Some(t) = &i.title_text {
        text("title_text", &slot(reel::TITLE)?, t)?;
    }
    if let Some(c) = &i.closing {
        for (field, key, value) in [
            ("closing.heading", reel::HEADING, &c.heading),
            ("closing.site", reel::SITE, &c.site),
            ("closing.slogan", reel::SLOGAN, &c.slogan),
        ] {
            if let Some(v) = value {
                text(field, &slot(key)?, v)?;
            }
        }
    }
    let photo_ms = i.photo_ms.unwrap_or(reel::DEFAULT_PHOTO_MS);
    let (lo, hi) = reel::PHOTO_MS;
    if !(lo..=hi).contains(&photo_ms) {
        return Err(AppError::validation(
            format!("a photo shows {lo} to {hi} ms"),
            json!({"field":"photo_ms","reason":"photo_ms_out_of_range","min":lo,"max":hi}),
        ));
    }
    if let Some(title) = &i.title
        && (title.trim().is_empty() || title.chars().count() > MAX_MATERIAL_TITLE_CHARS)
    {
        return Err(refused(
            "title",
            "title_invalid",
            "a title is 1 to 120 characters",
        ));
    }
    Ok(photo_ms)
}

/// The reel's sources, checked: its photos in order, then the logo (left out, with a note, when
/// it can no longer be drawn).
async fn sources(
    r: &mut dyn TenantRepos,
    i: &ReelRenderInput,
    brand: &BrandTokens,
    notes: &mut Vec<BrandFallback>,
    now: time::OffsetDateTime,
) -> Result<(Vec<Material>, Option<Material>), AppError> {
    let blocked = super::library::blocked_derivatives(r).await?;
    let mut photos = Vec::new();
    for (at, p) in i.photos.iter().enumerate() {
        let field = format!("photos.{at}.material_id");
        photos.push(source(r, p.material_id, &field, &blocked, now).await?);
    }
    let logo = logo_source(r, brand, &blocked, notes, now).await?;
    Ok((photos, logo))
}

/// The sources' stored bytes together are at most [`REEL_SOURCES_BYTES_LIMIT`].
async fn within_bytes(
    r: &mut dyn TenantRepos,
    photos: &[Material],
    logo: Option<&Material>,
) -> Result<(), AppError> {
    let mut total = 0u64;
    for m in photos.iter().chain(logo) {
        if let Some(f) = r.studio().get_file(m.file_id).await? {
            total += f.size_bytes;
        }
    }
    if total > REEL_SOURCES_BYTES_LIMIT {
        return Err(AppError::validation(
            "a reel's photos take at most 100 MB stored together; use smaller copies or fewer photos",
            json!({"field":"photos","reason":"sources_too_large","bytes":total,
                   "max_bytes":REEL_SOURCES_BYTES_LIMIT}),
        ));
    }
    Ok(())
}

fn answer(
    file: StoredFile,
    material: Material,
    frames: u32,
    duration_ms: u64,
    brand_fallbacks: Vec<BrandFallback>,
    reused: bool,
) -> ReelRenderOut {
    let (width, height) = Frame::Reel.size();
    ReelRenderOut {
        ai_generated: material.is_ai(),
        file,
        material,
        width,
        height,
        fps: reel::FPS,
        frames,
        duration_ms,
        formats: vec!["reel".into(), "tiktok_video".into()],
        brand_fallbacks,
        reused,
        next: NEXT.into(),
    }
}

async fn read_receipt(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    v: Value,
) -> Result<ReelRenderOut, AppError> {
    let receipt: ReelReceipt = decode(v)?;
    let material = r
        .studio_materials()
        .get_material(receipt.material_id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))?;
    if material.erased_at.is_some() {
        return Err(AppError {
            details: json!({"reason":"render_erased","material_id":material.id}),
            ..conflict("render_erased")
        });
    }
    let file = r
        .studio()
        .get_file(material.file_id)
        .await?
        .filter(|f| f.workspace_id == ctx.workspace_id)
        .ok_or_else(|| AppError::not_found("file"))?;
    Ok(answer(
        file,
        material,
        receipt.frames,
        receipt.duration_ms,
        receipt.brand_fallbacks,
        receipt.reused,
    ))
}

/// Renders a photo reel and adds it to the library (see the module documentation). Replayed by
/// `request_key`.
pub async fn reel_render(
    d: &Deps,
    ctx: &Ctx,
    i: ReelRenderInput,
) -> Result<ReelRenderOut, AppError> {
    ctx.require_any(super::permissions::for_use_case(USE_CASE))?;
    key(&i.request_key)?;
    let photo_ms = checked(&i)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    let mut r = open(d, ctx, Permission::ContentWork).await?;
    if let Some(v) = r
        .studio()
        .request_replay(USE_CASE, &i.request_key, &payload)
        .await?
    {
        return read_receipt(ctx, r.as_mut(), v).await;
    }
    let stored = r.studio_materials().brand().await?;
    let tokens = stored.map(|b| b.tokens).unwrap_or_default();
    let (brand, mut fallbacks) = tokens.effective();
    let (photos, logo) = sources(r.as_mut(), &i, &brand, &mut fallbacks, ctx.now).await?;
    derive(&photos, logo.as_ref())?;
    in_area(r.as_mut(), i.project_id, &photos).await?;
    within_bytes(r.as_mut(), &photos, logo.as_ref()).await?;
    drop(r);

    // A turn first: a reel waiting for its turn holds no source in memory.
    let ticket = d.compositor.reserve_reel().await.map_err(compose_error)?;
    let mut shown = Vec::with_capacity(photos.len());
    for (p, m) in i.photos.iter().zip(&photos) {
        let bytes = d.files.read(ctx.workspace_id, m.file_id).await?;
        shown.push(ReelPhoto {
            image: SourceImage {
                bytes: bytes.bytes,
                mime: m.mime.clone(),
                focus: (p.focus_x.unwrap_or(0.5), p.focus_y.unwrap_or(0.5)),
            },
            caption: p.text.clone(),
        });
    }
    let logo_image = match &logo {
        Some(m) => Some(SourceImage {
            bytes: d.files.read(ctx.workspace_id, m.file_id).await?.bytes,
            mime: m.mime.clone(),
            focus: (0.5, 0.5),
        }),
        None => None,
    };
    let closing = i.closing.clone().unwrap_or_default();
    let rendered = d
        .compositor
        .render_reel(
            ticket,
            ReelJob {
                photos: shown,
                photo_ms,
                title: i.title_text.clone(),
                closing_heading: closing.heading,
                closing_site: closing.site,
                closing_slogan: closing.slogan,
                logo: logo_image,
                brand: BrandTokens {
                    logo_material_id: logo.as_ref().map(|m| m.id),
                    ..brand
                },
            },
        )
        .await
        .map_err(compose_error)?;

    let drawn_logo = logo.as_ref().map(|m| m.id);
    let mut stage = Staging::new();
    let result = store(
        d, ctx, &i, &payload, rendered, fallbacks, drawn_logo, &mut stage,
    )
    .await;
    stage.compensate(d, ctx.workspace_id).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn store(
    d: &Deps,
    ctx: &Ctx,
    i: &ReelRenderInput,
    payload: &Value,
    rendered: RenderedReel,
    fallbacks: Vec<BrandFallback>,
    drawn_logo: Option<MaterialId>,
    stage: &mut Staging,
) -> Result<ReelRenderOut, AppError> {
    let (frames, duration_ms) = (rendered.frames, rendered.duration_ms);
    let upload = MediaUpload {
        bytes: rendered.bytes,
        mime: rendered.mime.to_owned(),
        filename: format!("reel-{}.mp4", reel::VARIANT),
    };
    let file = stage.put(d, ctx.workspace_id, upload).await?;
    let mut r = open(d, ctx, Permission::ContentWork).await?;
    if let Some(v) = r
        .studio()
        .request_replay(USE_CASE, &i.request_key, payload)
        .await?
    {
        return read_receipt(ctx, r.as_mut(), v).await;
    }
    r.studio_control().lock_control().await?;
    // Everything is checked again in the writing transaction: a source erased, un-shared or
    // marked while the reel was drawn refuses it here.
    let stored = r.studio_materials().brand().await?;
    let tokens = stored.map(|b| b.tokens).unwrap_or_default();
    let (brand, _) = tokens.effective();
    let mut notes = Vec::new();
    let (photos, logo) = sources(r.as_mut(), i, &brand, &mut notes, ctx.now).await?;
    // The logo drawn must be the logo recorded: an AI logo never leaves the provenance.
    if logo.as_ref().map(|m| m.id) != drawn_logo {
        return Err(AppError {
            details: json!({"reason":"brand_logo_changed"}),
            ..conflict("brand_logo_changed")
        });
    }
    in_area(r.as_mut(), i.project_id, &photos).await?;
    let receipt = |material_id, reused| ReelReceipt {
        material_id,
        frames,
        duration_ms,
        brand_fallbacks: fallbacks.clone(),
        reused,
    };
    if let Some(existing) = r
        .studio_materials()
        .material_by_sha256(&file.sha256)
        .await?
    {
        if existing.composition.is_none() || existing.erased_at.is_some() {
            return Err(AppError {
                details: json!({"reason":"duplicate_material_file","material_id":existing.id}),
                ..conflict("duplicate_material_file")
            });
        }
        let existing_file = r
            .studio()
            .get_file(existing.file_id)
            .await?
            .ok_or_else(|| AppError::not_found("file"))?;
        r.studio()
            .request_receipt(
                USE_CASE,
                &i.request_key,
                payload,
                &encode(&receipt(existing.id, true))?,
            )
            .await?;
        r.commit().await?;
        return Ok(answer(
            existing_file,
            existing,
            frames,
            duration_ms,
            fallbacks,
            true,
        ));
    }
    let derived = derive(&photos, logo.as_ref())?;
    let mut sources_ids: Vec<MaterialId> = photos.iter().map(|m| m.id).collect();
    sources_ids.extend(logo.as_ref().map(|m| m.id));
    let title = i
        .title
        .clone()
        .unwrap_or_else(|| format!("{} · {}", Role::Reel.key(), reel::VARIANT));
    let mut material = Material {
        id: MaterialId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        file_id: file.id,
        mime: file.mime.clone(),
        title,
        origin: if derived.ai {
            Origin::AiGenerated {
                generator: REEL_AI_GENERATOR.into(),
            }
        } else {
            Origin::Real
        },
        binding: derived.binding,
        freed: derived.freed,
        share: derived.share,
        tags: derived.tags,
        tags_reviewed_by: None,
        people: derived.people,
        captured_at: None,
        created_by: ctx.actor.clone(),
        revision: 1,
        created_at: ctx.now,
        erased_at: None,
        upload_for: None,
        composition: Some(Composition {
            renderer: REEL_RENDERER.into(),
            role: Role::Reel,
            variant: reel::VARIANT.to_owned(),
            frame: Frame::Reel,
            sources: sources_ids.clone(),
            logo: logo.as_ref().map(|m| m.id),
        }),
    };
    if material.validate().is_err() {
        // A permission the reel cannot carry as its sources' (an agent's share of an AI image
        // that now names a person): a person decides it.
        material.share = None;
    }
    material.validate().map_err(super::library::invalid)?;
    if !material.people.is_empty() {
        r.people().lock_workspace().await?;
        check_people(r.as_mut(), material.people.iter().copied()).await?;
    }
    available(d, ctx.workspace_id, &file).await?;
    r.studio().save_file(file.clone()).await?;
    r.studio_materials()
        .insert_material(material.clone())
        .await?;
    // Created analysed: it shows what its analysed sources show, and no agent analyses it again.
    let mut source_rows = Vec::new();
    for id in &sources_ids {
        source_rows.push(r.studio_materials().get_intelligence(*id).await?);
    }
    r.studio_materials()
        .save_intelligence(super::library::composed_record(
            &material,
            &source_rows,
            ctx.now,
        ))
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.reel.rendered",
            "studio_material",
            material.id,
            json!({
                "file_id": file.id,
                "sha256": file.sha256,
                "size_bytes": file.size_bytes,
                "mime": file.mime,
                "frames": frames,
                "duration_ms": duration_ms,
                "sources": sources_ids,
                "ai_generated": material.is_ai(),
                "share": material.share.as_ref().map(|s| s.permission),
            }),
        )?)
        .await?;
    r.studio()
        .request_receipt(
            USE_CASE,
            &i.request_key,
            payload,
            &encode(&receipt(material.id, false))?,
        )
        .await?;
    stage.commit_started = true;
    r.commit().await?;
    Ok(answer(
        file,
        material,
        frames,
        duration_ms,
        fallbacks,
        false,
    ))
}

/// The strict input schema of `studio.reel_render`.
pub fn schema() -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    // Texts are measured by the server, which names the slot and its limits when one does not
    // fit (`text_overflow`); the schema only bounds them.
    let text = json!({"type":["string","null"],"minLength":1,"maxLength":200});
    json!({
        "type":"object","additionalProperties":false,
        "properties":{
            "request_key":{"type":"string","minLength":1,"maxLength":200},
            "photos":{"type":"array","minItems":1,"maxItems":16,
                "items":{"type":"object","additionalProperties":false,
                    "properties":{
                        "material_id":uuid,
                        "text":text.clone(),
                        "focus_x":{"type":["number","null"],"minimum":0,"maximum":1},
                        "focus_y":{"type":["number","null"],"minimum":0,"maximum":1}},
                    "required":["material_id"]}},
            "title_text":text.clone(),
            "closing":{"type":["object","null"],"additionalProperties":false,
                "properties":{
                    "heading":text.clone(),
                    "site":text.clone(),
                    "slogan":text.clone()}},
            "photo_ms":{"type":["integer","null"],"minimum":reel::PHOTO_MS.0,"maximum":reel::PHOTO_MS.1},
            "project_id":{"type":["string","null"],"format":"uuid"},
            "title":{"type":["string","null"],"minLength":1,"maxLength":120},
        },
        "required":["request_key","photos"],
    })
}
