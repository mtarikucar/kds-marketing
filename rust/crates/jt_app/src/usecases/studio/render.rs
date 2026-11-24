//! Composed posts: a carousel slide or a story frame the server draws from the workspace's own
//! photo materials, a fixed template and short texts, in the workspace's brand tokens
//! (`studio.post_templates`, `studio.post_render`, `studio.brand_get`, `studio.brand_set`).
//!
//! A render is stored exactly as an upload is (a Studio file) and added to the library as a
//! material at once, so the answer names the `file_id` a piece shows and the `material_id` a
//! post proposal names. The material's origin is the server's to give, never the caller's: it is
//! real when every source is, AI-generated (generator `jeeta-compose`) when any source is, and
//! its `composition` records the template and the sources. Its binding, people, `depicts` and
//! share permission come from the sources (the most restrictive permission; none when a source
//! has none).
//!
//! Variety: consecutive posts of a workspace must not open alike. The workspace's composed
//! materials are its render history; a cover in the variant of the workspace's last rendered
//! cover is refused (`CONFLICT` `cover_variant_repeats`, naming the next variant) unless the
//! caller passes `allow_repeat`. `studio.post_templates` names the last variants and the next.
use super::files::{Staging, available, decode, encode, key};
use super::library::{check_people, conflict, open, refused};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        compose::{BrandRecord, ComposeError, ComposeJob, OutputFormat, Rect, SourceImage},
        files::StoredFile,
        materials::{
            Binding, HumanMark, Material, MaterialId, Origin, Quality, ShareDecision,
            SharePermission, Tags,
        },
    },
    usecases::{Deps, ledger_entry},
};
use jt_studio::compose::{
    BrandFallback, BrandTokens, COMPOSED_AI_GENERATOR, Composition, Frame, RENDERER, Role,
    SlotKind, Template, TextRefusal, check_text, next_cover_variant, template, templates,
};
use jt_studio::{MAX_MATERIAL_LABELS, MAX_MATERIAL_TITLE_CHARS, MediaUpload};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

/// The image types a source may have: what the renderer decodes.
const SOURCE_MIMES: &[&str] = &["image/jpeg", "image/png", "image/webp"];
/// The largest stored source (a photo or the logo) the renderer reads, in bytes: refused from
/// its stored size before any byte is read.
pub const SOURCE_BYTES_LIMIT: u64 = 25_000_000;
/// How many earlier renders the template listing names.
const RECENT: usize = 12;

fn permissions(id: &str) -> &'static [Permission] {
    super::permissions::for_use_case(id)
}

/// A photo slot's material, and the point of it a crop keeps in view.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhotoRef {
    pub material_id: MaterialId,
    /// 0 (left) to 1 (right); the middle by default.
    #[serde(default)]
    pub focus_x: Option<f32>,
    /// 0 (top) to 1 (bottom); the middle by default.
    #[serde(default)]
    pub focus_y: Option<f32>,
}

/// A slide's place in its carousel.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Counter {
    pub index: u8,
    pub total: u8,
}

/// `studio.post_render`'s input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostRenderInput {
    pub request_key: String,
    /// The template's role (`cover`, `steps`, `moment`…).
    pub role: String,
    pub variant: String,
    /// Each text slot's text, by slot key, drawn exactly as given.
    #[serde(default)]
    pub texts: BTreeMap<String, String>,
    /// Each photo slot's material, by slot key.
    #[serde(default)]
    pub photos: BTreeMap<String, PhotoRef>,
    /// A slide's place in its carousel ("2/7"); none on a story.
    #[serde(default)]
    pub counter: Option<Counter>,
    /// `jpeg` (the default: what Instagram takes for stories and feed images) or `png`.
    #[serde(default)]
    pub output: OutputFormat,
    /// Render a cover in the variant of the workspace's last rendered cover anyway.
    #[serde(default)]
    pub allow_repeat: bool,
    /// The material's title; "`role` · `variant`" by default.
    #[serde(default)]
    pub title: Option<String>,
}

/// `studio.post_render`'s answer: what the next call needs.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostRenderOut {
    /// The stored file, as `studio.file_upload` answers it: a piece names `file.id`.
    pub file: StoredFile,
    /// The library material made of it: a post proposal names `material.id`.
    pub material: Material,
    /// Whether any source is AI-generated: the material is then AI-generated, for labelling.
    pub ai_generated: bool,
    pub role: Role,
    pub variant: String,
    pub frame: Frame,
    pub width: u32,
    pub height: u32,
    /// The area left empty for the platform's own sticker (a poll, a link) on a story.
    #[serde(default)]
    pub sticker_area: Option<Rect>,
    /// Brand colours drawn otherwise than set, and why.
    #[serde(default)]
    pub brand_fallbacks: Vec<BrandFallback>,
    /// The same image was rendered before: its material is answered, nothing new is stored.
    #[serde(default)]
    pub reused: bool,
    pub next: String,
}

/// What `studio.post_render`'s request key keeps: ids and the drawing's facts, never the texts.
#[derive(Serialize, Deserialize)]
struct RenderReceipt {
    material_id: MaterialId,
    width: u32,
    height: u32,
    sticker_area: Option<Rect>,
    brand_fallbacks: Vec<BrandFallback>,
    reused: bool,
}

/// One earlier render, from the library.
#[derive(Clone, Debug, Serialize)]
pub struct RecentRender {
    pub material_id: MaterialId,
    pub role: Role,
    pub variant: String,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
}

/// The cover rotation: the variant of the workspace's last rendered cover and the one to use
/// next.
#[derive(Clone, Debug, Serialize)]
pub struct CoverRotation {
    pub last_variant: Option<String>,
    pub next_variant: &'static str,
}

/// `studio.post_templates`' answer.
#[derive(Clone, Debug, Serialize)]
pub struct PostTemplatesOut {
    pub templates: Vec<Template>,
    pub cover: CoverRotation,
    /// The last variant rendered of each role.
    pub last_variants: BTreeMap<String, String>,
    /// The latest renders, newest first.
    pub recent: Vec<RecentRender>,
    pub brand: BrandOut,
    pub rules: Vec<&'static str>,
}

/// The workspace's brand tokens: as set (the defaults when never set), as drawn, and why they
/// differ.
#[derive(Clone, Debug, Serialize)]
pub struct BrandOut {
    pub tokens: BrandTokens,
    pub effective: BrandTokens,
    pub fallbacks: Vec<BrandFallback>,
    /// Never set: the neutral defaults apply.
    pub is_default: bool,
    pub revision: u64,
    pub fonts: Vec<&'static str>,
}

/// `studio.brand_set`'s input: every token, replacing the stored ones.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrandSetInput {
    pub tokens: BrandTokens,
    /// The revision `studio.brand_get` answered (0 when never set).
    pub expected_revision: u64,
}

fn brand_out(record: Option<BrandRecord>) -> BrandOut {
    let (tokens, revision, is_default) = match record {
        Some(r) => (r.tokens, r.revision, false),
        None => (BrandTokens::default(), 0, true),
    };
    let (effective, fallbacks) = tokens.effective();
    BrandOut {
        tokens,
        effective,
        fallbacks,
        is_default,
        revision,
        fonts: jt_studio::compose::FontFamily::ALL
            .iter()
            .map(|f| f.key())
            .collect(),
    }
}

/// The workspace's composed materials, newest first.
fn renders(materials: &[Material]) -> Vec<RecentRender> {
    let mut out: Vec<RecentRender> = materials
        .iter()
        .filter_map(|m| {
            m.composition.as_ref().map(|c| RecentRender {
                material_id: m.id,
                role: c.role,
                variant: c.variant.clone(),
                created_at: m.created_at,
            })
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.material_id)));
    out
}

fn last_cover(history: &[RecentRender]) -> Option<String> {
    history
        .iter()
        .find(|r| r.role == Role::Cover)
        .map(|r| r.variant.clone())
}

/// Lists the templates (roles, variants, slots and their limits), the workspace's brand tokens,
/// and its render history: the last variant of each role and the cover to use next.
pub async fn post_templates(d: &Deps, ctx: &Ctx) -> Result<PostTemplatesOut, AppError> {
    ctx.require_any(permissions("studio.post_templates"))?;
    let mut r = open(d, ctx, Permission::ContentWork).await?;
    let history = renders(&r.studio_materials().list_materials().await?);
    let brand = brand_out(r.studio_materials().brand().await?);
    let last = last_cover(&history);
    let mut last_variants = BTreeMap::new();
    for h in history.iter().rev() {
        last_variants.insert(h.role.key().to_owned(), h.variant.clone());
    }
    Ok(PostTemplatesOut {
        templates: templates(),
        cover: CoverRotation {
            next_variant: next_cover_variant(last.as_deref()),
            last_variant: last,
        },
        last_variants,
        recent: history.into_iter().take(RECENT).collect(),
        brand,
        rules: vec![
            "Texts are drawn exactly as given: no casing is changed, nothing is shortened. A text over a slot's max_chars, or one that needs more than its max_lines at the template's size, is refused (VALIDATION text_overflow naming the slot and its limits): shorten it.",
            "Photo slots take material ids of live, filed JPEG, PNG or WebP materials; a not_shareable one is refused. Every photo bound to an olay must be the same olay.",
            "A cover in the variant of the workspace's last rendered cover is refused (CONFLICT cover_variant_repeats) unless allow_repeat is true: use cover.next_variant. Vary the other roles too (last_variants).",
            "Stories keep their top and bottom 250 px free of text; a question or item story leaves sticker_area empty for the platform's poll or link sticker.",
            "The answer's file.id goes in a piece (jeeta.studio.piece_submit), its material.id in a post proposal (jeeta.studio.posts_propose). Output is JPEG by default: Instagram takes JPEG for stories and feed images.",
        ],
    })
}

/// Reads the workspace's brand tokens.
pub async fn brand_get(d: &Deps, ctx: &Ctx) -> Result<BrandOut, AppError> {
    ctx.require_any(permissions("studio.brand_get"))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    super::chain::active(r.as_mut()).await?;
    Ok(brand_out(r.studio_materials().brand().await?))
}

/// Replaces the workspace's brand tokens at `expected_revision`. Colours are `#rrggbb`; a pair
/// under WCAG AA large-text contrast is stored as given and drawn with the fallback the answer
/// names. A logo is a live image material of the workspace.
pub async fn brand_set(d: &Deps, ctx: &Ctx, i: BrandSetInput) -> Result<BrandOut, AppError> {
    ctx.require_any(permissions("studio.brand_set"))?;
    i.tokens.validate().map_err(|_| {
        refused(
            "brand_name",
            "brand_name_invalid",
            "the brand name is one line of at most 32 characters, without leading or trailing spaces",
        )
    })?;
    let uncovered = d.compositor.uncovered(&i.tokens.brand_name);
    if !uncovered.is_empty() {
        return Err(AppError::validation(
            "the brand name holds a character no bundled font draws",
            json!({"field":"brand_name","reason":"unsupported_character",
                   "characters": uncovered.iter().map(char::to_string).collect::<Vec<_>>()}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    super::chain::active(r.as_mut()).await?;
    if let Some(logo) = i.tokens.logo_material_id {
        let blocked = super::library::blocked_derivatives(r.as_mut()).await?;
        source(r.as_mut(), logo, "logo_material_id", &blocked).await?;
    }
    let stored = r.studio_materials().brand().await?;
    let revision = stored.as_ref().map_or(0, |b| b.revision);
    if revision != i.expected_revision {
        return Err(AppError {
            details: json!({"reason":"brand_revision_changed","revision":revision}),
            ..conflict("brand_revision_changed")
        });
    }
    let record = BrandRecord {
        tokens: i.tokens,
        revision: revision + 1,
        updated_at: ctx.now,
    };
    r.studio_materials().save_brand(record.clone()).await?;
    let out = brand_out(Some(record));
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.brand.set",
            "studio_brand",
            ctx.workspace_id,
            json!({
                "revision": out.revision,
                "heading_font": out.tokens.heading_font.key(),
                "body_font": out.tokens.body_font.key(),
                "logo": out.tokens.logo_material_id.is_some(),
                "fallbacks": out.fallbacks.iter().map(|f| f.token.clone()).collect::<Vec<_>>(),
            }),
        )?)
        .await?;
    r.commit().await?;
    Ok(out)
}

/// A live, filed image material the renderer can draw, for `field`.
async fn source(
    r: &mut dyn TenantRepos,
    id: MaterialId,
    field: &str,
    blocked: &BTreeSet<MaterialId>,
) -> Result<Material, AppError> {
    let m = r
        .studio_materials()
        .get_material(id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))?;
    let file = r
        .studio()
        .get_file(m.file_id)
        .await?
        .filter(|f| f.deleted_at.is_none());
    let reason = if m.erased_at.is_some() || file.is_none() {
        Some(("source_erased", "the material is erased"))
    } else if file
        .as_ref()
        .is_some_and(|f| f.size_bytes > SOURCE_BYTES_LIMIT)
    {
        Some((
            "source_too_large",
            "a source is at most 25 MB; upload a smaller copy",
        ))
    } else if m.is_unfiled() {
        Some((
            "source_unfiled",
            "the material is not filed into an olay or genel yet",
        ))
    } else if !SOURCE_MIMES.contains(&m.mime.trim().to_ascii_lowercase().as_str()) {
        Some((
            "source_not_image",
            "only JPEG, PNG and WebP materials are drawn",
        ))
    } else if m
        .share
        .as_ref()
        .is_some_and(|s| s.permission == SharePermission::NotShareable)
    {
        Some(("source_not_shareable", "the material may not be shared"))
    } else if blocked.contains(&m.id) {
        // A derivative whose own source is restricted now (the publication fence): drawing it
        // would launder the restriction into a new material.
        Some((
            "source_restricted",
            "a material it was made from may not be shared now",
        ))
    } else {
        None
    };
    match reason {
        Some((reason, message)) => Err(AppError::validation(
            message,
            json!({"field": field, "reason": reason, "material_id": id}),
        )),
        None => Ok(m),
    }
}

/// The checked template and texts of a render.
fn checked_template(i: &PostRenderInput) -> Result<Template, AppError> {
    let role = Role::parse(&i.role).ok_or_else(|| {
        AppError::validation(
            "unknown role",
            json!({"field":"role","reason":"unknown_template",
                   "roles": Role::ALL.iter().map(|r| r.key()).collect::<Vec<_>>()}),
        )
    })?;
    let t = template(role, &i.variant).ok_or_else(|| {
        AppError::validation(
            "unknown variant",
            json!({"field":"variant","reason":"unknown_template",
                   "variants": role.variants().iter().map(|(v, _)| *v).collect::<Vec<_>>()}),
        )
    })?;
    for (key, text) in &i.texts {
        let slot = t
            .slot(key)
            .filter(|s| s.kind != SlotKind::Photo)
            .ok_or_else(|| refused(key, "unknown_slot", "the template has no such text slot"))?;
        check_text(slot, text).map_err(|e| match e {
            TextRefusal::TooLong => overflow(key, slot.max_chars, slot.max_lines, Cause::TooLong),
            TextRefusal::ControlCharacter => refused(
                key,
                "invalid_text",
                "a text holds no control character but a line feed",
            ),
            TextRefusal::Empty => refused(key, "empty_text", "leave an empty slot out"),
        })?;
    }
    for key in i.photos.keys() {
        t.slot(key)
            .filter(|s| s.kind == SlotKind::Photo)
            .ok_or_else(|| refused(key, "unknown_slot", "the template has no such photo slot"))?;
    }
    for slot in t.slots.iter().filter(|s| s.required) {
        let given = match slot.kind {
            SlotKind::Photo => i.photos.contains_key(slot.key),
            _ => i.texts.contains_key(slot.key),
        };
        if !given {
            return Err(refused(
                slot.key,
                "slot_required",
                "the template needs this slot",
            ));
        }
    }
    for p in i.photos.values() {
        for f in [p.focus_x, p.focus_y].into_iter().flatten() {
            if !(0.0..=1.0).contains(&f) {
                return Err(refused("focus", "focus_out_of_range", "a focus is 0 to 1"));
            }
        }
    }
    match (t.frame, i.counter) {
        (Frame::Story, Some(_)) => {
            return Err(refused(
                "counter",
                "story_counter",
                "a story has no slide counter",
            ));
        }
        (_, Some(c)) if c.index == 0 || c.index > c.total || c.total > 20 => {
            return Err(refused(
                "counter",
                "counter_range",
                "1 <= index <= total <= 20",
            ));
        }
        _ => {}
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
    Ok(t)
}

/// Why a text does not fit its slot.
enum Cause {
    /// Over the slot's `max_chars`.
    TooLong,
    /// More lines than the slot has.
    Lines(usize),
    /// One word wider than the slot on its own.
    WordTooWide(String),
}

fn overflow(slot: &str, max_chars: Option<u16>, max_lines: Option<u8>, cause: Cause) -> AppError {
    let mut details = json!({"field": slot, "reason": "text_overflow", "slot": slot,
        "max_chars": max_chars, "max_lines": max_lines});
    let hint = match cause {
        Cause::TooLong => {
            details["cause"] = json!("too_long");
            "shorten it".to_owned()
        }
        Cause::Lines(n) => {
            details["cause"] = json!("too_many_lines");
            details["lines_needed"] = json!(n);
            format!("it needs {n} lines; shorten it")
        }
        Cause::WordTooWide(word) => {
            details["cause"] = json!("word_too_wide");
            details["word"] = json!(word);
            format!("the word {word:?} is wider than the slot; use a shorter word")
        }
    };
    AppError::validation(
        format!(
            "the text of {slot} does not fit: at most {} characters on {} line(s); {hint}",
            max_chars.unwrap_or(0),
            max_lines.unwrap_or(1)
        ),
        details,
    )
}

fn compose_error(e: ComposeError) -> AppError {
    match e {
        ComposeError::Overflow {
            slot,
            max_chars,
            max_lines,
            lines_needed,
            word_too_wide,
        } => overflow(
            &slot,
            Some(max_chars),
            Some(max_lines),
            match word_too_wide {
                Some(word) => Cause::WordTooWide(word),
                None => Cause::Lines(lines_needed.unwrap_or(usize::from(max_lines) + 1)),
            },
        ),
        ComposeError::Collision { slot, with } => AppError::validation(
            format!("the text of {slot} runs into the {with}; shorten it"),
            json!({"field": slot, "reason": "text_overflow", "slot": slot,
                   "cause": "collides", "with": with}),
        ),
        ComposeError::UnsupportedCharacter { slot, character } => AppError::validation(
            format!("no bundled font draws {character:?} in {slot}"),
            json!({"field": slot, "reason": "unsupported_character", "character": character.to_string()}),
        ),
        ComposeError::Image { slot, reason } => AppError::validation(
            format!("the image of {slot} cannot be drawn: {reason}"),
            json!({"field": slot, "reason": "source_unreadable"}),
        ),
        ComposeError::MissingSlot { slot } => {
            refused(&slot, "slot_required", "the template needs this slot")
        }
        ComposeError::Busy => AppError {
            code: crate::error::ErrorCode::UpstreamUnavailable,
            message: "the renderer is busy; try again shortly".into(),
            details: json!({"reason":"renderer_busy"}),
        },
        ComposeError::Internal(m) => AppError::internal(m),
    }
}

/// What a composition takes from its sources: where it belongs, who it shows and whether it may
/// be shared.
struct Derived {
    binding: Binding,
    freed: Option<HumanMark>,
    ai: bool,
    share: Option<ShareDecision>,
    tags: Tags,
    people: BTreeSet<uuid::Uuid>,
}

fn derive(photos: &[Material], logo: Option<&Material>) -> Result<Derived, AppError> {
    let all: Vec<&Material> = photos.iter().chain(logo).collect();
    let ai = all.iter().any(|m| m.is_ai());
    let olays: BTreeSet<_> = photos.iter().filter_map(|m| m.olay_id()).collect();
    let (binding, freed) = match olays.len() {
        0 => {
            // Genel photos only: a real composition stays genel as its sources were freed.
            let freed = photos
                .iter()
                .filter_map(|m| m.freed.clone())
                .max_by_key(|f| f.at);
            if !ai && freed.is_none() {
                return Err(refused(
                    "photos",
                    "source_not_freed",
                    "a genel real photo must have been freed by a person",
                ));
            }
            (Binding::Genel, if ai { None } else { freed })
        }
        1 => (
            Binding::Olay {
                olay_id: *olays.iter().next().expect("one olay"),
            },
            None,
        ),
        _ => {
            return Err(refused(
                "photos",
                "mixed_olays",
                "every photo bound to an olay must be the same olay",
            ));
        }
    };
    // The most restrictive permission of the sources; none when any source has none.
    let share = if all.iter().all(|m| m.share.is_some()) {
        all.iter()
            .filter_map(|m| m.share.clone())
            .max_by_key(|s| match s.permission {
                SharePermission::Shareable => (0, s.by.is_some()),
                SharePermission::ProductOnly => (1, s.by.is_some()),
                SharePermission::NotShareable => (2, s.by.is_some()),
            })
    } else {
        None
    };
    let mut tags = Tags {
        quality: Some(Quality::Publishable),
        ..Tags::default()
    };
    let mut people = BTreeSet::new();
    for m in &all {
        tags.product_groups
            .extend(m.tags.product_groups.iter().copied());
        tags.doors.extend(m.tags.doors.iter().copied());
        tags.content_types
            .extend(m.tags.content_types.iter().copied());
        tags.depicts.extend(m.tags.depicts.iter().copied());
        people.extend(m.people.iter().copied());
    }
    tags.labels = photos
        .iter()
        .flat_map(|m| m.tags.labels.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_MATERIAL_LABELS)
        .collect();
    Ok(Derived {
        binding,
        freed,
        ai,
        share,
        tags,
        people,
    })
}

/// Loads and checks the sources of `i`: the photos in slot order, then the logo (dropped, with
/// a fallback note, when it can no longer be drawn).
async fn sources(
    r: &mut dyn TenantRepos,
    t: &Template,
    i: &PostRenderInput,
    brand: &BrandTokens,
    notes: &mut Vec<BrandFallback>,
) -> Result<(Vec<(String, Material)>, Option<Material>), AppError> {
    let blocked = super::library::blocked_derivatives(r).await?;
    let mut photos = Vec::new();
    for slot in t.slots.iter().filter(|s| s.kind == SlotKind::Photo) {
        if let Some(p) = i.photos.get(slot.key) {
            photos.push((
                slot.key.to_owned(),
                source(r, p.material_id, slot.key, &blocked).await?,
            ));
        }
    }
    let logo = match brand.logo_material_id {
        Some(id) => match source(r, id, "logo_material_id", &blocked).await {
            Ok(m) => Some(m),
            Err(_) => {
                notes.push(BrandFallback {
                    token: "logo_material_id".into(),
                    given: brand.background,
                    used: brand.background,
                    reason: "the logo material can no longer be drawn; the brand name's first letter is drawn instead".into(),
                });
                None
            }
        },
        None => None,
    };
    Ok((photos, logo))
}

async fn read_receipt(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    v: Value,
    t: &Template,
) -> Result<PostRenderOut, AppError> {
    let receipt: RenderReceipt = decode(v)?;
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
        t,
        receipt.width,
        receipt.height,
        receipt.sticker_area,
        receipt.brand_fallbacks,
        receipt.reused,
    ))
}

#[allow(clippy::too_many_arguments)]
fn answer(
    file: StoredFile,
    material: Material,
    t: &Template,
    width: u32,
    height: u32,
    sticker_area: Option<Rect>,
    brand_fallbacks: Vec<BrandFallback>,
    reused: bool,
) -> PostRenderOut {
    let next = match t.frame {
        Frame::Slide => {
            "Name file.id among the piece's media in order (jeeta.studio.piece_submit, a carousel of 2-10 slides) or material.id in a post proposal (jeeta.studio.posts_propose, format carousel or feed_post)."
        }
        Frame::Story => {
            "Name file.id as the piece's one medium (jeeta.studio.piece_submit) or material.id in a story proposal (jeeta.studio.posts_propose, format story); leave sticker_area for the platform's sticker."
        }
    };
    PostRenderOut {
        ai_generated: material.is_ai(),
        file,
        material,
        role: t.role,
        variant: t.variant.to_owned(),
        frame: t.frame,
        width,
        height,
        sticker_area,
        brand_fallbacks,
        reused,
        next: next.into(),
    }
}

/// Renders a slide or a story frame and adds it to the library (see the module documentation).
/// Replayed by `request_key`.
pub async fn post_render(
    d: &Deps,
    ctx: &Ctx,
    i: PostRenderInput,
) -> Result<PostRenderOut, AppError> {
    ctx.require_any(permissions("studio.post_render"))?;
    key(&i.request_key)?;
    let t = checked_template(&i)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    let mut r = open(d, ctx, Permission::ContentWork).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.post_render", &i.request_key, &payload)
        .await?
    {
        return read_receipt(ctx, r.as_mut(), v, &t).await;
    }
    let stored = r.studio_materials().brand().await?;
    let tokens = stored.map(|b| b.tokens).unwrap_or_default();
    let (brand, mut fallbacks) = tokens.effective();
    let (photos, logo) = sources(r.as_mut(), &t, &i, &brand, &mut fallbacks).await?;
    check_variety(r.as_mut(), &t, &i).await?;
    let photo_materials: Vec<Material> = photos.iter().map(|(_, m)| m.clone()).collect();
    derive(&photo_materials, logo.as_ref())?;
    drop(r);

    // A turn to render first: a render waiting for its turn holds no source in memory.
    let ticket = d.compositor.reserve().await.map_err(compose_error)?;
    // The sources' bytes, read outside any transaction.
    let mut images = BTreeMap::new();
    for (slot, m) in &photos {
        let bytes = d.files.read(ctx.workspace_id, m.file_id).await?;
        let p = &i.photos[slot];
        images.insert(
            slot.clone(),
            SourceImage {
                bytes: bytes.bytes,
                mime: m.mime.clone(),
                focus: (p.focus_x.unwrap_or(0.5), p.focus_y.unwrap_or(0.5)),
            },
        );
    }
    let logo_image = match &logo {
        Some(m) => Some(SourceImage {
            bytes: d.files.read(ctx.workspace_id, m.file_id).await?.bytes,
            mime: m.mime.clone(),
            focus: (0.5, 0.5),
        }),
        None => None,
    };
    let composed = d
        .compositor
        .compose(
            ticket,
            ComposeJob {
                template: t.clone(),
                texts: i.texts.clone(),
                photos: images,
                logo: logo_image,
                brand: BrandTokens {
                    logo_material_id: logo.as_ref().map(|m| m.id),
                    ..brand
                },
                counter: i.counter.map(|c| (c.index, c.total)),
                output: i.output,
            },
        )
        .await
        .map_err(compose_error)?;

    let drawn_logo = logo.as_ref().map(|m| m.id);
    let mut stage = Staging::new();
    let result = store(
        d, ctx, &i, &t, &payload, composed, fallbacks, drawn_logo, &mut stage,
    )
    .await;
    stage.compensate(d, ctx.workspace_id).await;
    result
}

/// A cover in the variant of the workspace's last rendered cover is refused unless the caller
/// allows the repeat.
async fn check_variety(
    r: &mut dyn TenantRepos,
    t: &Template,
    i: &PostRenderInput,
) -> Result<(), AppError> {
    if t.role != Role::Cover || i.allow_repeat {
        return Ok(());
    }
    let history = renders(&r.studio_materials().list_materials().await?);
    let last = last_cover(&history);
    if last.as_deref() == Some(t.variant) {
        let next = next_cover_variant(last.as_deref());
        return Err(AppError {
            message: format!(
                "the workspace's last rendered cover is {}: use {next}, or pass allow_repeat",
                t.variant
            ),
            details: json!({"reason":"cover_variant_repeats","last_variant":t.variant,"next_variant":next}),
            ..conflict("cover_variant_repeats")
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn store(
    d: &Deps,
    ctx: &Ctx,
    i: &PostRenderInput,
    t: &Template,
    payload: &Value,
    composed: crate::ports::compose::Composed,
    fallbacks: Vec<BrandFallback>,
    drawn_logo: Option<MaterialId>,
    stage: &mut Staging,
) -> Result<PostRenderOut, AppError> {
    let ext = i.output.extension();
    let upload = MediaUpload {
        bytes: composed.bytes,
        mime: composed.mime.to_owned(),
        filename: format!("{}-{}.{ext}", t.role.key(), t.variant),
    };
    let file = stage.put(d, ctx.workspace_id, upload).await?;
    let mut r = open(d, ctx, Permission::ContentWork).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.post_render", &i.request_key, payload)
        .await?
    {
        return read_receipt(ctx, r.as_mut(), v, t).await;
    }
    r.studio_control().lock_control().await?;
    let stored = r.studio_materials().brand().await?;
    let tokens = stored.map(|b| b.tokens).unwrap_or_default();
    let (brand, _) = tokens.effective();
    let mut notes = Vec::new();
    let (photos, logo) = sources(r.as_mut(), t, i, &brand, &mut notes).await?;
    // The logo drawn must be the logo recorded: an AI logo never leaves the provenance.
    if logo.as_ref().map(|m| m.id) != drawn_logo {
        return Err(AppError {
            details: json!({"reason":"brand_logo_changed"}),
            ..conflict("brand_logo_changed")
        });
    }
    check_variety(r.as_mut(), t, i).await?;
    let receipt = |material_id, reused| RenderReceipt {
        material_id,
        width: composed.width,
        height: composed.height,
        sticker_area: composed.sticker_area,
        brand_fallbacks: fallbacks.clone(),
        reused,
    };
    // The same bytes rendered before: that composition is answered (its staged copy goes).
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
                "studio.post_render",
                &i.request_key,
                payload,
                &encode(&receipt(existing.id, true))?,
            )
            .await?;
        r.commit().await?;
        return Ok(answer(
            existing_file,
            existing,
            t,
            composed.width,
            composed.height,
            composed.sticker_area,
            fallbacks,
            true,
        ));
    }
    let photo_materials: Vec<Material> = photos.iter().map(|(_, m)| m.clone()).collect();
    let derived = derive(&photo_materials, logo.as_ref())?;
    let mut sources_ids: Vec<MaterialId> = photo_materials.iter().map(|m| m.id).collect();
    sources_ids.extend(logo.as_ref().map(|m| m.id));
    let title = i
        .title
        .clone()
        .unwrap_or_else(|| format!("{} · {}", t.role.key(), t.variant));
    let mut material = Material {
        id: MaterialId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        file_id: file.id,
        mime: file.mime.clone(),
        title,
        origin: if derived.ai {
            Origin::AiGenerated {
                generator: COMPOSED_AI_GENERATOR.into(),
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
            renderer: RENDERER.into(),
            role: t.role,
            variant: t.variant.to_owned(),
            frame: t.frame,
            sources: sources_ids.clone(),
        }),
    };
    if material.validate().is_err() {
        // A permission the composition cannot carry as its sources' (an agent's share of an AI
        // image that now names a person): a person decides it.
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
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.post.rendered",
            "studio_material",
            material.id,
            json!({
                "file_id": file.id,
                "sha256": file.sha256,
                "size_bytes": file.size_bytes,
                "mime": file.mime,
                "role": t.role.key(),
                "variant": t.variant,
                "sources": sources_ids,
                "ai_generated": material.is_ai(),
                "allow_repeat": i.allow_repeat,
                "share": material.share.as_ref().map(|s| s.permission),
            }),
        )?)
        .await?;
    r.studio()
        .request_receipt(
            "studio.post_render",
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
        t,
        composed.width,
        composed.height,
        composed.sticker_area,
        fallbacks,
        false,
    ))
}

/// The strict input schemas of the composed-post tools.
pub fn schema(action: &str) -> Option<Value> {
    let color = json!({"type":"string","pattern":"^#[0-9A-Fa-f]{6}$"});
    let font = json!({"enum": jt_studio::compose::FontFamily::ALL.iter().map(|f| f.key()).collect::<Vec<_>>()});
    let uuid = json!({"type":"string","format":"uuid"});
    let object = |properties: Value, required: &[&str]| json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
    Some(match action {
        "post_templates" | "brand_get" => object(json!({}), &[]),
        "post_render" => object(
            json!({
                "request_key":{"type":"string","minLength":1,"maxLength":200},
                "role":{"enum": Role::ALL.iter().map(|r| r.key()).collect::<Vec<_>>()},
                "variant":{"type":"string","minLength":1,"maxLength":40},
                "texts":{"type":"object","maxProperties":16,"additionalProperties":{"type":"string","minLength":1,"maxLength":200}},
                "photos":{"type":"object","maxProperties":4,"additionalProperties":object(
                    json!({"material_id":uuid,
                           "focus_x":{"type":["number","null"],"minimum":0,"maximum":1},
                           "focus_y":{"type":["number","null"],"minimum":0,"maximum":1}}),
                    &["material_id"])},
                "counter":{"type":["object","null"],"additionalProperties":false,
                           "properties":{"index":{"type":"integer","minimum":1,"maximum":20},
                                         "total":{"type":"integer","minimum":1,"maximum":20}},
                           "required":["index","total"]},
                "output":{"enum":["jpeg","png"]},
                "allow_repeat":{"type":"boolean"},
                "title":{"type":["string","null"],"minLength":1,"maxLength":120},
            }),
            &["request_key", "role", "variant"],
        ),
        "brand_set" => object(
            json!({
                "tokens": object(json!({
                    "background":color,"ink":color,"accent":color,"muted":color,
                    "heading_font":font,"body_font":font,
                    "brand_name":{"type":"string","maxLength":32},
                    "logo_material_id":{"type":["string","null"],"format":"uuid"},
                }), &["background","ink","accent","muted","heading_font","body_font"]),
                "expected_revision":{"type":"integer","minimum":0},
            }),
            &["tokens", "expected_revision"],
        ),
        _ => return None,
    })
}
