#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{
        UnitOfWork,
        connectors::PublishReceipt,
        studio::{ApprovalTarget, PublishOutcome},
    },
    usecases::studio::{publish::*, work},
};
use jt_connector::{ConnectorError, Provider};
use jt_studio::{PublishState, SlotState};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry,
};
use std::sync::Arc;
use time::Duration;
async fn world() -> (support::World, Arc<ScriptedConnector>) {
    let mut w = support::world().await;
    let c = Arc::new(ScriptedConnector::new(Provider::X));
    w.d.connectors = Arc::new(ScriptedRegistry::new().with_connector(c.clone()));
    (w, c)
}
fn receipt() -> PublishReceipt {
    PublishReceipt {
        external_id: "123".into(),
        url: Some("https://x.com/i/status/123".parse().unwrap()),
    }
}
fn sends(c: &ScriptedConnector) -> usize {
    c.calls()
        .iter()
        .filter(|c| matches!(c, ConnectorCall::Publish { .. }))
        .count()
}
#[tokio::test]
async fn due_ready_post_publishes_without_human_by_default() {
    let (w, c) = world().await;
    c.push_publish(Ok(receipt()));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.publications.len(), 1);
    let p = &s.studio.publications[0];
    assert_eq!(p.chain, w.f.slot.chain);
    assert_eq!(p.executed_version_id, w.current);
    assert_eq!(p.external_id, "123");
    let finished = s
        .ledger
        .iter()
        .find(|row| {
            row.entry.action.as_str() == "studio.publish.finished"
                && row.entry.payload["state"] == "succeeded"
        })
        .unwrap();
    assert_eq!(
        finished.entry.payload["born_version_id"],
        serde_json::json!(w.f.slot.chain.born_version_id)
    );
    assert_eq!(
        finished.entry.payload["arm_id"],
        serde_json::json!(w.f.arm.id)
    );
    assert_eq!(s.studio.slots[0].state, SlotState::Published);
    assert_eq!(sends(&c), 1);
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
}
#[tokio::test]
async fn publish_requires_chain_and_current_capability() {
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.connector_public = serde_json::json!({});
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    assert!(publish_due(&w.d, w.f.ws).await.is_err());
    assert_eq!(sends(&c), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
}
#[tokio::test]
async fn accepted_publish_response_lost_never_blindly_retries() {
    let (w, c) = world().await;
    c.push_publish(Err(ConnectorError::unknown("accepted, response lost")));
    publish_due(&w.d, w.f.ws).await.unwrap();
    for _ in 0..3 {
        recover_publications(&w.d, w.f.ws).await.unwrap();
        publish_due(&w.d, w.f.ws).await.unwrap();
    }
    assert_eq!(sends(&c), 1);
    assert_eq!(
        w.uow.snapshot().studio.attempts[0].state(),
        PublishState::Unknown
    );
}
#[tokio::test]
async fn recovery_after_restart_keeps_unknown() {
    let (mut w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.commit().await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(3)));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&c), 0);
    assert_eq!(
        w.uow.snapshot().studio.attempts[0].state(),
        PublishState::Unknown
    );
}
#[tokio::test]
async fn result_replay_records_one_publication() {
    let (w, c) = world().await;
    c.push_publish(Ok(receipt()));
    publish_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    let a = s.studio.attempts[0].id();
    let n = s.ledger.len();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .finish_publication(a, PublishOutcome::Succeeded(receipt()), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(w.uow.snapshot().studio.publications.len(), 1);
    assert_eq!(w.uow.snapshot().ledger.len(), n);
}
fn errors() -> Vec<ConnectorError> {
    vec![
        ConnectorError::auth("secret"),
        ConnectorError::permission("secret"),
        ConnectorError::permanent("secret"),
        ConnectorError::throttle(Some(Duration::seconds(2))),
        ConnectorError::transient("secret"),
        ConnectorError::unknown("secret"),
    ]
}
#[tokio::test]
async fn all_publish_error_classes_have_zero_automatic_retries() {
    for e in errors() {
        let (w, c) = world().await;
        c.push_publish(Err(e));
        publish_due(&w.d, w.f.ws).await.unwrap();
        for _ in 0..2 {
            publish_due(&w.d, w.f.ws).await.unwrap();
            recover_publications(&w.d, w.f.ws).await.unwrap();
        }
        assert_eq!(sends(&c), 1);
    }
}
#[tokio::test]
async fn auth_permission_permanent_throttle_transient_are_distinct() {
    for e in errors() {
        let kind = e.kind();
        let (w, c) = world().await;
        c.push_publish(Err(e));
        publish_due(&w.d, w.f.ws).await.unwrap();
        let s = w.uow.snapshot();
        let value = serde_json::to_value(s.studio.attempts[0].outcome()).unwrap();
        assert_eq!(value["evidence"], kind);
        let pending = work::pending(&w.d, &w.ctx).await.unwrap();
        assert!(
            pending
                .blockers
                .iter()
                .any(|b| b.reason == format!("publish_{kind}"))
        );
    }
}
#[tokio::test]
async fn a_failed_publication_keeps_the_provider_reason_for_the_owner() {
    let (w, c) = world().await;
    c.push_publish(Err(ConnectorError::permanent(
        "HTTP 402 CreditsDepleted: Your enrolled account does not have any credits",
    )));
    publish_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    let line =
        "permanent: x: HTTP 402 CreditsDepleted: Your enrolled account does not have any credits";
    assert_eq!(s.studio.attempts[0].state(), PublishState::Failed);
    assert_eq!(s.studio.attempts[0].failure_reason(), Some(line));
    // The evidence keeps the closed category only; the ledger names the reason for the owner.
    let value = serde_json::to_value(s.studio.attempts[0].outcome()).unwrap();
    assert_eq!(value["evidence"], "permanent");
    let failure = s
        .ledger
        .iter()
        .find(|row| row.entry.action.as_str() == "studio.publish.failure")
        .expect("failure entry");
    assert_eq!(failure.entry.payload["provider_reason"], line);
}
#[tokio::test]
async fn no_id_unknown_stays_unknown_with_work_item() {
    let (w, c) = world().await;
    c.push_publish(Err(ConnectorError::unknown("lost")));
    publish_due(&w.d, w.f.ws).await.unwrap();
    recover_publications(&w.d, w.f.ws).await.unwrap();
    assert_eq!(c.calls().len(), 1);
    let p = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(
        p.blockers
            .iter()
            .any(|b| b.next_action.as_deref() == Some("review_publication_duplicate_risk"))
    );
}
#[tokio::test]
async fn a_retired_slot_carries_no_publish_failure_blocker() {
    let (w, c) = world().await;
    let slot = ApprovalTarget::Slot(w.f.slot.id);
    c.push_publish(Err(ConnectorError::auth("expired")));
    publish_due(&w.d, w.f.ws).await.unwrap();
    let p = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(
        p.blockers
            .iter()
            .any(|b| b.target == slot && b.reason == "publish_auth")
    );
    work::slot_cancel(
        &w.d,
        &w.ctx,
        work::CancelSlotInput {
            slot_id: w.f.slot.id,
            expected_revision: 1,
            reason: "Plan değişti".into(),
        },
    )
    .await
    .unwrap();
    // Cancelled, it is never sent: its failure is history in its detail, not work.
    let p = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(p.blockers.iter().all(|b| b.target != slot));
    let out = work::slot_get(&w.d, &w.ctx, w.f.slot.id).await.unwrap();
    assert_eq!(out.slot.state, SlotState::Retired);
    assert_eq!(out.attempts.len(), 1);
}
#[tokio::test]
async fn a_slot_already_sent_is_not_offered_for_approval_again() {
    let (w, c) = world().await;
    let slot = ApprovalTarget::Slot(w.f.slot.id);
    c.push_publish(Err(ConnectorError::permanent("HTTP 402 CreditsDepleted")));
    publish_due(&w.d, w.f.ws).await.unwrap();
    w.policy(true, 0).await;
    // The content supplied again is a new revision, but no revision of a sent slot is sent.
    let mut piece = w.f.piece.clone();
    piece.id = jt_studio::PieceId::new_v7();
    piece.revision = 2;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .save_piece(w.f.slot.id, 1, piece, "again")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let p = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(!p.approvals.contains(&slot));
    assert!(
        p.blockers
            .iter()
            .all(|b| b.target != slot || b.reason != "human_approval_required")
    );
    // What stops it stays in view: its failure.
    assert!(
        p.blockers
            .iter()
            .any(|b| b.target == slot && b.reason == "publish_permanent")
    );
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&c), 1);
}
#[tokio::test]
async fn provider_io_holds_no_tenant_row_locks() {
    let (w, c) = world().await;
    let uow = w.uow.clone();
    let ws = w.f.ws;
    c.push_send_hook(move || async move {
        let mut r = uow.tenant(ws).await.unwrap();
        r.strategy().lock_execution_frame().await.unwrap();
        r.studio_control().lock_control().await.unwrap();
        r.commit().await.unwrap();
    });
    c.push_publish(Ok(receipt()));
    tokio::time::timeout(std::time::Duration::from_secs(2), publish_due(&w.d, w.f.ws))
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn known_id_unknown_can_read_back() {
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.studio()
        .finish_publication(a.id(), PublishOutcome::Observed(receipt()), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.archive().await;
    c.push_post_metrics(Ok(Default::default()));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&c), 0);
    assert!(matches!(&c.calls()[0],ConnectorCall::PostMetrics{post_id,..} if post_id=="123"));
    assert_eq!(
        w.uow.snapshot().studio.publications[0].chain,
        w.f.slot.chain
    );
    assert_eq!(w.uow.snapshot().studio.slots[0].state, SlotState::Retired);
}
#[tokio::test]
async fn late_publish_success_keeps_evidence() {
    let (w, c) = world().await;
    let w = Arc::new(w);
    let other = w.clone();
    c.push_send_hook(move || async move {
        other.brake(true, None, 0).await;
        other.archive().await;
    });
    c.push_publish(Ok(receipt()));
    publish_due(&w.d, w.f.ws).await.unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.studio.publications.len(), 1);
    assert_eq!(s.studio.slots[0].state, SlotState::Retired);
    let ledger = serde_json::to_value(&s.ledger).unwrap().to_string();
    assert!(ledger.contains("late_completion"));
    assert!(ledger.contains(&w.f.arm.id.to_string()));
}
#[tokio::test]
async fn two_dispatchers_send_once() {
    let (w, c) = world().await;
    c.push_publish(Ok(receipt()));
    let (a, b) = tokio::join!(publish_due(&w.d, w.f.ws), publish_due(&w.d, w.f.ws));
    assert!(a.is_ok() || b.is_ok());
    assert_eq!(sends(&c), 1);
    assert_eq!(w.uow.snapshot().studio.publications.len(), 1);
}
#[tokio::test]
async fn metered_publication_requires_persisted_price() {
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.policy.spend_cap_minor = Some(1000);
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        publish_due(&w.d, w.f.ws).await.unwrap_err().details["reason"],
        "unknown_unit_price"
    );
    assert_eq!(sends(&c), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
}
#[tokio::test]
async fn full_request_uses_account_adaptation_and_stored_bytes() {
    use jt_app::usecases::studio::pieces::{PieceInput, piece_submit};
    use jt_studio::{ChannelContent, MediaAsset, MediaUpload};
    use std::collections::BTreeMap;
    let (mut w, c) = world().await;
    w.d.files = Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    drop(r);
    let u = MediaUpload {
        bytes: b"\x89PNG\r\n\x1a\nimage".to_vec(),
        mime: "image/png".into(),
        filename: "image.png".into(),
    };
    piece_submit(
        &w.d,
        &w.ctx,
        PieceInput {
            slot_id: w.f.slot.id,
            expected_revision: 1,
            request_key: "adaptation".into(),
            text: "base".into(),
            media: vec![],
            adaptations: BTreeMap::from([(
                cap.external_id.unwrap(),
                ChannelContent {
                    text: "adapted".into(),
                    media: vec![MediaAsset::Bytes { upload: u.clone() }],
                    link: Some("https://example.com/link".parse().unwrap()),
                    privacy: Some("SELF_ONLY".into()),
                },
            )]),
        },
    )
    .await
    .unwrap();
    c.push_publish(Ok(receipt()));
    publish_due(&w.d, w.f.ws).await.unwrap();
    let calls = c.calls();
    let ConnectorCall::Publish { request, .. } = &calls[0] else {
        panic!("publish")
    };
    assert_eq!(request.text, "adapted");
    assert_eq!(
        request.link.as_ref().unwrap().as_str(),
        "https://example.com/link"
    );
    assert_eq!(request.media, vec![u]);
    assert!(request.media_urls.is_empty());
    // Who may see it rides along, as the adaptation asked.
    assert_eq!(request.privacy.as_deref(), Some("SELF_ONLY"));
}
#[test]
fn media_delivery_per_kind() {
    use jt_app::usecases::studio::files::MediaDelivery::{self, Bytes, SignedUrl};
    for (kind, mime, expected) in [
        ("x", "image/png", Bytes),
        ("x", "video/mp4", Bytes),
        ("linkedin_member", "image/jpeg", Bytes),
        ("linkedin_page", "video/mp4", Bytes),
        // TikTok uploads a video's bytes, and pulls photos from their URLs.
        ("tiktok", "video/mp4", Bytes),
        ("tiktok", " Video/MP4 ", Bytes),
        ("tiktok", "image/jpeg", SignedUrl),
        ("instagram", "image/jpeg", SignedUrl),
        ("instagram", "video/mp4", SignedUrl),
        ("facebook_page", "image/png", SignedUrl),
    ] {
        assert_eq!(MediaDelivery::of(kind, mime), expected, "{kind} {mime}");
    }
}
/// A post of a provider that publishes in the background (TikTok): the receipt `publish`
/// returns is observed, not yet a publication; the recovery job asks where it stands until it
/// is published, and the publication carries the post's own receipt.
#[tokio::test]
async fn background_publication_settles_through_resolve() {
    use jt_app::ports::connectors::PublishResolution;
    let (mut w, c) = world().await;
    let sent = PublishReceipt {
        external_id: "v_pub_1".into(),
        url: None,
    };
    c.push_publish(Ok(sent.clone()));
    c.push_resolve(Ok(Some(PublishResolution::Pending)));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.attempts[0].state(), PublishState::Unknown);
    assert!(s.studio.publications.is_empty());
    assert_ne!(s.studio.slots[0].state, SlotState::Published);

    // Still processing a minute later: left for the next run.
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(1)));
    c.push_resolve(Ok(Some(PublishResolution::Pending)));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(w.uow.snapshot().studio.publications.is_empty());

    let post = PublishReceipt {
        external_id: "7300000000000000001".into(),
        url: Some(
            "https://www.tiktok.com/@jeeta_test/video/7300000000000000001"
                .parse()
                .unwrap(),
        ),
    };
    c.push_resolve(Ok(Some(PublishResolution::Published(post.clone()))));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.attempts[0].state(), PublishState::Succeeded);
    assert_eq!(s.studio.publications.len(), 1);
    assert_eq!(s.studio.publications[0].external_id, post.external_id);
    assert_eq!(s.studio.publications[0].url, post.url);
    assert_eq!(s.studio.slots[0].state, SlotState::Published);
    // Every status read named the receipt publish returned; nothing was sent twice.
    assert_eq!(c.resolve_calls(), vec![sent.clone(), sent.clone(), sent]);
    assert_eq!(sends(&c), 1);
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 0);
}
/// The provider gave up on a post processing in the background: the attempt fails with the
/// provider's failure line, and the owner reads it in the ledger.
#[tokio::test]
async fn background_publication_fails_with_its_reason() {
    use jt_app::ports::connectors::PublishResolution;
    let (mut w, c) = world().await;
    c.push_publish(Ok(PublishReceipt {
        external_id: "v_pub_2".into(),
        url: None,
    }));
    c.push_resolve(Ok(Some(PublishResolution::Pending)));
    publish_due(&w.d, w.f.ws).await.unwrap();
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(2)));
    c.push_resolve(Ok(Some(PublishResolution::Failed(
        ConnectorError::permanent("publish failed: duration_check_failed"),
    ))));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    let line = "permanent: x: publish failed: duration_check_failed";
    assert_eq!(s.studio.attempts[0].state(), PublishState::Failed);
    assert_eq!(s.studio.attempts[0].failure_reason(), Some(line));
    assert!(s.studio.publications.is_empty());
    let failure = s
        .ledger
        .iter()
        .find(|row| row.entry.action.as_str() == "studio.publish.failure")
        .expect("failure entry");
    assert_eq!(failure.entry.payload["provider_reason"], line);
    assert_eq!(sends(&c), 1);
}
/// A post that never settles is failed once the resolve window is over, never re-sent.
#[tokio::test]
async fn background_publication_times_out_after_the_window() {
    use jt_app::ports::connectors::PublishResolution;
    let (mut w, c) = world().await;
    c.push_publish(Ok(PublishReceipt {
        external_id: "v_pub_3".into(),
        url: None,
    }));
    c.push_resolve(Ok(Some(PublishResolution::Pending)));
    publish_due(&w.d, w.f.ws).await.unwrap();
    // A status read that fails inside the window waits for the next run, too.
    w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(10)));
    c.push_resolve(Err(ConnectorError::transient("offline")));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(
        w.uow.snapshot().studio.attempts[0].state(),
        PublishState::Unknown
    );
    w.d.clock = Arc::new(FixedClock(
        FIXED_NOW + RESOLVE_WINDOW + Duration::minutes(1),
    ));
    c.push_resolve(Ok(Some(PublishResolution::Pending)));
    assert_eq!(recover_publications(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.attempts[0].state(), PublishState::Failed);
    let reason = s.studio.attempts[0].failure_reason().unwrap();
    assert!(reason.starts_with("transient: x: "), "{reason}");
    assert!(reason.contains("timed out"), "{reason}");
    assert_eq!(sends(&c), 1);
}
#[tokio::test]
async fn held_consent_and_future_slot_do_not_create_attempts() {
    let (w, c) = world().await;
    w.policy(true, 0).await;
    // Waiting for its approval is not a failure.
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&c), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
    w.approve().await;
    c.push_publish(Ok(receipt()));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let (mut w, c) = world().await;
    w.d.clock = Arc::new(FixedClock(FIXED_NOW - Duration::days(1)));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&c), 0);
}

#[tokio::test]
async fn held_queue_head_does_not_starve_an_eligible_slot() {
    use jt_capability::{Capability, CapabilityId, NewCapability};
    use jt_studio::{PieceId, SlotId};
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut held = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    let mut other = Capability::new(
        CapabilityId::new_v7(),
        w.f.ws,
        NewCapability {
            kind_key: held.kind_key.clone(),
            key_detail: None,
            name: "other".into(),
            description: String::new(),
            external_id: Some("other-account".into()),
            connector_public: held.connector_public.clone(),
            policy: held.policy.clone(),
        },
        FIXED_NOW,
    )
    .unwrap();
    other.status = held.status;
    other.last_verified_at = held.last_verified_at;
    let sealed = r.capabilities().read_sealed(held.id).await.unwrap();
    r.capabilities()
        .insert(other.clone(), sealed)
        .await
        .unwrap();
    held.policy.requires_human_approval = true;
    r.capabilities().update(held).await.unwrap();
    let mut slot = w.f.slot.clone();
    slot.id = SlotId::new_v7();
    slot.capability_id = other.id;
    slot.scheduled_at = FIXED_NOW + Duration::seconds(1);
    r.studio()
        .insert_slots("second-slot", vec![slot.clone()])
        .await
        .unwrap();
    let mut piece = w.f.piece.clone();
    piece.id = PieceId::new_v7();
    r.studio()
        .save_piece(slot.id, 0, piece, "second-piece")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut d = w.d;
    d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::seconds(2)));
    c.push_publish(Ok(receipt()));
    assert_eq!(publish_due(&d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.publications[0].slot_id, slot.id);
    assert!(s.studio.attempts.iter().all(|a| a.slot_id() != w.f.slot.id));
    assert_eq!(sends(&c), 1);
}

async fn second_slot(w: &support::World) -> jt_studio::SlotId {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut slot = w.f.slot.clone();
    slot.id = jt_studio::SlotId::new_v7();
    r.studio()
        .insert_slots("second", vec![slot.clone()])
        .await
        .unwrap();
    let mut piece = w.f.piece.clone();
    piece.id = jt_studio::PieceId::new_v7();
    r.studio()
        .save_piece(slot.id, 0, piece, "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    slot.id
}

#[tokio::test]
async fn daily_ops_cap_limits_claims() {
    let (mut w, c) = world().await;
    let second = second_slot(&w).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.policy.daily_ops_cap = Some(1);
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    // Istanbul midnight is 21:00 UTC. Both timestamps are on the same UTC date.
    let before = FIXED_NOW.date().with_hms(20, 59, 59).unwrap().assume_utc();
    w.d.clock = Arc::new(FixedClock(before));
    c.push_publish(Ok(receipt()));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.attempts.len(), 1);
    assert_eq!(
        s.studio
            .slots
            .iter()
            .find(|s| s.id == second)
            .unwrap()
            .state,
        SlotState::Ready
    );
    assert!(
        s.ledger
            .iter()
            .any(|r| r.entry.payload["reason"] == "daily_ops_cap")
    );
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    w.d.clock = Arc::new(FixedClock(before + Duration::seconds(1)));
    c.push_publish(Ok(PublishReceipt {
        external_id: "124".into(),
        url: None,
    }));
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(sends(&c), 2);
}

struct BrokenMedia(jt_app::error::ErrorCode);
#[async_trait::async_trait]
impl jt_app::ports::files::MediaFetcher for BrokenMedia {
    async fn fetch(
        &self,
        _: jt_tenancy::WorkspaceId,
        _: &url::Url,
        _: &str,
        _: &str,
    ) -> Result<jt_studio::MediaUpload, jt_app::error::AppError> {
        Err(jt_app::error::AppError {
            code: self.0,
            message: "private diagnostic".into(),
            details: serde_json::json!({}),
        })
    }
}
#[tokio::test]
async fn broken_media_does_not_starve_healthy_slots() {
    use jt_app::error::ErrorCode;
    for (code, category) in [
        (
            ErrorCode::UpstreamUnavailable,
            jt_studio::RedactedPublishError::Transient,
        ),
        (
            ErrorCode::Validation,
            jt_studio::RedactedPublishError::Permanent,
        ),
    ] {
        let (mut w, c) = world().await;
        let healthy = second_slot(&w).await;
        w.d.media_fetch = Arc::new(BrokenMedia(code));
        let mut piece = w.f.piece.clone();
        piece.id = jt_studio::PieceId::new_v7();
        piece.revision = 2;
        piece.media = vec![jt_studio::MediaAsset::HostedUrl {
            url: "https://example.com/broken.png".parse().unwrap(),
            mime: "image/png".into(),
            size_bytes: 10,
        }];
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        r.studio()
            .save_piece(w.f.slot.id, 1, piece, "broken")
            .await
            .unwrap();
        r.commit().await.unwrap();
        c.push_publish(Ok(receipt()));
        assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 2);
        let s = w.uow.snapshot();
        assert_eq!(s.studio.publications.len(), 1);
        assert_eq!(s.studio.publications[0].slot_id, healthy);
        let a = s
            .studio
            .attempts
            .iter()
            .find(|a| a.slot_id() == w.f.slot.id)
            .unwrap();
        assert_eq!(a.state(), PublishState::Failed);
        assert_eq!(
            a.outcome(),
            Some(&jt_studio::PublishOutcome::Failed(category))
        );
        if category == jt_studio::RedactedPublishError::Permanent {
            assert_ne!(
                s.studio
                    .slots
                    .iter()
                    .find(|s| s.id == w.f.slot.id)
                    .unwrap()
                    .state,
                SlotState::Ready
            );
            // Retired by its broken media, it is never sent: no failure stays in Today.
            let p = work::pending(&w.d, &w.ctx).await.unwrap();
            assert!(
                p.blockers
                    .iter()
                    .all(|b| b.target != ApprovalTarget::Slot(w.f.slot.id))
            );
        }
        assert!(
            !serde_json::to_string(a)
                .unwrap()
                .contains("private diagnostic")
        );
        assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
        assert_eq!(sends(&c), 1);
    }
}

#[tokio::test]
async fn zero_daily_ops_cap_records_reason_without_claiming() {
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.policy.daily_ops_cap = Some(0);
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    let s = w.uow.snapshot();
    assert!(s.studio.attempts.is_empty());
    assert!(
        s.ledger
            .iter()
            .any(|r| r.entry.payload["reason"] == "daily_ops_cap")
    );
    assert_eq!(s.studio.slots[0].state, SlotState::Ready);
    assert_eq!(sends(&c), 0);
}

#[tokio::test]
async fn unpriced_queue_head_does_not_starve() {
    use jt_capability::{Capability, CapabilityId, NewCapability};
    use jt_studio::{PieceId, SlotId};
    let (w, c) = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut held = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    let mut other = Capability::new(
        CapabilityId::new_v7(),
        w.f.ws,
        NewCapability {
            kind_key: held.kind_key.clone(),
            key_detail: None,
            name: "other".into(),
            description: String::new(),
            external_id: Some("other-account".into()),
            connector_public: held.connector_public.clone(),
            policy: held.policy.clone(),
        },
        FIXED_NOW,
    )
    .unwrap();
    other.status = held.status;
    other.last_verified_at = held.last_verified_at;
    let sealed = r.capabilities().read_sealed(held.id).await.unwrap();
    r.capabilities()
        .insert(other.clone(), sealed)
        .await
        .unwrap();
    held.policy.spend_cap_minor = Some(1000);
    r.capabilities().update(held).await.unwrap();
    let mut slot = w.f.slot.clone();
    slot.id = SlotId::new_v7();
    slot.capability_id = other.id;
    slot.scheduled_at = FIXED_NOW + Duration::seconds(1);
    r.studio()
        .insert_slots("second-slot", vec![slot.clone()])
        .await
        .unwrap();
    let mut piece = w.f.piece.clone();
    piece.id = PieceId::new_v7();
    r.studio()
        .save_piece(slot.id, 0, piece, "second-piece")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut d = w.d;
    d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::seconds(2)));
    c.push_publish(Ok(receipt()));
    assert_eq!(publish_due(&d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert_eq!(s.studio.publications[0].slot_id, slot.id);
    assert!(s.studio.attempts.iter().all(|a| a.slot_id() != w.f.slot.id));
    assert_eq!(sends(&c), 1);
}
#[tokio::test]
async fn media_failure_does_not_leak_reservation() {
    let (mut w, c) = world().await;
    let item=jt_app::usecases::budget::create_item(&w.d,&w.ctx,serde_json::from_value(serde_json::json!({"name":"metered publish","kind":"cash","unit":{"kind":"currency","value":"TRY"},"cap":1000,"period":"monthly","unit_cost_minor":3})).unwrap()).await.unwrap();
    w.d.media_fetch = Arc::new(BrokenMedia(jt_app::error::ErrorCode::Validation));
    let mut piece = w.f.piece.clone();
    piece.id = jt_studio::PieceId::new_v7();
    piece.revision = 2;
    piece.media = vec![jt_studio::MediaAsset::HostedUrl {
        url: "https://example.com/broken.png".parse().unwrap(),
        mime: "image/png".into(),
        size_bytes: 10,
    }];
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.budget()
        .link(w.f.slot.capability_id, item.item.id)
        .await
        .unwrap();
    r.studio()
        .save_piece(w.f.slot.id, 1, piece, "broken")
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(sends(&c), 0);
    let s = w.uow.snapshot();
    assert!(s.studio.reservations.is_empty());
    assert!(
        s.studio
            .reservations
            .iter()
            .all(|(_, o)| *o == Some(jt_studio::SpendOutcome::Refused)),
        "no provider I/O occurred but the upper bound remains held"
    );
}
