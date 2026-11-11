//! The social module's accounts (design 2026-11-10 §7.1, §7.5, §7.6): each connected account with
//! what its platform said day by day, what is coming on it and what went out; a person's pause
//! of one account; and the daily read of the accounts' own numbers. A number a platform does not
//! give is absent everywhere, never zero.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{
        UnitOfWork,
        connectors::{AccountMetrics, PostMetrics, PublishReceipt},
        files::StoredFile,
        studio::ApprovalTarget,
    },
    usecases::{
        content, social,
        social::accounts::{UpcomingState, WaitsFor, read_days},
        studio::{
            control::{ApprovalInput, approve},
            measure::measure_due,
            projects, publish,
        },
    },
};
use jt_capability::{CapabilityId, StoredStatus};
use jt_connector::{ConnectorError, Provider};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{AgentConnectionId, Permission};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, macros::date, macros::datetime};
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

/// The world's X account.
fn x_account(w: &World) -> CapabilityId {
    w.f.slot.capability_id
}

/// Another connection of `kind` named `name`, a copy of the X account (credential not copied).
async fn connection(w: &World, kind: &str, name: &str, status: StoredStatus) -> CapabilityId {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r.capabilities().find(x_account(w)).await.unwrap().unwrap();
    c.id = CapabilityId::new_v7();
    c.kind_key = kind.into();
    c.name = name.into();
    c.status = status;
    c.external_id = Some(format!("{kind}-{name}"));
    let id = c.id;
    r.capabilities().insert(c, None).await.unwrap();
    r.commit().await.unwrap();
    id
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

/// An area a person opened and an agent finished with one version, scheduled on the X account
/// at `at`; answers the post's slot.
async fn scheduled(w: &World, key: &str, text: &str, at: OffsetDateTime) -> Slot {
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
            "versions":[{"format":"feed_post","text":text,"tags":[],"material_ids":[m.id],
                "hypothesis_id":w.f.slot.chain.hypothesis_id}]})),
    )
    .await
    .unwrap()
    .project;
    social::version_schedule(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"version_id":p.packages[0].versions[0].id,
            "capability_id":x_account(w),
            "publish_at":at.format(&time::format_description::well_known::Rfc3339).unwrap(),
            "request_key":format!("{key}-time")}),
        ),
    )
    .await
    .unwrap()
    .publication
    .slot
}

fn metrics(pairs: &[(&str, i64)]) -> AccountMetrics {
    AccountMetrics {
        metrics: pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
    }
}

fn account_reads(c: &ScriptedConnector) -> usize {
    c.calls()
        .iter()
        .filter(|call| matches!(call, ConnectorCall::AccountMetrics { .. }))
        .count()
}

async fn get(w: &World, ctx: &Ctx, q: Value) -> social::accounts::AccountDetail {
    social::account_get(&w.d, ctx, input(q)).await.unwrap()
}

#[tokio::test]
async fn the_daily_read_stores_one_snapshot_a_day_and_a_missing_number_stays_missing() {
    let (w, x) = social_world().await;
    let a = agent(&w);
    let account = x_account(&w);
    // An Instagram account with no credential, a retired page and an ad account: only the two
    // live social accounts are the module's, by name.
    let instagram = connection(&w, "instagram", "Atölye IG", StoredStatus::Verified).await;
    connection(&w, "facebook_page", "Eski sayfa", StoredStatus::Retired).await;
    connection(&w, "meta_ads", "Reklam hesabı", StoredStatus::Verified).await;
    let list = social::accounts_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    let mut expected = vec![instagram, account];
    expected.sort_by_key(|id| list.iter().position(|l| l.capability_id == *id));
    assert_eq!(
        list.iter().map(|l| l.capability_id).collect::<Vec<_>>(),
        expected
    );
    assert_eq!(list.len(), 2);
    assert!(
        list.windows(2).all(|p| p[0].name <= p[1].name),
        "by name: {list:?}"
    );
    // Nothing was read yet: no numbers, and none invented.
    for l in &list {
        assert_eq!(l.latest, None);
        assert_eq!(l.next, None);
        assert!(!l.paused);
    }

    // The platform gives followers and nothing else: one snapshot, the other four absent.
    x.push_account_metrics(Ok(metrics(&[
        ("followers_count", 120),
        ("listed_count", 3),
    ])));
    assert_eq!(read_days(&w.d, w.f.ws, FIXED_NOW).await.unwrap(), 1);
    assert_eq!(
        account_reads(&x),
        1,
        "the account without a credential is not read"
    );
    let s = w.uow.snapshot();
    assert_eq!(s.posts.account_days.len(), 1);
    let day = &s.posts.account_days[0];
    assert_eq!(day.capability_id, account);
    assert_eq!(day.day, date!(2026 - 10 - 22));
    assert_eq!(day.raw["listed_count"], 3, "the raw counters are kept");
    let listed = social::accounts_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    let mine = listed.iter().find(|l| l.capability_id == account).unwrap();
    assert_eq!(
        serde_json::to_value(mine.latest.as_ref().unwrap()).unwrap(),
        json!({"day":"2026-10-22","followers":120,"reach":null,"views":null,
               "engagement":null,"profile_visits":null}),
        "a number the platform does not give is null, never zero"
    );
    assert_eq!(
        listed
            .iter()
            .find(|l| l.capability_id == instagram)
            .unwrap()
            .latest,
        None
    );

    // The same day again: the first read stands and the platform is not asked (an unscripted
    // read would panic the adapter).
    assert_eq!(
        read_days(&w.d, w.f.ws, FIXED_NOW + Duration::hours(6))
            .await
            .unwrap(),
        0
    );
    assert_eq!(account_reads(&x), 1);

    // The next day the read fails, then answers nothing: a gap, no row and no zero. The run
    // after that reads it.
    let tomorrow = FIXED_NOW + Duration::days(1);
    x.push_account_metrics(Err(ConnectorError::transient("rate limited")));
    assert_eq!(read_days(&w.d, w.f.ws, tomorrow).await.unwrap(), 0);
    x.push_account_metrics(Ok(metrics(&[])));
    assert_eq!(read_days(&w.d, w.f.ws, tomorrow).await.unwrap(), 0);
    assert_eq!(w.uow.snapshot().posts.account_days.len(), 1);
    x.push_account_metrics(Ok(metrics(&[
        ("followers_count", 125),
        ("impressions", 900),
        ("profile_views", 14),
    ])));
    assert_eq!(
        read_days(&w.d, w.f.ws, tomorrow + Duration::hours(6))
            .await
            .unwrap(),
        1
    );

    // The account's page: the two days, oldest first, each with what it has.
    let ctx = Ctx {
        now: tomorrow + Duration::hours(7),
        ..a.clone()
    };
    let detail = get(&w, &ctx, json!({"capability_id":account})).await;
    assert_eq!(
        serde_json::to_value(&detail.days).unwrap(),
        json!([
            {"day":"2026-10-22","followers":120,"reach":null,"views":null,
             "engagement":null,"profile_visits":null},
            {"day":"2026-10-23","followers":125,"reach":null,"views":900,
             "engagement":null,"profile_visits":14},
        ])
    );
    assert_eq!(
        detail.account.latest.as_ref().unwrap().day,
        date!(2026 - 10 - 23)
    );
    // A period that leaves the first day out.
    let detail = get(
        &w,
        &ctx,
        json!({"capability_id":account,"from":"2026-10-23","until":"2026-10-23"}),
    )
    .await;
    assert_eq!(detail.days.len(), 1);
    // No post went out: the totals hold a count and no number.
    assert_eq!(
        serde_json::to_value(detail.totals).unwrap(),
        json!({"posts":0,"reach":null,"views":null,"engagement":null})
    );

    // Snapshots older than the keeping time are forgotten by the read.
    let later = FIXED_NOW + Duration::days(social::accounts::ACCOUNT_DAYS_KEPT + 2);
    {
        // The account was verified again since: a stale one is not read.
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r.capabilities().find(account).await.unwrap().unwrap();
        c.last_verified_at = Some(later);
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
    }
    x.push_account_metrics(Ok(metrics(&[("followers_count", 300)])));
    assert_eq!(read_days(&w.d, w.f.ws, later).await.unwrap(), 1);
    let kept: Vec<_> = w
        .uow
        .snapshot()
        .posts
        .account_days
        .iter()
        .map(|d| d.day)
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
}

#[tokio::test]
async fn the_read_is_the_social_modules_and_needs_a_usable_account() {
    let (w, x) = social_world().await;
    // The grant lacks the read scope: the account is not asked.
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r.capabilities().find(x_account(&w)).await.unwrap().unwrap();
        c.connector_public = json!({"access":{"scopes":["tweet.write"],"expires_at":null}});
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
    }
    assert_eq!(read_days(&w.d, w.f.ws, FIXED_NOW).await.unwrap(), 0);
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut c = r.capabilities().find(x_account(&w)).await.unwrap().unwrap();
        c.connector_public =
            json!({"access":{"scopes":["tweet.read","tweet.write"],"expires_at":null}});
        r.capabilities().update(c).await.unwrap();
        r.commit().await.unwrap();
    }
    // Without the social module nothing is read at all.
    jt_app::usecases::modules::remove(&w.d, &w.ctx, jt_app::usecases::modules::SOCIAL)
        .await
        .unwrap();
    assert_eq!(read_days(&w.d, w.f.ws, FIXED_NOW).await.unwrap(), 0);
    assert_eq!(account_reads(&x), 0);
    assert!(w.uow.snapshot().posts.account_days.is_empty());
}

#[tokio::test]
async fn an_accounts_page_shows_what_is_coming_why_it_waits_and_what_went_out() {
    let (mut w, x) = social_world().await;
    let a = agent(&w);
    let account = x_account(&w);
    let slot = scheduled(&w, "launch", "Yeni sezon başlıyor\nKayıtlar açık", WHEN).await;

    // Coming, by itself: ready, nobody to wait for, not held at the platform.
    let detail = get(&w, &a, json!({"capability_id":account})).await;
    let coming: Vec<_> = detail
        .upcoming
        .iter()
        .filter(|u| u.slot_id == slot.id)
        .collect();
    assert_eq!(coming.len(), 1);
    assert_eq!(
        serde_json::to_value(coming[0]).unwrap(),
        json!({"slot_id":slot.id,"publish_at":"2026-10-24T10:00:00Z","format":"feed_post",
               "title":"Yeni sezon başlıyor","held_at_provider":false,"state":"ready",
               "waits_for":null})
    );
    let listed = social::accounts_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    let next = listed
        .iter()
        .find(|l| l.capability_id == account)
        .unwrap()
        .next
        .clone()
        .expect("the account's next post");
    assert!(next.publish_at <= WHEN);

    // The connection asks for a person's approval: the post waits for it, and says so.
    w.approval(true).await;
    let detail = get(&w, &a, json!({"capability_id":account})).await;
    let u = detail
        .upcoming
        .iter()
        .find(|u| u.slot_id == slot.id)
        .unwrap();
    assert_eq!(u.state, UpcomingState::WaitingPerson);
    assert_eq!(u.waits_for, Some(WaitsFor::Approval));
    w.d.clock = Arc::new(FixedClock(WHEN));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    // A person approves it: it is ready again and goes out.
    approve(
        &w.d,
        &w.ctx,
        ApprovalInput {
            target: ApprovalTarget::Slot(slot.id),
            expected_revision: slot.revision,
        },
    )
    .await
    .unwrap();
    let detail = get(&w, &a, json!({"capability_id":account})).await;
    let u = detail
        .upcoming
        .iter()
        .find(|u| u.slot_id == slot.id)
        .unwrap();
    assert_eq!((u.state, u.waits_for), (UpcomingState::Ready, None));
    x.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }));
    assert!(publish::publish_due(&w.d, w.f.ws).await.unwrap() >= 1);

    // Gone out, not measured yet: listed with no number, and the totals count it with none.
    let ctx = Ctx {
        now: WHEN + Duration::hours(1),
        ..a.clone()
    };
    let detail = get(&w, &ctx, json!({"capability_id":account})).await;
    assert!(!detail.upcoming.iter().any(|u| u.slot_id == slot.id));
    let out = detail
        .recent
        .iter()
        .find(|r| r.slot_id == slot.id)
        .expect("the post that went out");
    assert_eq!(out.title, "Yeni sezon başlıyor");
    assert_eq!(out.format, Some(PostFormat::FeedPost));
    assert_eq!(
        serde_json::to_value(out.metrics).unwrap(),
        json!({"reach":null,"views":null,"engagement":null})
    );
    assert_eq!(detail.totals.posts as usize, detail.recent.len());
    assert_eq!(detail.totals.views, None);

    // Measured: the post carries what it reached and the totals add it up.
    w.d.clock = Arc::new(FixedClock(WHEN + Duration::days(1)));
    x.push_post_metrics(Ok(PostMetrics {
        metrics: [("impressions".into(), 400), ("engagements".into(), 31)].into(),
    }));
    assert!(measure_due(&w.d, w.f.ws).await.unwrap() >= 1);
    let ctx = Ctx {
        now: WHEN + Duration::days(1) + Duration::hours(1),
        ..a.clone()
    };
    let detail = get(&w, &ctx, json!({"capability_id":account})).await;
    let out = detail.recent.iter().find(|r| r.slot_id == slot.id).unwrap();
    assert_eq!(
        serde_json::to_value(out.metrics).unwrap(),
        json!({"reach":null,"views":400,"engagement":31})
    );
    assert_eq!(detail.totals.views, Some(400));
    assert_eq!(detail.totals.engagement, Some(31));
    assert_eq!(detail.totals.reach, None);
    // A period before the post went out counts none of it.
    let detail = get(
        &w,
        &ctx,
        json!({"capability_id":account,"from":"2026-10-01","until":"2026-10-20"}),
    )
    .await;
    assert_eq!(detail.totals.posts, 0);
    assert_eq!(detail.totals.views, None);
}

#[tokio::test]
async fn an_account_read_refuses_what_it_cannot_answer() {
    let (w, _) = social_world().await;
    let a = agent(&w);
    let account = x_account(&w);
    let ads = connection(&w, "meta_ads", "Reklam hesabı", StoredStatus::Verified).await;
    for (q, field) in [
        (
            json!({"capability_id":account,"from":"2026-10-22","until":"2026-10-21"}),
            "from",
        ),
        (
            json!({"capability_id":account,"from":"2025-10-01","until":"2026-10-22"}),
            "from",
        ),
    ] {
        let e = social::account_get(&w.d, &a, input(q)).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
        assert_eq!(e.details["field"], field);
    }
    // The longest period is taken.
    get(
        &w,
        &a,
        json!({"capability_id":account,"from":"2025-10-22","until":"2026-10-22"}),
    )
    .await;
    // An ad account and an unknown id are not social accounts.
    for id in [ads, CapabilityId::new_v7()] {
        let e = social::account_get(&w.d, &a, input(json!({"capability_id":id})))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    }
    // Reading is the module's work permission.
    let mut bare = a.clone();
    bare.permissions.retain(|p| *p != Permission::SocialWork);
    assert_eq!(
        social::accounts_list(&w.d, &bare, input(json!({})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        social::account_get(&w.d, &bare, input(json!({"capability_id":account})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn a_paused_account_takes_no_post_sends_none_and_resumes_where_it_stopped() {
    let (mut w, x) = social_world().await;
    let a = agent(&w);
    let account = x_account(&w);
    let slot = scheduled(&w, "before-pause", "Yeni sezon başlıyor", WHEN).await;
    let pause = |paused: bool, revision: u64| json!({"capability_id":account,"paused":paused,"expected_revision":revision});

    // Only a person pauses, and against the settings as they stand.
    let e = social::account_pause(&w.d, &a, input(pause(true, 0)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    let e = social::account_pause(&w.d, &w.ctx, input(pause(true, 7)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    let e = social::account_pause(
        &w.d,
        &w.ctx,
        input(json!({"capability_id":CapabilityId::new_v7(),"paused":true,"expected_revision":0})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    assert!(
        w.uow
            .snapshot()
            .posts
            .settings
            .iter()
            .all(|(_, s)| s.paused_capability_ids.is_empty())
    );

    let settings = social::account_pause(&w.d, &w.ctx, input(pause(true, 0)))
        .await
        .unwrap();
    assert_eq!(settings.revision, 1);
    assert!(settings.paused_capability_ids.contains(&account));
    // Pausing a paused account changes nothing and records nothing.
    let again = social::account_pause(&w.d, &w.ctx, input(pause(true, 1)))
        .await
        .unwrap();
    assert_eq!(again.revision, 1);
    let actions = |w: &World| -> Vec<String> {
        w.uow
            .snapshot()
            .ledger
            .iter()
            .map(|l| l.entry.action.as_str().to_owned())
            .filter(|action| action.starts_with("social.account."))
            .collect()
    };
    assert_eq!(actions(&w), ["social.account.paused"]);

    // The account shows as paused; its planned post stays, held.
    let listed = social::accounts_list(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert!(
        listed
            .iter()
            .find(|l| l.capability_id == account)
            .unwrap()
            .paused
    );
    let detail = get(&w, &a, json!({"capability_id":account})).await;
    let u = detail
        .upcoming
        .iter()
        .find(|u| u.slot_id == slot.id)
        .unwrap();
    assert_eq!((u.state, u.waits_for), (UpcomingState::Held, None));

    // Nothing new is planned on it.
    let m = material(&w).await;
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"while-paused","brief":"Atölyeyi anlat","material_ids":[m.id]})),
    )
    .await
    .unwrap();
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
            "request_key":"while-paused-delivery","summary":"Hazır",
            "versions":[{"format":"feed_post","text":"Atölyeden","tags":[],"material_ids":[m.id],
                "hypothesis_id":w.f.slot.chain.hypothesis_id}]})),
    )
    .await
    .unwrap()
    .project;
    let waiting = social::versions_waiting(&w.d, &a, input(json!({})))
        .await
        .unwrap();
    let v = waiting
        .iter()
        .find(|x| x.project_id == p.id)
        .expect("the version waits");
    assert!(
        !v.versions[0].accounts.contains(&account),
        "a paused account is not offered"
    );
    let time = json!({"project_id":p.id,"version_id":p.packages[0].versions[0].id,
        "capability_id":account,"publish_at":"2026-10-25T10:00:00Z","request_key":"paused-time"});
    let e = social::version_schedule(&w.d, &a, input(time.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "package_refused", "{e:?}");
    assert!(
        e.to_string().contains("account_paused")
            || e.details.to_string().contains("account_paused"),
        "{e:?}"
    );

    // Its time comes: nothing goes out, nothing is asked of the platform, and it is no failure.
    w.d.clock = Arc::new(FixedClock(WHEN));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    let s = w.uow.snapshot();
    assert!(!s.studio.publications.iter().any(|p| p.slot_id == slot.id));
    assert!(
        !x.calls()
            .iter()
            .any(|call| matches!(call, ConnectorCall::Publish { .. }))
    );
    // Nor is the paused account's day read.
    assert_eq!(read_days(&w.d, w.f.ws, WHEN).await.unwrap(), 0);
    assert_eq!(account_reads(&x), 0);

    // Resumed within the post's grace: it goes out, once; and the account takes posts again.
    let settings = social::account_pause(&w.d, &w.ctx, input(pause(false, 1)))
        .await
        .unwrap();
    assert_eq!(settings.revision, 2);
    assert!(settings.paused_capability_ids.is_empty());
    assert_eq!(
        actions(&w),
        ["social.account.paused", "social.account.resumed"]
    );
    x.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    let s = w.uow.snapshot();
    assert_eq!(
        s.studio
            .publications
            .iter()
            .filter(|p| p.slot_id == slot.id)
            .count(),
        1
    );
    social::version_schedule(&w.d, &a, input(time))
        .await
        .unwrap();
}

#[tokio::test]
async fn account_snapshots_repository_contract() {
    let (w, _) = social_world().await;
    let second = connection(&w, "instagram", "Atölye IG", StoredStatus::Verified).await;
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    jt_testkit::social_accounts_contract::exercise(
        &w.uow,
        w.f.ws,
        [x_account(&w), second],
        other.ws,
        other.slot.capability_id,
    )
    .await;
}
