//! The material gate (spec 2026-11-03 D1, D2, §5.5, §5.6): a piece shows only materials, at least
//! one an eligible anchor; publishing re-checks and holds. Whatever the approval policy.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, receipt, sends, world::World};
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::studio::{
        pieces::{PieceInput, piece_submit},
        publish, work,
    },
};
use jt_studio::{Binding, Origin, SharePermission, Subject, UseRole};
use jt_testkit::studio_contract::{confirmed_olay, eligible_material, stored_material};
use serde_json::{Value, json};

fn input(w: &World, key: &str, media: Value, subject: Option<Subject>) -> PieceInput {
    let mut v = json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":key,
        "text":"Atölyemizden","media":media,"adaptations":{}});
    if let Some(s) = subject {
        v["subject"] = serde_json::to_value(s).unwrap();
    }
    serde_json::from_value(v).unwrap()
}

fn reason(e: &jt_app::error::AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

fn olay_of(m: &jt_studio::Material) -> Subject {
    Subject::Olay {
        olay_id: m.olay_id().unwrap(),
    }
}

#[tokio::test]
async fn a_piece_whose_media_are_not_all_materials_is_refused() {
    let (w, _) = publishing_world().await;
    let m = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    let s = Some(olay_of(&m));
    let bytes = json!([{"kind":"bytes","data":"iVBORw0KGgpzbW9rZQ==","mime":"image/png","filename":"a.png"}]);
    let hosted = json!([{"kind":"hosted_url","url":"https://cdn.example.test/a.png","mime":"image/png","size_bytes":10}]);
    for (key, media) in [("bytes", bytes), ("hosted", hosted)] {
        let e = piece_submit(&w.d, &w.ctx, input(&w, key, media, s))
            .await
            .unwrap_err();
        assert_eq!(
            (e.code, reason(&e)),
            (ErrorCode::Validation, "not_a_material"),
            "{key}"
        );
    }
    // A stored file that is no material.
    let other = acceptance::attach_file_only(&w).await;
    let e = piece_submit(
        &w.d,
        &w.ctx,
        input(&w, "file", json!([{"kind":"file","id":other}]), s),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "not_a_material");
    // No media at all: no anchor.
    let e = piece_submit(&w.d, &w.ctx, input(&w, "empty", json!([]), s))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "no_eligible_material");
    // No subject.
    let media = json!([{"kind":"file","id":m.file_id}]);
    let e = piece_submit(&w.d, &w.ctx, input(&w, "no-subject", media, None))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "subject_required");
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 1, "nothing was saved");
}

#[tokio::test]
async fn a_piece_on_an_eligible_material_is_saved_with_what_it_shows() {
    let (w, _) = publishing_world().await;
    let m = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    let media = json!([{"kind":"file","id":m.file_id}]);
    let out = piece_submit(&w.d, &w.ctx, input(&w, "ok", media, Some(olay_of(&m))))
        .await
        .unwrap();
    assert_eq!(out.slot.revision, 2);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let shown = r
        .studio_materials()
        .piece_materials(w.f.slot.id, 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.subject, olay_of(&m));
    assert_eq!(shown.uses.len(), 1);
    assert_eq!(
        (shown.uses[0].material_id, shown.uses[0].role),
        (m.id, UseRole::Anchor)
    );
}

#[tokio::test]
async fn another_olays_material_never_appears_in_its_content() {
    let (w, _) = publishing_world().await;
    let a = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    let b = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    let media = json!([{"kind":"file","id":a.file_id}]);
    let e = piece_submit(&w.d, &w.ctx, input(&w, "other", media, Some(olay_of(&b))))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "material_refused");
    assert_eq!(e.details["refusals"][0]["code"], "other_olay");
    assert_eq!(e.details["refusals"][0]["material_id"], json!(a.id));
}

#[tokio::test]
async fn an_ai_supporting_visual_alone_is_no_anchor_and_an_unset_permission_is_refused() {
    let (w, _) = publishing_world().await;
    let real = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    // Turn a second stored material into an AI supporting visual, and a third into one whose
    // permission is unset.
    let ai = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    let unset = stored_material(&w.uow, w.d.files.as_ref(), w.f.ws).await;
    w.uow.edit(|s| {
        for m in s.materials.materials.iter_mut() {
            if m.id == ai.id {
                m.origin = Origin::AiGenerated {
                    generator: "codex".into(),
                };
                m.binding = Binding::Genel;
            }
            if m.id == unset.id {
                m.share = None;
            }
        }
    });
    let s = Some(olay_of(&real));
    let e = piece_submit(
        &w.d,
        &w.ctx,
        input(&w, "ai", json!([{"kind":"file","id":ai.file_id}]), s),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "no_eligible_material");
    let both = json!([{"kind":"file","id":real.file_id},{"kind":"file","id":ai.file_id}]);
    piece_submit(&w.d, &w.ctx, input(&w, "both", both, s))
        .await
        .unwrap();
    let mut i = input(
        &w,
        "unset",
        json!([{"kind":"file","id":unset.file_id}]),
        Some(olay_of(&unset)),
    );
    i.expected_revision = 2;
    let e = piece_submit(&w.d, &w.ctx, i).await.unwrap_err();
    assert_eq!(e.details["refusals"][0]["code"], "share_unset");
}

#[tokio::test]
async fn publishing_holds_once_the_permission_is_revoked_and_says_why() {
    let (w, x) = publishing_world().await;
    w.uow.edit(|s| {
        for m in s.materials.materials.iter_mut() {
            m.share.as_mut().unwrap().permission = SharePermission::NotShareable;
        }
    });
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 0, "nothing was sent");
    assert!(
        w.uow.snapshot().studio.attempts.is_empty(),
        "no attempt was claimed"
    );
    let pending = work::pending(&w.d, &w.ctx).await.unwrap();
    let hold = pending
        .blockers
        .iter()
        .find(|b| b.reason == "material_check_hold")
        .expect("a hold");
    assert_eq!(hold.details.as_ref().unwrap()[0]["code"], "not_shareable");
    // The permission given back: it publishes.
    w.uow.edit(|s| {
        for m in s.materials.materials.iter_mut() {
            m.share.as_mut().unwrap().permission = SharePermission::Shareable;
        }
    });
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(sends(&x), 1);
}

#[tokio::test]
async fn an_olay_unconfirmed_or_a_piece_with_no_recorded_material_holds() {
    let (w, x) = publishing_world().await;
    w.uow.edit(|s| {
        for o in s.materials.olays.iter_mut() {
            o.status = jt_studio::OlayStatus::Proposed;
            o.confirmed = None;
        }
    });
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    w.uow.edit(|s| s.materials.piece_uses.clear());
    let pending = work::pending(&w.d, &w.ctx).await.unwrap();
    let hold = pending
        .blockers
        .iter()
        .find(|b| b.reason == "material_check_hold")
        .unwrap();
    assert_eq!(hold.details.as_ref().unwrap()[0]["code"], "no_material");
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 0);
}

/// The owner's structural requirement: an approved strategy, no approval policy and no material
/// produce no publication, and no piece can be submitted.
#[tokio::test]
async fn no_material_means_no_piece_and_no_publication_whatever_the_policy() {
    let (w, x) = publishing_world().await;
    w.uow.edit(|s| {
        s.materials.piece_uses.clear();
        s.materials.materials.clear();
        s.materials.olays.clear();
    });
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 0);
    let olay = confirmed_olay(w.f.ws);
    let e = piece_submit(
        &w.d,
        &w.ctx,
        input(
            &w,
            "none",
            json!([]),
            Some(Subject::Olay { olay_id: olay.id }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(&e), "no_eligible_material");
    // A material record pointing at a file that is not stored is no way around it either.
    let fake = eligible_material(&olay, jt_studio::FileId::new_v7());
    let e = piece_submit(
        &w.d,
        &w.ctx,
        input(
            &w,
            "fake",
            json!([{"kind":"file","id":fake.file_id}]),
            Some(Subject::Olay { olay_id: olay.id }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(w.uow.snapshot().studio.publications.is_empty());
}

/// A material's file is the owner's library: the 30-day publication cleanup keeps it; once the
/// material is erased, the file goes (spec D14).
#[tokio::test]
async fn cleanup_keeps_a_live_materials_file_and_deletes_an_erased_ones() {
    use jt_app::usecases::jobs::Job;
    use jt_testkit::fakes::FixedClock;
    let (mut w, x) = publishing_world().await;
    let file = acceptance::attach_file(&w).await;
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    w.d.clock = std::sync::Arc::new(FixedClock(
        jt_testkit::fakes::FIXED_NOW + time::Duration::days(60),
    ));
    Job::StudioFilesCleanup.run(&w.d, w.d.clock.now()).await;
    let state = w.uow.snapshot();
    let stored = state.studio.files.iter().find(|f| f.id == file.id).unwrap();
    assert!(
        stored.deleted_at.is_none(),
        "a live material's file is kept"
    );
    let at = w.d.clock.now();
    w.uow.edit(move |s| {
        for m in s.materials.materials.iter_mut() {
            if m.file_id == file.id {
                *m = m.redacted(at);
            }
        }
    });
    Job::StudioFilesCleanup.run(&w.d, w.d.clock.now()).await;
    let state = w.uow.snapshot();
    let stored = state.studio.files.iter().find(|f| f.id == file.id).unwrap();
    assert!(
        stored.deleted_at.is_some(),
        "an erased material's file is deleted"
    );
}
