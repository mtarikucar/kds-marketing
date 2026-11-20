#[path = "support/studio.rs"]
mod support;
use jt_app::usecases::studio::pieces::{PieceInput, piece_submit};
use serde_json::{Value, json};
use support::world;

/// The world, with a file store that keeps bytes and a material stored in it: the media and
/// subject every piece must show (spec 2026-11-03 D1, D2).
async fn material_world() -> (support::World, Value, Value) {
    let mut w = world().await;
    w.d.files = std::sync::Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    let (m, subject) = w.stored().await;
    (
        w,
        json!([{"kind":"file","id":m.file_id}]),
        serde_json::to_value(subject).unwrap(),
    )
}
#[tokio::test]
async fn duplicate_piece_has_one_ready_revision() {
    let (w, media, subject) = material_world().await;
    let input: PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"edit","text":"new text","media":media,"adaptations":{},"subject":subject})).unwrap();
    let first = piece_submit(&w.d, &w.ctx, input.clone()).await.unwrap();
    let second = piece_submit(&w.d, &w.ctx, input.clone()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert_eq!(first.slot.revision, 2);
    let mut changed = input;
    changed.text = "different".into();
    assert!(piece_submit(&w.d, &w.ctx, changed).await.is_err());
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 2);
}
#[tokio::test]
async fn foreign_file_cannot_be_submitted() {
    use jt_app::ports::UnitOfWork;
    let (w, _, subject) = material_world().await;
    let foreign = jt_testkit::studio_contract::fixture(&w.uow).await;
    let id = jt_studio::FileId::new_v7();
    let file =
        w.d.files
            .put(
                foreign.ws,
                id,
                jt_studio::MediaUpload {
                    bytes: b"\x89PNG\r\n\x1a\nasset".to_vec(),
                    mime: "image/png".into(),
                    filename: "a.png".into(),
                },
            )
            .await
            .unwrap();
    let mut r = w.uow.tenant(foreign.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.commit().await.unwrap();
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"foreign","text":"text","media":[{"kind":"file","id":id}],"adaptations":{},"subject":subject})).unwrap();
    assert_eq!(
        piece_submit(&w.d, &w.ctx, i).await.unwrap_err().code,
        jt_app::error::ErrorCode::NotFound
    );
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 1);
}

#[tokio::test]
async fn piece_edit_invalidates_approval() {
    let (w, media, subject) = material_world().await;
    w.approve().await;
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"edit","text":"changed","media":media,"adaptations":{},"subject":subject})).unwrap();
    let out = piece_submit(&w.d, &w.ctx, i).await.unwrap();
    use jt_app::ports::UnitOfWork;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        r.studio()
            .get_approval(
                jt_app::ports::studio::ApprovalTarget::Slot(w.f.slot.id),
                out.slot.revision
            )
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn concurrent_piece_submission_replays_without_replacing_revision() {
    let (w, media, subject) = material_world().await;
    let i:PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"concurrent","text":"text","media":media,"adaptations":{},"subject":subject})).unwrap();
    let (a, b) = tokio::join!(
        piece_submit(&w.d, &w.ctx, i.clone()),
        piece_submit(&w.d, &w.ctx, i)
    );
    assert_eq!(
        serde_json::to_value(a.unwrap()).unwrap(),
        serde_json::to_value(b.unwrap()).unwrap()
    );
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 2);
}
/// Inline bytes carry no provenance (spec 2026-11-03 D2): refused before any byte is stored. A
/// replay still returns the original result after a later edit.
#[tokio::test]
async fn byte_submission_is_refused_and_replay_preserves_original_result() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (w, media, subject) = material_world().await;
    let files = w.uow.snapshot().studio.files.len();
    let bytes:PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"bytes","text":"text","media":[{"kind":"bytes","data":STANDARD.encode(b"\x89PNG\r\n\x1a\nbytes"),"filename":"asset.png","mime":"image/png"}],"adaptations":{},"subject":subject})).unwrap();
    let e = piece_submit(&w.d, &w.ctx, bytes).await.unwrap_err();
    assert_eq!(e.details["reason"], "not_a_material");
    assert_eq!(
        w.uow.snapshot().studio.files.len(),
        files,
        "no byte was stored"
    );
    let i:PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"file","text":"text","media":media,"adaptations":{},"subject":subject})).unwrap();
    let out = piece_submit(&w.d, &w.ctx, i.clone()).await.unwrap();
    assert!(matches!(
        out.piece.as_ref().unwrap().media[0],
        jt_studio::MediaAsset::File { .. }
    ));
    let edit=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":2,"request_key":"next","text":"edited","media":media,"adaptations":{},"subject":subject})).unwrap();
    piece_submit(&w.d, &w.ctx, edit).await.unwrap();
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        serde_json::to_value(piece_submit(&w.d, &w.ctx, i).await.unwrap()).unwrap()
    );
    assert_eq!(w.uow.snapshot().studio.files.len(), files);
}
#[tokio::test]
async fn account_adaptation_and_strict_bytes_schema_are_checked() {
    let (w, media, subject) = material_world().await;
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"account","text":"text","media":media,"adaptations":{"foreign-account":{"text":"other","media":[]}},"subject":subject})).unwrap();
    assert_eq!(
        piece_submit(&w.d, &w.ctx, i).await.unwrap_err().details["field"],
        "adaptations"
    );
    assert!(serde_json::from_value::<PieceInput>(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"strict","text":"text","media":[{"kind":"bytes","data":"","mime":"image/png","filename":"x","extra":true}],"adaptations":{}})).is_err());
}
#[tokio::test]
async fn invalid_submission_compensates_all_written_bytes() {
    let mut w = world().await;
    let files = std::sync::Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    w.d.files = files.clone();
    let i = PieceInput {
        slot_id: w.f.slot.id,
        expected_revision: 1,
        request_key: "invalid-after-write".into(),
        text: "text".into(),
        media: vec![
            jt_studio::MediaAsset::Bytes {
                upload: jt_studio::MediaUpload {
                    bytes: b"\x89PNG\r\n\x1a\nasset".to_vec(),
                    mime: "image/png".into(),
                    filename: "a.png".into(),
                },
            },
            jt_studio::MediaAsset::File {
                id: jt_studio::FileId::new_v7(),
            },
        ],
        adaptations: Default::default(),
        subject: Some(jt_studio::Subject::Olay {
            olay_id: w.material().olay_id().unwrap(),
        }),
    };
    // Only the fixture material's record is there: no byte is written, none is left behind.
    let records = w.uow.snapshot().studio.files.len();
    assert!(piece_submit(&w.d, &w.ctx, i.clone()).await.is_err());
    assert!(files.files.lock().unwrap().is_empty());
    assert_eq!(w.uow.snapshot().studio.files.len(), records);
    assert!(piece_submit(&w.d, &w.ctx, i).await.is_err());
    assert!(files.files.lock().unwrap().is_empty());
}

/// The caller as an agent: the owner's key used through an agent connection.
fn agent(w: &support::World) -> jt_app::ctx::Ctx {
    let jt_ledger::Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let connection_id = jt_tenancy::AgentConnectionId::new_v7();
    jt_app::ctx::Ctx {
        actor: jt_ledger::Actor::Agent {
            user_id,
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

/// The fixture slot's current piece submitted again: its text, media, adaptations and subject.
async fn same_piece(w: &support::World, key: &str) -> PieceInput {
    use jt_app::ports::UnitOfWork;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let subject = r
        .studio_materials()
        .piece_materials(w.f.slot.id, 1)
        .await
        .unwrap()
        .unwrap()
        .subject;
    serde_json::from_value(
        json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":key,
        "text":w.f.piece.text,"media":w.f.piece.media,"adaptations":w.f.piece.adaptations,
        "subject":subject}),
    )
    .unwrap()
}

async fn approved(w: &support::World, revision: u64) -> bool {
    use jt_app::ports::UnitOfWork;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .get_approval(
            jt_app::ports::studio::ApprovalTarget::Slot(w.f.slot.id),
            revision,
        )
        .await
        .unwrap()
        .is_some()
}

fn submissions(w: &support::World) -> usize {
    w.uow
        .snapshot()
        .ledger
        .iter()
        .filter(|row| row.entry.action.as_str() == "studio.piece_submit")
        .count()
}

/// Rule 1 (2026-11-20): the current piece submitted again, unchanged, is a no-op for an agent and
/// a person alike: the answer is the piece as it is, no revision is written, nothing is recorded,
/// and the approval stands.
#[tokio::test]
async fn an_unchanged_piece_is_a_no_op_that_keeps_its_approval() {
    let w = world().await;
    w.approve().await;
    let before = submissions(&w);
    for (ctx, key) in [(agent(&w), "again"), (w.ctx.clone(), "again-person")] {
        let out = piece_submit(&w.d, &ctx, same_piece(&w, key).await)
            .await
            .unwrap();
        assert_eq!(out.slot.revision, 1);
        assert_eq!(out.piece.as_ref().map(|p| p.id), Some(w.f.piece.id));
        assert_eq!(out.slot.state, jt_studio::SlotState::Ready);
    }
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 1);
    assert!(approved(&w, 1).await, "the approval stands");
    assert_eq!(submissions(&w), before, "nothing is recorded");
}

/// Rule 2: an agent does not replace a piece a person approved; the refusal says why. A person in
/// person still can, and that voids the approval as before.
#[tokio::test]
async fn an_agent_cannot_replace_an_approved_piece_but_a_person_can() {
    let (w, media, subject) = material_world().await;
    w.approve().await;
    let i: PieceInput = serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,
        "request_key":"replace","text":"changed","media":media,"adaptations":{},"subject":subject}))
    .unwrap();
    let e = piece_submit(&w.d, &agent(&w), i.clone()).await.unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "approved_piece");
    assert!(e.message.contains("leave it"), "{}", e.message);
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 1);
    assert!(approved(&w, 1).await);
    let out = piece_submit(&w.d, &w.ctx, i).await.unwrap();
    assert_eq!(out.slot.revision, 2);
    assert!(
        !approved(&w, 2).await,
        "the new piece waits for its approval"
    );
}

/// Rule 2 leaves an agent's work alone where no person approved the piece: it replaces it.
#[tokio::test]
async fn an_agent_replaces_a_piece_nobody_approved() {
    let (w, media, subject) = material_world().await;
    let i: PieceInput = serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,
        "request_key":"replace","text":"changed","media":media,"adaptations":{},"subject":subject}))
    .unwrap();
    let out = piece_submit(&w.d, &agent(&w), i).await.unwrap();
    assert_eq!(out.slot.revision, 2);
    assert_eq!(out.piece.unwrap().text, "changed");
}
