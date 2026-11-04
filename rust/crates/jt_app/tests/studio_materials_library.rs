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
use std::sync::Arc;
use time::macros::datetime;

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
