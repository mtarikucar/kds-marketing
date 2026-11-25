//! Composed posts (`studio.post_render`, `studio.post_templates`, `studio.brand_*`): a render is
//! stored and added to the library at once, its origin is the server's (AI when any source is),
//! it is replayed by its key, a cover never repeats the last one's variant unless allowed, a text
//! that does not fit is refused, and the brand tokens fall back where their contrast is too low.
//! Test images are generated here; no photo is used.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageBuffer, Rgb, RgbImage};
use jt_app::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    usecases::studio::{files, library, projects, render},
};
use jt_studio::compose::{BrandTokens, COMPOSED_AI_GENERATOR, Color};
use jt_studio::*;
use jt_tenancy::Permission;
use serde_json::{Value, json};
use std::sync::Arc;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

/// A generated gradient PNG, distinct per `seed`.
fn png(seed: u8) -> Vec<u8> {
    let img: RgbImage = ImageBuffer::from_fn(320, 240, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, seed])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn world() -> World {
    let (mut w, _) = publishing_world().await;
    w.d.compositor = Arc::new(jt_render::Renderer::new(jt_render::Limits::default()));
    w
}

async fn upload(w: &World, key: &str, seed: u8) -> FileId {
    files::file_upload(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":key,"filename":"p.png","mime":"image/png",
            "content":{"kind":"bytes_base64","data":STANDARD.encode(png(seed))}}),
        ),
    )
    .await
    .unwrap()
    .id
}

/// Marks `id`'s analysis complete, as an agent's completion would.
async fn analysed(w: &World, id: MaterialId) {
    use jt_app::ports::{
        UnitOfWork,
        materials::{AnalysisStatus, DateSource, MaterialAnalysisRecord},
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let m = r
        .studio_materials()
        .get_material(id)
        .await
        .unwrap()
        .unwrap();
    let mut row = MaterialAnalysisRecord::pending(id, w.ctx.now, DateSource::Unknown);
    row.intelligence.status = AnalysisStatus::Completed;
    row.intelligence.analyzed_revision = Some(m.revision);
    row.intelligence.analyzed_at = Some(w.ctx.now);
    r.studio_materials().save_intelligence(row).await.unwrap();
    r.commit().await.unwrap();
}

/// A real, shareable, publishable photo of a confirmed olay, added by the owner and analysed.
async fn real_photo(w: &World, key: &str, seed: u8, olay: OlayId) -> Material {
    let m = unanalysed_photo(w, key, seed, olay).await;
    analysed(w, m.id).await;
    m
}

/// [`real_photo`] before its analysis.
async fn unanalysed_photo(w: &World, key: &str, seed: u8, olay: OlayId) -> Material {
    let file = upload(w, &format!("f-{key}"), seed).await;
    library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":key,"file_id":file,"origin":{"kind":"real"},
            "olay_id":olay,"share":"shareable","quality":"publishable","labels":["atölye"]}),
        ),
    )
    .await
    .unwrap()
    .material
}

async fn olay(w: &World) -> OlayId {
    library::olay_create(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"olay","kind":"workshop","title":"Atölye",
            "starts_on":"2026-11-16","ends_on":"2026-11-16"}),
        ),
    )
    .await
    .unwrap()
    .id
}

fn cover(key: &str, variant: &str, photo: MaterialId) -> render::PostRenderInput {
    input(json!({"request_key":key,"role":"cover","variant":variant,
        "texts":{"heading":"Sabah ışığında küçük bir masa.","line":"İçeride: yeni düzen"},
        "photos":{"photo":{"material_id":photo,"focus_y":0.4}},
        "counter":{"index":1,"total":5}}))
}

#[tokio::test]
async fn a_render_is_a_stored_file_and_a_composed_material() {
    let w = world().await;
    let o = olay(&w).await;
    let photo = real_photo(&w, "p1", 1, o).await;
    let out = render::post_render(&w.d, &w.ctx, cover("r1", "full_bottom", photo.id))
        .await
        .unwrap();
    assert_eq!(out.file.mime, "image/jpeg");
    assert_eq!((out.width, out.height), (1080, 1350));
    assert_eq!(out.material.file_id, out.file.id);
    assert!(!out.ai_generated);
    assert_eq!(out.material.origin, Origin::Real);
    assert_eq!(out.material.binding, Binding::Olay { olay_id: o });
    assert_eq!(
        out.material.share.as_ref().map(|s| s.permission),
        Some(SharePermission::Shareable)
    );
    assert_eq!(out.material.tags.quality, Some(Quality::Publishable));
    let c = out.material.composition.as_ref().expect("composition");
    assert_eq!(c.sources, vec![photo.id]);
    assert_eq!(c.variant, "full_bottom");
    // The stored bytes are the JPEG the answer names.
    let stored =
        w.d.files
            .read(w.ctx.workspace_id, out.file.id)
            .await
            .unwrap();
    assert!(stored.bytes.starts_with(&[0xff, 0xd8, 0xff]));
    let img = image::load_from_memory(&stored.bytes).unwrap();
    assert_eq!((img.width(), img.height()), (1080, 1350));

    // Replayed by its key: the same material, nothing new stored.
    let again = render::post_render(&w.d, &w.ctx, cover("r1", "full_bottom", photo.id))
        .await
        .unwrap();
    assert_eq!(again.material.id, out.material.id);
    assert_eq!(again.file.id, out.file.id);
    let all = library::materials_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    assert_eq!(all.iter().filter(|m| m.composition.is_some()).count(), 1);
}

#[tokio::test]
async fn an_ai_source_makes_the_composition_ai_generated() {
    let w = world().await;
    let file = upload(&w, "ai-file", 9).await;
    let ai = library::material_add(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"ai","file_id":file,
            "origin":{"kind":"ai_generated","generator":"some-model"},
            "genel":true,"depicts":[],"share":"shareable","quality":"publishable"})),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, ai.id).await;
    let out = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"r-ai","role":"moment","variant":"text_top",
            "texts":{"heading":"Mevsim değişiyor"},"photos":{"photo":{"material_id":ai.id}}}),
        ),
    )
    .await
    .unwrap();
    assert!(out.ai_generated);
    assert_eq!(
        out.material.origin,
        Origin::AiGenerated {
            generator: COMPOSED_AI_GENERATOR.into()
        }
    );
    assert_eq!(out.material.binding, Binding::Genel);
    assert_eq!((out.width, out.height), (1080, 1920));
}

#[tokio::test]
async fn a_cover_does_not_repeat_the_last_covers_variant() {
    let w = world().await;
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    let b = real_photo(&w, "b", 2, o).await;
    let first = render::post_templates(&w.d, &w.ctx).await.unwrap();
    assert_eq!(first.cover.last_variant, None);
    assert_eq!(first.cover.next_variant, "full_bottom");
    render::post_render(&w.d, &w.ctx, cover("c1", "full_bottom", a.id))
        .await
        .unwrap();
    let e = render::post_render(&w.d, &w.ctx, cover("c2", "full_bottom", b.id))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(reason(&e), "cover_variant_repeats");
    assert_eq!(e.details["next_variant"], "full_top");
    let listed = render::post_templates(&w.d, &w.ctx).await.unwrap();
    assert_eq!(listed.cover.last_variant.as_deref(), Some("full_bottom"));
    assert_eq!(listed.cover.next_variant, "full_top");
    // Another variant passes; an explicit override passes too.
    render::post_render(&w.d, &w.ctx, cover("c3", "full_top", b.id))
        .await
        .unwrap();
    let mut repeat = cover("c4", "full_top", a.id);
    repeat.allow_repeat = true;
    render::post_render(&w.d, &w.ctx, repeat).await.unwrap();
    // Other roles do not count for the cover rule.
    render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"s1","role":"steps","variant":"photo_top",
            "texts":{"heading":"Üç adımda hazır","step_1":"Kutuyu aç."},
            "photos":{"photo":{"material_id":a.id}}}),
        ),
    )
    .await
    .unwrap();
    let e = render::post_render(&w.d, &w.ctx, cover("c5", "full_top", b.id))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "cover_variant_repeats");
}

#[tokio::test]
async fn a_text_that_does_not_fit_is_refused_naming_its_slot() {
    let w = world().await;
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    // Over max_chars.
    let mut i = cover("o1", "full_bottom", a.id);
    i.texts.insert("heading".into(), "Ç".repeat(60));
    let e = render::post_render(&w.d, &w.ctx, i).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(reason(&e), "text_overflow");
    assert_eq!(e.details["slot"], "heading");
    assert_eq!(e.details["max_chars"], 48);
    assert_eq!(e.details["max_lines"], 3);
    // Within max_chars, but wider than the slot's lines.
    let mut i = cover("o2", "full_bottom", a.id);
    i.texts.insert(
        "heading".into(),
        "MMMMMM WWWWWW MMMMMM WWWWWW MMMMMM WWW".into(),
    );
    let e = render::post_render(&w.d, &w.ctx, i).await.unwrap_err();
    assert_eq!(reason(&e), "text_overflow");
    assert_eq!(e.details["slot"], "heading");
    // Nothing was stored.
    let all = library::materials_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    assert!(all.iter().all(|m| m.composition.is_none()));
    // An unknown slot and a missing required one are refused before drawing.
    let mut i = cover("o3", "full_bottom", a.id);
    i.texts.insert("subtitle".into(), "x".into());
    assert_eq!(
        reason(&render::post_render(&w.d, &w.ctx, i).await.unwrap_err()),
        "unknown_slot"
    );
    let mut i = cover("o4", "full_bottom", a.id);
    i.photos.clear();
    assert_eq!(
        reason(&render::post_render(&w.d, &w.ctx, i).await.unwrap_err()),
        "slot_required"
    );
}

#[tokio::test]
async fn brand_tokens_are_validated_and_fall_back() {
    let w = world().await;
    let start = render::brand_get(&w.d, &w.ctx).await.unwrap();
    assert!(start.is_default);
    assert_eq!(start.revision, 0);
    assert!(start.fallbacks.is_empty());
    // A colour is #rrggbb.
    let bad: Result<render::BrandSetInput, _> = serde_json::from_value(json!({
        "tokens": {"background":"white","ink":"#111111","accent":"#f0b030","muted":"#555555",
                   "heading_font":"figtree","body_font":"figtree"},
        "expected_revision": 0}));
    assert!(bad.is_err());
    // Ink too light on the background: drawn with the defaults, and said so.
    let set = render::brand_set(
        &w.d,
        &w.ctx,
        input(
            json!({"tokens": {"background":"#ffffff","ink":"#bbbbbb","accent":"#f0b030",
            "muted":"#555555","heading_font":"figtree","body_font":"bricolage_grotesque",
            "brand_name":"Örnek"}, "expected_revision": 0}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(set.revision, 1);
    assert_eq!(set.tokens.ink, Color(0xbb, 0xbb, 0xbb));
    assert_eq!(set.effective.ink, BrandTokens::default().ink);
    assert!(set.fallbacks.iter().any(|f| f.token == "ink"));
    // A stale revision is refused.
    let e = render::brand_set(
        &w.d,
        &w.ctx,
        input(
            json!({"tokens": {"background":"#ffffff","ink":"#111111","accent":"#f0b030",
            "muted":"#555555","heading_font":"figtree","body_font":"figtree"},
            "expected_revision": 0}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "brand_revision_changed");
    // A render answers the fallbacks it drew with.
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    let out = render::post_render(&w.d, &w.ctx, cover("b1", "framed_dark", a.id))
        .await
        .unwrap();
    assert!(out.brand_fallbacks.iter().any(|f| f.token == "ink"));
    // Setting needs content.manage.
    let worker = Ctx {
        permissions: [Permission::ContentWork].into_iter().collect(),
        ..w.ctx.clone()
    };
    let e = render::brand_set(
        &w.d,
        &worker,
        input(
            json!({"tokens": {"background":"#ffffff","ink":"#111111","accent":"#f0b030",
            "muted":"#555555","heading_font":"figtree","body_font":"figtree"},
            "expected_revision": 1}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    render::brand_get(&w.d, &worker).await.unwrap();
}

/// A second olay, with its own request key.
async fn other_olay(w: &World, key: &str) -> OlayId {
    library::olay_create(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":key,"kind":"workshop","title":"Başka gün",
            "starts_on":"2026-11-17","ends_on":"2026-11-17"}),
        ),
    )
    .await
    .unwrap()
    .id
}

/// Renders `role`/`variant` from `photo` under `key`; covers may repeat.
async fn render_from(
    w: &World,
    key: &str,
    role: &str,
    variant: &str,
    photo: MaterialId,
) -> Result<render::PostRenderOut, AppError> {
    let texts = match role {
        "steps" => json!({"heading":"Üç adımda hazır","step_1":"Kutuyu aç."}),
        _ => json!({"heading":"Sabah ışığında küçük bir masa."}),
    };
    render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":key,"role":role,"variant":variant,"texts":texts,
            "photos":{"photo":{"material_id":photo}},"allow_repeat":true}),
        ),
    )
    .await
}

fn material(w: &World, id: MaterialId) -> Material {
    w.uow
        .snapshot()
        .materials
        .materials
        .into_iter()
        .find(|m| m.id == id)
        .unwrap()
}

async fn person(w: &World, name: &str) -> jt_inbox::PersonId {
    jt_app::usecases::inbox::people::create(
        &w.d,
        &w.ctx,
        input(json!({"display_name":name,"source":"form",
            "identities":[{"channel":"email","value":format!("{name}@example.com")}]})),
    )
    .await
    .unwrap()
    .person
    .id
}

/// Sources are refused for what they are: another workspace's, erased, a video, not shareable,
/// or from two olays.
#[tokio::test]
async fn sources_that_may_not_be_drawn_are_refused() {
    let w = world().await;
    let o = olay(&w).await;
    // Another workspace's material is no material here.
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    let theirs = w
        .uow
        .snapshot()
        .materials
        .materials
        .into_iter()
        .find(|m| m.workspace_id == other.ws)
        .unwrap();
    let e = render_from(&w, "x1", "cover", "full_top", theirs.id)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    // Erased by its owner.
    let gone = real_photo(&w, "gone", 3, o).await;
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":gone.id,"expected_revision":gone.revision,"confirm":true})),
    )
    .await
    .unwrap();
    let e = render_from(&w, "x2", "cover", "full_top", gone.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_erased");
    // A video.
    let mut mp4 = 24u32.to_be_bytes().to_vec();
    mp4.extend_from_slice(b"ftypisom");
    mp4.extend_from_slice(&0u32.to_be_bytes());
    mp4.extend_from_slice(b"isommp41");
    let file = files::file_upload(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"video","filename":"v.mp4","mime":"video/mp4",
            "content":{"kind":"bytes_base64","data":STANDARD.encode(&mp4)}}),
        ),
    )
    .await
    .unwrap()
    .id;
    let video = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"video","file_id":file,"origin":{"kind":"real"},
            "olay_id":o,"share":"shareable","quality":"publishable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    let e = render_from(&w, "x3", "cover", "full_top", video.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_not_image");
    // Not shareable.
    let private = real_photo(&w, "private", 4, o).await;
    library::material_permission(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":private.id,"expected_revision":private.revision,
            "permission":"not_shareable"}),
        ),
    )
    .await
    .unwrap();
    let e = render_from(&w, "x4", "cover", "full_top", private.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_not_shareable");
    // Two olays in one image.
    let o2 = other_olay(&w, "olay-2").await;
    let a = real_photo(&w, "a", 5, o).await;
    let b = real_photo(&w, "b", 6, o2).await;
    let e = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"x5","role":"second_cover","variant":"pair_top",
            "texts":{"heading":"İki farklı gün"},
            "photos":{"photo_1":{"material_id":a.id},"photo_2":{"material_id":b.id}}}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "mixed_olays");
    // Nothing composed was stored.
    assert!(
        w.uow
            .snapshot()
            .materials
            .materials
            .iter()
            .all(|m| m.composition.is_none())
    );
}

/// The composition takes its sources' most restrictive permission and their people; the AI flag
/// comes through the logo and through a composition used as a source.
#[tokio::test]
async fn share_people_and_the_ai_flag_come_from_the_sources() {
    let w = world().await;
    let o = olay(&w).await;
    let ada = person(&w, "ada").await;
    let a = real_photo(&w, "a", 1, o).await;
    let file = upload(&w, "f-b", 2).await;
    let b = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"b","file_id":file,"origin":{"kind":"real"},
            "olay_id":o,"share":"product_only","quality":"publishable","people":[ada]}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, b.id).await;
    let pair = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"pair","role":"second_cover","variant":"pair_bottom",
            "texts":{"heading":"İki görünüm"},
            "photos":{"photo_1":{"material_id":a.id},"photo_2":{"material_id":b.id}}}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        pair.material.share.as_ref().map(|s| s.permission),
        Some(SharePermission::ProductOnly)
    );
    assert!(pair.material.people.contains(&ada.0));
    assert!(!pair.ai_generated);

    // An AI logo makes every render AI-generated, and is a recorded source.
    let logo_file = upload(&w, "logo-file", 9).await;
    let logo = library::material_add(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"logo","file_id":logo_file,
            "origin":{"kind":"ai_generated","generator":"some-model"},
            "genel":true,"depicts":[],"share":"shareable","quality":"publishable"})),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, logo.id).await;
    render::brand_set(
        &w.d,
        &w.ctx,
        input(
            json!({"tokens":{"background":"#f5f5f3","ink":"#171a1f","accent":"#f2b83c",
            "muted":"#555b66","heading_font":"bricolage_grotesque","body_font":"figtree",
            "brand_name":"Örnek","logo_material_id":logo.id},"expected_revision":0}),
        ),
    )
    .await
    .unwrap();
    let with_logo = render_from(&w, "logo-render", "cover", "framed_dark", a.id)
        .await
        .unwrap();
    assert!(with_logo.ai_generated);
    assert_eq!(
        with_logo.material.composition.as_ref().unwrap().sources,
        vec![a.id, logo.id]
    );

    // A composition drawn from that composition is AI-generated too.
    let again = render_from(
        &w,
        "of-composite",
        "steps",
        "photo_top",
        with_logo.material.id,
    )
    .await
    .unwrap();
    assert!(again.ai_generated);
    assert_eq!(
        again.material.composition.as_ref().unwrap().sources[0],
        with_logo.material.id
    );
}

/// The same request key with another input is refused; a replay of a render erased since is
/// refused, never answered with the erased material.
#[tokio::test]
async fn replays_check_their_input_and_never_answer_an_erased_render() {
    let w = world().await;
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    let first = render_from(&w, "same", "cover", "full_top", a.id)
        .await
        .unwrap();
    let mut other = cover("same", "full_top", a.id);
    other
        .texts
        .insert("heading".into(), "Başka bir başlık".into());
    let e = render::post_render(&w.d, &w.ctx, other).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":a.id,"expected_revision":a.revision,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(material(&w, first.material.id).erased_at.is_some());
    let e = render_from(&w, "same", "cover", "full_top", a.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "render_erased");
}

/// What happens to a source happens to what was drawn from it, and to what was drawn from that:
/// deleted (redacted), its permission revoked (cleared), a person tagged later (added), a person
/// erased (redacted, also when the tag never reached the composition), the retention rule
/// (redacted with the source).
#[tokio::test]
async fn compositions_follow_their_sources() {
    let (mut w, _) = publishing_world().await;
    w.d.compositor = Arc::new(jt_render::Renderer::new(jt_render::Limits::default()));
    let o = olay(&w).await;

    // Deleted.
    let p = real_photo(&w, "p", 1, o).await;
    let c1 = render_from(&w, "c1", "cover", "full_top", p.id)
        .await
        .unwrap()
        .material;
    let c2 = render_from(&w, "c2", "steps", "photo_top", c1.id)
        .await
        .unwrap()
        .material;
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":p.id,"expected_revision":p.revision,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(material(&w, c1.id).erased_at.is_some());
    assert!(material(&w, c2.id).erased_at.is_some());
    let e = render_from(&w, "c3", "cover", "full_top", c1.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_erased");

    // Not shareable.
    let q = real_photo(&w, "q", 2, o).await;
    let d1 = render_from(&w, "d1", "cover", "full_top", q.id)
        .await
        .unwrap()
        .material;
    let d2 = render_from(&w, "d2", "steps", "photo_top", d1.id)
        .await
        .unwrap()
        .material;
    assert!(d2.share.is_some());
    library::material_permission(
        &w.d,
        &w.ctx,
        input(json!({"material_id":q.id,"expected_revision":q.revision,
            "permission":"not_shareable"})),
    )
    .await
    .unwrap();
    assert!(material(&w, d1.id).share.is_none());
    assert!(material(&w, d2.id).share.is_none());

    // A person tagged after the render, then erased.
    let ada = person(&w, "ada").await;
    let s = real_photo(&w, "s", 3, o).await;
    let e1 = render_from(&w, "e1", "cover", "full_top", s.id)
        .await
        .unwrap()
        .material;
    let e2 = render_from(&w, "e2", "steps", "photo_top", e1.id)
        .await
        .unwrap()
        .material;
    library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":s.id,"expected_revision":s.revision,"people":[ada]})),
    )
    .await
    .unwrap();
    assert!(material(&w, e1.id).people.contains(&ada.0));
    assert!(material(&w, e2.id).people.contains(&ada.0));
    assert!(material(&w, e2.id).share.is_none());
    jt_app::usecases::inbox::erasure::erase(
        &w.d,
        &w.ctx,
        ada,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(material(&w, e1.id).erased_at.is_some());
    assert!(material(&w, e2.id).erased_at.is_some());

    // A tag that never reached the composition: erasure still finds it through its source.
    let bob = person(&w, "bob").await;
    let t = real_photo(&w, "t", 4, o).await;
    let f1 = render_from(&w, "f1", "cover", "full_top", t.id)
        .await
        .unwrap()
        .material;
    {
        use jt_app::ports::UnitOfWork;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut tagged = material(&w, t.id);
        let revision = tagged.revision;
        tagged.people.insert(bob.0);
        tagged.revision += 1;
        r.studio_materials()
            .update_material(tagged, revision)
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    assert!(!material(&w, f1.id).people.contains(&bob.0));
    jt_app::usecases::inbox::erasure::erase(
        &w.d,
        &w.ctx,
        bob,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(material(&w, f1.id).erased_at.is_some());

    // The retention rule: a composition goes with the source it erases.
    let old = library::olay_create(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"old","kind":"workshop","title":"Eski gün",
            "starts_on":"2026-10-20","ends_on":"2026-10-22"}),
        ),
    )
    .await
    .unwrap()
    .id;
    let face_file = upload(&w, "f-face", 7).await;
    let face = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"face","file_id":face_file,"origin":{"kind":"real"},
            "olay_id":old,"share":"shareable","quality":"publishable","depicts":["face"]}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, face.id).await;
    let g1 = render_from(&w, "g1", "cover", "full_top", face.id)
        .await
        .unwrap()
        .material;
    w.d.clock = Arc::new(jt_testkit::fakes::FixedClock(time::macros::datetime!(
        2028-10-23 12:00 UTC
    )));
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(material(&w, face.id).erased_at.is_some());
    assert!(material(&w, g1.id).erased_at.is_some());
}

fn agent_of(w: &World) -> Ctx {
    let connection_id = jt_tenancy::AgentConnectionId::new_v7();
    let jt_ledger::Actor::Human { user_id } = w.ctx.actor else {
        panic!("the world's caller is its owner")
    };
    Ctx {
        actor: jt_ledger::Actor::Agent {
            connection_id,
            user_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

async fn blocked(w: &World) -> std::collections::BTreeSet<MaterialId> {
    use jt_app::ports::UnitOfWork;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    library::blocked_derivatives(r.as_mut()).await.unwrap()
}

async fn permit(w: &World, id: MaterialId, permission: &str) {
    library::material_permission(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":id,"expected_revision":material(w, id).revision,
            "permission":permission}),
        ),
    )
    .await
    .unwrap();
}

/// Laundering: an AI-edited output whose source is no longer shareable stays behind the
/// publication fence even when a person re-approves it, and drawing a slide from it is refused, so
/// the restriction never passes into a new material.
#[tokio::test]
async fn a_restricted_production_output_is_no_render_source() {
    let w = world().await;
    let o = olay(&w).await;
    let s = real_photo(&w, "s", 1, o).await;
    let p = library::material_production_request(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"edit","kind":"poster","instructions":"Arka planı sadeleştir",
            "sources":[{"material_id":s.id,"expected_revision":s.revision}]}),
        ),
    )
    .await
    .unwrap();
    let a = agent_of(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let file = upload(&w, "f-edit", 8).await;
    let edited = library::material_add(
        &w.d,
        &a,
        input(json!({"request_key":"edited","file_id":file,
            "origin":{"kind":"ai_generated","generator":"some-model"},
            "genel":true,"depicts":[],"quality":"publishable"})),
    )
    .await
    .unwrap()
    .material;
    library::material_production_complete(
        &w.d,
        &a,
        input(
            json!({"production_id":p.id,"expected_revision":claim.production.revision,
            "claim_token":claim.claim_token,"output_material_id":edited.id}),
        ),
    )
    .await
    .unwrap();
    // The source is restricted, then a person re-approves the output anyway.
    permit(&w, s.id, "not_shareable").await;
    permit(&w, edited.id, "shareable").await;
    assert_eq!(
        material(&w, edited.id).share.map(|s| s.permission),
        Some(SharePermission::Shareable)
    );
    assert!(blocked(&w).await.contains(&edited.id));
    let e = render_from(&w, "laundered", "cover", "full_top", edited.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_restricted");
}

/// Re-approval: a source is un-shared, its composition's permission is cleared, an owner
/// re-approves the composition; the fence still blocks it while the source stays restricted, and
/// lets it through once the source is shareable again.
#[tokio::test]
async fn a_reapproved_composition_stays_behind_its_restricted_source() {
    let w = world().await;
    let o = olay(&w).await;
    let s = real_photo(&w, "s", 1, o).await;
    let c = render_from(&w, "c", "cover", "full_top", s.id)
        .await
        .unwrap()
        .material;
    assert!(!blocked(&w).await.contains(&c.id));
    permit(&w, s.id, "not_shareable").await;
    assert!(material(&w, c.id).share.is_none());
    permit(&w, c.id, "shareable").await;
    assert!(blocked(&w).await.contains(&c.id));
    let e = render_from(&w, "c-again", "steps", "photo_top", c.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_restricted");
    permit(&w, s.id, "shareable").await;
    assert!(!blocked(&w).await.contains(&c.id));
}

/// A marker an agent's analysis adds to a source after the render reaches the composition.
#[tokio::test]
async fn an_analysis_marker_reaches_the_compositions() {
    let mut w = world().await;
    w.d.tokens = Arc::new(jt_testkit::fakes::FixedTokenGen::new(
        (0..20).map(|n| format!("analysis-token-{n}")),
    ));
    let o = olay(&w).await;
    let s = real_photo(&w, "s", 1, o).await;
    let c = render_from(&w, "c", "cover", "full_top", s.id)
        .await
        .unwrap()
        .material;
    assert!(c.tags.depicts.is_empty() && c.share.is_some());
    let a = agent_of(&w);
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":s.id,"expected_revision":material(&w, s.id).revision})),
    )
    .await
    .unwrap();
    let current = material(&w, s.id);
    let claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":s.id,"expected_revision":current.revision})),
    )
    .await
    .unwrap();
    library::material_analysis_complete(
        &w.d,
        &a,
        input(
            json!({"material_id":s.id,"expected_revision":claim.expected_revision,
            "claim_token":claim.claim_token,"description":"Bir masa ve bir kişi",
            "labels":["masa"],"date_source":"unknown","depicts":["face"]}),
        ),
    )
    .await
    .unwrap();
    let after = material(&w, c.id);
    assert!(after.tags.depicts.contains(&Depicts::Face));
    assert!(after.share.is_none());
}

/// The materials the agent's work list asks to analyse.
async fn analysis_items(w: &World) -> Vec<MaterialId> {
    jt_app::usecases::work::pending(&w.d, &w.ctx)
        .await
        .unwrap()
        .items
        .into_iter()
        .filter_map(|i| match i.kind {
            jt_app::usecases::work::WorkKind::StudioMaterialAnalysis { material_id, .. } => {
                Some(material_id)
            }
            _ => None,
        })
        .collect()
}

/// A render is created analysed: it never becomes analysis work, its analysis keeps what it took
/// from its sources (their group, their labels and markers) as its own, and no agent may claim or
/// requeue it.
#[tokio::test]
async fn a_render_is_created_analysed_and_is_no_analysis_work() {
    let w = world().await;
    let o = olay(&w).await;
    let s = real_photo(&w, "s", 1, o).await;
    {
        use jt_app::ports::UnitOfWork;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut row = r
            .studio_materials()
            .get_intelligence(s.id)
            .await
            .unwrap()
            .unwrap();
        row.intelligence.group_name = Some("Masa düzeni".into());
        r.studio_materials().save_intelligence(row).await.unwrap();
        r.commit().await.unwrap();
    }
    let c = render_from(&w, "c", "cover", "full_top", s.id)
        .await
        .unwrap()
        .material;
    assert!(!analysis_items(&w).await.contains(&c.id));
    let out = library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":c.id})))
        .await
        .unwrap();
    use jt_app::ports::materials::AnalysisStatus;
    assert_eq!(out.intelligence.status, AnalysisStatus::Completed);
    assert_eq!(out.intelligence.group_name.as_deref(), Some("Masa düzeni"));
    assert_eq!(out.intelligence.analyzed_revision, Some(c.revision));
    for field in ["labels", "quality", "description", "group_name"] {
        assert!(out.intelligence.manual_fields.contains(field), "{field}");
    }
    assert!(out.material.tags.labels.contains("atölye"));
    assert_eq!(out.material.tags.quality, Some(Quality::Publishable));
    // No agent analyses it, and no one requeues it for one.
    let a = agent_of(&w);
    let e = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "composed_material");
    let e = library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "composed_material");
    assert!(!analysis_items(&w).await.contains(&c.id));
}

/// A source not analysed yet is refused (retryable): what no one checked for faces, names and
/// marks is never drawn into a post. Once analysed, the same render goes through.
#[tokio::test]
async fn an_unanalysed_source_is_refused_until_its_analysis_is_complete() {
    let w = world().await;
    let o = olay(&w).await;
    let s = unanalysed_photo(&w, "s", 1, o).await;
    assert!(analysis_items(&w).await.contains(&s.id));
    let e = render_from(&w, "early", "cover", "full_top", s.id)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(reason(&e), "source_not_analysed");
    assert_eq!(e.details["retryable"], json!(true));
    analysed(&w, s.id).await;
    render_from(&w, "later", "cover", "full_top", s.id)
        .await
        .unwrap();
}

/// A composition is never more shareable than its sources: it takes the most restrictive
/// permission, no analysis can widen it (none runs on it), and a source with no permission yet
/// leaves it with none.
#[tokio::test]
async fn a_composition_is_never_more_shareable_than_its_sources() {
    let w = world().await;
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    let file = upload(&w, "f-b", 2).await;
    let b = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"b","file_id":file,"origin":{"kind":"real"},
            "olay_id":o,"share":"product_only","quality":"publishable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, b.id).await;
    let pair = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"pair","role":"second_cover","variant":"pair_top",
            "texts":{"heading":"İki görünüm"},
            "photos":{"photo_1":{"material_id":a.id},"photo_2":{"material_id":b.id}}}),
        ),
    )
    .await
    .unwrap()
    .material;
    assert_eq!(
        pair.share.as_ref().map(|s| s.permission),
        Some(SharePermission::ProductOnly)
    );
    // An agent's file with no permission yet: the composition has none either.
    let agent = agent_of(&w);
    let file = upload(&w, "f-agent", 3).await;
    let unshared = library::material_add(
        &w.d,
        &agent,
        input(
            json!({"request_key":"unshared","file_id":file,"origin":{"kind":"real"},
            "olay_id":o,"quality":"publishable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    assert!(unshared.share.is_none());
    analysed(&w, unshared.id).await;
    let c = render_from(&w, "c", "cover", "full_top", unshared.id)
        .await
        .unwrap()
        .material;
    assert!(c.share.is_none());
    assert!(c.upload_for.is_none());
    // And nothing the analysis path does can give it one.
    let e = library::material_analysis_claim(
        &w.d,
        &agent,
        input(json!({"material_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "composed_material");
    assert!(material(&w, c.id).share.is_none());
}

/// Completes `id`'s analysis as an agent does: claimed, then completed with no finding.
async fn complete_analysis(w: &World, id: MaterialId) {
    let a = agent_of(w);
    let claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":id,"expected_revision":material(w, id).revision})),
    )
    .await
    .unwrap();
    library::material_analysis_complete(
        &w.d,
        &a,
        input(
            json!({"material_id":id,"expected_revision":claim.expected_revision,
            "claim_token":claim.claim_token,"description":"Bir masa",
            "labels":["masa"],"date_source":"unknown","depicts":[]}),
        ),
    )
    .await
    .unwrap();
}

/// A composition never stands in for an unanalysed photo behind it: drawn from a photo whose
/// analysis is pending again (or never ran, as for a composition the previous release made), it
/// is refused as a source, naming the photo; once the photo's analysis completes, the
/// composition's own analysis is completed with it and it renders.
#[tokio::test]
async fn a_composition_never_stands_in_for_an_unanalysed_photo() {
    let mut w = world().await;
    w.d.tokens = Arc::new(jt_testkit::fakes::FixedTokenGen::new(
        (0..20).map(|n| format!("analysis-token-{n}")),
    ));
    let o = olay(&w).await;
    let p = real_photo(&w, "p", 1, o).await;
    let c = render_from(&w, "c", "cover", "full_top", p.id)
        .await
        .unwrap()
        .material;
    // As before this release: the photo not analysed, the composition with no record.
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":p.id,"expected_revision":material(&w, p.id).revision})),
    )
    .await
    .unwrap();
    {
        use jt_app::ports::UnitOfWork;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        r.studio_materials()
            .delete_intelligence(c.id)
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    let e = render_from(&w, "again", "steps", "photo_top", c.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_not_analysed");
    assert_eq!(e.details["unanalysed_material_id"], json!(p.id));
    // Not analysis work, whatever its record says.
    assert!(!analysis_items(&w).await.contains(&c.id));
    complete_analysis(&w, p.id).await;
    use jt_app::ports::materials::AnalysisStatus;
    let out = library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":c.id})))
        .await
        .unwrap();
    assert_eq!(out.intelligence.status, AnalysisStatus::Completed);
    render_from(&w, "again", "steps", "photo_top", c.id)
        .await
        .unwrap();
}

/// A brand logo whose analysis is not complete is left out of the brand chip: the render goes on
/// with the brand name's letter, says so, and does not record (or take the AI flag of) the logo.
#[tokio::test]
async fn an_unanalysed_logo_is_left_out_and_said_so() {
    let w = world().await;
    let o = olay(&w).await;
    let a = real_photo(&w, "a", 1, o).await;
    let logo_file = upload(&w, "logo-file", 9).await;
    let logo = library::material_add(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"logo","file_id":logo_file,
            "origin":{"kind":"ai_generated","generator":"some-model"},
            "genel":true,"depicts":[],"share":"shareable","quality":"publishable"})),
    )
    .await
    .unwrap()
    .material;
    // Not analysed yet: brand_set refuses it outright.
    let tokens = json!({"background":"#f5f5f3","ink":"#171a1f","accent":"#f2b83c",
        "muted":"#555b66","heading_font":"bricolage_grotesque","body_font":"figtree",
        "brand_name":"Örnek","logo_material_id":logo.id});
    let e = render::brand_set(
        &w.d,
        &w.ctx,
        input(json!({"tokens":tokens,"expected_revision":0})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "source_not_analysed");
    analysed(&w, logo.id).await;
    render::brand_set(
        &w.d,
        &w.ctx,
        input(json!({"tokens":tokens,"expected_revision":0})),
    )
    .await
    .unwrap();
    // Its analysis is asked for again after the brand was set.
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":logo.id,"expected_revision":material(&w, logo.id).revision})),
    )
    .await
    .unwrap();
    let out = render_from(&w, "no-logo", "cover", "framed_dark", a.id)
        .await
        .unwrap();
    assert!(
        out.brand_fallbacks
            .iter()
            .any(|f| f.token == "logo_material_id")
    );
    assert_eq!(
        out.material.composition.as_ref().unwrap().sources,
        vec![a.id]
    );
    assert!(!out.ai_generated);
}

/// A content area takes a composed image in one step: rendered with the area's `project_id` from
/// the area's own photo, it is the area's and is delivered as a package that waits for the
/// owner. A photo outside the area is refused before drawing; a composed image of one, delivered
/// anyway, is refused with what to do.
#[tokio::test]
async fn a_content_area_takes_a_composed_image_of_its_own_photos() {
    let w = world().await;
    let o = olay(&w).await;
    let inside = real_photo(&w, "inside", 1, o).await;
    let outside = real_photo(&w, "outside", 2, o).await;
    // The workspace has a brand logo: drawn in every image, never one of an area's materials.
    let logo_file = upload(&w, "logo-file", 9).await;
    let logo = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"logo","file_id":logo_file,"origin":{"kind":"real"},
            "genel":true,"share":"shareable","quality":"publishable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, logo.id).await;
    render::brand_set(
        &w.d,
        &w.ctx,
        input(
            json!({"tokens":{"background":"#f5f5f3","ink":"#171a1f","accent":"#f2b83c",
            "muted":"#555b66","heading_font":"bricolage_grotesque","body_font":"figtree",
            "brand_name":"Örnek","logo_material_id":logo.id},"expected_revision":0}),
        ),
    )
    .await
    .unwrap();
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"area","brief":"Masadan bir paylaşım hazırla"})),
    )
    .await
    .unwrap();
    let p = projects::project_materials(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"add":[inside.id]})),
    )
    .await
    .unwrap();
    // Refused before drawing: a photo that is not the area's.
    let e = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"out","role":"cover","variant":"full_top",
            "texts":{"heading":"Sabah ışığında küçük bir masa."},
            "photos":{"photo":{"material_id":outside.id}},"project_id":p.id}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "source_not_in_area");
    assert_eq!(e.details["missing"], json!([outside.id]));
    let cover = render::post_render(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"in","role":"cover","variant":"full_top",
            "texts":{"heading":"Sabah ışığında küçük bir masa."},
            "photos":{"photo":{"material_id":inside.id}},"project_id":p.id}),
        ),
    )
    .await
    .unwrap()
    .material;
    let drawn = cover.composition.clone().unwrap();
    assert_eq!(drawn.logo, Some(logo.id));
    assert_eq!(drawn.sources, vec![inside.id, logo.id]);
    let stray = render_from(&w, "stray", "steps", "photo_top", outside.id)
        .await
        .unwrap()
        .material;
    // The agent takes the area and delivers.
    let a = agent_of(&w);
    let p = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap()
        .project;
    let claim = jt_app::usecases::content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let version = |m: &Material| {
        json!({"format":"feed_post","text":"Masadan yeni bir düzen","material_ids":[m.id],
            "hypothesis_id":w.f.slot.chain.hypothesis_id})
    };
    let e = jt_app::usecases::content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":claim.claim_token,"request_key":"stray",
            "summary":"Hazırlandı","versions":[version(&stray)]}),
        ),
    )
    .await
    .unwrap_err();
    let findings = &e.details["versions"][0]["findings"];
    let finding = findings
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["code"] == "material_not_in_area")
        .expect("material_not_in_area");
    assert_eq!(finding["composed"], json!(true));
    assert_eq!(finding["missing_sources"], json!([outside.id]));
    assert!(finding["hint"].as_str().unwrap().contains("project_id"));
    assert!(
        findings
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["code"] != "media_type")
    );
    let out = jt_app::usecases::content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":claim.claim_token,"request_key":"cover",
            "summary":"Hazırlandı","versions":[version(&cover)]}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(out.project.packages.len(), 1);
    assert_eq!(
        out.project.packages[0].versions[0].material_ids,
        vec![cover.id]
    );
    // A composition stored before the logo was recorded apart: the workspace's current logo
    // among its sources is still taken for the logo, never as a missing area material.
    {
        use jt_app::ports::UnitOfWork;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut old = r
            .studio_materials()
            .get_material(cover.id)
            .await
            .unwrap()
            .unwrap();
        let revision = old.revision;
        old.composition.as_mut().unwrap().logo = None;
        old.revision += 1;
        r.studio_materials()
            .update_material(old, revision)
            .await
            .unwrap();
        let stored = r
            .studio_projects()
            .get_project(p.id)
            .await
            .unwrap()
            .unwrap();
        let ids = projects::available_material_ids(r.as_mut(), &stored)
            .await
            .unwrap();
        assert!(ids.contains(&cover.id));
        r.commit().await.unwrap();
    }
    // The composed image is the area's only while its photo is.
    projects::project_materials(
        &w.d,
        &w.ctx,
        input(
            json!({"project_id":p.id,"expected_revision":out.project.revision,
            "remove":[inside.id]}),
        ),
    )
    .await
    .unwrap();
    use jt_app::ports::UnitOfWork;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let stored = r
        .studio_projects()
        .get_project(p.id)
        .await
        .unwrap()
        .unwrap();
    let ids = projects::available_material_ids(r.as_mut(), &stored)
        .await
        .unwrap();
    assert!(!ids.contains(&cover.id));
}

/// A source later judged not publishable makes what was drawn from it the same.
#[tokio::test]
async fn a_source_judged_unusable_makes_its_compositions_unusable() {
    let w = world().await;
    let o = olay(&w).await;
    let s = real_photo(&w, "s", 1, o).await;
    let c = render_from(&w, "c", "cover", "full_top", s.id)
        .await
        .unwrap()
        .material;
    assert_eq!(c.tags.quality, Some(Quality::Publishable));
    library::material_tag(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":s.id,"expected_revision":material(&w, s.id).revision,
            "quality":"unusable"}),
        ),
    )
    .await
    .unwrap();
    let after = material(&w, c.id);
    assert_eq!(after.tags.quality, Some(Quality::Unusable));
    assert_eq!(
        after.share, c.share,
        "a quality alone does not reopen the permission"
    );
}

/// Rewrites `id`'s stored material as a later release would have written it: a role and a frame
/// this build does not know, and a field it does not know on the material and on its composition.
/// Returns the material as stored.
async fn from_a_later_release(w: &World, id: MaterialId) -> Material {
    use jt_app::ports::UnitOfWork;
    let current = material(w, id);
    let mut v = serde_json::to_value(&current).unwrap();
    v["composition"]["role"] = json!("some_new_role");
    v["composition"]["frame"] = json!("some_new_frame");
    v["composition"]["added_later"] = json!(["kept"]);
    v["added_later"] = json!({"kept": true});
    let mut later: Material = serde_json::from_value(v).unwrap();
    later.revision += 1;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .update_material(later.clone(), current.revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    later
}

/// A composition a later release made (a role and a frame this build does not know) is read,
/// kept unchanged when the material is saved again, follows every rule a composition follows
/// (its sources' erasure and retention, un-sharing, late marks and quality; the publication
/// fence; an area's membership by its sources; no trigger counts it), and is never drawn from
/// nor counted as a render of this build.
#[tokio::test]
async fn a_composition_a_later_release_made_follows_every_rule() {
    let w = world().await;
    let o = olay(&w).await;
    let ada = person(&w, "ada").await;

    // Read, and written back unchanged when the material is saved again (a permission set).
    let p = real_photo(&w, "p", 1, o).await;
    let c = from_a_later_release(
        &w,
        render_from(&w, "c", "cover", "full_top", p.id)
            .await
            .unwrap()
            .material
            .id,
    )
    .await;
    let stored = material(&w, c.id);
    let raw = serde_json::to_value(&stored).unwrap();
    assert_eq!(raw["composition"]["role"], "some_new_role");
    assert_eq!(raw["composition"]["frame"], "some_new_frame");
    library::materials_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    permit(&w, c.id, "product_only").await;
    let again = serde_json::to_value(material(&w, c.id)).unwrap();
    assert_eq!(again["composition"], raw["composition"]);
    assert_eq!(again["composition"]["added_later"], json!(["kept"]));
    assert_eq!(again["added_later"], json!({"kept": true}));

    // Never drawn from, and no render of this build: the cover rotation does not see it.
    let e = render_from(&w, "of-later", "steps", "photo_top", c.id)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_unknown_composition");
    let t = render::post_templates(&w.d, &w.ctx).await.unwrap();
    assert!(t.recent.iter().all(|r| r.material_id != c.id));

    // Late marks and quality reach it; un-sharing its source clears its permission and the
    // fence holds it while the source is restricted.
    library::material_tag(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":p.id,"expected_revision":material(&w, p.id).revision,
            "people":[ada],"quality":"unusable"}),
        ),
    )
    .await
    .unwrap();
    let after = material(&w, c.id);
    assert!(after.people.contains(&ada.0));
    assert_eq!(after.tags.quality, Some(Quality::Unusable));
    assert!(after.share.is_none());
    permit(&w, c.id, "shareable").await;
    permit(&w, p.id, "not_shareable").await;
    assert!(material(&w, c.id).share.is_none());
    permit(&w, c.id, "shareable").await;
    assert!(blocked(&w).await.contains(&c.id));

    // A person's erasure reaches it through its source.
    jt_app::usecases::inbox::erasure::erase(
        &w.d,
        &w.ctx,
        ada,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(material(&w, c.id).erased_at.is_some());

    // Its source deleted: redacted with it.
    let q = real_photo(&w, "q", 2, o).await;
    let d1 = from_a_later_release(
        &w,
        render_from(&w, "d", "cover", "full_top", q.id)
            .await
            .unwrap()
            .material
            .id,
    )
    .await;
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":q.id,"expected_revision":material(&w, q.id).revision,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(material(&w, d1.id).erased_at.is_some());

    // An area's while its source is; it is no analysis work.
    let s = real_photo(&w, "s", 3, o).await;
    let e1 = from_a_later_release(
        &w,
        render_from(&w, "e", "cover", "full_top", s.id)
            .await
            .unwrap()
            .material
            .id,
    )
    .await;
    assert!(!analysis_items(&w).await.contains(&e1.id));
    let area = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"area","brief":"Masadan bir paylaşım hazırla"})),
    )
    .await
    .unwrap();
    projects::project_materials(
        &w.d,
        &w.ctx,
        input(json!({"project_id":area.id,"expected_revision":area.revision,"add":[s.id]})),
    )
    .await
    .unwrap();
    {
        use jt_app::ports::UnitOfWork;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let stored = r
            .studio_projects()
            .get_project(area.id)
            .await
            .unwrap()
            .unwrap();
        let ids = projects::available_material_ids(r.as_mut(), &stored)
            .await
            .unwrap();
        assert!(ids.contains(&e1.id));
    }

    // No trigger counts it: the planner asks for no content made of it.
    jt_app::usecases::studio::planner::plan(&w.d, w.f.ws, w.ctx.now + time::Duration::hours(3))
        .await
        .unwrap();
    assert!(
        w.uow
            .snapshot()
            .posts
            .requests
            .iter()
            .all(|q| !q.material_ids.contains(&e1.id))
    );

    // The retention rule: an old olay's face photo goes, and what was drawn from it.
    let old = library::olay_create(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"old","kind":"workshop","title":"Eski gün",
            "starts_on":"2026-10-20","ends_on":"2026-10-22"}),
        ),
    )
    .await
    .unwrap()
    .id;
    let face_file = upload(&w, "f-face", 7).await;
    let face = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"face","file_id":face_file,"origin":{"kind":"real"},
            "olay_id":old,"share":"shareable","quality":"publishable","depicts":["face"]}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, face.id).await;
    let g1 = from_a_later_release(
        &w,
        render_from(&w, "g", "cover", "full_top", face.id)
            .await
            .unwrap()
            .material
            .id,
    )
    .await;
    let mut w = w;
    w.d.clock = Arc::new(jt_testkit::fakes::FixedClock(time::macros::datetime!(
        2028-10-23 12:00 UTC
    )));
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(material(&w, g1.id).erased_at.is_some());
}
