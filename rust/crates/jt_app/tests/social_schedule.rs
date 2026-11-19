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

/// The social page asks for a revision from a post: `studio.slot_get` names the post's content,
/// its package and what a redo does to each of its posts, to a reader of the production line
/// only; the redo names the posts it took back, and a note written again keeps them.
#[tokio::test]
async fn a_posts_content_shows_with_its_slot_to_a_content_reader_only() {
    let (mut w, x) = social_world().await;
    let m = material(&w, true).await;
    let other = material(&w, true).await;
    let p = finished(
        &w,
        "content-of-slot",
        &[&m, &other],
        vec![
            version(&w, &m, json!({})),
            version(&w, &other, json!({"text":"İkinci gönderi"})),
        ],
    )
    .await;
    let a = agent(&w);
    let first = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "c1")))
        .await
        .unwrap()
        .publication
        .slot;
    let later = datetime!(2026-10-26 10:00 UTC);
    let second = social::version_schedule(&w.d, &a, input(schedule_input(&p, 1, &w, later, "c2")))
        .await
        .unwrap()
        .publication
        .slot;
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let mut person = w.ctx.clone();
    person.now = WHEN;

    // The owner reads the content with the post: the area, its package, and both its posts.
    let out = jt_app::usecases::studio::work::slot_get(&w.d, &person, second.id)
        .await
        .unwrap();
    let c = out
        .content
        .expect("a content reader sees the post's content");
    assert_eq!(c.project_id, p.id);
    assert_eq!(c.title, p.title);
    assert_eq!(c.package_revision, Some(1));
    assert!(c.current);
    assert_eq!(c.redo, None);
    assert_eq!(c.posts.len(), 2);
    assert_eq!(c.posts[0].slot_id, first.id);
    assert!(c.posts[0].published);
    assert!(!c.posts[0].withdrawn_by_redo);
    assert_eq!(c.posts[1].slot_id, second.id);
    assert_eq!(c.posts[1].format, PostFormat::FeedPost);
    assert_eq!(c.posts[1].capability_id, w.f.slot.capability_id);
    assert!(c.posts[1].account_name.is_some());
    assert_eq!(c.posts[1].scheduled_at, later);
    assert!(!c.posts[1].published);
    assert!(c.posts[1].withdrawn_by_redo);
    // The answer is the same JSON for the panel and the agent, the time in RFC 3339.
    let json = serde_json::to_value(
        jt_app::usecases::studio::work::slot_get(&w.d, &person, second.id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(json["content"]["project_id"], json!(p.id));
    assert_eq!(
        json["content"]["posts"][1]["withdrawn_by_redo"],
        json!(true)
    );
    assert!(json["content"]["posts"][1]["scheduled_at"].is_string());

    // A session that may not read the production line sees the post without its content.
    let mut social_only = person.clone();
    social_only.permissions.remove(&Permission::ContentWork);
    social_only.permissions.remove(&Permission::ContentManage);
    let out = jt_app::usecases::studio::work::slot_get(&w.d, &social_only, second.id)
        .await
        .unwrap();
    assert!(out.content.is_none());
    assert!(serde_json::to_value(&out).unwrap().get("content").is_none());
    // A content worker reads it.
    let mut worker = social_only.clone();
    worker.permissions.insert(Permission::ContentWork);
    assert!(
        jt_app::usecases::studio::work::slot_get(&w.d, &worker, second.id)
            .await
            .unwrap()
            .content
            .is_some()
    );
    // A post of no content has none.
    assert!(
        jt_app::usecases::studio::work::slot_get(&w.d, &person, w.f.slot.id)
            .await
            .unwrap()
            .content
            .is_none()
    );

    // The redo takes back the planned one and names it; the published one stays.
    let redo = content::area_redo(
        &w.d,
        &person,
        input(json!({"project_id":p.id,"package_revision":c.package_revision,"note":"Daha sade"})),
    )
    .await
    .unwrap()
    .project
    .redo
    .expect("the redo stands");
    assert_eq!(redo.withdrawn, [second.id]);
    // The post taken back still names its content, no longer of its package.
    let back = jt_app::usecases::studio::work::slot_get(&w.d, &person, second.id)
        .await
        .unwrap()
        .content
        .expect("the post's content");
    assert!(!back.current);
    assert_eq!(
        back.redo.as_ref().map(|r| r.note.as_str()),
        Some("Daha sade")
    );
    assert_eq!(
        back.posts.iter().map(|x| x.slot_id).collect::<Vec<_>>(),
        [first.id]
    );
    // A note written again keeps what the first one took back.
    let again = content::area_redo(
        &w.d,
        &person,
        input(json!({"project_id":p.id,"package_revision":1,"note":"Daha da sade"})),
    )
    .await
    .unwrap()
    .project
    .redo
    .unwrap();
    assert_eq!(again.note, "Daha da sade");
    assert_eq!(again.withdrawn, [second.id]);
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

#[tokio::test]
async fn an_agent_that_cancels_a_planned_version_gives_it_another_time_and_a_persons_cancel_ends_it()
 {
    use jt_app::usecases::studio::work::{CancelSlotInput, slot_cancel};
    let (w, _) = social_world().await;
    let m = material(&w, true).await;
    let p = finished(&w, "move", &[&m], vec![version(&w, &m, json!({}))]).await;
    let a = agent(&w);
    let first = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "t-1")))
        .await
        .unwrap()
        .publication
        .slot;

    // The agent has no other way to move a planned post: it cancels it before anything was
    // sent, and the version waits for a time again.
    slot_cancel(
        &w.d,
        &a,
        CancelSlotInput {
            slot_id: first.id,
            expected_revision: first.revision,
            reason: "another time".into(),
        },
    )
    .await
    .unwrap();
    let waiting = social::versions_waiting(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert_eq!(waiting.len(), 1, "the version waits again");
    assert_eq!(
        waiting[0].versions[0].version_id,
        p.packages[0].versions[0].id
    );
    let later = WHEN + time::Duration::hours(4);
    let second = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, later, "t-2")))
        .await
        .unwrap()
        .publication;
    assert_ne!(second.slot.id, first.id);
    assert_eq!(second.slot.state, SlotState::Ready);
    assert_eq!(second.post.publish_at, later);

    // A person who cancels it decided it does not go out: it is not offered again.
    slot_cancel(
        &w.d,
        &w.ctx,
        CancelSlotInput {
            slot_id: second.slot.id,
            expected_revision: second.slot.revision,
            reason: "not this one".into(),
        },
    )
    .await
    .unwrap();
    assert!(
        social::versions_waiting(&w.d, &a, input(json!({})))
            .await
            .unwrap()
            .is_empty()
    );
    let e = social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(
            &p,
            0,
            &w,
            later + time::Duration::hours(4),
            "t-3",
        )),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "version_already_scheduled");
}

/// The production line's row of area `p` (`content.areas`).
async fn line_row(w: &World, p: &ProductionProject) -> content::views::AreaRow {
    content::areas(&w.d, &w.ctx, projects::ProjectQuery::default())
        .await
        .unwrap()
        .areas
        .into_iter()
        .find(|r| r.area.id == p.id)
        .expect("the area is on the production line")
}

fn stage(
    row: &content::views::AreaRow,
    key: content::pipeline::StageKey,
) -> content::pipeline::Stage {
    row.pipeline.stage(key).unwrap().clone()
}

/// The slot `id` as stored now.
fn slot_now(w: &World, id: SlotId) -> Slot {
    w.uow
        .snapshot()
        .studio
        .slots
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
}

/// Review fix 5: a post that went out stays in the pipeline, with its results and counted as
/// published, while a redo stands and after the next package.
#[tokio::test]
async fn a_published_post_stays_on_the_line_through_a_redo_and_the_next_package() {
    use content::pipeline::{StageKey, StageState};
    let (mut w, x) = social_world().await;
    let m = material(&w, true).await;
    let other = material(&w, true).await;
    let p = finished(
        &w,
        "kept",
        &[&m, &other],
        vec![
            version(&w, &m, json!({})),
            version(&w, &other, json!({"text":"İkinci gönderi"})),
        ],
    )
    .await;
    let a = agent(&w);
    let first = social::version_schedule(&w.d, &a, input(schedule_input(&p, 0, &w, WHEN, "k1")))
        .await
        .unwrap();
    let later = datetime!(2026-10-26 10:00 UTC);
    social::version_schedule(&w.d, &a, input(schedule_input(&p, 1, &w, later, "k2")))
        .await
        .unwrap();
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    let mut person = w.ctx.clone();
    person.now = WHEN;
    content::area_redo(
        &w.d,
        &person,
        input(json!({"project_id":p.id,"package_revision":1,"note":"Daha sade"})),
    )
    .await
    .unwrap();
    // The redo stands: the area is not finished, but what went out is still there.
    let check = |row: &content::views::AreaRow, onay: StageState| {
        assert!(row.pipeline.published());
        let yayin = stage(row, StageKey::Yayin);
        let out: Vec<_> = yayin
            .publications
            .iter()
            .filter(|f| f.published_at.is_some())
            .collect();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].slot_id, first.publication.slot.id);
        assert_ne!(yayin.state, StageState::Todo);
        assert_ne!(yayin.state, StageState::Problem);
        assert_eq!(stage(row, StageKey::Onay).state, onay);
        assert_eq!(stage(row, StageKey::Sonuc).state, StageState::Current);
    };
    let row = line_row(&w, &p).await;
    check(&row, StageState::Done);
    assert!(row.pipeline.unscheduled.is_empty());
    assert!(!row.pipeline.has_problem());
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    assert_eq!(tree.genel.published, 1);
    // The agent delivers the next package: the published post of the first one stays.
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":line_row(&w, &p).await.area.revision})),
    )
    .await
    .unwrap();
    content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":"kept-2",
            "summary":"Yeniden","versions":[version(&w, &m, json!({"text":"Daha sade"}))]}),
        ),
    )
    .await
    .unwrap();
    let row = line_row(&w, &p).await;
    assert_eq!(
        row.pipeline
            .stage(StageKey::Paket)
            .unwrap()
            .package
            .as_ref()
            .unwrap()
            .revision,
        2
    );
    // The new package's version has no time yet: Onay says so, the published post stays.
    check(&row, StageState::Current);
    assert_eq!(row.pipeline.unscheduled.len(), 1);
    assert!(row.pipeline.awaits_time());
    assert_eq!(
        content::tree(&w.d, &w.ctx).await.unwrap().genel.published,
        1
    );
}

/// Review fix 5: a person's cancellation is not a problem; a post whose one attempt failed is;
/// one whose outcome is still unknown is not (it is being asked about).
#[tokio::test]
async fn a_cancelled_post_is_no_problem_and_a_failed_one_is() {
    use content::pipeline::{StageKey, StageState};
    use jt_app::usecases::studio::work::{CancelSlotInput, slot_cancel};
    use jt_connector::ConnectorError;
    let (mut w, x) = social_world().await;
    let a = agent(&w);
    let m = material(&w, true).await;
    let cancelled = finished(&w, "cancelled", &[&m], vec![version(&w, &m, json!({}))]).await;
    let slot = social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(&cancelled, 0, &w, WHEN, "c1")),
    )
    .await
    .unwrap()
    .publication
    .slot;
    slot_cancel(
        &w.d,
        &w.ctx,
        CancelSlotInput {
            slot_id: slot.id,
            expected_revision: slot.revision,
            reason: "not this one".into(),
        },
    )
    .await
    .unwrap();
    let row = line_row(&w, &cancelled).await;
    let yayin = stage(&row, StageKey::Yayin);
    assert_eq!(
        yayin.publications[0].retirement,
        Some(RetirementReason::Cancelled)
    );
    assert!(!yayin.publications[0].failed);
    assert_ne!(yayin.state, StageState::Problem);
    assert!(!row.pipeline.has_problem());
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    assert_eq!(tree.waiting.problem_contents, 0);

    // Its one attempt failed: a problem, for good (a planned post is never sent twice).
    let failing = finished(&w, "failing", &[&m], vec![version(&w, &m, json!({}))]).await;
    let day = WHEN + time::Duration::days(1);
    let failed =
        social::version_schedule(&w.d, &a, input(schedule_input(&failing, 0, &w, day, "f1")))
            .await
            .unwrap()
            .publication
            .slot;
    w.d.clock = Arc::new(FixedClock(day));
    x.push_publish(Err(ConnectorError::permanent("refused by the platform")));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    let row = line_row(&w, &failing).await;
    let yayin = stage(&row, StageKey::Yayin);
    assert!(yayin.publications[0].failed);
    assert_eq!(yayin.state, StageState::Problem);
    assert!(row.pipeline.has_problem());
    assert_eq!(
        content::tree(&w.d, &w.ctx)
            .await
            .unwrap()
            .waiting
            .problem_contents,
        1
    );

    // The outcome is unknown: still asked about, not a problem.
    let unsure = finished(&w, "unsure", &[&m], vec![version(&w, &m, json!({}))]).await;
    let next = WHEN + time::Duration::days(2);
    social::version_schedule(&w.d, &a, input(schedule_input(&unsure, 0, &w, next, "u1")))
        .await
        .unwrap();
    w.d.clock = Arc::new(FixedClock(next));
    x.push_publish(Err(ConnectorError::unknown("response lost")));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    let row = line_row(&w, &unsure).await;
    let yayin = stage(&row, StageKey::Yayin);
    assert!(!yayin.publications[0].failed);
    assert_eq!(yayin.state, StageState::Current);

    // A person cancels the failed post: a decision, not a problem any more.
    let failed = slot_now(&w, failed.id);
    slot_cancel(
        &w.d,
        &w.ctx,
        CancelSlotInput {
            slot_id: failed.id,
            expected_revision: failed.revision,
            reason: "leave it".into(),
        },
    )
    .await
    .unwrap();
    let row = line_row(&w, &failing).await;
    assert!(!row.pipeline.has_problem());
    assert_eq!(
        content::tree(&w.d, &w.ctx)
            .await
            .unwrap()
            .waiting
            .problem_contents,
        0
    );
}

/// Review fix 4: the tree counts a folder the way its list shows it.
#[tokio::test]
async fn the_trees_numbers_agree_with_the_lists_of_the_same_folder() {
    use content::views::WaitReason;
    use jt_connector::ConnectorError;
    let (mut w, x) = social_world().await;
    let a = agent(&w);
    let m = material(&w, true).await;
    let olay = m.olay_id().unwrap();
    let in_olay = |key: &'static str| {
        let (w, a, m) = (&w, &a, &m);
        async move {
            let p = projects::project_create(
                &w.d,
                &w.ctx,
                input(json!({"request_key":key,"brief":"Atölyeden bir gün",
                    "material_ids":[m.id],"olay_id":olay})),
            )
            .await
            .unwrap();
            let c = content::area_claim(
                &w.d,
                a,
                input(json!({"project_id":p.id,"expected_revision":p.revision})),
            )
            .await
            .unwrap();
            (p, c.claim_token)
        }
    };
    let deliver = |p: ProductionProject, token: String, key: &'static str| {
        let (w, a, m) = (&w, &a, &m);
        async move {
            content::area_deliver(
                &w.d,
                a,
                input(
                    json!({"project_id":p.id,"claim_token":token,"request_key":key,
                    "summary":"Hazır","versions":[version(w, m, json!({}))]}),
                ),
            )
            .await
            .unwrap()
            .project
        }
    };
    // One published, one failed, one finished with no time yet, one waiting for a capture.
    let (p, t) = in_olay("published").await;
    let published = deliver(p, t, "published-d").await;
    let (p, t) = in_olay("failed").await;
    let failed = deliver(p, t, "failed-d").await;
    let (p, t) = in_olay("waiting").await;
    deliver(p, t, "waiting-d").await;
    let (p, t) = in_olay("asking").await;
    let p = content::area_progress(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":t,"step":9,"note":"Yakın plan lazım"})),
    )
    .await
    .unwrap()
    .project;
    projects::project_request(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"shot",
            "text":"Yakın plan"}),
        ),
    )
    .await
    .unwrap();
    social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(&published, 0, &w, WHEN, "t1")),
    )
    .await
    .unwrap();
    let day = WHEN + time::Duration::days(1);
    social::version_schedule(&w.d, &a, input(schedule_input(&failed, 0, &w, day, "t2")))
        .await
        .unwrap();
    w.d.clock = Arc::new(FixedClock(WHEN));
    x.push_publish(Ok(sent()));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    w.d.clock = Arc::new(FixedClock(day));
    x.push_publish(Err(ConnectorError::permanent("refused")));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();

    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    let mut all = Vec::new();
    for (folder, filter) in [
        (
            tree.olays
                .iter()
                .find(|o| o.olay.id() == olay)
                .unwrap()
                .folder
                .clone(),
            json!(olay),
        ),
        (tree.genel.clone(), json!("genel")),
    ] {
        let q: projects::ProjectQuery = input(json!({ "olay_id": filter }));
        let rows = content::areas(&w.d, &w.ctx, q).await.unwrap().areas;
        assert_eq!(folder.areas as usize, rows.len());
        assert_eq!(
            folder.published as usize,
            rows.iter().filter(|r| r.pipeline.published()).count()
        );
        let area_waits = |reason: WaitReason, holds: bool| {
            assert_eq!(folder.waits.contains(&reason), holds, "{reason:?}");
        };
        area_waits(
            WaitReason::MaterialRequest,
            rows.iter().any(|r| r.area.open_requests > 0),
        );
        area_waits(
            WaitReason::ContentApproval,
            rows.iter().any(|r| r.pipeline.awaits_approval()),
        );
        area_waits(
            WaitReason::ContentProblem,
            rows.iter().any(|r| r.pipeline.has_problem()),
        );
        area_waits(
            WaitReason::ContentTime,
            rows.iter().any(|r| r.pipeline.awaits_time()),
        );
        all.extend(rows);
    }
    assert_eq!(tree.areas as usize, all.len());
    assert_eq!(
        tree.waiting.problem_contents as usize,
        all.iter().filter(|r| r.pipeline.has_problem()).count()
    );
    assert_eq!(
        tree.waiting.content_approvals as usize,
        all.iter()
            .flat_map(|r| r.pipeline.stage(content::pipeline::StageKey::Onay))
            .flat_map(|s| s.approvals.iter())
            .filter(|f| f.waiting)
            .count()
    );
    assert_eq!(
        tree.waiting.content_times as usize,
        all.iter().filter(|r| r.pipeline.awaits_time()).count()
    );
    // The olay's flow counts the same contents its list shows.
    let view = content::olay_view(&w.d, &w.ctx, input(json!({ "olay_id": olay })))
        .await
        .unwrap();
    let contents = view.contents.unwrap();
    assert_eq!(
        view.flow.awaiting_time as usize,
        contents.iter().filter(|r| r.pipeline.awaits_time()).count()
    );
    assert_eq!(
        view.flow.problems as usize,
        contents.iter().filter(|r| r.pipeline.has_problem()).count()
    );
    // What this world holds, so the agreement is not vacuous.
    let node = &tree
        .olays
        .iter()
        .find(|o| o.olay.id() == olay)
        .unwrap()
        .folder;
    assert_eq!(node.areas, 4);
    assert_eq!(node.published, 1);
    assert!(node.waits.contains(&WaitReason::MaterialRequest));
    assert!(node.waits.contains(&WaitReason::ContentProblem));
    assert!(node.waits.contains(&WaitReason::ContentTime));
    assert_eq!(tree.waiting.content_times, 1);
    assert_eq!(view.flow.awaiting_time, 1);
}

/// A finished package whose versions have no time yet says so: Onay is current with the
/// versions that wait, the content is counted as waiting for a time (the agent gives it on its
/// next run, or a person does), and a version no account can take is a problem with its reason.
#[tokio::test]
async fn a_finished_package_with_no_time_says_so_and_a_blocked_version_is_a_problem() {
    use content::pipeline::{StageKey, StageState};
    use content::views::WaitReason;
    let (w, _) = social_world().await;
    let account = w.f.slot.capability_id;
    let m = material(&w, true).await;
    let olay = m.olay_id().unwrap();
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"untimed","brief":"Atölyeden bir gün",
            "material_ids":[m.id],"olay_id":olay})),
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
    let p = content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":"untimed-d",
            "summary":"Hazır","versions":[version(&w, &m, json!({}))]}),
        ),
    )
    .await
    .unwrap()
    .project;
    let version_id = p.packages[0].versions[0].id;

    let row = line_row(&w, &p).await;
    assert_eq!(row.pipeline.unscheduled.len(), 1);
    let wait = &row.pipeline.unscheduled[0];
    assert_eq!(wait.version_id, version_id);
    assert_eq!(wait.accounts, vec![account]);
    assert_eq!(wait.blocked, None);
    assert!(row.pipeline.awaits_time());
    assert!(!row.pipeline.has_problem());
    assert_eq!(stage(&row, StageKey::Onay).state, StageState::Current);
    assert_eq!(stage(&row, StageKey::Yayin).state, StageState::Todo);
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    let node = &tree
        .olays
        .iter()
        .find(|o| o.olay.id() == olay)
        .unwrap()
        .folder;
    assert!(node.waits.contains(&WaitReason::ContentTime));
    assert_eq!(tree.waiting.content_times, 1);
    assert_eq!(tree.waiting.problem_contents, 0);
    let view = content::olay_view(&w.d, &w.ctx, input(json!({ "olay_id": olay })))
        .await
        .unwrap();
    assert_eq!(view.flow.awaiting_time, 1);
    assert_eq!(view.flow.in_production, 0);
    assert_eq!(view.flow.problems, 0);
    let json = serde_json::to_value(&row.pipeline).unwrap();
    assert_eq!(json["unscheduled"][0]["version_id"], json!(version_id));
    assert!(json["unscheduled"][0].get("blocked").is_none());

    // A person paused the only account: nothing can take the version. That is a problem a
    // person fixes, with its reason, and no longer a content the agent will time.
    let pause = |paused: bool, revision: u64| json!({"capability_id":account,"paused":paused,"expected_revision":revision});
    let settings = social::account_pause(&w.d, &w.ctx, input(pause(true, 0)))
        .await
        .unwrap();
    let row = line_row(&w, &p).await;
    assert_eq!(row.pipeline.unscheduled[0].blocked, Some("account_paused"));
    assert!(row.pipeline.unscheduled[0].accounts.is_empty());
    assert!(!row.pipeline.awaits_time());
    assert!(row.pipeline.has_problem());
    assert_eq!(stage(&row, StageKey::Yayin).state, StageState::Problem);
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    let node = &tree
        .olays
        .iter()
        .find(|o| o.olay.id() == olay)
        .unwrap()
        .folder;
    assert!(node.waits.contains(&WaitReason::ContentProblem));
    assert!(!node.waits.contains(&WaitReason::ContentTime));
    assert_eq!(tree.waiting.content_times, 0);
    assert_eq!(tree.waiting.problem_contents, 1);
    let view = content::olay_view(&w.d, &w.ctx, input(json!({ "olay_id": olay })))
        .await
        .unwrap();
    assert_eq!(view.flow.problems, 1);
    assert_eq!(view.flow.awaiting_time, 0);

    // Resumed and given its time: nothing waits for a time any more.
    social::account_pause(&w.d, &w.ctx, input(pause(false, settings.revision)))
        .await
        .unwrap();
    social::version_schedule(
        &w.d,
        &a,
        input(schedule_input(&p, 0, &w, WHEN, "untimed-t")),
    )
    .await
    .unwrap();
    let row = line_row(&w, &p).await;
    assert!(row.pipeline.unscheduled.is_empty());
    assert!(!row.pipeline.has_problem());
    assert_eq!(stage(&row, StageKey::Onay).state, StageState::Done);
    assert_eq!(stage(&row, StageKey::Yayin).state, StageState::Current);
    assert_eq!(
        content::tree(&w.d, &w.ctx)
            .await
            .unwrap()
            .waiting
            .content_times,
        0
    );
}
