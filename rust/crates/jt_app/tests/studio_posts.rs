//! Olay-driven publishing (spec 2026-11-03 §14.4): the planner's triggers write package requests
//! or çekim listesi items and never a post; an agent's package is validated all-or-nothing and
//! materialized with its preparation starts; a post is pending only from its preparation start,
//! retired past its grace, and the weekly summary names what happened.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    error::ErrorCode,
    ports::{
        UnitOfWork,
        files::StoredFile,
        posts::{PackageStatus, PackageTrigger, PostingSettings},
        studio::SlotQuery,
    },
    usecases::{
        studio::{
            pieces::{PieceInput, piece_submit},
            planner, posts, publish, work,
        },
        work as agent_work,
    },
};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::UserId;
use jt_testkit::fakes::{FIXED_NOW, files::MemoryFiles};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, macros::datetime};

/// The test world without its fixture's material: nothing in the library yet.
async fn posting_world() -> World {
    let mut w = without_content(world().await).await;
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    w
}

fn minutes(n: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(n)
}

/// A confirmed workshop on FIXED_NOW's day.
async fn workshop(w: &World) -> Olay {
    let o = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials().insert_olay(o.clone()).await.unwrap();
    r.commit().await.unwrap();
    o
}

/// A shareable, publishable material added at `at` (a stored file with its bytes), bound to
/// `olay`, or genel and freed by a human when `olay` is none.
async fn material(w: &World, olay: Option<&Olay>, at: OffsetDateTime, mime: &str) -> Material {
    let upload = MediaUpload {
        bytes: if mime == "video/mp4" {
            b"\x00\x00\x00\x14ftypisom\x00\x00\x02\x00isommaterial".to_vec()
        } else {
            b"\x89PNG\r\n\x1a\nmaterial".to_vec()
        },
        mime: mime.into(),
        filename: "material".into(),
    };
    let file: StoredFile =
        w.d.files
            .put(w.f.ws, FileId::new_v7(), upload)
            .await
            .unwrap();
    let base = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut m = jt_testkit::studio_contract::eligible_material(olay.unwrap_or(&base), file.id);
    m.mime = mime.into();
    m.created_at = at;
    if let Some(share) = &mut m.share {
        share.at = at;
    }
    if olay.is_none() {
        m.binding = Binding::Genel;
        m.freed = Some(HumanMark {
            by: UserId::new_v7(),
            at,
        });
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

async fn plan(w: &World, at: OffsetDateTime) -> u64 {
    planner::plan(&w.d, w.f.ws, at).await.unwrap()
}

fn requests(w: &World) -> Vec<PackageRequest> {
    w.uow
        .snapshot()
        .posts
        .requests
        .into_iter()
        .filter(|r| r.workspace_id == w.f.ws)
        .collect()
}

fn at(w: &World, now: OffsetDateTime) -> jt_app::ctx::Ctx {
    let mut ctx = w.ctx.clone();
    ctx.now = now;
    ctx
}

/// An agent's post on the fixture's X account.
fn post(publish_at: OffsetDateTime, materials: &[&Material], subject: Subject, w: &World) -> Value {
    json!({"format":"feed_post","capability_id":w.f.slot.capability_id,
        "publish_at":publish_at.format(&time::format_description::well_known::Rfc3339).unwrap(),
        "material_ids":materials.iter().map(|m| m.id).collect::<Vec<_>>(),
        "subject":subject,"hypothesis_id":w.f.slot.chain.hypothesis_id})
}

async fn propose(
    w: &World,
    now: OffsetDateTime,
    request: PackageRequestId,
    key: &str,
    items: Vec<Value>,
) -> Result<posts::PackageProposalOut, jt_app::error::AppError> {
    posts::posts_propose(
        &w.d,
        &at(w, now),
        serde_json::from_value(json!({"request_id":request,"request_key":key,"posts":items}))
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn zero_materials_ask_for_shoots_and_never_post_or_publish() {
    let w = posting_world().await;
    // No approval is required anywhere: the material gate and the caps are the safety.
    assert!(plan(&w, FIXED_NOW).await > 0);
    let s = w.uow.snapshot();
    assert!(requests(&w).is_empty());
    assert!(s.posts.posts.is_empty());
    let reasons: Vec<ShootReason> = s
        .materials
        .shoot_requests
        .iter()
        .filter(|q| q.status == ShootStatus::Open)
        .map(|q| q.reason.clone())
        .collect();
    // The calendar: Cadılar Bayramı's window is open and Öğretmenler Günü's is within its lead.
    for occasion in ["cadilar_bayrami", "ogretmenler_gunu"] {
        assert!(reasons.contains(&ShootReason::SeasonAhead {
            occasion: occasion.into(),
            year: 2026
        }));
    }
    // The floor found no generic material for the channel's hypothesis.
    assert!(reasons.contains(&ShootReason::SlotUnfilled {
        hypothesis_id: w.f.slot.chain.hypothesis_id,
        content_type: "text".into(),
    }));
    // The weekly quotas' ready slot retired: nothing is due, nothing goes out.
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    let s = w.uow.snapshot();
    assert!(s.studio.publications.is_empty());
    assert!(s.studio.slots.iter().all(|x| x.state == SlotState::Retired));
    // Another run asks nothing twice.
    let before = s.materials.shoot_requests.len();
    plan(&w, minutes(10)).await;
    assert_eq!(w.uow.snapshot().materials.shoot_requests.len(), before);
}

#[tokio::test]
async fn twenty_materials_in_minutes_make_one_request_thirty_minutes_after_the_last() {
    let w = posting_world().await;
    let o = workshop(&w).await;
    let mut added = Vec::new();
    for i in 0..20 {
        added.push(material(&w, Some(&o), minutes(i), "image/png").await);
        if i % 5 == 4 {
            plan(&w, minutes(i)).await;
        }
    }
    // 19 minutes is the last change: nothing until 30 minutes after it.
    plan(&w, minutes(40)).await;
    assert!(requests(&w).is_empty());
    plan(&w, minutes(49)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 1);
    let q = &all[0];
    assert_eq!(q.trigger, PackageTrigger::Olay);
    assert_eq!(q.status, PackageStatus::Open);
    assert_eq!(q.olay_id, Some(o.id));
    assert_eq!(q.key, olay_package_key(o.id, 0, &q.material_ids));
    assert_eq!(
        q.material_ids,
        added.iter().map(|m| m.id).collect::<Vec<_>>()
    );
    assert_eq!(q.hints.subject, Some(Subject::Olay { olay_id: o.id }));
    // The formats, best first: none measured yet.
    assert_eq!(q.best_formats[0].format, PostFormat::FeedPost);
    // Later runs list nothing twice; the request is agents' pending work.
    plan(&w, minutes(60)).await;
    plan(&w, minutes(120)).await;
    assert_eq!(requests(&w).len(), 1);
    let pending = work::pending(&w.d, &at(&w, minutes(120))).await.unwrap();
    assert_eq!(pending.post_requests.len(), 1);
    let items = agent_work::pending(&w.d, &at(&w, minutes(120)))
        .await
        .unwrap()
        .items;
    assert!(items.iter().any(|i| matches!(
        i.kind,
        agent_work::WorkKind::StudioPostRequest { post_request_id } if post_request_id == q.id
    )));
    // A material added afterwards makes a new request of its own once it settles.
    let late = material(&w, Some(&o), minutes(130), "image/png").await;
    plan(&w, minutes(161)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|q| q.material_ids == vec![late.id]));
}

/// A confirmed special-day olay of occasion `key`, shot on `day` (its season year's window).
async fn special_day(w: &World, key: &str, day: time::Date) -> Olay {
    let o = Olay {
        kind: OlayKind::SpecialDay,
        occasion: Some(key.into()),
        starts_on: day,
        ends_on: day,
        ..jt_testkit::studio_contract::confirmed_olay(w.f.ws)
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials().insert_olay(o.clone()).await.unwrap();
    r.commit().await.unwrap();
    o
}

fn shoot(w: &World, key: &str) -> Option<ShootRequest> {
    w.uow
        .snapshot()
        .materials
        .shoot_requests
        .into_iter()
        .find(|q| q.key == key)
}

/// D25, D49: within an occasion's lead, its confirmed olay's eligible materials, once they
/// settled (the olay trigger's debounce), make a calendar request with the occasion's window;
/// the çekim listesi item that asked for them closes once they exist, and the olay trigger lists
/// them no second time.
#[tokio::test]
async fn an_occasion_within_its_lead_asks_for_its_olays_package_once() {
    let w = posting_world().await;
    // Öğretmenler Günü 2026: 10–24 November, its 21-day lead open since 20 October.
    plan(&w, FIXED_NOW).await;
    let item = shoot(&w, &season_request_key("ogretmenler_gunu", 2026)).unwrap();
    assert_eq!(item.status, ShootStatus::Open);
    let o = special_day(
        &w,
        "ogretmenler_gunu",
        datetime!(2026-11-24 00:00 UTC).date(),
    )
    .await;
    let m = material(&w, Some(&o), minutes(5), "image/png").await;
    plan(&w, minutes(10)).await;
    assert!(requests(&w).is_empty(), "the material has not settled");
    let item = shoot(&w, &season_request_key("ogretmenler_gunu", 2026)).unwrap();
    assert_eq!(item.status, ShootStatus::Done, "its material exists");
    plan(&w, minutes(35)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 1, "{all:?}");
    let q = &all[0];
    assert_eq!(q.trigger, PackageTrigger::Calendar);
    assert_eq!(q.key, calendar_package_key("ogretmenler_gunu", 2026));
    assert_eq!(q.olay_id, Some(o.id));
    assert_eq!(q.occasion.as_deref(), Some("ogretmenler_gunu"));
    assert_eq!(q.year, Some(2026));
    assert_eq!(q.material_ids, vec![m.id]);
    assert_eq!(q.hints.subject, Some(Subject::Olay { olay_id: o.id }));
    assert_eq!(
        (q.hints.window_start, q.hints.window_end),
        (
            Some(datetime!(2026-11-10 00:00 UTC).date()),
            Some(datetime!(2026-11-24 00:00 UTC).date())
        )
    );
    // The olay trigger finds its material listed: one request still.
    plan(&w, minutes(60)).await;
    plan(&w, minutes(120)).await;
    assert_eq!(requests(&w).len(), 1);
}

/// An occasion's olay whose materials an olay request already lists (they settled before the
/// lead began, once the window came within the horizon) is covered: the calendar trigger asks
/// for no second package about the same materials, and no çekim listesi item.
#[tokio::test]
async fn an_occasion_its_olay_request_covers_asks_for_nothing_more() {
    let w = posting_world().await;
    // Yılbaşı 2026: 1–31 December; within the 30-day horizon from 1 November, its lead from
    // 10 November.
    let o = special_day(&w, "yilbasi", datetime!(2026-11-20 00:00 UTC).date()).await;
    let m = material(&w, Some(&o), FIXED_NOW, "image/png").await;
    plan(&w, minutes(40)).await;
    assert!(requests(&w).is_empty(), "the window is past the horizon");
    plan(&w, datetime!(2026-11-02 09:00 UTC)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].trigger, PackageTrigger::Olay);
    assert_eq!(all[0].material_ids, vec![m.id]);
    // An agent answered it (an expired one would give its materials back).
    w.uow.edit(|s| {
        for q in s.posts.requests.iter_mut() {
            q.status = PackageStatus::Answered;
            q.answered_at = Some(datetime!(2026-11-02 10:00 UTC));
        }
    });
    plan(&w, datetime!(2026-11-11 09:00 UTC)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 1, "{all:?}");
    assert!(shoot(&w, &season_request_key("yilbasi", 2026)).is_none());
    // A material added within the lead is the calendar's to list once it settled.
    let late = material(&w, Some(&o), datetime!(2026-11-11 09:00 UTC), "image/png").await;
    plan(&w, datetime!(2026-11-11 09:10 UTC)).await;
    assert_eq!(requests(&w).len(), 1);
    plan(&w, datetime!(2026-11-11 09:30 UTC)).await;
    let all = requests(&w);
    assert_eq!(all.len(), 2, "{all:?}");
    let q = all
        .iter()
        .find(|q| q.trigger == PackageTrigger::Calendar)
        .unwrap();
    assert_eq!(q.material_ids, vec![late.id]);
    plan(&w, datetime!(2026-11-11 10:00 UTC)).await;
    assert_eq!(requests(&w).len(), 2);
}

/// D31, D57: a measured post's reward counts for its format, its olay's kind and its hypothesis:
/// the weekly summary's scores show it, and the next request about an olay of that kind lists that
/// format first.
#[tokio::test]
async fn a_measured_post_ranks_its_format_for_its_olay_kind() {
    let mut w = without_content(world().await).await;
    w.d.files = Arc::new(MemoryFiles::default());
    let o = workshop(&w).await;
    jt_testkit::studio_contract::attach_post(&w.uow, &w.f).await;
    // The fixture's slot carries a reel about the workshop.
    w.uow.edit(|s| {
        for p in s.posts.posts.iter_mut() {
            p.format = PostFormat::Reel;
            p.olay_id = Some(o.id);
            p.subject = Subject::Olay { olay_id: o.id };
        }
    });
    let publication = w.publish_evidence().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .record_measurement(Measurement {
            id: MeasurementId::new_v7(),
            chain: w.f.slot.chain.clone(),
            evidence_key: "post/24h".into(),
            publication_id: Some(publication),
            binding_id: None,
            window: MeasurementWindow::Hours24,
            evidence_revision: 0,
            scheduled_at: None,
            account_timezone: None,
            minor_unit_exponent: None,
            measured_at: FIXED_NOW + Duration::days(1),
            source: "x".into(),
            raw_metrics: [
                ("impressions".into(), Some(100)),
                ("engagements".into(), Some(25)),
            ]
            .into(),
            metric_scope: "post".into(),
            date: None,
            currency: None,
            status: MeasurementStatus::Complete,
            failure: None,
            rule_version: LEARNING_RULE.into(),
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let summary = posts::weekly_summary(&w.d, &w.ctx, Default::default())
        .await
        .unwrap();
    assert_eq!(
        summary.scores,
        vec![PostScore {
            format: PostFormat::Reel,
            olay_kind: Some(OlayKind::Workshop),
            hypothesis_id: w.f.slot.chain.hypothesis_id,
            mean: 0.25,
            posts: 1,
        }]
    );
    // Another workshop's materials: their request lists the reel first.
    let next = workshop(&w).await;
    let m = material(&w, Some(&next), FIXED_NOW, "image/png").await;
    plan(&w, minutes(31)).await;
    let q = requests(&w)
        .into_iter()
        .find(|q| q.olay_id == Some(next.id))
        .expect("the workshop's request");
    assert_eq!(q.material_ids, vec![m.id]);
    assert_eq!(q.best_formats[0].format, PostFormat::Reel);
    assert_eq!(q.best_formats[0].mean, Some(0.25));
    assert_eq!(q.best_formats[0].posts, 1);
    assert!(q.best_formats[1..].iter().all(|f| f.mean.is_none()));
}

/// A world with an open olay request for a workshop's materials: four images, a video, and an
/// image that is not shareable (refused by the material gate).
async fn requested() -> (World, Olay, Vec<Material>, PackageRequestId) {
    let w = posting_world().await;
    let o = workshop(&w).await;
    let mut ms = Vec::new();
    for _ in 0..4 {
        ms.push(material(&w, Some(&o), FIXED_NOW, "image/png").await);
    }
    ms.push(material(&w, Some(&o), FIXED_NOW, "video/mp4").await);
    let mut closed = material(&w, Some(&o), FIXED_NOW, "image/png").await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let revision = closed.revision;
    closed.share = Some(ShareDecision {
        permission: SharePermission::NotShareable,
        by: Some(UserId::new_v7()),
        at: FIXED_NOW,
    });
    closed.revision += 1;
    r.studio_materials()
        .update_material(closed.clone(), revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    ms.push(closed);
    plan(&w, minutes(31)).await;
    let q = requests(&w).pop().expect("the olay's request");
    assert_eq!(q.material_ids.len(), 5, "the closed material is not listed");
    (w, o, ms, q.id)
}

const NOW: OffsetDateTime = datetime!(2026-10-22 10:00 UTC);

#[tokio::test]
async fn a_package_breaking_any_rule_is_refused_whole_with_each_posts_reason() {
    let (w, o, ms, q) = requested().await;
    let s = Subject::Olay { olay_id: o.id };
    let slots_before = w.uow.snapshot().studio.slots.len();
    let mut carousel = post(datetime!(2026-10-25 07:00 UTC), &[&ms[0], &ms[1]], s, &w);
    carousel["format"] = json!("carousel");
    let mut stranger = post(datetime!(2026-10-28 07:00 UTC), &[&ms[2]], s, &w);
    stranger["hypothesis_id"] = json!(uuid::Uuid::from_u128(77));
    let items = vec![
        // 0: Saturday 10:00 in Istanbul: fine.
        post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w),
        // 1: an hour later on the same channel: closer than three hours.
        post(datetime!(2026-10-24 08:00 UTC), &[&ms[1]], s, &w),
        // 2: X publishes no carousel.
        carousel,
        // 3: 02:00 in Istanbul.
        post(datetime!(2026-10-24 23:00 UTC), &[&ms[2]], s, &w),
        // 4: ten hours ahead, a feed post's lead is a day.
        post(datetime!(2026-10-22 20:00 UTC), &[&ms[3]], s, &w),
        // 5: a material its owner did not let be shared.
        post(datetime!(2026-10-26 07:00 UTC), &[&ms[5]], s, &w),
        // 6: 13:30 on Saturday: the day's second feed post, fine.
        post(datetime!(2026-10-24 10:30 UTC), &[&ms[2]], s, &w),
        // 7: 17:00 on Saturday: the third.
        post(datetime!(2026-10-24 14:00 UTC), &[&ms[3]], s, &w),
        // 8: a video on X.
        post(datetime!(2026-10-27 07:00 UTC), &[&ms[4]], s, &w),
        // 9: past the 30-day horizon.
        post(datetime!(2026-11-23 07:00 UTC), &[&ms[0]], s, &w),
        // 10: no such hypothesis.
        stranger,
    ];
    let e = propose(&w, NOW, q, "package", items).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "package_refused");
    let reasons: Vec<(u64, String)> = e.details["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["index"].as_u64().unwrap(),
                i["reason"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let expected: Vec<(u64, String)> = [
        (1, "spacing"),
        (2, "format_unsupported"),
        (3, "quiet_hours"),
        (4, "lead_too_short"),
        (5, "material_refused"),
        (7, "cap_per_day"),
        (8, "media_type"),
        (9, "beyond_horizon"),
        (10, "hypothesis_not_postable"),
    ]
    .into_iter()
    .map(|(i, r)| (i, r.to_owned()))
    .collect();
    assert_eq!(reasons, expected);
    let refused = &e.details["items"][4];
    assert_eq!(refused["refusals"][0]["code"], "not_shareable");
    assert_eq!(refused["refusals"][0]["material_id"], json!(ms[5].id));
    // Nothing was written: no post, no slot, the request still open.
    let snap = w.uow.snapshot();
    assert!(snap.posts.posts.is_empty());
    assert_eq!(snap.studio.slots.len(), slots_before);
    assert_eq!(requests(&w)[0].status, PackageStatus::Open);

    // The valid part alone materializes at once, with its preparation starts.
    let out = propose(
        &w,
        NOW,
        q,
        "package-2",
        vec![
            post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w),
            post(datetime!(2026-10-24 10:30 UTC), &[&ms[2]], s, &w),
        ],
    )
    .await
    .unwrap();
    assert_eq!(out.request.status, PackageStatus::Answered);
    assert_eq!(out.posts.len(), 2);
    let first = &out.posts[0];
    assert_eq!(first.slot.state, SlotState::Planned);
    assert_eq!(first.slot.scheduled_at, datetime!(2026-10-24 07:00 UTC));
    assert_eq!(first.post.prep_start_at, datetime!(2026-10-23 07:00 UTC));
    assert_eq!(first.post.grace_until, datetime!(2026-10-24 13:00 UTC));
    assert_eq!(first.post.olay_id, Some(o.id));
    assert_eq!(first.post.content_type, "text");
    assert!(!first.pending);
    // Replayed by its key; another answer finds the request closed.
    let again = propose(
        &w,
        NOW,
        q,
        "package-2",
        vec![
            post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w),
            post(datetime!(2026-10-24 10:30 UTC), &[&ms[2]], s, &w),
        ],
    )
    .await
    .unwrap();
    assert_eq!(again.posts[0].slot.id, first.slot.id);
    let e = propose(
        &w,
        NOW,
        q,
        "package-3",
        vec![post(datetime!(2026-10-25 07:00 UTC), &[&ms[1]], s, &w)],
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "request_not_open");
    // The ledger names ids and codes.
    let snap = w.uow.snapshot();
    let answered = snap
        .ledger
        .iter()
        .find(|e| e.entry.action.as_str() == "studio.package.answered")
        .unwrap();
    assert_eq!(
        answered.entry.payload["slot_ids"].as_array().unwrap().len(),
        2
    );
}

#[tokio::test]
async fn a_post_is_pending_from_its_prep_start_and_retired_past_its_grace() {
    let (w, o, ms, q) = requested().await;
    let s = Subject::Olay { olay_id: o.id };
    let out = propose(
        &w,
        NOW,
        q,
        "package",
        vec![
            post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w),
            post(datetime!(2026-10-24 10:30 UTC), &[&ms[2]], s, &w),
        ],
    )
    .await
    .unwrap();
    let (a, b) = (out.posts[0].slot.id, out.posts[1].slot.id);
    let listed = |p: &work::PendingStudioOut, id: SlotId| p.slots.iter().any(|s| s.slot.id == id);
    // Before its preparation start a post is in posts_list only.
    let early = work::pending(&w.d, &at(&w, NOW)).await.unwrap();
    assert!(!listed(&early, a) && !listed(&early, b));
    let items = agent_work::pending(&w.d, &at(&w, NOW)).await.unwrap().items;
    assert!(
        !items
            .iter()
            .any(|i| matches!(i.kind, agent_work::WorkKind::StudioSlot { .. }))
    );
    let list = posts::posts_list(&w.d, &at(&w, NOW), Default::default())
        .await
        .unwrap();
    assert_eq!(list.posts.len(), 2);
    assert!(list.posts.iter().all(|p| !p.pending));
    assert_eq!(list.settings, PostingSettings::default());
    // From it, it is the agent's to prepare.
    let prep = datetime!(2026-10-23 07:00 UTC);
    let now = work::pending(&w.d, &at(&w, prep)).await.unwrap();
    assert!(listed(&now, a) && !listed(&now, b));
    let items = agent_work::pending(&w.d, &at(&w, prep))
        .await
        .unwrap()
        .items;
    assert!(items.iter().any(|i| matches!(
        i.kind,
        agent_work::WorkKind::StudioSlot { slot_id, .. } if slot_id == a
    )));
    // Not ready at the end of its grace: retired missed_grace, once, and in the summary.
    plan(&w, datetime!(2026-10-24 13:00 UTC)).await;
    assert!(
        w.uow
            .snapshot()
            .posts
            .posts
            .iter()
            .all(|p| p.retired.is_none())
    );
    plan(&w, datetime!(2026-10-24 13:01 UTC)).await;
    let snap = w.uow.snapshot();
    let slot = snap.studio.slots.iter().find(|s| s.id == a).unwrap();
    assert_eq!(slot.state, SlotState::Retired);
    let retired = snap.posts.posts.iter().find(|p| p.slot_id == a).unwrap();
    assert_eq!(
        retired.retired,
        Some(PostRetirement {
            reason: RetirementReason::MissedGrace,
            at: datetime!(2026-10-24 13:01 UTC)
        })
    );
    assert_eq!(
        snap.ledger
            .iter()
            .filter(|e| e.entry.action.as_str() == "studio.slot.missed_grace")
            .count(),
        1
    );
    plan(&w, datetime!(2026-10-24 13:11 UTC)).await;
    let summary = posts::weekly_summary(
        &w.d,
        &at(&w, datetime!(2026-10-24 13:11 UTC)),
        serde_json::from_value(json!({"week":"2026-10-19"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(summary.week_start, time::macros::date!(2026 - 10 - 19));
    assert_eq!(summary.from, datetime!(2026-10-18 21:00 UTC));
    assert!(summary.cancelled.iter().any(|c| c.slot_id == a
        && c.reason == "missed_grace"
        && c.format == Some(PostFormat::FeedPost)));
    assert!(summary.planned.iter().any(|p| p.slot_id == b));
    assert!(summary.published.is_empty());
    // The weekly quotas' ready slot, retired on the first run, is named too.
    assert!(
        summary
            .cancelled
            .iter()
            .any(|c| c.slot_id == w.f.slot.id && c.reason == "replanned")
    );
    // A week starts on a Monday.
    let e = posts::weekly_summary(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"week":"2026-10-20"})).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "not_a_monday");
}

#[tokio::test]
async fn a_piece_for_a_post_speaks_about_its_subject_with_the_media_its_format_takes() {
    let (w, o, ms, q) = requested().await;
    let s = Subject::Olay { olay_id: o.id };
    let out = propose(
        &w,
        NOW,
        q,
        "package",
        vec![post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w)],
    )
    .await
    .unwrap();
    let slot = out.posts[0].slot.id;
    let ctx = at(&w, datetime!(2026-10-23 08:00 UTC));
    let submit = |media: Vec<&Material>, subject: Option<Subject>, key: &str| PieceInput {
        slot_id: slot,
        expected_revision: 0,
        request_key: key.into(),
        text: "Atölyemizden".into(),
        media: media
            .iter()
            .map(|m| MediaAsset::File { id: m.file_id })
            .collect(),
        adaptations: Default::default(),
        subject,
    };
    let reason = |e: jt_app::error::AppError| e.details["reason"].as_str().unwrap().to_owned();
    let e = piece_submit(
        &w.d,
        &ctx,
        submit(vec![&ms[0]], Some(Subject::Generic), "a"),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(e), "subject_mismatch");
    let e = piece_submit(&w.d, &ctx, submit(vec![&ms[0], &ms[1]], None, "b"))
        .await
        .unwrap_err();
    assert_eq!(reason(e), "media_count");
    let e = piece_submit(&w.d, &ctx, submit(vec![&ms[4]], None, "c"))
        .await
        .unwrap_err();
    assert_eq!(reason(e), "media_type");
    // The post's own subject by default: the piece is ready and records what it shows.
    let done = piece_submit(&w.d, &ctx, submit(vec![&ms[1]], None, "d"))
        .await
        .unwrap();
    assert_eq!(done.slot.state, SlotState::Ready);
    assert_eq!(done.post.unwrap().slot_id, slot);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let shown = r
        .studio_materials()
        .piece_materials(slot, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.subject, s);
}

#[tokio::test]
async fn the_floor_fires_after_floor_days_without_a_feed_post_and_not_while_a_package_is_pending() {
    let w = posting_world().await;
    // The weekly quotas published on the channel at FIXED_NOW; a freed, genel material waits.
    w.publish_evidence().await;
    let generic = material(&w, None, FIXED_NOW, "image/png").await;
    plan(&w, FIXED_NOW + Duration::days(3)).await;
    plan(&w, FIXED_NOW + Duration::days(4) - Duration::minutes(1)).await;
    assert!(requests(&w).is_empty());
    let fired = FIXED_NOW + Duration::days(4);
    plan(&w, fired).await;
    let all = requests(&w);
    assert_eq!(all.len(), 1);
    let q = &all[0];
    assert_eq!(q.trigger, PackageTrigger::Floor);
    assert_eq!(q.capability_id, Some(w.f.slot.capability_id));
    assert_eq!(q.material_ids, vec![generic.id]);
    assert_eq!(q.hints.max_posts, Some(1));
    assert_eq!(q.hints.subject, Some(Subject::Generic));
    // The hypothesis by its arms' posterior mean: the only one here.
    assert_eq!(q.hints.hypothesis_id, Some(w.f.slot.chain.hypothesis_id));
    assert_eq!(q.hints.content_type.as_deref(), Some("text"));
    // X takes feed posts only.
    assert!(
        q.best_formats
            .iter()
            .all(|f| f.format == PostFormat::FeedPost)
    );
    // Not again while it is pending, the next day included.
    plan(&w, fired + Duration::minutes(10)).await;
    plan(&w, fired + Duration::days(1)).await;
    assert_eq!(requests(&w).len(), 1);
    // A floor request takes one post.
    let e = propose(
        &w,
        fired,
        q.id,
        "floor-2",
        vec![
            post(fired + Duration::days(2), &[&generic], Subject::Generic, &w),
            post(fired + Duration::days(3), &[&generic], Subject::Generic, &w),
        ],
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "too_many_posts");
    // Answered with one post: still nothing while that post is pending.
    let out = propose(
        &w,
        fired,
        q.id,
        "floor",
        vec![post(
            fired + Duration::days(2),
            &[&generic],
            Subject::Generic,
            &w,
        )],
    )
    .await
    .unwrap();
    assert_eq!(out.posts.len(), 1);
    plan(&w, fired + Duration::days(1) + Duration::hours(1)).await;
    assert_eq!(requests(&w).len(), 1);
}

#[tokio::test]
async fn old_planned_and_ready_slots_retire_replanned_once_with_their_evidence() {
    let w = world().await;
    // A published slot of the weekly quotas, and a planned one.
    let mut planned = w.f.slot.clone();
    planned.id = SlotId::new_v7();
    planned.state = SlotState::Planned;
    planned.revision = 0;
    planned.scheduled_at = FIXED_NOW + Duration::days(1);
    let mut ready = w.f.slot.clone();
    ready.id = SlotId::new_v7();
    ready.state = SlotState::Planned;
    ready.revision = 0;
    ready.scheduled_at = FIXED_NOW + Duration::days(2);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .insert_slots("old", vec![planned.clone(), ready.clone()])
        .await
        .unwrap();
    let piece = Piece {
        id: PieceId::new_v7(),
        chain: ready.chain.clone(),
        revision: 1,
        text: "old".into(),
        media: vec![],
        adaptations: Default::default(),
    };
    r.studio()
        .save_piece(ready.id, 0, piece.clone(), "old-piece")
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.publish_evidence().await;
    plan(&w, FIXED_NOW).await;
    let snap = w.uow.snapshot();
    let state = |id: SlotId| snap.studio.slots.iter().find(|s| s.id == id).unwrap().state;
    assert_eq!(state(planned.id), SlotState::Retired);
    assert_eq!(state(ready.id), SlotState::Retired);
    // Published work is untouched; the ready piece stays stored.
    assert_eq!(state(w.f.slot.id), SlotState::Published);
    assert!(snap.studio.pieces.iter().any(|(_, p)| p.id == piece.id));
    let replanned: Vec<_> = snap
        .ledger
        .iter()
        .filter(|e| e.entry.action.as_str() == "studio.slot.replanned")
        .collect();
    assert_eq!(replanned.len(), 2);
    assert!(
        replanned
            .iter()
            .all(|e| e.entry.payload["reason"] == "replanned"
                && matches!(e.entry.actor, Actor::System { .. }))
    );
    // Once: a slot stored later is left as it is.
    let mut later = planned.clone();
    later.id = SlotId::new_v7();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .insert_slots("later", vec![later.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    plan(&w, FIXED_NOW + Duration::minutes(10)).await;
    let snap = w.uow.snapshot();
    assert_eq!(
        snap.studio
            .slots
            .iter()
            .find(|s| s.id == later.id)
            .unwrap()
            .state,
        SlotState::Planned
    );
    assert_eq!(
        snap.ledger
            .iter()
            .filter(|e| e.entry.action.as_str() == "studio.slot.replanned")
            .count(),
        2
    );
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        !r.studio()
            .list_slots(SlotQuery {
                from: FIXED_NOW,
                until: FIXED_NOW + Duration::days(7),
                hypothesis_id: None,
                lane: None,
            })
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_posting_policy_is_a_humans_and_validated() {
    let w = posting_world().await;
    let mut settings = PostingSettings::default();
    settings.policy.floor_days = 2;
    settings.tz = "Europe/Berlin".into();
    let saved = posts::posting_policy_set(&w.d, &w.ctx, settings.clone())
        .await
        .unwrap();
    // Every change moves the settings' revision (pausing an account names the one it saw).
    settings.revision = 1;
    assert_eq!(saved, settings);
    let list = posts::posts_list(&w.d, &w.ctx, Default::default())
        .await
        .unwrap();
    assert_eq!(list.settings, settings);
    let mut bad = settings.clone();
    bad.tz = "Mars/Olympus".into();
    let e = posts::posting_policy_set(&w.d, &w.ctx, bad)
        .await
        .unwrap_err();
    assert_eq!(e.details["field"], "tz");
    let mut bad = settings.clone();
    bad.policy.floor_days = 0;
    let e = posts::posting_policy_set(&w.d, &w.ctx, bad)
        .await
        .unwrap_err();
    assert_eq!(e.details["field"], "posting_policy.floor_days");
    // An agent never sets it.
    let mut agent = w.ctx.clone();
    agent.agent_connection_id = Some(jt_tenancy::AgentConnectionId::new_v7());
    let e = posts::posting_policy_set(&w.d, &agent, settings)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_cancelled_or_archived_post_records_why() {
    let (w, o, ms, q) = requested().await;
    let s = Subject::Olay { olay_id: o.id };
    let out = propose(
        &w,
        NOW,
        q,
        "package",
        vec![
            post(datetime!(2026-10-24 07:00 UTC), &[&ms[0]], s, &w),
            post(datetime!(2026-10-24 10:30 UTC), &[&ms[2]], s, &w),
        ],
    )
    .await
    .unwrap();
    let (a, b) = (out.posts[0].slot.id, out.posts[1].slot.id);
    work::slot_cancel(
        &w.d,
        &at(&w, NOW),
        work::CancelSlotInput {
            slot_id: a,
            expected_revision: 0,
            reason: "not this week".into(),
        },
    )
    .await
    .unwrap();
    w.archive().await;
    let snap = w.uow.snapshot();
    let reason = |id: SlotId| {
        snap.posts
            .posts
            .iter()
            .find(|p| p.slot_id == id)
            .unwrap()
            .retired
            .map(|r| r.reason)
    };
    assert_eq!(reason(a), Some(RetirementReason::Cancelled));
    assert_eq!(reason(b), Some(RetirementReason::StrategyArchived));
}

// ---------------------------------------------------------------------------------------------
// Review of Phase 3 (2026-11-04)
// ---------------------------------------------------------------------------------------------

/// Sets the quality of material `id` as a tag edit would: a change that carries no time (D48).
fn set_quality(w: &World, id: MaterialId, quality: Option<Quality>) {
    w.uow.edit(|s| {
        for m in s.materials.materials.iter_mut() {
            if m.id == id {
                m.tags.quality = quality;
            }
        }
    });
}

/// The fixture slot carries a planned feed post (grace until FIXED_NOW + 6 h), and a publish
/// attempt for it was claimed at FIXED_NOW and ended with `outcome` (none: still sending).
async fn attempted(w: &World, outcome: Option<jt_app::ports::studio::PublishOutcome>) {
    jt_testkit::studio_contract::attach_post(&w.uow, &w.f).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .expect("the fixture slot is due");
    if let Some(outcome) = outcome {
        r.studio()
            .finish_publication(a.id(), outcome, FIXED_NOW)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
}

fn slot_state(w: &World, id: SlotId) -> SlotState {
    w.uow
        .snapshot()
        .studio
        .slots
        .iter()
        .find(|s| s.id == id)
        .unwrap()
        .state
}

/// Materials uploaded back to back share their second; tagging some of them later makes a
/// second set, which gets its own request: an olay's request is named by its set, never by a
/// clock two sets can share (review HIGH 1).
#[tokio::test]
async fn a_later_set_of_an_olays_materials_gets_its_own_request() {
    let w = posting_world().await;
    let o = workshop(&w).await;
    let mut all = Vec::new();
    for _ in 0..20 {
        all.push(material(&w, Some(&o), FIXED_NOW, "image/png").await);
    }
    for m in &all[12..] {
        set_quality(&w, m.id, Some(Quality::NeedsCrop));
    }
    plan(&w, minutes(31)).await;
    let first = requests(&w);
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].material_ids,
        all[..12].iter().map(|m| m.id).collect::<Vec<_>>()
    );
    for m in &all[12..] {
        set_quality(&w, m.id, Some(Quality::Publishable));
    }
    plan(&w, minutes(40)).await;
    let both = requests(&w);
    assert_eq!(both.len(), 2, "{both:?}");
    let second = both.iter().find(|q| q.id != first[0].id).unwrap();
    assert_eq!(
        second.material_ids,
        all[12..].iter().map(|m| m.id).collect::<Vec<_>>()
    );
    assert_ne!(second.key, first[0].key);
    // Nothing more once both sets are listed.
    plan(&w, minutes(80)).await;
    assert_eq!(requests(&w).len(), 2);
}

/// A request nobody answered gives its materials back: once it expired, they are asked for
/// again, under a key of their own (review MEDIUM 3).
#[tokio::test]
async fn an_expired_requests_materials_are_asked_for_again() {
    let w = posting_world().await;
    let o = workshop(&w).await;
    let ms = [
        material(&w, Some(&o), FIXED_NOW, "image/png").await,
        material(&w, Some(&o), FIXED_NOW, "image/png").await,
    ];
    plan(&w, minutes(31)).await;
    let first = requests(&w).pop().unwrap();
    plan(&w, FIXED_NOW + Duration::days(8)).await;
    let olay: Vec<PackageRequest> = requests(&w)
        .into_iter()
        .filter(|q| q.trigger == PackageTrigger::Olay)
        .collect();
    assert_eq!(olay.len(), 2, "{olay:?}");
    let expired = olay.iter().find(|q| q.id == first.id).unwrap();
    assert_eq!(expired.status, PackageStatus::Expired);
    let again = olay.iter().find(|q| q.id != first.id).unwrap();
    assert_eq!(again.status, PackageStatus::Open);
    assert_eq!(
        again.material_ids,
        ms.iter().map(|m| m.id).collect::<Vec<_>>()
    );
    assert_ne!(again.key, first.key);
}

/// A post whose only attempt failed is never sent again: past its grace it retires
/// `missed_grace`, and it no longer counts as pending on its channel, so the floor asks for a
/// post there (review MEDIUM 2).
#[tokio::test]
async fn a_failed_post_past_its_grace_retires_and_the_floor_asks_again() {
    let mut w = without_content(world().await).await;
    w.d.files = Arc::new(MemoryFiles::default());
    // The fixture's own material asks for nothing: no olay request covers the channel.
    let own = w.uow.snapshot().materials.materials[0].id;
    set_quality(&w, own, None);
    let generic = material(&w, None, FIXED_NOW, "image/png").await;
    attempted(
        &w,
        Some(jt_app::ports::studio::PublishOutcome::Failed(
            jt_app::error::AppError::internal("refused for good"),
        )),
    )
    .await;
    plan(&w, FIXED_NOW + Duration::hours(6)).await;
    assert_eq!(slot_state(&w, w.f.slot.id), SlotState::Ready);
    plan(&w, FIXED_NOW + Duration::hours(6) + Duration::minutes(1)).await;
    assert_eq!(slot_state(&w, w.f.slot.id), SlotState::Retired);
    let post = w.uow.snapshot().posts.posts[0].clone();
    assert_eq!(
        post.retired.map(|r| r.reason),
        Some(RetirementReason::MissedGrace)
    );
    // The next local day (the floor asks once a day; the fixture's post answered today's).
    plan(&w, FIXED_NOW + Duration::days(1)).await;
    let floor: Vec<PackageRequest> = requests(&w)
        .into_iter()
        // The fixture's post was planned from an answered floor request: a new one is open.
        .filter(|q| q.trigger == PackageTrigger::Floor && q.status == PackageStatus::Open)
        .collect();
    assert_eq!(floor.len(), 1, "{floor:?}");
    assert_eq!(floor[0].capability_id, Some(w.f.slot.capability_id));
    assert_eq!(floor[0].material_ids, vec![generic.id]);
}

/// A post whose attempt may still be going out (`unknown`) is never retired (D46), but past its
/// grace it is no longer pending work: the floor asks for another post on its channel.
#[tokio::test]
async fn a_post_in_flight_past_its_grace_stays_but_does_not_hold_the_floor() {
    let mut w = without_content(world().await).await;
    w.d.files = Arc::new(MemoryFiles::default());
    // The fixture's own material asks for nothing: no olay request covers the channel.
    let own = w.uow.snapshot().materials.materials[0].id;
    set_quality(&w, own, None);
    material(&w, None, FIXED_NOW, "image/png").await;
    attempted(
        &w,
        Some(jt_app::ports::studio::PublishOutcome::Unknown(
            jt_app::error::AppError::internal("lost"),
        )),
    )
    .await;
    // The next local day (the floor asks once a day; the fixture's post answered today's).
    plan(&w, FIXED_NOW + Duration::days(1)).await;
    assert_eq!(slot_state(&w, w.f.slot.id), SlotState::Ready);
    assert!(w.uow.snapshot().posts.posts[0].retired.is_none());
    let floor: Vec<PackageRequest> = requests(&w)
        .into_iter()
        // The fixture's post was planned from an answered floor request: a new one is open.
        .filter(|q| q.trigger == PackageTrigger::Floor && q.status == PackageStatus::Open)
        .collect();
    assert_eq!(floor.len(), 1, "{floor:?}");
    assert_eq!(floor[0].capability_id, Some(w.f.slot.capability_id));
}

/// The one-time retirement of the weekly quotas' slots never takes a slot whose publish is in
/// flight; it retires it on a later run, once its attempt ended unsent (review LOW 4).
#[tokio::test]
async fn the_one_time_replan_waits_for_an_attempt_in_flight() {
    let w = world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .expect("the fixture slot is due");
    r.commit().await.unwrap();
    plan(&w, minutes(10)).await;
    assert_eq!(slot_state(&w, w.f.slot.id), SlotState::Ready);
    let replanned = |w: &World| {
        w.uow
            .snapshot()
            .ledger
            .iter()
            .filter(|e| e.entry.action.as_str() == "studio.slot.replanned")
            .count()
    };
    assert_eq!(replanned(&w), 0);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            jt_app::ports::studio::PublishOutcome::Failed(jt_app::error::AppError::internal(
                "refused for good",
            )),
            minutes(11),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    plan(&w, minutes(20)).await;
    assert_eq!(slot_state(&w, w.f.slot.id), SlotState::Retired);
    assert_eq!(replanned(&w), 1);
    plan(&w, minutes(30)).await;
    assert_eq!(replanned(&w), 1);
}

/// The publisher never claims a post past its grace: it would go out late, maybe in quiet hours
/// (review LOW 5). Within the grace it does.
#[tokio::test]
async fn a_post_past_its_grace_is_never_claimed() {
    let w = world().await;
    jt_testkit::studio_contract::attach_post(&w.uow, &w.f).await;
    let grace = FIXED_NOW + Duration::hours(6);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        r.studio()
            .claim_publication(grace + Duration::seconds(1))
            .await
            .unwrap()
            .is_none()
    );
    drop(r);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    assert!(r.studio().claim_publication(grace).await.unwrap().is_some());
}

/// A preparation lead longer than a week still brings the post into the pending work at its
/// preparation start (review LOW 6).
#[tokio::test]
async fn a_post_with_a_lead_beyond_a_week_is_pending_from_its_prep_start() {
    let w = world().await;
    let mut settings = PostingSettings::default();
    settings.policy.lead_minutes.feed_post = 10 * 24 * 60;
    posts::posting_policy_set(&w.d, &w.ctx, settings)
        .await
        .unwrap();
    jt_testkit::studio_contract::attach_post(&w.uow, &w.f).await;
    let publish_at = FIXED_NOW + Duration::days(9);
    w.uow.edit(|s| {
        for slot in s.studio.slots.iter_mut() {
            if slot.id == w.f.slot.id {
                slot.scheduled_at = publish_at;
            }
        }
        for p in s.posts.posts.iter_mut() {
            p.publish_at = publish_at;
            p.prep_start_at = publish_at - Duration::days(10);
            p.grace_until = publish_at + Duration::hours(6);
        }
    });
    let pending = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(pending.slots.iter().any(|s| s.slot.id == w.f.slot.id));
}

/// Quiet hours (and a day's cap) are read at each post's own time in the policy's zone: a post
/// after a change of the clocks takes the offset of its day, not that of the proposal's
/// (review LOW 7, D51).
#[tokio::test]
async fn quiet_hours_take_each_posts_own_offset() {
    let (w, o, ms, q) = requested().await;
    posts::posting_policy_set(
        &w.d,
        &w.ctx,
        PostingSettings {
            policy: PostingPolicy::default(),
            tz: "Europe/Berlin".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let s = Subject::Olay { olay_id: o.id };
    // 22 October, summer time (UTC+2); 27 October 06:30 UTC is 07:30 in winter time (UTC+1),
    // inside the quiet hours, though 08:30 at the proposal's offset.
    let e = propose(
        &w,
        NOW,
        q,
        "berlin",
        vec![post(datetime!(2026-10-27 06:30 UTC), &[&ms[0]], s, &w)],
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["items"][0]["reason"], "quiet_hours");
    let out = propose(
        &w,
        NOW,
        q,
        "berlin-2",
        vec![post(datetime!(2026-10-27 07:30 UTC), &[&ms[0]], s, &w)],
    )
    .await
    .unwrap();
    assert_eq!(out.posts.len(), 1);
}
