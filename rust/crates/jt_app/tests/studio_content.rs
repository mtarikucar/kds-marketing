#[path = "support/studio.rs"]
mod support;
use jt_app::usecases::studio::pieces::{PieceInput, piece_submit};
use serde_json::json;
use support::world;
#[tokio::test]
async fn duplicate_piece_has_one_ready_revision() {
    let w = world().await;
    let input: PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"edit","text":"new text","media":[],"adaptations":{}})).unwrap();
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
    let mut w = world().await;
    w.d.files = std::sync::Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
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
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"foreign","text":"text","media":[{"kind":"file","id":id}],"adaptations":{}})).unwrap();
    assert!(piece_submit(&w.d, &w.ctx, i).await.is_err());
    assert_eq!(w.uow.snapshot().studio.pieces.len(), 1);
}

#[tokio::test]
async fn piece_edit_invalidates_approval() {
    let w = world().await;
    w.approve().await;
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"edit","text":"changed","media":[],"adaptations":{}})).unwrap();
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
    let w = world().await;
    let i:PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"concurrent","text":"text","media":[],"adaptations":{}})).unwrap();
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
#[tokio::test]
async fn byte_submission_normalizes_files_and_replay_preserves_original_result() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut w = world().await;
    w.d.files = std::sync::Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    let i:PieceInput=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"bytes","text":"text","media":[{"kind":"bytes","data":STANDARD.encode(b"\x89PNG\r\n\x1a\nbytes"),"filename":"asset.png","mime":"image/png"}],"adaptations":{}})).unwrap();
    let out = piece_submit(&w.d, &w.ctx, i.clone()).await.unwrap();
    assert!(matches!(
        out.piece.as_ref().unwrap().media[0],
        jt_studio::MediaAsset::File { .. }
    ));
    let edit=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":2,"request_key":"next","text":"edited","media":[],"adaptations":{}})).unwrap();
    piece_submit(&w.d, &w.ctx, edit).await.unwrap();
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        serde_json::to_value(piece_submit(&w.d, &w.ctx, i).await.unwrap()).unwrap()
    );
    assert_eq!(w.uow.snapshot().studio.files.len(), 1);
}
#[tokio::test]
async fn account_adaptation_and_strict_bytes_schema_are_checked() {
    let w = world().await;
    let i=serde_json::from_value(json!({"slot_id":w.f.slot.id,"expected_revision":1,"request_key":"account","text":"text","media":[],"adaptations":{"foreign-account":{"text":"other","media":[]}}})).unwrap();
    assert!(piece_submit(&w.d, &w.ctx, i).await.is_err());
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
    };
    assert!(piece_submit(&w.d, &w.ctx, i.clone()).await.is_err());
    assert!(files.files.lock().unwrap().is_empty());
    assert!(w.uow.snapshot().studio.files.is_empty());
    assert!(piece_submit(&w.d, &w.ctx, i).await.is_err());
    assert!(files.files.lock().unwrap().is_empty());
}
