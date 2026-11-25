//! Photo reels (`studio.reel_render`): a reel is an MP4 stored and added to the library at once
//! as a composed material, and it keeps every rule a rendered slide keeps: provenance in its
//! composition (every photo in order, the logo last), the AI flag of any source, the cascades of
//! its sources (erasure, retention, un-sharing, late person and depicts marks, an unusable
//! quality), created analysed and never analysis work, never a new material of any trigger, the
//! area's when its photos are, the publication fence, analysed sources only, replay by key, the
//! logo left out (and said so) when it can no longer be drawn. It goes the whole way on each of
//! the three paths with format `reel`. Test images are generated here; no photo is used.
#[path = "support/studio.rs"]
mod support;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageBuffer, Rgb, RgbImage};
use jt_app::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        UnitOfWork,
        materials::{AnalysisStatus, DateSource, MaterialAnalysisRecord},
    },
    usecases::studio::{
        files, library,
        pieces::{PieceInput, piece_submit},
        planner, posts, projects, reel, render,
    },
};
use jt_strategy::ChannelChoice;
use jt_studio::compose::{Frame, REEL_AI_GENERATOR, REEL_RENDERER, Role};
use jt_studio::*;
use jt_testkit::fakes::{FIXED_NOW, files::MemoryFiles};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, macros::datetime};

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

/// The test world on an Instagram account with the real renderer: the fixture's channel is
/// Instagram, connected for publishing, chosen by the strategy; the library starts empty.
async fn reel_world() -> World {
    let mut w = without_content(world().await).await;
    w.d.files = Arc::new(MemoryFiles::default());
    w.d.compositor = Arc::new(jt_render::Renderer::new(jt_render::Limits::default()));
    let (channel, current) = (w.f.slot.capability_id, w.current);
    w.uow.edit(|s| {
        s.materials = Default::default();
        for c in s.capabilities.iter_mut() {
            if c.capability.id == channel {
                c.capability.kind_key = "instagram".into();
                c.capability.connector_public = json!({"kind_key":"instagram","access":{
                    "scopes":["instagram_content_publish","instagram_manage_insights"],
                    "expires_at":null}});
            }
        }
        for v in s.strategy_versions.iter_mut() {
            if v.id == current {
                v.sections.channels.push(ChannelChoice {
                    channel: "instagram".into(),
                    rationale: "test".into(),
                    group_id: None,
                });
            }
        }
    });
    w
}

fn at(w: &World, now: OffsetDateTime) -> Ctx {
    let mut ctx = w.ctx.clone();
    ctx.now = now;
    ctx
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

/// A real, shareable, publishable photo of `olay`, added by the owner and analysed.
async fn photo(w: &World, key: &str, seed: u8, olay: OlayId) -> Material {
    let m = unanalysed_photo(w, key, seed, olay).await;
    analysed(w, m.id).await;
    m
}

/// Three photos of `olay`, each image distinct from every other key's.
async fn photos(w: &World, key: &str, olay: OlayId) -> Vec<Material> {
    let base = key.bytes().fold(0u8, u8::wrapping_add);
    let mut out = Vec::new();
    for n in 0..3u8 {
        let seed = base.wrapping_add(n * 40 + 1);
        out.push(photo(w, &format!("{key}-{n}"), seed, olay).await);
    }
    out
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

fn request(key: &str, photos: &[MaterialId]) -> reel::ReelRenderInput {
    input(json!({
        "request_key": key,
        "photos": photos.iter().enumerate().map(|(i, id)|
            json!({"material_id": id, "text": format!("Adım {}: tezgâhta", i + 1)}))
            .collect::<Vec<_>>(),
        "photo_ms": 2500,
    }))
}

/// [`request`] with a title card and a closing card.
fn carded(key: &str, photos: &[MaterialId]) -> reel::ReelRenderInput {
    let mut r = request(key, photos);
    r.title_text = Some("Atölyeden bir gün".into());
    r.closing = Some(input(
        json!({"site": "ornek.com.tr", "slogan": "Elde yapılır."}),
    ));
    r
}

async fn render(
    w: &World,
    key: &str,
    photos: &[MaterialId],
) -> Result<reel::ReelRenderOut, AppError> {
    reel::reel_render(&w.d, &w.ctx, request(key, photos)).await
}

fn ids(ms: &[Material]) -> Vec<MaterialId> {
    ms.iter().map(|m| m.id).collect()
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

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

/// A reel is a stored MP4 (index first) and a composed material: role reel, every photo in order
/// as a source, created analysed, never analysis work, replayed by its key.
#[tokio::test]
async fn a_reel_is_a_stored_mp4_and_a_composed_material() {
    let w = reel_world().await;
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let out = reel::reel_render(&w.d, &w.ctx, carded("r1", &ids(&ps)))
        .await
        .unwrap();
    assert_eq!(out.file.mime, "video/mp4");
    assert_eq!((out.width, out.height, out.fps), (1080, 1920, 30));
    assert!(out.duration_ms >= 3_000);
    assert_eq!(out.formats, ["reel", "tiktok_video"]);
    assert!(out.next.contains("area_deliver") && out.next.contains("posts_propose"));
    assert!(out.next.contains("piece_submit"));
    assert!(!out.ai_generated);
    assert_eq!(out.material.origin, Origin::Real);
    assert_eq!(out.material.binding, Binding::Olay { olay_id: o });
    assert_eq!(out.material.mime, "video/mp4");
    assert_eq!(out.material.tags.quality, Some(Quality::Publishable));
    assert!(out.material.tags.labels.contains("atölye"));
    let c = out.material.composition.as_ref().expect("composition");
    assert_eq!(c.renderer, REEL_RENDERER);
    assert_eq!(c.role, Role::Reel);
    assert_eq!(c.frame, Frame::Reel);
    assert_eq!(c.sources, ids(&ps));
    // The stored bytes: ftyp, then moov, then mdat; the length the answer names.
    let stored =
        w.d.files
            .read(w.ctx.workspace_id, out.file.id)
            .await
            .unwrap();
    assert_eq!(&stored.bytes[4..8], b"ftyp");
    let moov = be32(&stored.bytes, 0) as usize;
    assert_eq!(&stored.bytes[moov + 4..moov + 8], b"moov");
    let upload = jt_studio::MediaUpload {
        bytes: stored.bytes.clone(),
        mime: "video/mp4".into(),
        filename: "reel.mp4".into(),
    };
    assert_eq!(upload.video_duration_ms(), Some(out.duration_ms));
    // Created analysed and never analysis work; no agent may claim it.
    assert!(!analysis_items(&w).await.contains(&out.material.id));
    let got = library::material_intelligence_get(
        &w.d,
        &w.ctx,
        input(json!({"material_id":out.material.id})),
    )
    .await
    .unwrap();
    assert_eq!(got.intelligence.status, AnalysisStatus::Completed);
    let e = library::material_analysis_claim(
        &w.d,
        &agent_of(&w),
        input(json!({"material_id":out.material.id,"expected_revision":1})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "composed_material");
    // Replayed by its key; another input under the key is a conflict.
    let again = reel::reel_render(&w.d, &w.ctx, carded("r1", &ids(&ps)))
        .await
        .unwrap();
    assert_eq!(again.material.id, out.material.id);
    assert_eq!(again.file.id, out.file.id);
    let mut other = carded("r1", &ids(&ps));
    other.title_text = Some("Başka bir başlık".into());
    let e = reel::reel_render(&w.d, &w.ctx, other).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    // The templates' listing names the reel's limits and its history.
    let t = render::post_templates(&w.d, &w.ctx).await.unwrap();
    assert_eq!(t.reel.max_photos, 8);
    assert_eq!(
        t.last_variants.get("reel").map(String::as_str),
        Some("photo_reel")
    );
    assert_eq!(t.cover.last_variant, None, "a reel is no cover");
}

/// What a reel is refused for before anything is drawn: the photo count, a photo twice, a text
/// over its slot (named), an unanalysed photo (retryable), a video, a photo outside the area.
#[tokio::test]
async fn a_reel_is_refused_before_drawing_for_what_its_input_is() {
    let w = reel_world().await;
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let e = render(&w, "two", &ids(&ps)[..2]).await.unwrap_err();
    assert_eq!(reason(&e), "photo_count");
    let e = render(&w, "dup", &[ps[0].id, ps[1].id, ps[0].id])
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "duplicate_photo");
    assert_eq!(e.details["field"], "photos.2.material_id");
    let mut long = request("long", &ids(&ps));
    long.photos[1].text = Some("ç".repeat(61));
    let e = reel::reel_render(&w.d, &w.ctx, long).await.unwrap_err();
    assert_eq!(reason(&e), "text_overflow");
    assert_eq!(e.details["slot"], "photos.1.text");
    let mut wide = carded("wide", &ids(&ps));
    wide.closing.as_mut().unwrap().site = Some("WWWWWWWWWWWWWWWWWWWWWWWWWWW".into());
    let e = reel::reel_render(&w.d, &w.ctx, wide).await.unwrap_err();
    assert_eq!(reason(&e), "text_overflow");
    assert_eq!(e.details["slot"], "closing.site");
    assert_eq!(e.details["cause"], "word_too_wide");
    let mut slow = request("slow", &ids(&ps));
    slow.photo_ms = Some(5_000);
    let e = reel::reel_render(&w.d, &w.ctx, slow).await.unwrap_err();
    assert_eq!(reason(&e), "photo_ms_out_of_range");
    // A photo not analysed yet: retryable, naming it.
    let fresh = unanalysed_photo(&w, "fresh", 200, o).await;
    let e = render(&w, "fresh", &[ps[0].id, ps[1].id, fresh.id])
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(reason(&e), "source_not_analysed");
    assert_eq!(e.details["field"], "photos.2.material_id");
    assert_eq!(e.details["retryable"], json!(true));
    analysed(&w, fresh.id).await;
    render(&w, "fresh", &[ps[0].id, ps[1].id, fresh.id])
        .await
        .unwrap();
    // A reel is no photo of another reel.
    let first = material(&w, ps[0].id);
    let made = w
        .uow
        .snapshot()
        .materials
        .materials
        .into_iter()
        .find(|m| m.composition.is_some())
        .unwrap();
    let e = render(&w, "of-reel", &[first.id, ps[1].id, made.id])
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_not_image");
}

/// Provenance and the AI flag: an AI photo or an AI logo makes the reel AI-generated
/// (generator jeeta-reel); the logo is recorded last and apart; one the renderer can no longer
/// draw is left out and said so. People and the most restrictive permission come from the photos.
#[tokio::test]
async fn provenance_ai_flag_people_and_the_logo_come_from_the_sources() {
    let w = reel_world().await;
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let ada = person(&w, "ada").await;
    let file = upload(&w, "f-ada", 90).await;
    let with_ada = library::material_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"ada","file_id":file,"origin":{"kind":"real"},
            "olay_id":o,"share":"product_only","quality":"publishable","people":[ada]}),
        ),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, with_ada.id).await;
    let out = render(&w, "people", &[ps[0].id, ps[1].id, with_ada.id])
        .await
        .unwrap();
    assert!(out.material.people.contains(&ada.0));
    assert_eq!(
        out.material.share.as_ref().map(|s| s.permission),
        Some(SharePermission::ProductOnly)
    );
    // An AI photo, genel.
    let ai_file = upload(&w, "f-ai", 91).await;
    let ai = library::material_add(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"ai","file_id":ai_file,
            "origin":{"kind":"ai_generated","generator":"some-model"},
            "genel":true,"depicts":[],"share":"shareable","quality":"publishable"})),
    )
    .await
    .unwrap()
    .material;
    analysed(&w, ai.id).await;
    let out = render(&w, "ai", &[ps[0].id, ai.id, ps[2].id])
        .await
        .unwrap();
    assert!(out.ai_generated);
    assert_eq!(
        out.material.origin,
        Origin::AiGenerated {
            generator: REEL_AI_GENERATOR.into()
        }
    );
    // An AI logo: recorded last, and apart.
    let logo_file = upload(&w, "f-logo", 92).await;
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
    let out = render(&w, "logo", &ids(&ps)).await.unwrap();
    assert!(out.ai_generated);
    let c = out.material.composition.as_ref().unwrap();
    assert_eq!(c.sources, [ids(&ps), vec![logo.id]].concat());
    assert_eq!(c.logo, Some(logo.id));
    // Its analysis is asked for again: the logo is left out, and the answer says so.
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":logo.id,"expected_revision":material(&w, logo.id).revision})),
    )
    .await
    .unwrap();
    let mut r = request("no-logo", &ids(&ps));
    r.photo_ms = Some(2600);
    let out = reel::reel_render(&w.d, &w.ctx, r).await.unwrap();
    assert!(
        out.brand_fallbacks
            .iter()
            .any(|f| f.token == "logo_material_id")
    );
    assert_eq!(out.material.composition.as_ref().unwrap().sources, ids(&ps));
    assert!(!out.ai_generated);
}

/// A reel follows its sources: a photo deleted (the reel redacted, its replay refused), made not
/// shareable (its permission cleared, then fenced when re-approved), tagged with a person later
/// (added, cleared) and that person erased (redacted), judged unusable (unusable), erased by the
/// retention rule (redacted).
#[tokio::test]
async fn a_reel_follows_its_sources() {
    let mut w = reel_world().await;
    let o = olay(&w).await;

    // Deleted.
    let ps = photos(&w, "a", o).await;
    let r1 = render(&w, "r1", &ids(&ps)).await.unwrap().material;
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":ps[1].id,"expected_revision":ps[1].revision,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(material(&w, r1.id).erased_at.is_some());
    let e = render(&w, "r1", &ids(&ps)).await.unwrap_err();
    assert_eq!(reason(&e), "render_erased");

    // Not shareable, then the reel re-approved: the fence still holds it.
    let qs = photos(&w, "b", o).await;
    let r2 = render(&w, "r2", &ids(&qs)).await.unwrap().material;
    assert!(r2.share.is_some());
    permit(&w, qs[0].id, "not_shareable").await;
    assert!(material(&w, r2.id).share.is_none());
    permit(&w, r2.id, "shareable").await;
    let blocked = {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        library::blocked_derivatives(r.as_mut()).await.unwrap()
    };
    assert!(blocked.contains(&r2.id));

    // A person tagged after the render, then erased.
    let ada = person(&w, "ada").await;
    let ss = photos(&w, "c", o).await;
    let r3 = render(&w, "r3", &ids(&ss)).await.unwrap().material;
    library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":ss[2].id,"expected_revision":ss[2].revision,"people":[ada]})),
    )
    .await
    .unwrap();
    assert!(material(&w, r3.id).people.contains(&ada.0));
    assert!(material(&w, r3.id).share.is_none());
    jt_app::usecases::inbox::erasure::erase(
        &w.d,
        &w.ctx,
        ada,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(material(&w, r3.id).erased_at.is_some());

    // Judged unusable.
    let us = photos(&w, "d", o).await;
    let r4 = render(&w, "r4", &ids(&us)).await.unwrap().material;
    library::material_tag(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":us[0].id,"expected_revision":material(&w, us[0].id).revision,
            "quality":"unusable"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(material(&w, r4.id).tags.quality, Some(Quality::Unusable));

    // The retention rule: an old olay's face photo goes, and the reel with it.
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
    let mut olds = Vec::new();
    for n in 0..3u8 {
        let file = upload(&w, &format!("f-old-{n}"), 120 + n).await;
        let m = library::material_add(
            &w.d,
            &w.ctx,
            input(
                json!({"request_key":format!("old-{n}"),"file_id":file,"origin":{"kind":"real"},
                "olay_id":old,"share":"shareable","quality":"publishable","depicts":["face"]}),
            ),
        )
        .await
        .unwrap()
        .material;
        analysed(&w, m.id).await;
        olds.push(m);
    }
    let r5 = render(&w, "r5", &ids(&olds)).await.unwrap().material;
    w.d.clock = Arc::new(jt_testkit::fakes::FixedClock(
        datetime!(2028-10-23 12:00 UTC),
    ));
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(material(&w, olds[0].id).erased_at.is_some());
    assert!(material(&w, r5.id).erased_at.is_some());
}

/// A marker an agent's analysis adds to a photo after the reel was made reaches the reel.
#[tokio::test]
async fn a_late_analysis_marker_reaches_the_reel() {
    let mut w = reel_world().await;
    w.d.tokens = Arc::new(jt_testkit::fakes::FixedTokenGen::new(
        (0..20).map(|n| format!("analysis-token-{n}")),
    ));
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let r = render(&w, "r", &ids(&ps)).await.unwrap().material;
    assert!(r.tags.depicts.is_empty() && r.share.is_some());
    let a = agent_of(&w);
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":ps[1].id,"expected_revision":material(&w, ps[1].id).revision})),
    )
    .await
    .unwrap();
    let claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":ps[1].id,"expected_revision":material(&w, ps[1].id).revision})),
    )
    .await
    .unwrap();
    library::material_analysis_complete(
        &w.d,
        &a,
        input(
            json!({"material_id":ps[1].id,"expected_revision":claim.expected_revision,
            "claim_token":claim.claim_token,"description":"Bir tezgâh ve bir kişi",
            "labels":["tezgâh"],"date_source":"unknown","depicts":["face"]}),
        ),
    )
    .await
    .unwrap();
    let after = material(&w, r.id);
    assert!(after.tags.depicts.contains(&Depicts::Face));
    assert!(after.share.is_none());
}

/// A content area: a reel of the area's own photos, rendered with its project_id, is the area's
/// and is delivered by its material id as format reel; the package waits for the owner. A photo
/// outside the area is refused before drawing.
#[tokio::test]
async fn a_content_area_takes_a_reel_of_its_own_photos_as_a_reel() {
    let w = reel_world().await;
    let o = olay(&w).await;
    let inside = photos(&w, "in", o).await;
    let outside = photo(&w, "out", 210, o).await;
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"area","brief":"Atölyeden kısa bir video hazırla"})),
    )
    .await
    .unwrap();
    let p = projects::project_materials(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"add":ids(&inside)})),
    )
    .await
    .unwrap();
    let mut out_of_area = request("out", &[inside[0].id, inside[1].id, outside.id]);
    out_of_area.project_id = Some(p.id);
    let e = reel::reel_render(&w.d, &w.ctx, out_of_area)
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "source_not_in_area");
    assert_eq!(e.details["missing"], json!([outside.id]));
    let mut ok = request("in", &ids(&inside));
    ok.project_id = Some(p.id);
    let made = reel::reel_render(&w.d, &w.ctx, ok).await.unwrap();
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
    let out = jt_app::usecases::content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":claim.claim_token,"request_key":"reel",
            "summary":"Kısa video hazır","versions":[{"format":"reel","text":"Atölyeden bir gün",
            "material_ids":[made.material.id],"capability_id":w.f.slot.capability_id,
            "hypothesis_id":w.f.slot.chain.hypothesis_id}]}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(out.project.packages.len(), 1);
    let v = &out.project.packages[0].versions[0];
    assert_eq!(v.format, PostFormat::Reel);
    assert_eq!(v.material_ids, vec![made.material.id]);
}

/// A post request and its slot: a reel of an olay's photos is no new material of that olay (no
/// request names it), it is proposed by its material id as format reel, and its file submitted
/// as the slot's piece makes the slot ready for the owner.
#[tokio::test]
async fn a_reel_goes_through_a_post_request_and_its_slot() {
    let w = reel_world().await;
    let o = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        r.studio_materials().insert_olay(o.clone()).await.unwrap();
        r.commit().await.unwrap();
    }
    let ps = photos(&w, "p", o.id).await;
    planner::plan(&w.d, w.f.ws, FIXED_NOW + Duration::minutes(31))
        .await
        .unwrap();
    let requests = || {
        w.uow
            .snapshot()
            .posts
            .requests
            .into_iter()
            .filter(|r| r.workspace_id == w.f.ws)
            .collect::<Vec<_>>()
    };
    let before = requests();
    assert_eq!(before.len(), 1, "the photos' request");
    let made = reel::reel_render(
        &w.d,
        &at(&w, FIXED_NOW + Duration::minutes(40)),
        request("reel", &ids(&ps)),
    )
    .await
    .unwrap();
    planner::plan(&w.d, w.f.ws, FIXED_NOW + Duration::minutes(200))
        .await
        .unwrap();
    let after = requests();
    assert_eq!(after.len(), 1, "no request for the reel");
    assert!(
        after
            .iter()
            .all(|q| !q.material_ids.contains(&made.material.id))
    );
    let out = posts::posts_propose(
        &w.d,
        &at(&w, datetime!(2026-10-22 10:00 UTC)),
        input(
            json!({"request_id":before[0].id,"request_key":"package","posts":[{
            "format":"reel","capability_id":w.f.slot.capability_id,
            "publish_at":"2026-10-25T07:00:00Z","material_ids":[made.material.id],
            "subject":Subject::Olay { olay_id: o.id },
            "hypothesis_id":w.f.slot.chain.hypothesis_id}]}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(out.posts[0].post.format, PostFormat::Reel);
    let slot = out.posts[0].slot.id;
    let done = piece_submit(
        &w.d,
        &at(&w, datetime!(2026-10-23 08:00 UTC)),
        PieceInput {
            slot_id: slot,
            expected_revision: 0,
            request_key: "piece".into(),
            text: "Atölyeden bir gün".into(),
            media: vec![MediaAsset::File { id: made.file.id }],
            adaptations: Default::default(),
            subject: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(done.slot.state, SlotState::Ready);
    assert_eq!(done.post.unwrap().format, PostFormat::Reel);
}

/// The real renderer behind a gate: each reel waits until the test opens the gate, and the
/// reels it was asked for are counted.
struct Gated {
    inner: jt_render::Renderer,
    gate: Arc<tokio::sync::Semaphore>,
    reels: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl jt_app::ports::compose::Compositor for Gated {
    async fn reserve(
        &self,
    ) -> Result<jt_app::ports::compose::RenderTicket, jt_app::ports::compose::ComposeError> {
        self.inner.reserve().await
    }
    async fn compose(
        &self,
        ticket: jt_app::ports::compose::RenderTicket,
        job: jt_app::ports::compose::ComposeJob,
    ) -> Result<jt_app::ports::compose::Composed, jt_app::ports::compose::ComposeError> {
        self.inner.compose(ticket, job).await
    }
    fn uncovered(&self, text: &str) -> Vec<char> {
        self.inner.uncovered(text)
    }
    async fn reserve_reel(
        &self,
    ) -> Result<jt_app::ports::compose::RenderTicket, jt_app::ports::compose::ComposeError> {
        self.inner.reserve_reel().await
    }
    async fn render_reel(
        &self,
        ticket: jt_app::ports::compose::RenderTicket,
        job: jt_app::ports::compose::ReelJob,
        photos: Box<dyn jt_app::ports::compose::ReelPhotoBytes>,
    ) -> Result<jt_app::ports::compose::RenderedReel, jt_app::ports::compose::ComposeError> {
        self.reels.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.gate.acquire().await.expect("gate").forget();
        self.inner.render_reel(ticket, job, photos).await
    }
}

/// [`reel_world`] with the gated renderer.
async fn gated_world() -> (World, Arc<Gated>) {
    let mut w = reel_world().await;
    let gated = Arc::new(Gated {
        inner: jt_render::Renderer::new(jt_render::Limits::default()),
        gate: Arc::new(tokio::sync::Semaphore::new(0)),
        reels: Default::default(),
    });
    w.d.compositor = gated.clone();
    (w, gated)
}

/// Waits (a bounded while) until `done` holds.
async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..600 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("never happened");
}

fn reels_stored(w: &World) -> Vec<Material> {
    w.uow
        .snapshot()
        .materials
        .materials
        .into_iter()
        .filter(|m| m.composition.is_some())
        .collect()
}

/// A call that goes away mid-render (its client disconnected) does not lose the reel: the
/// render goes on detached, the reel and its receipt are stored, and the key's replay answers
/// it without a second render.
#[tokio::test]
async fn a_reel_whose_caller_went_away_is_stored_and_replayed() {
    let (w, gated) = gated_world().await;
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let call = {
        let (d, ctx, input) = (w.d.clone(), w.ctx.clone(), request("gone", &ids(&ps)));
        tokio::spawn(async move { reel::reel_render(&d, &ctx, input).await })
    };
    until(|| gated.reels.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    // The client disconnects: the call's future is dropped mid-render.
    call.abort();
    let _ = call.await;
    gated.gate.add_permits(8);
    until(|| reels_stored(&w).len() == 1).await;
    let again = render(&w, "gone", &ids(&ps)).await.unwrap();
    assert_eq!(again.material.id, reels_stored(&w)[0].id);
    assert_eq!(gated.reels.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// Two calls with one key while its reel is being made: one render, both answered with it. A
/// different input under that key is refused while it renders, as it is once stored.
#[tokio::test]
async fn one_key_renders_once_and_refuses_another_input_meanwhile() {
    let (w, gated) = gated_world().await;
    let o = olay(&w).await;
    let ps = photos(&w, "p", o).await;
    let spawn = |input: reel::ReelRenderInput| {
        let (d, ctx) = (w.d.clone(), w.ctx.clone());
        tokio::spawn(async move { reel::reel_render(&d, &ctx, input).await })
    };
    let first = spawn(request("twice", &ids(&ps)));
    until(|| gated.reels.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let second = spawn(request("twice", &ids(&ps)));
    let mut other = request("twice", &ids(&ps));
    other.photo_ms = Some(3000);
    let e = reel::reel_render(&w.d, &w.ctx, other).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    gated.gate.add_permits(8);
    let (a, b) = (
        first.await.unwrap().unwrap(),
        second.await.unwrap().unwrap(),
    );
    assert_eq!(a.material.id, b.material.id);
    assert_eq!(gated.reels.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(reels_stored(&w).len(), 1);
}
