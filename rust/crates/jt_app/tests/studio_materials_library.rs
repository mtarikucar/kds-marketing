//! The materials library's use cases (spec 2026-11-03 §5.2, §5.3, §8, §9): olays, materials and
//! their tags, what a slot may show, the calendar, the çekim listesi, and a person's erasure and
//! the retention rule. None needs an approved strategy (D35); every consent decision is an owner's
//! or a manager's in person (D4), the AI self-permission aside (D5, D17).
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_app::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::UnitOfWork,
    usecases::{
        inbox::{erasure, people},
        studio::{files, library},
        work,
    },
};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering::SeqCst},
};
use time::{OffsetDateTime, macros::datetime};

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

fn owner(w: &World) -> UserId {
    match w.ctx.actor {
        Actor::Human { user_id } => user_id,
        _ => unreachable!("the world's caller is its owner"),
    }
}

/// The owner's key used by an agent through its connection.
fn agent(w: &World) -> Ctx {
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id: owner(w),
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

/// A person in the panel who is neither owner nor manager (a role with `studio.work`).
fn member(w: &World) -> Ctx {
    Ctx {
        role_key: Some("studio_helper".into()),
        ..w.ctx.clone()
    }
}

fn png(n: u8) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    b.push(n);
    b
}

/// A JPEG whose EXIF `DateTimeOriginal` is `date` (Istanbul time).
fn jpeg(date: &str) -> Vec<u8> {
    let mut tiff = b"II\x2a\0\x08\0\0\0".to_vec();
    // IFD0: the Exif sub-IFD at 26.
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x8769u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&26u32.to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    // The Exif IFD: DateTimeOriginal at 44.
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x9003u16.to_le_bytes());
    tiff.extend_from_slice(&2u16.to_le_bytes());
    tiff.extend_from_slice(&20u32.to_le_bytes());
    tiff.extend_from_slice(&44u32.to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(format!("{date}\0").as_bytes());
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
    out.extend_from_slice(b"Exif\0\0");
    out.extend_from_slice(&tiff);
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

/// An MP4 whose `moov`, with an `mvhd` made at `at`, follows `padding` bytes of media data.
fn mp4(at: OffsetDateTime, padding: usize) -> Vec<u8> {
    let mut b = 16u32.to_be_bytes().to_vec();
    b.extend_from_slice(b"ftypisom");
    b.extend_from_slice(&0u32.to_be_bytes());
    b.extend_from_slice(&u32::try_from(8 + padding).unwrap().to_be_bytes());
    b.extend_from_slice(b"mdat");
    b.extend(std::iter::repeat_n(0u8, padding));
    // Seconds since 1904-01-01, the epoch of ISO base media times.
    let created = u32::try_from(at.unix_timestamp() + 2_082_844_800).unwrap();
    // Version 0 and flags, creation and modification times, timescale, duration, the rest.
    let mut mvhd = vec![0u8; 4];
    mvhd.extend_from_slice(&created.to_be_bytes());
    mvhd.extend_from_slice(&created.to_be_bytes());
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&5000u32.to_be_bytes());
    mvhd.extend(std::iter::repeat_n(0u8, 80));
    let mut mvhd_box = u32::try_from(8 + mvhd.len())
        .unwrap()
        .to_be_bytes()
        .to_vec();
    mvhd_box.extend_from_slice(b"mvhd");
    mvhd_box.extend(mvhd);
    b.extend_from_slice(&u32::try_from(8 + mvhd_box.len()).unwrap().to_be_bytes());
    b.extend_from_slice(b"moov");
    b.extend(mvhd_box);
    b
}

/// A file store that counts the bytes it gives out, whichever way they are read.
struct Counting {
    inner: Arc<dyn jt_app::ports::files::FileStore>,
    read: Arc<AtomicU64>,
}

#[async_trait::async_trait]
impl jt_app::ports::files::FileStore for Counting {
    async fn probe(&self) -> Result<(), AppError> {
        self.inner.probe().await
    }
    async fn put(
        &self,
        ws: jt_tenancy::WorkspaceId,
        id: FileId,
        u: MediaUpload,
    ) -> Result<jt_app::ports::files::StoredFile, AppError> {
        self.inner.put(ws, id, u).await
    }
    async fn read(&self, ws: jt_tenancy::WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        let u = self.inner.read(ws, id).await?;
        self.read.fetch_add(u.bytes.len() as u64, SeqCst);
        Ok(u)
    }
    async fn read_range(
        &self,
        ws: jt_tenancy::WorkspaceId,
        id: FileId,
        offset: u64,
        len: usize,
    ) -> Result<Vec<u8>, AppError> {
        let part = self.inner.read_range(ws, id, offset, len).await?;
        self.read.fetch_add(part.len() as u64, SeqCst);
        Ok(part)
    }
    async fn provider_url(
        &self,
        ws: jt_tenancy::WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
    ) -> Result<url::Url, AppError> {
        self.inner.provider_url(ws, id, expires_at).await
    }
    async fn delete(&self, ws: jt_tenancy::WorkspaceId, id: FileId) -> Result<(), AppError> {
        self.inner.delete(ws, id).await
    }
}

async fn upload(w: &World, key: &str, mime: &str, bytes: &[u8]) -> FileId {
    files::file_upload(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"filename":"m.img","mime":mime,
            "content":{"kind":"bytes_base64","data":STANDARD.encode(bytes)}})),
    )
    .await
    .unwrap()
    .id
}

async fn olay(w: &World, ctx: &Ctx, key: &str, extra: Value) -> Olay {
    library::olay_create(&w.d, ctx, olay_input(key, extra))
        .await
        .unwrap()
}

fn olay_input(key: &str, extra: Value) -> library::OlayCreateInput {
    let mut v = json!({"request_key":key,"kind":"workshop","title":"Atölye",
        "starts_on":"2026-11-16","ends_on":"2026-11-16"});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    input(v)
}

/// The input of `material_add` for `file`, with `extra` fields.
fn add_input(key: &str, file: FileId, extra: Value) -> library::MaterialAddInput {
    let mut v = json!({"request_key":key,"file_id":file,"origin":{"kind":"real"}});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    input(v)
}

async fn add(w: &World, ctx: &Ctx, key: &str, file: FileId, extra: Value) -> Material {
    library::material_add(&w.d, ctx, add_input(key, file, extra))
        .await
        .unwrap()
        .material
}

#[tokio::test]
async fn an_owners_olay_is_confirmed_and_an_agents_proposed() {
    let (w, _) = publishing_world().await;
    let mine = olay(&w, &w.ctx, "mine", json!({})).await;
    assert_eq!(mine.status, OlayStatus::Confirmed);
    assert_eq!(
        mine.confirmed,
        Some(HumanMark {
            by: owner(&w),
            at: FIXED_NOW
        })
    );
    for (key, ctx) in [("agent", agent(&w)), ("member", member(&w))] {
        let o = olay(&w, &ctx, key, json!({})).await;
        assert_eq!(
            (o.status, o.confirmed),
            (OlayStatus::Proposed, None),
            "{key}"
        );
    }
    // Replayed by its key; the same key with another input is a conflict.
    let again = olay(&w, &w.ctx, "mine", json!({})).await;
    assert_eq!(again, mine);
    let e = library::olay_create(&w.d, &w.ctx, olay_input("mine", json!({"title":"Başka"})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    // The rules of an olay hold.
    for (extra, field) in [
        (json!({"ends_on":"2026-11-01"}), "dates"),
        (json!({"kind":"season"}), "occasion"),
        (json!({"occasion":"yilbasi"}), "occasion"),
        (json!({"title":" "}), "title"),
        (json!({"client":{}}), "client"),
    ] {
        let e = library::olay_create(&w.d, &w.ctx, olay_input(field, extra))
            .await
            .unwrap_err();
        assert_eq!(
            (e.code, e.details["field"].as_str()),
            (ErrorCode::Validation, Some(field))
        );
    }
    let listed = library::olays_list(&w.d, &w.ctx, input(json!({"status":"proposed"})))
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
}

#[tokio::test]
async fn an_agent_changes_only_proposed_olays_and_only_a_human_confirms() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let proposed = olay(&w, &a, "proposed", json!({"place":"Moda"})).await;
    let changed = library::olay_update(
        &w.d,
        &a,
        input(json!({"olay_id":proposed.id,"expected_revision":1,"title":"Atölye 2","place":null})),
    )
    .await
    .unwrap();
    assert_eq!((changed.title.as_str(), changed.place), ("Atölye 2", None));
    assert_eq!(changed.revision, 2);
    // A stale revision, and an edit naming nothing.
    let e = library::olay_update(
        &w.d,
        &a,
        input(json!({"olay_id":proposed.id,"expected_revision":1,"title":"x"})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = library::olay_update(
        &w.d,
        &a,
        input(json!({"olay_id":proposed.id,"expected_revision":2})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    // Only an owner or manager in person confirms.
    for ctx in [a.clone(), member(&w)] {
        let e = library::olay_confirm(
            &w.d,
            &ctx,
            input(json!({"olay_id":proposed.id,"expected_revision":2})),
        )
        .await
        .unwrap_err();
        assert_eq!(
            (e.code, reason(&e)),
            (ErrorCode::Forbidden, "owner_or_manager_human")
        );
    }
    let confirmed = library::olay_confirm(
        &w.d,
        &w.ctx,
        input(json!({"olay_id":proposed.id,"expected_revision":2})),
    )
    .await
    .unwrap();
    assert!(confirmed.is_confirmed());
    let e = library::olay_confirm(
        &w.d,
        &w.ctx,
        input(json!({"olay_id":proposed.id,"expected_revision":3})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "already_confirmed");
    // A confirmed olay is a human's to change.
    for ctx in [a, member(&w)] {
        let e = library::olay_update(
            &w.d,
            &ctx,
            input(json!({"olay_id":proposed.id,"expected_revision":3,"ends_on":"2026-11-17"})),
        )
        .await
        .unwrap_err();
        assert_eq!(
            (e.code, reason(&e)),
            (ErrorCode::Forbidden, "owner_or_manager_human")
        );
    }
    library::olay_update(
        &w.d,
        &w.ctx,
        input(json!({"olay_id":proposed.id,"expected_revision":3,"ends_on":"2026-11-17"})),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_library_needs_no_strategy_but_an_active_workspace() {
    let (w, _) = publishing_world().await;
    w.archive().await;
    let file = upload(&w, "file", "image/png", &png(1)).await;
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    add(
        &w,
        &w.ctx,
        "material",
        file,
        json!({"olay_id":o.id,"share":"shareable"}),
    )
    .await;
    library::shoot_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"shoot","text":"Çek"})),
    )
    .await
    .unwrap();
    library::calendar_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    // The shoot request is pending work without a strategy.
    let pending = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(
        pending
            .items
            .iter()
            .any(|i| matches!(i.kind, work::WorkKind::StudioShootRequest { .. }))
    );
    let mut r = w.uow.platform().await.unwrap();
    r.workspace_set_status(
        w.f.ws,
        WorkspaceStatus::Suspended,
        "test",
        &Actor::System {
            component: "test".into(),
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    let e = library::olays_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::WorkspaceInactive);
    let e = library::olay_create(&w.d, &w.ctx, olay_input("later", json!({})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::WorkspaceInactive);
    // `studio.work` is needed.
    let mut rep = w.ctx.clone();
    rep.permissions = jt_tenancy::SystemRole::Rep.permissions();
    let e = library::materials_list(&w.d, &rep, input(json!({})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_material_takes_its_capture_time_from_its_bytes_and_suggests_its_olays() {
    let (w, _) = publishing_world().await;
    let workshop = olay(&w, &w.ctx, "workshop", json!({})).await;
    let order = olay(
        &w,
        &agent(&w),
        "order",
        json!({"kind":"order","starts_on":"2026-11-10","ends_on":"2026-11-20"}),
    )
    .await;
    let file = upload(&w, "photo", "image/jpeg", &jpeg("2026:11:16 10:30:00")).await;
    let i = add_input(
        "photo",
        file,
        json!({"olay_id":workshop.id,"share":"shareable","quality":"publishable",
            "product_groups":["figur"],"captured_at":"2020-01-01T00:00:00Z"}),
    );
    let out = library::material_add(&w.d, &w.ctx, i.clone())
        .await
        .unwrap();
    assert_eq!(
        out.material.captured_at,
        Some(datetime!(2026-11-16 10:30 +03:00))
    );
    assert_eq!(
        out.olay_suggestions
            .iter()
            .map(|o| o.id)
            .collect::<Vec<_>>(),
        vec![workshop.id, order.id]
    );
    let m = &out.material;
    assert_eq!(
        m.binding,
        Binding::Olay {
            olay_id: workshop.id
        }
    );
    assert_eq!(m.mime, "image/jpeg");
    assert_eq!(m.created_by, w.ctx.actor);
    assert_eq!(m.tags_reviewed_by, Some(owner(&w)));
    assert_eq!(
        m.share.as_ref().map(|s| (s.permission, s.by)),
        Some((SharePermission::Shareable, Some(owner(&w))))
    );
    // Replayed by its key: the same answer.
    let again = library::material_add(&w.d, &w.ctx, i).await.unwrap();
    assert_eq!(again.material, out.material);
    assert_eq!(again.olay_suggestions.len(), 2);
    // One material per file; an unknown file or olay is not found.
    let e = library::material_add(
        &w.d,
        &w.ctx,
        add_input(
            "twice",
            file,
            json!({"olay_id":workshop.id,"share":"shareable"}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "file_has_material")
    );
    let e = library::material_add(
        &w.d,
        &w.ctx,
        add_input(
            "unknown",
            FileId::new_v7(),
            json!({"genel":true,"share":"shareable"}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let other = upload(&w, "other", "image/png", &png(2)).await;
    let e = library::material_add(
        &w.d,
        &w.ctx,
        add_input(
            "no-olay",
            other,
            json!({"olay_id":OlayId::new_v7(),"share":"shareable"}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    // A PNG names no time: the uploader's.
    let png_out = library::material_add(
        &w.d,
        &w.ctx,
        add_input(
            "png",
            other,
            json!({"olay_id":workshop.id,"share":"shareable","captured_at":"2026-11-16T08:00:00Z"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        png_out.material.captured_at,
        Some(datetime!(2026-11-16 08:00 UTC))
    );
}

/// `material_add` reads a capture time from what it needs of the file, never the whole of it
/// (spec D41): a JPEG's first part, a video's box headers and its `mvhd`.
#[tokio::test]
async fn a_capture_time_is_read_without_the_whole_file() {
    let (mut w, _) = publishing_world().await;
    let read = Arc::new(AtomicU64::new(0));
    w.d.files = Arc::new(Counting {
        inner: w.d.files.clone(),
        read: read.clone(),
    });
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    let padding = 3_000_000;
    let mut big = jpeg("2026:11:16 10:30:00");
    big.extend(std::iter::repeat_n(0u8, padding));
    let photo = upload(&w, "photo", "image/jpeg", &big).await;
    // The upload reads its file back whole to check it; adding it reads only its first part.
    read.store(0, SeqCst);
    let m = add(
        &w,
        &w.ctx,
        "photo",
        photo,
        json!({"olay_id":o.id,"share":"shareable"}),
    )
    .await;
    assert_eq!(m.captured_at, Some(datetime!(2026-11-16 10:30 +03:00)));
    let n = read.load(SeqCst);
    assert!(n <= 128 * 1024, "{n} bytes read of {}", big.len());
    // A video whose `moov` follows its media data: the boxes between are skipped unread.
    let at = datetime!(2026-11-16 07:30 UTC);
    let video = mp4(at, padding);
    let clip = upload(&w, "clip", "video/mp4", &video).await;
    read.store(0, SeqCst);
    let m = add(
        &w,
        &w.ctx,
        "clip",
        clip,
        json!({"olay_id":o.id,"share":"shareable"}),
    )
    .await;
    assert_eq!(m.captured_at, Some(at));
    let n = read.load(SeqCst);
    assert!(n <= 1024, "{n} bytes read of {}", video.len());
}

#[tokio::test]
async fn who_decides_what_when_a_material_is_added() {
    let (w, _) = publishing_world().await;
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    let a = agent(&w);
    let ai = json!({"kind":"ai_generated","generator":"codex"});
    let cases = [
        // The owner gives the permission: mandatory.
        (
            w.ctx.clone(),
            json!({"olay_id":o.id}),
            (ErrorCode::Validation, "share_required"),
        ),
        // An agent never gives a real material's permission, nor frees one.
        (
            a.clone(),
            json!({"olay_id":o.id,"share":"shareable"}),
            (ErrorCode::Forbidden, "owner_or_manager_human"),
        ),
        (
            member(&w),
            json!({"olay_id":o.id,"share":"shareable"}),
            (ErrorCode::Forbidden, "owner_or_manager_human"),
        ),
        (
            a.clone(),
            json!({"genel":true}),
            (ErrorCode::Forbidden, "owner_or_manager_human"),
        ),
        // An AI image names what it depicts.
        (
            a.clone(),
            json!({"genel":true,"origin":ai}),
            (ErrorCode::Validation, "depicts_required"),
        ),
        // Its own permission only while it depicts nothing.
        (
            a.clone(),
            json!({"genel":true,"origin":ai,"depicts":["face"],"share":"shareable"}),
            (ErrorCode::Forbidden, "owner_or_manager_human"),
        ),
        // An olay, or genel.
        (
            w.ctx.clone(),
            json!({"share":"shareable"}),
            (ErrorCode::Validation, "olay_or_genel"),
        ),
        (
            w.ctx.clone(),
            json!({"olay_id":o.id,"genel":true,"share":"shareable"}),
            (ErrorCode::Validation, "olay_or_genel"),
        ),
    ];
    for (n, (ctx, extra, (code, why))) in cases.into_iter().enumerate() {
        let file = upload(&w, &format!("f{n}"), "image/png", &png(n as u8)).await;
        let e = library::material_add(&w.d, &ctx, add_input(&format!("m{n}"), file, extra))
            .await
            .unwrap_err();
        assert_eq!((e.code, reason(&e)), (code, why), "case {n}");
    }
    // An agent adds a real material with no permission, and an AI image depicting nothing with
    // its own.
    let file = upload(&w, "real", "image/png", &png(20)).await;
    let real = add(
        &w,
        &a,
        "real",
        file,
        json!({"olay_id":o.id,"quality":"publishable"}),
    )
    .await;
    assert_eq!((real.share.clone(), real.tags_reviewed_by), (None, None));
    let file = upload(&w, "ai", "image/png", &png(21)).await;
    let poster = add(
        &w,
        &a,
        "ai",
        file,
        json!({"genel":true,"origin":ai,"depicts":[],"share":"shareable"}),
    )
    .await;
    assert_eq!(poster.share.as_ref().map(|s| s.by), Some(None));
    assert_eq!(poster.freed, None);
    // The owner adds a real genel material: freed by that decision.
    let file = upload(&w, "genel", "image/png", &png(22)).await;
    let genel = add(
        &w,
        &w.ctx,
        "genel",
        file,
        json!({"genel":true,"share":"product_only"}),
    )
    .await;
    assert_eq!(genel.freed.map(|f| f.by), Some(owner(&w)));
    // What still needs a person.
    let review = library::materials_list(&w.d, &w.ctx, input(json!({"state":"needs_review"})))
        .await
        .unwrap();
    assert!(review.iter().any(|m| m.id == real.id));
    let of_olay = library::materials_list(&w.d, &w.ctx, input(json!({"olay_id":o.id})))
        .await
        .unwrap();
    assert_eq!(
        of_olay.iter().map(|m| m.id).collect::<Vec<_>>(),
        vec![real.id]
    );
}

#[tokio::test]
async fn an_agent_suggests_tags_and_never_removes_a_privacy_marker() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let file = upload(&w, "ai", "image/png", &png(1)).await;
    let poster = add(
        &w,
        &a,
        "ai",
        file,
        json!({"genel":true,"origin":{"kind":"ai_generated","generator":"codex"},"depicts":[],
            "share":"shareable","quality":"publishable"}),
    )
    .await;
    // A human's edit reviews the tags.
    let reviewed = library::material_tag(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":poster.id,"expected_revision":1,"product_groups":["figur"],
            "doors":["kisiye_ozel"],"content_types":["bitmis_urun"]}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(reviewed.tags_reviewed_by, Some(owner(&w)));
    assert_eq!(reviewed.share.as_ref().map(|s| s.by), Some(None));
    // An agent's flag on its self-permitted AI image clears the permission: a human decides.
    let flagged = library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":poster.id,"expected_revision":2,"depicts":["client_logo"]})),
    )
    .await
    .unwrap();
    assert_eq!((flagged.share, flagged.tags_reviewed_by), (None, None));
    assert_eq!(flagged.tags.product_groups, reviewed.tags.product_groups);
    // Removing a flag, or a person, is a person's correction.
    let e = library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":poster.id,"expected_revision":3,"depicts":[]})),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (e.code, reason(&e), e.details["field"].as_str()),
        (ErrorCode::Forbidden, "human_required", Some("depicts"))
    );
    let cleared = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":poster.id,"expected_revision":3,"depicts":[],"quality":null})),
    )
    .await
    .unwrap();
    assert!(cleared.tags.depicts.is_empty());
    assert_eq!(cleared.tags.quality, None);
    // An unknown person is not found.
    let e = library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":poster.id,"expected_revision":4,"people":[uuid::Uuid::from_u128(0xdead)]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

/// One photo is one material, once (spec D36): bytes a material of the workspace was made of, live
/// or erased, its file deleted or not, never make another, whatever origin the adder claims. A
/// refused photo cannot come back as an "AI" poster with an agent's own permission (D37).
#[tokio::test]
async fn bytes_a_material_was_made_of_never_make_another() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let o = olay(
        &w,
        &w.ctx,
        "olay",
        json!({"starts_on":"2026-11-30","ends_on":"2026-11-30"}),
    )
    .await;
    let photo = png(1);
    let file = upload(&w, "photo", "image/png", &photo).await;
    let refused_photo = add(
        &w,
        &w.ctx,
        "photo",
        file,
        json!({"olay_id":o.id,"share":"not_shareable","depicts":["face"]}),
    )
    .await;
    let ai = json!({"kind":"ai_generated","generator":"codex"});
    // An agent's AI poster, permitted by the agent itself.
    let poster = |extra: Value| {
        let mut v = json!({"origin":ai,"depicts":[],"share":"shareable","quality":"publishable"});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let refused = |e: AppError| {
        assert_eq!(
            (e.code, reason(&e)),
            (ErrorCode::Conflict, "duplicate_material_file")
        );
        assert_eq!(e.details["material_id"], json!(refused_photo.id));
    };
    // Its bytes stored again under a new file id, as an AI poster of the upcoming olay.
    let copy = upload(&w, "copy", "image/png", &photo).await;
    assert_ne!(copy, file);
    refused(
        library::material_add(
            &w.d,
            &a,
            add_input("copy", copy, poster(json!({"olay_id":o.id}))),
        )
        .await
        .unwrap_err(),
    );
    // Deleted by the owner and its file cleaned up: still refused, as an AI poster or genel, and
    // as a real photo from the owner.
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":refused_photo.id,"expected_revision":1,"confirm":true})),
    )
    .await
    .unwrap();
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    let record = |id: FileId| {
        w.uow
            .snapshot()
            .studio
            .files
            .into_iter()
            .find(|f| f.id == id)
            .unwrap()
    };
    assert!(record(file).deleted_at.is_some());
    let again = upload(&w, "again", "image/png", &photo).await;
    for (n, (ctx, extra)) in [
        (a.clone(), poster(json!({"olay_id":o.id}))),
        (a.clone(), poster(json!({"genel":true}))),
        (w.ctx.clone(), json!({"olay_id":o.id,"share":"shareable"})),
    ]
    .into_iter()
    .enumerate()
    {
        refused(
            library::material_add(&w.d, &ctx, add_input(&format!("again{n}"), again, extra))
                .await
                .unwrap_err(),
        );
    }
    let all = library::materials_list(&w.d, &w.ctx, input(json!({"state":"all"})))
        .await
        .unwrap();
    assert_eq!(
        all.iter()
            .filter(|m| [copy, again].contains(&m.file_id))
            .count(),
        0
    );
    // Other bytes are another material.
    let other = upload(&w, "other", "image/png", &png(2)).await;
    add(&w, &a, "other", other, poster(json!({"olay_id":o.id}))).await;
}

/// A person named in `people` counts as a `depicts` flag (spec D38): an agent never gives such
/// an AI image its own permission, and naming one on an image it permitted clears that permission.
#[tokio::test]
async fn a_named_person_needs_a_humans_permission_as_a_depicts_flag_does() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let ada = people::create(
        &w.d,
        &w.ctx,
        input(json!({"display_name":"Ada","source":"form",
            "identities":[{"channel":"email","value":"ada@example.com"}]})),
    )
    .await
    .unwrap()
    .person
    .id;
    let ai = json!({"kind":"ai_generated","generator":"codex"});
    let file = upload(&w, "named", "image/png", &png(1)).await;
    let e = library::material_add(
        &w.d,
        &a,
        add_input(
            "named",
            file,
            json!({"genel":true,"origin":ai,"depicts":[],"people":[ada],"share":"shareable"}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Forbidden, "owner_or_manager_human")
    );
    let file = upload(&w, "poster", "image/png", &png(2)).await;
    let poster = add(
        &w,
        &a,
        "poster",
        file,
        json!({"genel":true,"origin":ai,"depicts":[],"share":"shareable","quality":"publishable"}),
    )
    .await;
    assert_eq!(poster.share.as_ref().map(|s| s.by), Some(None));
    let named = library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":poster.id,"expected_revision":1,"people":[ada]})),
    )
    .await
    .unwrap();
    assert_eq!(named.share, None);
    let review = library::materials_list(&w.d, &w.ctx, input(json!({"state":"needs_review"})))
        .await
        .unwrap();
    assert!(review.iter().any(|m| m.id == poster.id));
    let entry = w
        .uow
        .snapshot()
        .ledger
        .into_iter()
        .rfind(|r| r.entry.action.as_str() == "studio.material.tagged")
        .unwrap();
    assert_eq!(entry.entry.payload["share_cleared"], json!(true));
}

/// The materials listed as waiting for a person.
async fn needs_review(w: &World) -> Vec<MaterialId> {
    library::materials_list(&w.d, &w.ctx, input(json!({"state":"needs_review"})))
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect()
}

/// A new privacy marker reopens a human's permission (spec D45): it was given for what the
/// material was known to show. The material is listed for review until a human gives it again.
#[tokio::test]
async fn a_new_privacy_marker_reopens_a_humans_permission() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    let file = upload(&w, "photo", "image/png", &png(1)).await;
    let m = add(
        &w,
        &w.ctx,
        "photo",
        file,
        json!({"olay_id":o.id,"share":"shareable","quality":"publishable","depicts":["client_logo"]}),
    )
    .await;
    // Other tags, or the flags it had: the permission stands.
    let kept = library::material_tag(
        &w.d,
        &a,
        input(
            json!({"material_id":m.id,"expected_revision":1,"product_groups":["figur"],
            "depicts":["client_logo"]}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        kept.share.as_ref().map(|s| (s.permission, s.by)),
        Some((SharePermission::Shareable, Some(owner(&w))))
    );
    // A face the owner was not told of: an owner or manager decides again.
    let flagged = library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":m.id,"expected_revision":2,"depicts":["client_logo","face"]})),
    )
    .await
    .unwrap();
    assert_eq!(flagged.share, None);
    assert!(needs_review(&w).await.contains(&m.id));
    let entry = w
        .uow
        .snapshot()
        .ledger
        .into_iter()
        .rfind(|r| r.entry.action.as_str() == "studio.material.tagged")
        .unwrap();
    assert_eq!(entry.entry.payload["share_cleared"], json!(true));
    // Given again; a person named later reopens it again, whoever names them.
    library::material_permission(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":3,"permission":"shareable"})),
    )
    .await
    .unwrap();
    let ada = people::create(
        &w.d,
        &w.ctx,
        input(json!({"display_name":"Ada","source":"form",
            "identities":[{"channel":"email","value":"ada@example.com"}]})),
    )
    .await
    .unwrap()
    .person
    .id;
    let named = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":4,"people":[ada]})),
    )
    .await
    .unwrap();
    assert_eq!(named.share, None);
    assert!(needs_review(&w).await.contains(&m.id));
    // A marker a person removes keeps a permission given since.
    library::material_permission(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":5,"permission":"shareable"})),
    )
    .await
    .unwrap();
    let corrected = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":6,"depicts":["client_logo"]})),
    )
    .await
    .unwrap();
    assert!(corrected.share.is_some());
}

#[tokio::test]
async fn the_panels_decisions_are_an_owners_or_a_managers_in_person() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    let other = olay(&w, &w.ctx, "other", json!({"title":"Başka atölye"})).await;
    let file = upload(&w, "real", "image/png", &png(1)).await;
    let m = add(&w, &a, "real", file, json!({"olay_id":o.id})).await;
    let id = m.id;
    for ctx in [a.clone(), member(&w)] {
        let refusals = [
            library::material_permission(
                &w.d,
                &ctx,
                input(json!({"material_id":id,"expected_revision":1,"permission":"shareable"})),
            )
            .await,
            library::material_free(
                &w.d,
                &ctx,
                input(json!({"material_id":id,"expected_revision":1,"free":true})),
            )
            .await,
            library::material_bind(
                &w.d,
                &ctx,
                input(json!({"material_id":id,"expected_revision":1,"binding":{"kind":"genel"}})),
            )
            .await,
            library::material_delete(
                &w.d,
                &ctx,
                input(json!({"material_id":id,"expected_revision":1,"confirm":true})),
            )
            .await,
        ];
        for e in refusals {
            let e = e.unwrap_err();
            assert_eq!(
                (e.code, reason(&e)),
                (ErrorCode::Forbidden, "owner_or_manager_human")
            );
        }
        let e = library::calendar_set(
            &w.d,
            &ctx,
            input(json!({"key":"ramazan_bayrami","year":2027,
            "name":"Ramazan Bayramı","kind":"special_day","enabled":true})),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden);
        let e = library::material_policy_set(&w.d, &ctx, MaterialPolicy::default())
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden);
    }
    let m = library::material_permission(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":1,"permission":"shareable"})),
    )
    .await
    .unwrap();
    assert_eq!(m.share.as_ref().map(|s| s.by), Some(Some(owner(&w))));
    let m = library::material_free(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":2,"free":true})),
    )
    .await
    .unwrap();
    assert!(m.freed.is_some());
    let m = library::material_bind(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":3,"binding":{"kind":"olay","olay_id":other.id}})),
    )
    .await
    .unwrap();
    assert_eq!(m.binding, Binding::Olay { olay_id: other.id });
    // Unfreed, then made genel: the binding frees it again; a real genel stays freed.
    let m = library::material_free(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":4,"free":false})),
    )
    .await
    .unwrap();
    assert!(m.freed.is_none());
    let m = library::material_bind(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":5,"binding":{"kind":"genel"}})),
    )
    .await
    .unwrap();
    assert_eq!(m.freed.as_ref().map(|f| f.by), Some(owner(&w)));
    let e = library::material_free(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":6,"free":false})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "genel_stays_freed");
    // Deleting asks for the confirmation, redacts and removes the bytes.
    let e = library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":6})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let gone = library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":6,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(gone.erased_at.is_some() && gone.share.is_none());
    assert_eq!(
        (gone.file_id, gone.origin.clone(), gone.binding),
        (file, Origin::Real, Binding::Genel)
    );
    // Its bytes go at the next cleanup (D43).
    assert!(w.d.files.read(w.f.ws, file).await.is_ok());
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(w.d.files.read(w.f.ws, file).await.is_err());
    let e = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({"material_id":id,"expected_revision":7,"doors":[]})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "material_erased");
    let erased = library::materials_list(&w.d, &w.ctx, input(json!({"state":"erased"})))
        .await
        .unwrap();
    assert_eq!(erased.iter().map(|m| m.id).collect::<Vec<_>>(), vec![id]);
}

#[tokio::test]
async fn the_calendar_and_the_policy_are_the_owners_to_set() {
    let (w, _) = publishing_world().await;
    let before = library::calendar_list(&w.d, &w.ctx, input(json!({"year":2027})))
        .await
        .unwrap();
    let ramazan = |c: &library::CalendarOut| {
        c.entries
            .iter()
            .find(|e| e.key == "ramazan_bayrami")
            .cloned()
            .unwrap()
    };
    assert_eq!(ramazan(&before).window(), None);
    assert!(before.rows.is_empty());
    assert_eq!(before.policy, MaterialPolicy::default());
    let row = library::calendar_set(
        &w.d,
        &w.ctx,
        input(
            json!({"key":"ramazan_bayrami","year":2027,"name":"Ramazan Bayramı",
            "kind":"special_day","window_start":"2027-02-26","window_end":"2027-03-12",
            "lead_days":14,"enabled":true}),
        ),
    )
    .await
    .unwrap();
    let after = library::calendar_list(&w.d, &w.ctx, input(json!({"year":2027})))
        .await
        .unwrap();
    assert_eq!(ramazan(&after), row);
    assert_eq!(after.rows, vec![row]);
    let e = library::calendar_set(
        &w.d,
        &w.ctx,
        input(json!({"key":"Bad Key","year":2027,"name":"x","kind":"season","enabled":true})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["field"], "key");
    let e = library::calendar_list(&w.d, &w.ctx, input(json!({"year":1999})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let policy = MaterialPolicy {
        lead_days: 30,
        reuse_days: 7,
        recap_days: 60,
    };
    library::material_policy_set(&w.d, &w.ctx, policy)
        .await
        .unwrap();
    let e = library::material_policy_set(
        &w.d,
        &w.ctx,
        MaterialPolicy {
            lead_days: 91,
            ..policy
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let now = library::calendar_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    assert_eq!((now.year, now.policy), (2026, policy));
}

#[tokio::test]
async fn the_shoot_list_takes_requests_and_its_own_close_themselves() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let asked = library::shoot_request(
        &w.d,
        &a,
        input(json!({"request_key":"poster","text":"16 Kasım atölyesi için afiş yükle"})),
    )
    .await
    .unwrap();
    assert_eq!(asked.key, "agent:poster");
    assert_eq!(asked.week_start, time::macros::date!(2026 - 10 - 19));
    assert_eq!(asked.reason, ShootReason::Requested);
    let again = library::shoot_request(
        &w.d,
        &a,
        input(json!({"request_key":"poster","text":"16 Kasım atölyesi için afiş yükle"})),
    )
    .await
    .unwrap();
    assert_eq!(again, asked);
    let human = library::shoot_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"poster","text":"Ürün fotoğrafı","week_start":"2026-10-26"})),
    )
    .await
    .unwrap();
    assert_eq!(human.key, "human:poster");
    let e = library::shoot_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"tuesday","text":"x","week_start":"2026-10-27"})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "not_a_monday");
    // A request the planner adds closes itself; an agent resolves only its own kind.
    let system = ShootRequest {
        id: ShootRequestId::new_v7(),
        key: season_request_key("yilbasi", 2026),
        reason: ShootReason::SeasonAhead {
            occasion: "yilbasi".into(),
            year: 2026,
        },
        created_by: Actor::System {
            component: "studio_plan".into(),
        },
        ..asked.clone()
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        r.studio_materials()
            .insert_shoot_request(system.clone())
            .await
            .unwrap()
    );
    r.commit().await.unwrap();
    let e = library::shoot_resolve(
        &w.d,
        &a,
        input(json!({"request_id":system.id,"status":"done"})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "closes_itself");
    let open = library::shoot_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert_eq!(open.len(), 3);
    let done = library::shoot_resolve(
        &w.d,
        &a,
        input(json!({"request_id":asked.id,"status":"done"})),
    )
    .await
    .unwrap();
    assert_eq!(
        (done.status, done.resolved_by.clone()),
        (ShootStatus::Done, Some(a.actor.clone()))
    );
    // Resolved again as the same: no change; as the other: a conflict.
    let same = library::shoot_resolve(
        &w.d,
        &a,
        input(json!({"request_id":asked.id,"status":"done"})),
    )
    .await
    .unwrap();
    assert_eq!(same, done);
    let e = library::shoot_resolve(
        &w.d,
        &a,
        input(json!({"request_id":asked.id,"status":"dismissed"})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "already_resolved");
    library::shoot_resolve(
        &w.d,
        &w.ctx,
        input(json!({"request_id":system.id,"status":"dismissed"})),
    )
    .await
    .unwrap();
    let open = library::shoot_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert_eq!(
        open.iter().map(|q| q.id).collect::<Vec<_>>(),
        vec![human.id]
    );
    let all = library::shoot_list(&w.d, &a, input(json!({"status":"all"})))
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
    let items = work::pending(&w.d, &a).await.unwrap().items;
    let shoots: Vec<_> = items
        .iter()
        .filter_map(|i| match i.kind {
            work::WorkKind::StudioShootRequest { shoot_request_id } => Some(shoot_request_id),
            _ => None,
        })
        .collect();
    assert_eq!(shoots, vec![human.id]);
}

#[tokio::test]
async fn a_slot_lists_what_its_piece_may_show_and_a_material_where_it_was_used() {
    let (w, _) = publishing_world().await;
    let fixture = w.material();
    let a = agent(&w);
    let file = upload(&w, "unset", "image/png", &png(1)).await;
    let unset = add(
        &w,
        &a,
        "unset",
        file,
        json!({"olay_id":fixture.olay_id().unwrap(),"quality":"publishable"}),
    )
    .await;
    let out = library::slot_materials(&w.d, &a, input(json!({"slot_id":w.f.slot.id})))
        .await
        .unwrap();
    assert_eq!(out.scheduled_at, w.f.slot.scheduled_at);
    let first = &out.candidates[0];
    assert_eq!(
        (first.material_id, first.role, first.subject),
        (
            fixture.id,
            UseRole::Anchor,
            Subject::Olay {
                olay_id: fixture.olay_id().unwrap()
            }
        )
    );
    assert_eq!(first.file_id, fixture.file_id);
    assert!(
        out.refused
            .iter()
            .any(|r| r.material_id == unset.id && r.code == "share_unset")
    );
    // The fixture piece shows the fixture material: its use, and the olay's materials.
    let detail = library::material_get(&w.d, &a, input(json!({"material_id":fixture.id})))
        .await
        .unwrap();
    assert_eq!(detail.used_in.len(), 1);
    assert_eq!(
        (detail.used_in[0].slot_id, detail.used_in[0].role),
        (w.f.slot.id, UseRole::Anchor)
    );
    assert!(detail.used_in[0].publications.is_empty());
    let olay = library::olay_get(
        &w.d,
        &a,
        input(json!({"olay_id":fixture.olay_id().unwrap()})),
    )
    .await
    .unwrap();
    assert_eq!(
        olay.materials
            .iter()
            .map(|m| m.material.id)
            .collect::<std::collections::BTreeSet<_>>(),
        [fixture.id, unset.id].into_iter().collect()
    );
    let e = library::slot_materials(&w.d, &a, input(json!({"slot_id":SlotId::new_v7()})))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn the_ledger_names_ids_codes_and_tags_never_the_owners_words() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let o = olay(
        &w,
        &a,
        "olay",
        json!({"title":"CANARY-TITLE","place":"CANARY-PLACE","notes":"CANARY-NOTES",
            "client":{"organization":"CANARY-ORG"}}),
    )
    .await;
    library::olay_update(
        &w.d,
        &a,
        input(json!({"olay_id":o.id,"expected_revision":1,"title":"CANARY-RETITLE"})),
    )
    .await
    .unwrap();
    library::olay_confirm(
        &w.d,
        &w.ctx,
        input(json!({"olay_id":o.id,"expected_revision":2})),
    )
    .await
    .unwrap();
    let file = upload(&w, "file", "image/png", &png(1)).await;
    let m = add(
        &w,
        &w.ctx,
        "m",
        file,
        json!({"olay_id":o.id,"share":"shareable","title":"CANARY-MATERIAL","product_groups":["figur"]}),
    )
    .await;
    library::material_tag(
        &w.d,
        &a,
        input(json!({"material_id":m.id,"expected_revision":1,"doors":["toplu_siparis"]})),
    )
    .await
    .unwrap();
    library::shoot_request(
        &w.d,
        &a,
        input(json!({"request_key":"s","text":"CANARY-SHOOT"})),
    )
    .await
    .unwrap();
    library::calendar_set(
        &w.d,
        &w.ctx,
        input(
            json!({"key":"kendi_gunu","year":2026,"name":"CANARY-CALENDAR","kind":"special_day",
            "window_start":"2026-11-01","window_end":"2026-11-02","enabled":true}),
        ),
    )
    .await
    .unwrap();
    let ledger = w.uow.snapshot().ledger;
    let actions: Vec<&str> = ledger.iter().map(|r| r.entry.action.as_str()).collect();
    for action in [
        "studio.olay.created",
        "studio.olay.updated",
        "studio.olay.confirmed",
        "studio.material.added",
        "studio.material.tagged",
        "studio.shoot.requested",
        "studio.calendar.set",
    ] {
        assert!(actions.contains(&action), "{action}");
    }
    let text = format!(
        "{:?}",
        ledger.iter().map(|r| &r.entry.payload).collect::<Vec<_>>()
    );
    assert!(!text.contains("CANARY"), "{text}");
    let tagged = ledger
        .iter()
        .find(|r| r.entry.action.as_str() == "studio.material.tagged")
        .unwrap();
    assert_eq!(tagged.entry.payload["doors"], json!(["toplu_siparis"]));
    assert_eq!(tagged.entry.payload["fields"], json!(["doors"]));
}

/// A material of `olay` that shows `person`, as the owner adds it.
async fn shows(w: &World, olay: OlayId, key: &str, person: jt_inbox::PersonId, n: u8) -> Material {
    let file = upload(w, key, "image/png", &png(n)).await;
    add(
        w,
        &w.ctx,
        key,
        file,
        json!({"olay_id":olay,"share":"shareable","people":[person],"title":"Ada'nın figürü"}),
    )
    .await
}

#[tokio::test]
async fn a_persons_erasure_redacts_their_materials_and_unlinks_their_olays() {
    let (w, _) = publishing_world().await;
    let person = |name: &str, email: &str| {
        people::create(
            &w.d,
            &w.ctx,
            input(json!({"display_name":name,"source":"form",
                "identities":[{"channel":"email","value":email}]})),
        )
    };
    let ada = person("Ada", "ada@example.com").await.unwrap().person.id;
    let merged = person("Ada 2", "ada2@example.com").await.unwrap().person.id;
    let bob = person("Bob", "bob@example.com").await.unwrap().person.id;
    let o = olay(
        &w,
        &w.ctx,
        "olay",
        json!({"client":{"person_id":ada,"organization":"Kulüp"}}),
    )
    .await;
    let only_ada = olay(&w, &w.ctx, "only", json!({"client":{"person_id":ada}})).await;
    let ada_photo = shows(&w, o.id, "ada", ada, 1).await;
    let merged_photo = shows(&w, o.id, "merged", merged, 2).await;
    let bob_photo = shows(&w, o.id, "bob", bob, 3).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.people()
        .mark_merged(merged, Some(ada), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    erasure::erase(&w.d, &w.ctx, ada, erasure::EraseInput { confirm: true })
        .await
        .unwrap();
    let state = w.uow.snapshot();
    let material = |id: MaterialId| {
        state
            .materials
            .materials
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .clone()
    };
    for m in [material(ada_photo.id), material(merged_photo.id)] {
        assert!(m.erased_at.is_some(), "{:?}", m.id);
        assert!(m.share.is_none() && m.people.is_empty() && m.title.is_empty());
        assert!(w.d.files.read(w.f.ws, m.file_id).await.is_err());
    }
    let kept = material(bob_photo.id);
    assert!(kept.erased_at.is_none());
    assert!(w.d.files.read(w.f.ws, kept.file_id).await.is_ok());
    let olay = |id: OlayId| {
        state
            .materials
            .olays
            .iter()
            .find(|x| x.id == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        olay(o.id).client,
        Some(OlayClient {
            person_id: None,
            organization: Some("Kulüp".into())
        })
    );
    assert_eq!(olay(only_ada.id).client, None);
    // An erased person is linked to nothing new.
    let e = library::olay_create(
        &w.d,
        &w.ctx,
        olay_input("after", json!({"client":{"person_id":ada}})),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "person_erased");
    // A second erasure changes nothing more.
    let before = w.uow.snapshot().ledger.len();
    erasure::erase(&w.d, &w.ctx, ada, erasure::EraseInput { confirm: true })
        .await
        .unwrap();
    assert_eq!(w.uow.snapshot().ledger.len(), before);
}

/// The library's request keys keep ids, never the records (spec D40): a replay reads what is
/// stored now, so after a person's erasure it answers the redacted records, and no receipt holds
/// a title, a text or a person.
#[tokio::test]
async fn a_replay_after_an_erasure_answers_the_redacted_records() {
    let (w, _) = publishing_world().await;
    let ada = people::create(
        &w.d,
        &w.ctx,
        input(json!({"display_name":"Ada","source":"form",
            "identities":[{"channel":"email","value":"ada@example.com"}]})),
    )
    .await
    .unwrap()
    .person
    .id;
    let create = olay_input(
        "olay",
        json!({"title":"CANARY-OLAY","client":{"person_id":ada,"organization":"Kulüp"}}),
    );
    let o = library::olay_create(&w.d, &w.ctx, create.clone())
        .await
        .unwrap();
    let file = upload(&w, "photo", "image/jpeg", &jpeg("2026:11:16 10:30:00")).await;
    let photo = add_input(
        "photo",
        file,
        json!({"olay_id":o.id,"share":"shareable","people":[ada],"title":"CANARY-MATERIAL"}),
    );
    let first = library::material_add(&w.d, &w.ctx, photo.clone())
        .await
        .unwrap();
    assert_eq!(
        first
            .olay_suggestions
            .iter()
            .map(|o| o.id)
            .collect::<Vec<_>>(),
        vec![o.id]
    );
    let shoot = json!({"request_key":"shoot","text":"CANARY-SHOOT"});
    let asked = library::shoot_request(&w.d, &w.ctx, input(shoot.clone()))
        .await
        .unwrap();
    let receipts = format!("{:?}", w.uow.snapshot().studio.receipts);
    assert!(!receipts.contains("CANARY"), "{receipts}");
    assert!(!receipts.contains(&ada.to_string()), "{receipts}");
    erasure::erase(&w.d, &w.ctx, ada, erasure::EraseInput { confirm: true })
        .await
        .unwrap();
    // Replayed by their keys: the records as they are now.
    let again = library::material_add(&w.d, &w.ctx, photo).await.unwrap();
    assert_eq!(again.material.id, first.material.id);
    assert!(again.material.erased_at.is_some());
    assert!(again.material.people.is_empty() && again.material.title.is_empty());
    assert_eq!(
        again
            .olay_suggestions
            .iter()
            .map(|o| (o.id, o.client.clone()))
            .collect::<Vec<_>>(),
        vec![(
            o.id,
            Some(OlayClient {
                person_id: None,
                organization: Some("Kulüp".into())
            })
        )]
    );
    let o_again = library::olay_create(&w.d, &w.ctx, create).await.unwrap();
    assert_eq!(o_again.id, o.id);
    assert_eq!(o_again.client.and_then(|c| c.person_id), None);
    let asked_again = library::shoot_request(&w.d, &w.ctx, input(shoot))
        .await
        .unwrap();
    assert_eq!(asked_again, asked);
}

/// The stored record of file `id`.
fn file_record(w: &World, id: FileId) -> jt_app::ports::files::StoredFile {
    w.uow
        .snapshot()
        .studio
        .files
        .into_iter()
        .find(|f| f.id == id)
        .unwrap()
}

/// Deleting a material redacts it at once; its bytes go at the next cleanup, once no publish
/// attempt in flight shows it (spec D43): a provider may still be reading them.
#[tokio::test]
async fn a_deleted_materials_bytes_wait_for_the_attempt_in_flight() {
    use jt_app::ports::{connectors::PublishReceipt, studio::PublishOutcome};
    let (w, _) = publishing_world().await;
    let o = olay(&w, &w.ctx, "olay", json!({})).await;
    let file = upload(&w, "photo", "image/png", &png(1)).await;
    let m = add(
        &w,
        &w.ctx,
        "photo",
        file,
        json!({"olay_id":o.id,"share":"shareable","quality":"publishable"}),
    )
    .await;
    // The fixture slot's piece shows it, and an attempt to publish that piece is sending.
    let mut p = w.f.piece.clone();
    p.id = PieceId::new_v7();
    p.revision = 2;
    p.media = vec![MediaAsset::File { id: file }];
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .save_piece(w.f.slot.id, 1, p, "piece")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let attempt = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.commit().await.unwrap();
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":1,"confirm":true})),
    )
    .await
    .unwrap();
    assert!(w.d.files.read(w.f.ws, file).await.is_ok());
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(w.d.files.read(w.f.ws, file).await.is_ok());
    assert!(file_record(&w, file).deleted_at.is_none());
    // Once the attempt has finished, the next cleanup deletes them.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .finish_publication(
            attempt.id(),
            PublishOutcome::Succeeded(PublishReceipt {
                external_id: "post".into(),
                url: None,
            }),
            FIXED_NOW,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(w.d.files.read(w.f.ws, file).await.is_err());
    assert!(file_record(&w, file).deleted_at.is_some());
}

/// A file store whose deletes see what is committed: one of a material that is live there counts
/// as early, and the first delete fails as a crash would, removing nothing.
struct Committed {
    inner: Arc<dyn jt_app::ports::files::FileStore>,
    uow: jt_testkit::fakes::InMemoryUow,
    early: Arc<std::sync::atomic::AtomicBool>,
    fail: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl jt_app::ports::files::FileStore for Committed {
    async fn probe(&self) -> Result<(), AppError> {
        self.inner.probe().await
    }
    async fn put(
        &self,
        ws: jt_tenancy::WorkspaceId,
        id: FileId,
        u: MediaUpload,
    ) -> Result<jt_app::ports::files::StoredFile, AppError> {
        self.inner.put(ws, id, u).await
    }
    async fn read(&self, ws: jt_tenancy::WorkspaceId, id: FileId) -> Result<MediaUpload, AppError> {
        self.inner.read(ws, id).await
    }
    async fn provider_url(
        &self,
        ws: jt_tenancy::WorkspaceId,
        id: FileId,
        expires_at: OffsetDateTime,
    ) -> Result<url::Url, AppError> {
        self.inner.provider_url(ws, id, expires_at).await
    }
    async fn delete(&self, ws: jt_tenancy::WorkspaceId, id: FileId) -> Result<(), AppError> {
        let live = self
            .uow
            .snapshot()
            .materials
            .materials
            .iter()
            .any(|m| m.file_id == id && m.erased_at.is_none());
        if live {
            self.early.store(true, SeqCst);
        }
        if self.fail.swap(false, SeqCst) {
            return Err(AppError::internal("simulated crash"));
        }
        self.inner.delete(ws, id).await
    }
}

/// The retention rule's erasure is committed before its file's bytes go (spec D43): a crash in
/// between leaves an erased material whose file the next run deletes, never a live material
/// without bytes.
#[tokio::test]
async fn retention_deletes_the_bytes_only_once_the_erasure_is_committed() {
    let (mut w, _) = publishing_world().await;
    let o = olay(
        &w,
        &w.ctx,
        "olay",
        json!({"starts_on":"2026-10-20","ends_on":"2026-10-22"}),
    )
    .await;
    let file = upload(&w, "face", "image/png", &png(1)).await;
    let face = add(
        &w,
        &w.ctx,
        "face",
        file,
        json!({"olay_id":o.id,"share":"shareable","depicts":["face"]}),
    )
    .await;
    w.d.clock = Arc::new(FixedClock(datetime!(2028-10-23 12:00 UTC)));
    let early = Arc::new(std::sync::atomic::AtomicBool::new(false));
    w.d.files = Arc::new(Committed {
        inner: w.d.files.clone(),
        uow: w.uow.clone(),
        early: early.clone(),
        fail: std::sync::atomic::AtomicBool::new(true),
    });
    assert!(files::cleanup_files(&w.d, w.f.ws).await.is_err());
    let erased = |w: &World| {
        w.uow
            .snapshot()
            .materials
            .materials
            .into_iter()
            .find(|m| m.id == face.id)
            .unwrap()
            .erased_at
    };
    assert!(erased(&w).is_some(), "the erasure was committed first");
    assert!(file_record(&w, file).deleted_at.is_none());
    assert!(w.d.files.read(w.f.ws, file).await.is_ok());
    // The next run deletes the erased material's file.
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(w.d.files.read(w.f.ws, file).await.is_err());
    assert!(file_record(&w, file).deleted_at.is_some());
    assert!(
        !early.load(SeqCst),
        "no bytes went while their material was live"
    );
}

#[tokio::test]
async fn a_material_showing_people_is_erased_24_months_after_its_olay() {
    let (mut w, _) = publishing_world().await;
    let o = olay(
        &w,
        &w.ctx,
        "olay",
        json!({"starts_on":"2026-10-20","ends_on":"2026-10-22"}),
    )
    .await;
    let face = upload(&w, "face", "image/png", &png(1)).await;
    let face = add(
        &w,
        &w.ctx,
        "face",
        face,
        json!({"olay_id":o.id,"share":"shareable","depicts":["face"]}),
    )
    .await;
    let product = upload(&w, "product", "image/png", &png(2)).await;
    let product = add(
        &w,
        &w.ctx,
        "product",
        product,
        json!({"olay_id":o.id,"share":"shareable"}),
    )
    .await;
    let erased = |w: &World, id: MaterialId| {
        w.uow
            .snapshot()
            .materials
            .materials
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .erased_at
            .is_some()
    };
    w.d.clock = Arc::new(FixedClock(datetime!(2028-10-22 12:00 UTC)));
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(!erased(&w, face.id));
    w.d.clock = Arc::new(FixedClock(datetime!(2028-10-23 12:00 UTC)));
    files::cleanup_files(&w.d, w.f.ws).await.unwrap();
    assert!(erased(&w, face.id));
    assert!(w.d.files.read(w.f.ws, face.file_id).await.is_err());
    assert!(!erased(&w, product.id));
    assert!(w.d.files.read(w.f.ws, product.file_id).await.is_ok());
    let entry = w
        .uow
        .snapshot()
        .ledger
        .into_iter()
        .find(|r| r.entry.action.as_str() == "studio.material.erased")
        .unwrap();
    assert_eq!(entry.entry.payload["reason"], "retention");
}

#[tokio::test]
async fn free_labels_and_capture_corrections_preserve_manual_intent() {
    let (w, _) = publishing_world().await;
    let file = upload(&w, "generic-label-file", "image/png", &png(213)).await;
    let material = add(
        &w,
        &w.ctx,
        "generic-label-material",
        file,
        json!({
            "genel":true,"share":"shareable","labels":["  Summer   Launch  ","summer launch","Cafe"]
        }),
    )
    .await;
    assert_eq!(
        material.tags.labels,
        ["cafe".into(), "summer launch".into()].into()
    );
    assert_eq!(
        material.captured_at, None,
        "upload time is not capture time"
    );
    let initial =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":material.id})))
            .await
            .unwrap();
    assert_eq!(
        serde_json::to_value(initial.intelligence.status).unwrap(),
        "pending"
    );
    let edited = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":material.id,"expected_revision":material.revision,
            "title":"Summer menu","labels":["Drinks"],"captured_at":"2026-06-01T12:00:00Z"
        })),
    )
    .await
    .unwrap();
    assert_eq!(edited.title, "Summer menu");
    assert_eq!(edited.tags.labels, ["drinks".into()].into());
    assert_eq!(edited.captured_at, Some(datetime!(2026-06-01 12:00 UTC)));
    let metadata =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":material.id})))
            .await
            .unwrap();
    for field in ["title", "labels", "captured_at"] {
        assert!(metadata.intelligence.manual_fields.contains(field));
    }
    let cleared = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":material.id,"expected_revision":edited.revision,"captured_at":null
        })),
    )
    .await
    .unwrap();
    assert_eq!(cleared.captured_at, None);
    let same = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":material.id,"expected_revision":cleared.revision,"labels":[]
        })),
    )
    .await
    .unwrap();
    assert_eq!(same.captured_at, None);
    assert!(same.tags.labels.is_empty());
    let stale = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":material.id,"expected_revision":edited.revision,"title":"stale"
        })),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":material.id,"expected_revision":same.revision,"confirm":true
        })),
    )
    .await
    .unwrap();
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert!(
        r.studio_materials()
            .get_intelligence(material.id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn legacy_tag_tool_cannot_bypass_human_analysis_field_locks() {
    let (w, _) = publishing_world().await;
    let file = upload(&w, "locked-source", "image/png", &png(214)).await;
    let original = add(
        &w,
        &w.ctx,
        "locked-material",
        file,
        json!({"genel":true,"share":"shareable"}),
    )
    .await;
    let corrected = library::material_tag(
        &w.d,
        &w.ctx,
        input(json!({
            "material_id":original.id,"expected_revision":original.revision,
            "title":"Human title","labels":["Cafe"],"quality":"publishable",
            "captured_at":"2026-06-01T12:00:00Z"
        })),
    )
    .await
    .unwrap();
    for change in [
        json!({"title":"Agent title"}),
        json!({"labels":["other"]}),
        json!({"quality":"unusable"}),
        json!({"captured_at":null}),
    ] {
        let mut request =
            json!({"material_id":corrected.id,"expected_revision":corrected.revision});
        request
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let error = library::material_tag(&w.d, &agent(&w), input(request))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(reason(&error), "material_manual_field_locked");
        let stored =
            library::material_get(&w.d, &w.ctx, input(json!({"material_id":corrected.id})))
                .await
                .unwrap()
                .material;
        assert_eq!(stored, corrected);
    }
    let same = library::material_tag(
        &w.d,
        &agent(&w),
        input(json!({
            "material_id":corrected.id,"expected_revision":corrected.revision,
            "title":" Human title ","labels":[" CAFE "],"quality":"publishable",
            "captured_at":"2026-06-01T12:00:00Z"
        })),
    )
    .await
    .unwrap();
    assert_eq!(same.title, corrected.title);
    assert_eq!(same.tags, corrected.tags);
    assert_eq!(same.captured_at, corrected.captured_at);
}
