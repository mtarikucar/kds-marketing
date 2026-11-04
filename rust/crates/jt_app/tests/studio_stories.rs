//! Instagram stories (spec 2026-11-03 D30, D60): a story is one medium Instagram takes (a JPEG up
//! to 8 MB, or an MP4 of 3 to 60 seconds), checked at the proposal and at submission with a
//! refusal that says what to fix; its text never goes out, so it needs none and the caption check
//! has nothing to read; it goes out as a story, and it is left out of measurement and learning.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{
        UnitOfWork,
        connectors::{PostFormat as WireFormat, PublishReceipt},
        files::StoredFile,
    },
    usecases::studio::{
        measure,
        pieces::{PieceInput, piece_submit},
        planner, posts, publish,
    },
};
use jt_strategy::ChannelChoice;
use jt_studio::*;
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW, FixedClock, files::MemoryFiles};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, macros::datetime};

/// The test world on an Instagram account: the fixture's channel is Instagram, connected for
/// publishing, and the strategy chooses it; the library starts empty.
async fn instagram_world() -> World {
    let mut w = world().await;
    w.d.files = Arc::new(MemoryFiles::default());
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

/// A confirmed workshop on FIXED_NOW's day.
async fn workshop(w: &World) -> Olay {
    let o = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials().insert_olay(o.clone()).await.unwrap();
    r.commit().await.unwrap();
    o
}

/// A shareable, publishable material of `olay` for a file of `bytes` typed `mime`.
async fn material(w: &World, olay: &Olay, mime: &str, bytes: Vec<u8>) -> Material {
    let upload = MediaUpload {
        bytes,
        mime: mime.into(),
        filename: "story".into(),
    };
    let file: StoredFile =
        w.d.files
            .put(w.f.ws, FileId::new_v7(), upload)
            .await
            .unwrap();
    let mut m = jt_testkit::studio_contract::eligible_material(olay, file.id);
    m.mime = mime.into();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

fn jpeg(len: usize) -> Vec<u8> {
    let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0];
    b.resize(len.max(4), 0);
    b
}

fn png() -> Vec<u8> {
    b"\x89PNG\r\n\x1a\nstory".to_vec()
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut b = u32::try_from(8 + payload.len())
        .unwrap()
        .to_be_bytes()
        .to_vec();
    b.extend_from_slice(kind);
    b.extend_from_slice(payload);
    b
}

/// An MP4 of `ms` milliseconds (its `mvhd` in a timescale of 1000), or with no `moov` at all.
fn mp4(ms: Option<u32>) -> Vec<u8> {
    let mut b = mp4_box(b"ftyp", b"isom\x00\x00\x02\x00isom");
    b.extend(mp4_box(b"mdat", &[0u8; 64]));
    if let Some(ms) = ms {
        let mut mvhd = vec![0u8; 4];
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&ms.to_be_bytes());
        mvhd.extend(std::iter::repeat_n(0u8, 80));
        b.extend(mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)));
    }
    b
}

async fn plan(w: &World, at: OffsetDateTime) {
    planner::plan(&w.d, w.f.ws, at).await.unwrap();
}

fn ctx_at(w: &World, now: OffsetDateTime) -> jt_app::ctx::Ctx {
    let mut ctx = w.ctx.clone();
    ctx.now = now;
    ctx
}

fn story(at: OffsetDateTime, m: &Material, o: &Olay, w: &World) -> Value {
    json!({"format":"story","capability_id":w.f.slot.capability_id,
        "publish_at":at.format(&time::format_description::well_known::Rfc3339).unwrap(),
        "material_ids":[m.id],"subject":Subject::Olay { olay_id: o.id },
        "hypothesis_id":w.f.slot.chain.hypothesis_id})
}

async fn propose(
    w: &World,
    request: PackageRequestId,
    key: &str,
    items: Vec<Value>,
) -> Result<posts::PackageProposalOut, jt_app::error::AppError> {
    posts::posts_propose(
        &w.d,
        &ctx_at(w, NOW),
        serde_json::from_value(json!({"request_id":request,"request_key":key,"posts":items}))
            .unwrap(),
    )
    .await
}

/// 22 October, 10:00 UTC (13:00 in Istanbul).
const NOW: OffsetDateTime = datetime!(2026-10-22 10:00 UTC);
/// 23 October, 09:00 in Istanbul.
const MORNING: OffsetDateTime = datetime!(2026-10-23 06:00 UTC);

/// The olay request for `o`'s materials, once they settled.
async fn request(w: &World) -> PackageRequestId {
    plan(w, FIXED_NOW + Duration::minutes(31)).await;
    w.uow
        .snapshot()
        .posts
        .requests
        .into_iter()
        .find(|q| q.trigger == PackageTrigger::Olay)
        .expect("the olay's request")
        .id
}

#[tokio::test]
async fn a_story_is_one_jpeg_up_to_8_mb_or_one_video_of_3_to_60_seconds() {
    let w = instagram_world().await;
    let o = workshop(&w).await;
    let fine = material(&w, &o, "image/jpeg", jpeg(1000)).await;
    let png = material(&w, &o, "image/png", png()).await;
    let big = material(&w, &o, "image/jpeg", jpeg(8_000_001)).await;
    let short = material(&w, &o, "video/mp4", mp4(Some(2_000))).await;
    let long = material(&w, &o, "video/mp4", mp4(Some(61_000))).await;
    let unknown = material(&w, &o, "video/mp4", mp4(None)).await;
    let video = material(&w, &o, "video/mp4", mp4(Some(10_000))).await;
    let q = request(&w).await;
    let at = |n: i64| MORNING + Duration::minutes(10 * n);
    let e = propose(
        &w,
        q,
        "stories",
        vec![
            story(at(0), &fine, &o, &w),
            story(at(1), &png, &o, &w),
            story(at(2), &big, &o, &w),
            story(at(3), &short, &o, &w),
            story(at(4), &long, &o, &w),
            story(at(5), &unknown, &o, &w),
            story(at(6), &video, &o, &w),
        ],
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "package_refused");
    let reasons: Vec<(u64, String)> = e.details["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["index"].as_u64().unwrap(),
                i["reason"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        reasons,
        [
            (1, "story_image_jpeg_only"),
            (2, "story_image_too_large"),
            (3, "story_video_length"),
            (4, "story_video_length"),
            (5, "story_video_length_unknown"),
        ]
        .map(|(i, r)| (i, r.to_owned()))
    );
    // A burst: twenty stories ten minutes apart, as new products arrive.
    let burst: Vec<Value> = (0..20)
        .map(|n| story(at(n), if n % 2 == 0 { &fine } else { &video }, &o, &w))
        .collect();
    let out = propose(&w, q, "burst", burst).await.unwrap();
    assert_eq!(out.posts.len(), 20);
    assert!(out.posts.iter().all(|p| p.post.format == PostFormat::Story));
    // A story's preparation starts two hours before it goes out.
    assert_eq!(
        out.posts[0].post.prep_start_at,
        MORNING - Duration::hours(2)
    );
}

#[tokio::test]
async fn a_story_needs_no_text_its_caption_is_not_checked_and_it_goes_out_as_a_story() {
    let mut w = instagram_world().await;
    let o = workshop(&w).await;
    let fine = material(&w, &o, "image/jpeg", jpeg(1000)).await;
    let png = material(&w, &o, "image/png", png()).await;
    // Another olay whose place a caption could name.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut moda = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    moda.place = Some("Moda Sahnesi".into());
    r.studio_materials().insert_olay(moda).await.unwrap();
    r.commit().await.unwrap();
    let q = request(&w).await;
    let out = propose(&w, q, "one", vec![story(MORNING, &fine, &o, &w)])
        .await
        .unwrap();
    let slot = out.posts[0].slot.id;
    let ctx = ctx_at(&w, MORNING - Duration::hours(1));
    let submit = |m: &Material, text: &str, key: &str| PieceInput {
        slot_id: slot,
        expected_revision: 0,
        request_key: key.into(),
        text: text.into(),
        media: vec![MediaAsset::File { id: m.file_id }],
        adaptations: Default::default(),
        subject: None,
    };
    // What to fix, by its code (the panel words it).
    let e = piece_submit(&w.d, &ctx, submit(&png, "", "png"))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "story_image_jpeg_only");
    assert_eq!(e.details["field"], "media");
    // No text needed; a text naming another olay's place holds nothing: it never goes out.
    let done = piece_submit(&w.d, &ctx, submit(&fine, "Moda Sahnesi'nde", "jpeg"))
        .await
        .unwrap();
    assert_eq!(done.slot.state, SlotState::Ready);
    let check = done.material_check.unwrap();
    assert!(check.findings.is_empty() && !check.holds, "{check:?}");

    // At its time it goes out as a story.
    w.d.clock = Arc::new(FixedClock(MORNING));
    w.ads.push_publish(Ok(PublishReceipt {
        external_id: "story-1".into(),
        url: None,
    }));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let sent: Vec<_> = w
        .ads
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::Publish { request, .. } => Some(request),
            _ => None,
        })
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].format, Some(WireFormat::Story));

    // Never measured: its insights last a day, and learning leaves it out.
    w.d.clock = Arc::new(FixedClock(MORNING + Duration::days(8)));
    measure::measure_due(&w.d, w.f.ws).await.unwrap();
    assert!(
        !w.ads
            .calls()
            .iter()
            .any(|c| matches!(c, ConnectorCall::PostMetrics { .. }))
    );
    assert!(w.uow.snapshot().studio.measurements.is_empty());
}
