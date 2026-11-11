//! A post left with its platform's own scheduler (design 2026-11-10 §7.3, B47): where a
//! workspace switched it on and the platform can hold the post, the slot's one attempt hands it
//! over ahead of its time; from its time on the platform is asked whether it went out; and
//! whatever would stop Jeeta from sending takes it back first. Nothing is ever sent twice.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{
        UnitOfWork,
        connectors::{PublishReceipt, Scheduled},
        files::StoredFile,
        production_projects::ProductionProject,
    },
    usecases::{
        content, social,
        social::accounts::UpcomingState,
        studio::{
            projects,
            publish::{self, WITHDRAW_MARGIN},
            work as studio_work,
        },
    },
};
use jt_connector::{ConnectorError, Provider};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::AgentConnectionId;
use jt_testkit::fakes::{
    ConnectorCall, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, macros::datetime};
use uuid::Uuid;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// The Studio world whose X account's platform has a scheduler of its own (15 minutes to 29 days
/// ahead), with a real file store and an empty library. The workspace has it switched on when
/// `on`.
async fn hold_world(on: bool) -> (World, Arc<ScriptedConnector>) {
    let mut w = world().await;
    let x = Arc::new(
        ScriptedConnector::new(Provider::X)
            .with_scheduler(Duration::minutes(15), Duration::days(29)),
    );
    w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(w.ads.clone())
            .with_connector(x.clone()),
    );
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    if on {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut settings = r.studio_posts().posting_settings().await.unwrap();
        settings.provider_scheduling = true;
        r.studio_posts()
            .save_posting_settings(settings)
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    (w, x)
}

fn agent(w: &World) -> Ctx {
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            user_id,
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

/// A shareable, publishable image of a confirmed workshop, with its bytes stored.
async fn material(w: &World) -> Material {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(Uuid::now_v7().as_bytes());
    let file: StoredFile =
        w.d.files
            .put(
                w.f.ws,
                FileId::new_v7(),
                MediaUpload {
                    bytes,
                    mime: "image/png".into(),
                    filename: "material.png".into(),
                },
            )
            .await
            .unwrap();
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials().insert_olay(olay).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

const WHEN: OffsetDateTime = datetime!(2026-10-24 10:00 UTC);

/// An area a person opened and an agent finished with one version of `format`, scheduled on the
/// X account at `at`: the area and the post's slot.
async fn scheduled(
    w: &World,
    key: &str,
    format: &str,
    at: OffsetDateTime,
) -> (ProductionProject, Slot) {
    let m = material(w).await;
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"brief":"Yeni sezonu duyur","material_ids":[m.id]})),
    )
    .await
    .unwrap();
    let a = agent(w);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let p = content::area_deliver(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":c.claim_token,
            "request_key":format!("{key}-delivery"),"summary":"Hazır",
            "versions":[{"format":format,"text":"Yeni sezon başlıyor","tags":[],
                "material_ids":[m.id],"hypothesis_id":w.f.slot.chain.hypothesis_id}]})),
    )
    .await
    .unwrap()
    .project;
    let out = social::version_schedule(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"version_id":p.packages[0].versions[0].id,
            "capability_id":w.f.slot.capability_id,
            "publish_at":at.format(&time::format_description::well_known::Rfc3339).unwrap(),
            "request_key":format!("{key}-time")}),
        ),
    )
    .await
    .unwrap();
    (out.project, out.publication.slot)
}

fn held_receipt() -> PublishReceipt {
    PublishReceipt {
        external_id: "scheduled-1".into(),
        url: None,
    }
}

fn calls(x: &ScriptedConnector, what: &str) -> usize {
    x.calls()
        .iter()
        .filter(|c| match c {
            ConnectorCall::Publish { .. } => what == "publish",
            ConnectorCall::Schedule { .. } => what == "schedule",
            ConnectorCall::Withdraw { .. } => what == "withdraw",
            _ => false,
        })
        .count()
}

/// The slot's attempt.
fn attempt(w: &World, slot: SlotId) -> PublishAttempt {
    w.uow
        .snapshot()
        .studio
        .attempts
        .iter()
        .find(|a| a.slot_id() == slot)
        .cloned()
        .expect("the slot's attempt")
}

fn slot_state(w: &World, slot: SlotId) -> SlotState {
    w.uow
        .snapshot()
        .studio
        .slots
        .iter()
        .find(|s| s.id == slot)
        .unwrap()
        .state
}

fn ledgered(w: &World, action: &str) -> usize {
    w.uow
        .snapshot()
        .ledger
        .iter()
        .filter(|l| l.entry.action.as_str() == action)
        .count()
}

/// Leaves the slot's post with the platform: one hand-over, held until `WHEN`.
async fn hold(w: &World, x: &ScriptedConnector, slot: SlotId) {
    x.push_schedule(Ok(held_receipt()));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 1);
    let a = attempt(w, slot);
    assert!(a.is_held());
    assert_eq!(a.held_until(), Some(WHEN));
}

#[tokio::test]
async fn off_by_default_jeeta_sends_every_post_itself() {
    let (mut w, x) = hold_world(false).await;
    let (_, slot) = scheduled(&w, "off", "feed_post", WHEN).await;
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(calls(&x, "schedule"), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(slot_state(&w, slot.id), SlotState::Published);
    // Switching it on is a person's, with the posting settings.
    let settings = jt_app::ports::posts::PostingSettings {
        provider_scheduling: true,
        ..Default::default()
    };
    let e = jt_app::usecases::studio::posts::posting_policy_set(&w.d, &agent(&w), settings.clone())
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    let saved = jt_app::usecases::studio::posts::posting_policy_set(&w.d, &w.ctx, settings)
        .await
        .unwrap();
    assert!(saved.provider_scheduling);
}

#[tokio::test]
async fn a_post_is_left_with_the_platform_once_and_settles_when_it_went_out_there() {
    let (mut w, x) = hold_world(true).await;
    let a = agent(&w);
    let (_, slot) = scheduled(&w, "held", "feed_post", WHEN).await;

    // Two days ahead: the slot's one attempt hands the post over, to go out at its time.
    hold(&w, &x, slot.id).await;
    let handed: Vec<_> = x
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::Schedule { request, at, .. } => Some((request.text, at)),
            _ => None,
        })
        .collect();
    assert_eq!(handed, [("Yeni sezon başlıyor".to_owned(), WHEN)]);
    assert_eq!(slot_state(&w, slot.id), SlotState::Ready);
    assert_eq!(ledgered(&w, "studio.publish.claimed"), 1);
    // The account's page says where it waits; nothing is stuck for anybody. It also says what
    // the platform's own scheduler holds: Jeeta's post, and one Jeeta does not know of (left
    // there by hand, or by a hand-over that never said whether it was taken).
    x.push_scheduled_list(Ok(Some(vec![
        jt_app::ports::connectors::PlatformScheduled {
            external_id: "stray-1".into(),
            publish_at: WHEN + Duration::days(1),
            text: "Elle zamanlanmış\nikinci satır".into(),
        },
        jt_app::ports::connectors::PlatformScheduled {
            external_id: "sched-1".into(),
            publish_at: WHEN,
            text: "Yeni sezon başlıyor".into(),
        },
    ])));
    let detail = social::account_get(
        &w.d,
        &a,
        input(json!({"capability_id":w.f.slot.capability_id})),
    )
    .await
    .unwrap();
    let u = detail
        .upcoming
        .iter()
        .find(|u| u.slot_id == slot.id)
        .unwrap();
    assert!(u.held_at_provider);
    assert_eq!(u.state, UpcomingState::Ready);
    assert_eq!(
        serde_json::to_value(&detail.at_platform).unwrap(),
        json!([
            {"external_id":"sched-1","publish_at":"2026-10-24T10:00:00Z",
             "title":"Yeni sezon başlıyor","known":true},
            {"external_id":"stray-1","publish_at":"2026-10-25T10:00:00Z",
             "title":"Elle zamanlanmış","known":false},
        ])
    );
    // A platform that has no scheduler to read, or a read that fails, leaves the list out and
    // never fails the page.
    x.push_scheduled_list(Err(ConnectorError::transient("down")));
    for _ in 0..2 {
        let detail = social::account_get(
            &w.d,
            &a,
            input(json!({"capability_id":w.f.slot.capability_id})),
        )
        .await
        .unwrap();
        assert_eq!(detail.at_platform, None);
        assert!(
            serde_json::to_value(&detail)
                .unwrap()
                .get("at_platform")
                .is_none()
        );
    }
    let pending = studio_work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(
        !serde_json::to_string(&pending)
            .unwrap()
            .contains("publish_processing"),
        "a post waiting at its platform is not a stuck one"
    );

    // Handed over once: no second hand-over, and Jeeta does not send it at its time.
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 0);
    w.d.clock = Arc::new(FixedClock(WHEN));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!((calls(&x, "schedule"), calls(&x, "publish")), (1, 0));

    // From its time on the platform is asked: still waiting, then out. The attempt succeeds with
    // the post's own receipt and the slot is published.
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::minutes(1)));
    x.push_scheduled(Ok(Scheduled::Waiting));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        0
    );
    x.push_scheduled(Ok(Scheduled::Published(PublishReceipt {
        external_id: "post-9".into(),
        url: None,
    })));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        1
    );
    assert_eq!(x.scheduled_calls(), [held_receipt(), held_receipt()]);
    let s = w.uow.snapshot();
    let published: Vec<_> = s
        .studio
        .publications
        .iter()
        .filter(|p| p.slot_id == slot.id)
        .collect();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].external_id, "post-9");
    assert_eq!(slot_state(&w, slot.id), SlotState::Published);
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        0
    );
    assert_eq!(calls(&x, "publish"), 0);
}

#[tokio::test]
async fn a_post_nearer_than_the_platforms_shortest_lead_stays_with_jeeta() {
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "near", "feed_post", WHEN).await;
    // Ten minutes before its time (the platform takes a post fifteen minutes ahead at the
    // least): it is not handed over, and nothing is claimed for it.
    w.d.clock = Arc::new(FixedClock(WHEN - Duration::minutes(10)));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(calls(&x, "schedule"), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
    // Jeeta sends it at its time.
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(slot_state(&w, slot.id), SlotState::Published);
}

#[tokio::test]
async fn a_failed_hand_over_is_a_failed_publication_and_is_not_sent() {
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "refused", "feed_post", WHEN).await;
    x.push_schedule(Err(ConnectorError::permission("the page refused the post")));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 1);
    let a = attempt(&w, slot.id);
    assert_eq!(a.state(), PublishState::Failed);
    assert!(!a.is_held());
    assert_eq!(ledgered(&w, "studio.publish.failure"), 1);
    w.d.clock = Arc::new(FixedClock(WHEN));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!((calls(&x, "schedule"), calls(&x, "publish")), (1, 0));
}

/// Review Focus 3: whatever stops a send takes the held post back; the stop lifted, the content
/// goes out once, through a new time.
#[tokio::test]
async fn a_brake_a_pause_or_the_connections_approval_takes_a_held_post_back() {
    for stop in ["brake", "pause", "approval"] {
        let (mut w, x) = hold_world(true).await;
        let a = agent(&w);
        let (area, slot) = scheduled(&w, stop, "feed_post", WHEN).await;
        hold(&w, &x, slot.id).await;
        // Nothing stops it: nothing is taken back.
        assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
        assert_eq!(calls(&x, "withdraw"), 0);

        match stop {
            "brake" => {
                w.brake(true, None, 0).await;
            }
            "pause" => {
                social::account_pause(
                    &w.d,
                    &w.ctx,
                    input(json!({"capability_id":w.f.slot.capability_id,"paused":true,
                        "expected_revision":0})),
                )
                .await
                .unwrap();
            }
            _ => w.approval(true).await,
        }
        x.push_withdraw(Ok(true));
        assert_eq!(
            publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(),
            1,
            "{stop}"
        );
        let taken: Vec<_> = x
            .calls()
            .into_iter()
            .filter_map(|c| match c {
                ConnectorCall::Withdraw { receipt, .. } => Some(receipt),
                _ => None,
            })
            .collect();
        assert_eq!(taken, [held_receipt()], "{stop}");
        // The attempt ends refused, with why; the slot is cancelled; the version waits again.
        let old = attempt(&w, slot.id);
        assert_eq!(old.state(), PublishState::Refused, "{stop}");
        assert!(
            old.failure_reason()
                .is_some_and(|r| r.starts_with("withdrawn: ")),
            "{stop}: {:?}",
            old.failure_reason()
        );
        assert_eq!(slot_state(&w, slot.id), SlotState::Retired, "{stop}");
        assert_eq!(ledgered(&w, "studio.publish.withdrawn"), 1, "{stop}");
        let waiting = social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap();
        assert!(
            waiting.iter().any(|p| p.project_id == area.id),
            "{stop}: the version waits for a time again"
        );
        // Asked once: the next run has nothing to take back, and nothing goes out at its time.
        assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
        assert_eq!(calls(&x, "withdraw"), 1, "{stop}");
        w.d.clock = Arc::new(FixedClock(WHEN));
        let sent = publish::publish_due(&w.d, w.f.ws).await.unwrap_or(0);
        assert_eq!(sent, 0, "{stop}");
        assert_eq!(calls(&x, "publish"), 0, "{stop}");
        assert!(
            !w.uow
                .snapshot()
                .studio
                .publications
                .iter()
                .any(|p| p.slot_id == slot.id),
            "{stop}"
        );
    }
}

#[tokio::test]
async fn a_withdrawal_the_platform_does_not_confirm_is_never_a_second_send() {
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "unconfirmed", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    w.brake(true, None, 0).await;

    // A passing failure changes nothing: the next run asks again.
    x.push_withdraw(Err(ConnectorError::transient("timeout")));
    assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(attempt(&w, slot.id).is_held());
    // The platform says the post is out already: it is left to be settled as published.
    x.push_withdraw(Ok(false));
    assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
    assert!(attempt(&w, slot.id).is_held());
    // The platform refuses: an unknown outcome, recorded once, for a person; not asked again.
    x.push_withdraw(Err(ConnectorError::permission(
        "this app may not delete posts",
    )));
    assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
    let a = attempt(&w, slot.id);
    assert_eq!(a.state(), PublishState::Unknown);
    assert!(!a.is_held());
    assert!(
        a.failure_reason()
            .is_some_and(|r| r.starts_with("withdraw (studio_braked)")),
        "{:?}",
        a.failure_reason()
    );
    assert_eq!(ledgered(&w, "studio.publish.withdraw_unconfirmed"), 1);
    assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(calls(&x, "withdraw"), 3);
    // Whatever happens next, Jeeta sends nothing for this slot.
    w.brake(false, None, 1).await;
    w.d.clock = Arc::new(FixedClock(WHEN));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(calls(&x, "publish"), 0);
}

#[tokio::test]
async fn a_stop_in_the_last_minutes_comes_too_late_and_the_post_is_recorded_as_it_went() {
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "late", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    w.d.clock = Arc::new(FixedClock(WHEN - WITHDRAW_MARGIN + Duration::seconds(1)));
    w.brake(true, None, 0).await;
    // It is going out: a post that is out is never deleted, so nothing is asked.
    assert_eq!(publish::withdraw_stopped(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(calls(&x, "withdraw"), 0);
    // It went out there; the record says so.
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::minutes(1)));
    x.push_scheduled(Ok(Scheduled::Published(PublishReceipt {
        external_id: "post-9".into(),
        url: None,
    })));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        1
    );
    assert_eq!(slot_state(&w, slot.id), SlotState::Published);
}

#[tokio::test]
async fn a_held_post_the_platform_lost_or_keeps_past_its_time_is_not_called_published() {
    // Gone from the platform: failed, not published.
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "gone", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::minutes(1)));
    x.push_scheduled(Ok(Scheduled::Gone));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        1
    );
    assert_eq!(attempt(&w, slot.id).state(), PublishState::Failed);
    assert!(w.uow.snapshot().studio.publications.is_empty());

    // Still waiting half an hour after its time: unknown, for a person.
    let (mut w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "stuck", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::minutes(29)));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        0
    );
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::minutes(31)));
    assert_eq!(
        publish::recover_publications(&w.d, w.f.ws).await.unwrap(),
        1
    );
    assert_eq!(attempt(&w, slot.id).state(), PublishState::Unknown);
    assert!(w.uow.snapshot().studio.publications.is_empty());
    assert_eq!(calls(&x, "publish"), 0);
}

/// Review Focus 2: "Olmamış" on content whose post waits at its platform takes it back first;
/// if the platform does not confirm, nothing changes and the person is told.
#[tokio::test]
async fn redo_and_cancel_take_a_held_post_back_first_or_change_nothing() {
    let (w, x) = hold_world(true).await;
    let a = agent(&w);
    let (area, slot) = scheduled(&w, "redo", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    let redo = json!({"project_id":area.id,"package_revision":1,"note":"Daha sade olsun"});

    // Its content is not replaced under it either.
    let e = social::version_schedule(
        &w.d,
        &a,
        input(
            json!({"project_id":area.id,"version_id":area.packages[0].versions[0].id,
            "capability_id":w.f.slot.capability_id,"publish_at":"2026-10-25T10:00:00Z",
            "request_key":"redo-again"}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");

    // The platform does not answer: the redo is refused and nothing moved.
    x.push_withdraw(Err(ConnectorError::transient("timeout")));
    let e = content::area_redo(&w.d, &w.ctx, input(redo.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["reason"], "withdraw_unconfirmed");
    assert!(attempt(&w, slot.id).is_held());
    assert_eq!(slot_state(&w, slot.id), SlotState::Ready);
    let unchanged = projects::project_get(
        &w.d,
        &w.ctx,
        projects::ProjectIdInput {
            project_id: area.id,
        },
    )
    .await
    .unwrap()
    .project;
    assert!(unchanged.redo.is_none());
    assert_eq!(unchanged.packages[0].versions[0].slot_id, Some(slot.id));

    // The platform takes it back: the redo goes through, the post is cancelled, nothing waits.
    x.push_withdraw(Ok(true));
    let out = content::area_redo(&w.d, &w.ctx, input(redo))
        .await
        .unwrap()
        .project;
    assert!(out.redo.is_some());
    assert_eq!(out.packages[0].versions[0].slot_id, None);
    assert_eq!(attempt(&w, slot.id).state(), PublishState::Refused);
    assert_eq!(slot_state(&w, slot.id), SlotState::Retired);
    assert_eq!(ledgered(&w, "studio.publish.withdrawn"), 1);

    // Cancelling a held slot does the same.
    let (w, x) = hold_world(true).await;
    let (_, slot) = scheduled(&w, "cancel", "feed_post", WHEN).await;
    hold(&w, &x, slot.id).await;
    let cancel = json!({"slot_id":slot.id,"expected_revision":slot.revision,"reason":"vazgeçtik"});
    x.push_withdraw(Err(ConnectorError::transient("timeout")));
    let e = studio_work::slot_cancel(&w.d, &w.ctx, input(cancel.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "withdraw_unconfirmed");
    assert_eq!(slot_state(&w, slot.id), SlotState::Ready);
    x.push_withdraw(Ok(true));
    studio_work::slot_cancel(&w.d, &w.ctx, input(cancel))
        .await
        .unwrap();
    assert_eq!(slot_state(&w, slot.id), SlotState::Retired);
    assert_eq!(attempt(&w, slot.id).state(), PublishState::Refused);
    assert_eq!(calls(&x, "publish"), 0);
}

/// A hand-over that never learnt whether the platform took the post: once its slot no longer
/// goes out, Jeeta finds its own post at the platform by what it sent and takes it back; no
/// other post there is touched.
#[tokio::test]
async fn an_unknown_hand_over_is_looked_up_at_the_platform_and_taken_back_once_its_slot_is_cancelled()
 {
    use jt_app::ports::connectors::PlatformScheduled;
    use jt_app::usecases::studio::work::{CancelSlotInput, slot_cancel};
    let (w, x) = hold_world(true).await;
    let a = agent(&w);
    let (_, slot) = scheduled(&w, "unknown", "feed_post", WHEN).await;
    x.push_schedule(Err(ConnectorError::unknown(
        "accepted response lacks post id",
    )));
    assert_eq!(publish::hold_ahead(&w.d, w.f.ws).await.unwrap(), 1);
    let attempt_of = attempt(&w, slot.id);
    assert_eq!(attempt_of.state(), PublishState::Unknown);
    assert_eq!(attempt_of.held_until(), Some(WHEN));
    let sent = attempt_of.piece().text.clone();
    let at_platform = |id: &str, at: OffsetDateTime, text: &str| PlatformScheduled {
        external_id: id.into(),
        publish_at: at,
        text: text.into(),
    };
    let listed = || {
        Ok(Some(vec![
            at_platform("other-time", WHEN + Duration::hours(1), &sent),
            at_platform("other-text", WHEN, "Elle zamanlanmış başka bir gönderi"),
            at_platform("ours", WHEN, &format!("{sent}\n")),
        ]))
    };

    // While the slot still stands nothing is looked up: its outcome is a person's to look at.
    assert_eq!(
        publish::reconcile_unknown_hand_overs(&w.d, w.f.ws)
            .await
            .unwrap(),
        0
    );
    // Cancelled: the post is looked up and only the exact match is taken back.
    slot_cancel(
        &w.d,
        &a,
        CancelSlotInput {
            slot_id: slot.id,
            expected_revision: slot.revision,
            reason: "not this one".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(slot_state(&w, slot.id), SlotState::Retired);
    x.push_scheduled_list(listed());
    x.push_withdraw(Ok(true));
    assert_eq!(
        publish::reconcile_unknown_hand_overs(&w.d, w.f.ws)
            .await
            .unwrap(),
        1
    );
    let taken: Vec<_> = x
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::Withdraw { receipt, .. } => Some(receipt.external_id),
            _ => None,
        })
        .collect();
    assert_eq!(taken, ["ours"]);
    assert_eq!(ledgered(&w, "studio.publish.withdrawn"), 1);

    // Gone from the platform: nothing more to do. Two posts that both match are not ours to
    // choose between, and a platform that cannot be read is asked again next time.
    x.push_scheduled_list(Ok(Some(vec![at_platform(
        "other-text",
        WHEN,
        "Elle zamanlanmış başka bir gönderi",
    )])));
    x.push_scheduled_list(Ok(Some(vec![
        at_platform("twin-1", WHEN, &sent),
        at_platform("twin-2", WHEN, &sent),
    ])));
    x.push_scheduled_list(Err(ConnectorError::transient("down")));
    for _ in 0..3 {
        assert_eq!(
            publish::reconcile_unknown_hand_overs(&w.d, w.f.ws)
                .await
                .unwrap(),
            0
        );
    }
    assert_eq!(calls(&x, "withdraw"), 1);
}
