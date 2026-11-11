//! A finished content package goes out without a person (design 2026-11-10 §7.2): its versions
//! wait for a time, the social agent gives each one an account and a time through one use case,
//! and the unchanged posting engine plans, checks and publishes it.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{UnitOfWork, connectors::PublishReceipt, files::StoredFile, production_projects::*},
    usecases::{
        content, social,
        studio::{projects, publish},
        work::{self, WorkKind},
    },
};
use jt_connector::Provider;
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{AgentConnectionId, Permission, UserId};
use jt_testkit::fakes::{
    FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{OffsetDateTime, macros::datetime};
use uuid::Uuid;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// The Studio world with a real file store, an empty library, and its X account's scripted
/// provider.
async fn social_world() -> (World, Arc<ScriptedConnector>) {
    let mut w = world().await;
    let x = Arc::new(ScriptedConnector::new(Provider::X));
    w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(w.ads.clone())
            .with_connector(x.clone()),
    );
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    (w, x)
}

fn sent() -> PublishReceipt {
    PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }
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

/// A shareable, publishable image with its bytes stored: of a confirmed workshop on FIXED_NOW's
/// day when `of_olay`, else genel and freed by a person.
async fn material(w: &World, of_olay: bool) -> Material {
    // A PNG signature, then bytes of its own: one file is one material.
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
    let mut m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    if !of_olay {
        m.binding = Binding::Genel;
        m.freed = Some(HumanMark {
            by: UserId::new_v7(),
            at: FIXED_NOW,
        });
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    if of_olay {
        r.studio_materials().insert_olay(olay).await.unwrap();
    }
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

fn version(w: &World, m: &Material, patch: Value) -> Value {
    let mut v = json!({"format":"feed_post","text":"Yeni sezon başlıyor","tags":["seramik"],
        "material_ids":[m.id],"hypothesis_id":w.f.slot.chain.hypothesis_id});
    v.as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    v
}

/// An area a person opened and an agent finished with `versions`.
async fn finished(
    w: &World,
    key: &str,
    materials: &[&Material],
    versions: Vec<Value>,
) -> ProductionProject {
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"brief":"Yeni sezonu duyur",
            "material_ids":materials.iter().map(|m| m.id).collect::<Vec<_>>()})),
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
    content::area_deliver(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":format!("{key}-delivery"),
            "summary":"Hazır","versions":versions})),
    )
    .await
    .unwrap()
    .project
}

const WHEN: OffsetDateTime = datetime!(2026-10-24 10:00 UTC);

fn schedule_input(
    p: &ProductionProject,
    version: usize,
    w: &World,
    at: OffsetDateTime,
    key: &str,
) -> Value {
    json!({"project_id":p.id,"version_id":p.packages.last().unwrap().versions[version].id,
        "capability_id":w.f.slot.capability_id,
        "publish_at":at.format(&time::format_description::well_known::Rfc3339).unwrap(),
        "request_key":key})
}

#[tokio::test]
async fn a_finished_version_waits_is_scheduled_ready_and_goes_out_through_the_publisher() {
    let (mut w, x) = social_world().await;
    let m = material(&w, true).await;
    let p = finished(&w, "launch", &[&m], vec![version(&w, &m, json!({}))]).await;
    let a = agent(&w);

    // It waits for a time, with the account that can take it, and is the agent's work.
    let waiting = social::versions_waiting(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].project_id, p.id);
    assert_eq!(waiting[0].goal, "Yeni sezonu duyur");
    let v = &waiting[0].versions[0];
    assert_eq!(v.version_id, p.packages[0].versions[0].id);
    assert_eq!(v.accounts, [w.f.slot.capability_id]);
    let items = work::pending(&w.d, &a).await.unwrap().items;
    let item = items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::SocialSchedule { .. }))
        .expect("the waiting version is the agent's work");
    assert!(
        matches!(item.kind, WorkKind::SocialSchedule { project_id, version_id }
        if project_id == p.id && version_id == v.version_id)
    );
    assert!(item.hint.contains("jeeta.social.version_schedule"));
    // A person has nothing to do about it.
    assert!(
        !work::pending(&w.d, &w.ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::SocialSchedule { .. }))
    );

    // One call plans the post and makes its slot ready with the version as its piece.
    let out = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "time-1")))
        .await
        .unwrap();
    let slot = out.publication.slot.clone();
    assert_eq!(slot.state, SlotState::Ready);
    assert_eq!(out.publication.post.publish_at, WHEN);
    assert_eq!(out.publication.post.format, PostFormat::FeedPost);
    assert_eq!(out.project.packages[0].versions[0].slot_id, Some(slot.id));
    let s = w.uow.snapshot();
    let piece = s
        .studio
        .pieces
        .iter()
        .find(|(id, _)| *id == slot.id)
        .map(|(_, p)| p.clone())
        .expect("the version is the slot's piece");
    assert_eq!(piece.text, "Yeni sezon başlıyor\n\n#seramik");
    assert_eq!(piece.media, [MediaAsset::File { id: m.file_id }]);
    // Nothing waits any more: no work, no waiting package.
    assert!(
        social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        !work::pending(&w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::SocialSchedule { .. }))
    );

    // The same call replays; another call for the same version is refused. One post, ever.
    let again =
        social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "time-1")))
            .await
            .unwrap();
    assert_eq!(again.publication.slot.id, slot.id);
    let e = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "time-2")))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "version_already_scheduled");
    assert_eq!(
        w.uow
            .snapshot()
            .posts
            .posts
            .iter()
            .filter(|x| x.package_request_id == out.publication.post.package_request_id)
            .count(),
        1
    );

    // Nobody approves: at its time the unchanged publisher sends it.
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let s = w.uow.snapshot();
    assert!(s.studio.publications.iter().any(|x| x.slot_id == slot.id));
}

#[tokio::test]
async fn the_engines_limits_refuse_a_time_and_store_nothing() {
    let (w, _) = social_world().await;
    let m = material(&w, true).await;
    let p = finished(&w, "limits", &[&m], vec![version(&w, &m, json!({}))]).await;
    let a = agent(&w);
    let before = w.uow.snapshot();
    // Quiet hours (Istanbul night), and beyond the planning horizon.
    for at in [
        datetime!(2026-10-24 23:00 UTC),
        datetime!(2027-06-01 10:00 UTC),
    ] {
        let e = social::version_schedule(
            &w.d,
            &a,
            input(schedule_input(&p, 0, &w, at, &format!("limit-{at}"))),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
        assert_eq!(e.details["reason"], "package_refused", "{e:?}");
    }
    let after = w.uow.snapshot();
    assert_eq!(after.posts.posts.len(), before.posts.posts.len());
    assert_eq!(after.posts.requests.len(), before.posts.requests.len());
    assert_eq!(after.studio.slots.len(), before.studio.slots.len());
    let area = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap()
        .project;
    assert_eq!(area.packages[0].versions[0].slot_id, None);
    // The version still waits, and a time inside the limits is taken.
    assert_eq!(
        social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap()
            .len(),
        1
    );
    social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "ok")))
        .await
        .unwrap();
}

#[tokio::test]
async fn what_may_not_be_scheduled_is_refused_with_its_reason() {
    let (w, _) = social_world().await;
    let m = material(&w, true).await;
    let other = Uuid::now_v7();
    let p = finished(
        &w,
        "refusals",
        &[&m],
        vec![
            version(&w, &m, json!({})),
            version(&w, &m, json!({"capability_id":w.f.slot.capability_id})),
        ],
    )
    .await;
    let a = agent(&w);
    // Working permission of the module, and an agent or a person alike.
    let mut stranger = a.clone();
    stranger.permissions.remove(&Permission::SocialWork);
    assert_eq!(
        social::version_schedule(
            &w.d,
            &stranger,
            input(schedule_input(&p, 0, &w, WHEN, "no"))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
    // A version made for one account goes out on no other.
    let mut wrong = schedule_input(&p, 1, &w, WHEN, "wrong");
    wrong["capability_id"] = json!(other);
    let e = social::version_schedule(&w.d, &a, input(wrong))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "version_made_for_another_account");
    // An unknown version.
    let mut unknown = schedule_input(&p, 0, &w, WHEN, "unknown");
    unknown["version_id"] = json!(other);
    assert_eq!(
        social::version_schedule(&w.d, &a, input(unknown))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    // "Olmamış": what is there is not what should go out, and it no longer waits.
    content::area_redo(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"package_revision":1,"note":"Daha sade"})),
    )
    .await
    .unwrap();
    let e = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "redo")))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "area_redo_open");
    assert!(
        social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap()
            .is_empty()
    );
}

/// Design B45: a package a person accepted although the text check held it goes out; the
/// person's word travels with the version to the publisher's own check.
#[tokio::test]
async fn a_released_packages_version_is_not_held_again_at_publishing() {
    let (mut w, x) = social_world().await;
    let m = material(&w, true).await;
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"released","brief":"Atölyeyi anlat","material_ids":[m.id]})),
    )
    .await
    .unwrap();
    let a = agent(&w);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    // The material's olay is one day; the text states another date: held three times.
    for n in 1..=3 {
        let e = content::area_deliver(
            &w.d,
            &a,
            input(json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":format!("held-{n}"),
                "summary":"Hazır","versions":[version(&w, &m, json!({"text":"03.01.2020 tarihinde atölyedeydik"}))]})),
        )
        .await
        .unwrap_err();
        assert_eq!(
            e.details["versions"][0]["findings"][0]["code"],
            "date_outside_olay"
        );
    }
    let held = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap()
        .project;
    let accepted = content::delivery_accept(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":held.revision})),
    )
    .await
    .unwrap()
    .project;
    let out = social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(&accepted, 0, &w, WHEN, "released")),
    )
    .await
    .unwrap();
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let release = w
        .uow
        .snapshot()
        .materials
        .releases
        .iter()
        .find(|(_, x)| x.slot_id == out.publication.slot.id)
        .map(|(_, x)| x.clone())
        .expect("the person's acceptance is the slot's release");
    assert_eq!(release.by, user_id);
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
}

/// Design B7: "Olmamış" takes back what has not gone out; what went out stays.
#[tokio::test]
async fn a_redo_cancels_the_planned_posts_that_have_not_gone_out_and_keeps_the_published() {
    let (mut w, x) = social_world().await;
    let m = material(&w, true).await;
    let other = material(&w, true).await;
    let p = finished(
        &w,
        "redo",
        &[&m, &other],
        vec![
            version(&w, &m, json!({})),
            version(&w, &other, json!({"text":"İkinci gönderi"})),
        ],
    )
    .await;
    let a = agent(&w);
    let first = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "first")))
        .await
        .unwrap();
    let later = datetime!(2026-10-26 10:00 UTC);
    let second =
        social::version_schedule(&w.d, &a, input(schedule_input(&p, 1, &w, later, "second")))
            .await
            .unwrap();
    // The first goes out; the second is still planned when the person says "Olmamış".
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let mut person = w.ctx.clone();
    person.now = WHEN;
    let redo = content::area_redo(
        &w.d,
        &person,
        input(json!({"project_id":p.id,"package_revision":1,"note":"Daha sade"})),
    )
    .await
    .unwrap()
    .project;
    let versions = &redo.packages[0].versions;
    assert_eq!(versions[0].slot_id, Some(first.publication.slot.id));
    assert_eq!(versions[1].slot_id, None);
    let s = w.uow.snapshot();
    let state = |id| s.studio.slots.iter().find(|x| x.id == id).unwrap().state;
    assert_eq!(state(first.publication.slot.id), SlotState::Published);
    assert_eq!(state(second.publication.slot.id), SlotState::Retired);
    let post = s
        .posts
        .posts
        .iter()
        .find(|x| x.slot_id == second.publication.slot.id)
        .unwrap();
    assert_eq!(
        post.retired.as_ref().unwrap().reason,
        RetirementReason::Cancelled
    );
    // Nothing more goes out for this package, at any later time.
    w.d.clock = Arc::new(FixedClock(later));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
}

/// Sets how many organic posts a week the hypothesis asks for in the strategy in force.
async fn organic_slots(w: &World, hypothesis: jt_strategy::HypothesisId, slots: u16) {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut h = r
        .hypotheses()
        .list(w.current)
        .await
        .unwrap()
        .into_iter()
        .find(|h| h.id == hypothesis)
        .unwrap();
    h.cadence
        .get_mut(&jt_strategy::LaneKind::Organic)
        .unwrap()
        .slots_per_week = slots;
    r.hypotheses().upsert(w.current, h).await.unwrap();
    r.commit().await.unwrap();
}

/// Design 2026-11-10 B53: a finished version always has a way out, or says what is in its way.
#[tokio::test]
async fn a_label_the_strategy_does_not_know_still_goes_out_and_a_blocked_version_says_why() {
    let (w, _) = social_world().await;
    let a = agent(&w);
    let account = w.f.slot.capability_id;

    // The agent that made the content labelled its version with a type the strategy does not
    // name. The post is planned all the same, under the hypothesis's own type ("text" here).
    let m = material(&w, true).await;
    let labelled = finished(
        &w,
        "label",
        &[&m],
        vec![version(&w, &m, json!({"content_type":"duyuru"}))],
    )
    .await;
    let out = social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(&labelled, 0, &w, WHEN, "label-1")),
    )
    .await
    .unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(out.publication.slot.state, SlotState::Ready);
    let arm = out.publication.slot.chain.arm_id;
    let s = w.uow.snapshot();
    let arm = s.studio.arms.iter().find(|x| x.id == arm).expect("the arm");
    assert_eq!(arm.key.content_type, "text");

    // A version nothing can take says why, to the agent and to the person alike.
    let m = material(&w, true).await;
    finished(&w, "blocked", &[&m], vec![version(&w, &m, json!({}))]).await;
    let blocked = || async {
        let waiting = social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap();
        let v = &waiting[0].versions[0];
        (v.accounts.clone(), v.blocked)
    };
    assert_eq!(blocked().await, (vec![account], None));

    // A person paused the account.
    let pause = |paused: bool, revision: u64| json!({"capability_id":account,"paused":paused,"expected_revision":revision});
    let settings = social::account_pause(&w.d, &w.ctx, input(pause(true, 0)))
        .await
        .unwrap();
    assert_eq!(blocked().await, (vec![], Some("account_paused")));
    social::account_pause(&w.d, &w.ctx, input(pause(false, settings.revision)))
        .await
        .unwrap();

    // The hypothesis does not post: it names an organic cadence of nothing.
    let hypothesis = w.f.slot.chain.hypothesis_id;
    organic_slots(&w, hypothesis, 0).await;
    assert_eq!(blocked().await, (vec![], Some("hypothesis_does_not_post")));
    assert!(
        !work::pending(&w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::SocialSchedule { .. })),
        "a version nothing can take is nobody's work"
    );
    organic_slots(&w, hypothesis, 7).await;

    // The account is not connected any more.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r.capabilities().find(account).await.unwrap().unwrap();
    c.status = jt_capability::StoredStatus::Declared;
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(blocked().await, (vec![], Some("no_connected_account")));
}
