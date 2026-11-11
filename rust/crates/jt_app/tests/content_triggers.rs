//! With the content module installed the planner's triggers open production areas (design
//! 2026-11-10 §6.3): an olay's new materials, a special day within its lead and a quiet channel
//! each give an agent an area to work, and nobody is asked for a package of posts. Without the
//! module the same triggers ask for posts as before (`studio_posts`).
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{
        UnitOfWork,
        files::StoredFile,
        posts::{PackageStatus, PackageTrigger},
        production_projects::*,
    },
    usecases::{
        modules,
        studio::{library, planner, work as studio_work},
        work::{self, WorkKind},
    },
};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::AgentConnectionId;
use jt_testkit::fakes::{FIXED_NOW, files::MemoryFiles};
use serde_json::json;
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// The Studio world (every module installed) with a real file store and an empty library.
async fn content_world() -> World {
    let mut w = world().await;
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    w
}

fn minutes(n: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(n)
}

async fn workshop(w: &World) -> Olay {
    let o = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials().insert_olay(o.clone()).await.unwrap();
    r.commit().await.unwrap();
    o
}

/// A shareable, publishable image of `olay`, added at `at`.
async fn material(w: &World, olay: &Olay, at: OffsetDateTime) -> Material {
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
    let mut m = jt_testkit::studio_contract::eligible_material(olay, file.id);
    m.created_at = at;
    if let Some(share) = &mut m.share {
        share.at = at;
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

async fn plan(w: &World, at: OffsetDateTime) {
    planner::plan(&w.d, w.f.ws, at).await.unwrap();
}

/// The areas the system opened by `trigger`, oldest first.
fn opened(w: &World, trigger: AreaTrigger) -> Vec<ProductionProject> {
    let mut areas: Vec<_> = w
        .uow
        .snapshot()
        .production_projects
        .into_iter()
        .filter(|p| {
            p.workspace_id == w.f.ws
                && matches!(&p.opened_by, OpenedBy::System { trigger: t, .. } if *t == trigger)
        })
        .collect();
    areas.sort_by_key(|p| (p.created_at, p.id));
    areas
}

fn agent_at(w: &World, now: OffsetDateTime) -> jt_app::ctx::Ctx {
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let connection_id = AgentConnectionId::new_v7();
    jt_app::ctx::Ctx {
        actor: Actor::Agent {
            user_id,
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        now,
        ..w.ctx.clone()
    }
}

#[tokio::test]
async fn an_olays_new_materials_open_one_area_for_an_agent_and_ask_nobody_for_posts() {
    let w = content_world().await;
    let o = workshop(&w).await;
    let first = material(&w, &o, minutes(0)).await;
    let second = material(&w, &o, minutes(1)).await;
    // Still settling: nothing yet. Half an hour after the last change: one area.
    plan(&w, minutes(20)).await;
    assert!(opened(&w, AreaTrigger::Olay).is_empty());
    plan(&w, minutes(31)).await;
    let areas = opened(&w, AreaTrigger::Olay);
    assert_eq!(areas.len(), 1);
    let area = &areas[0];
    assert_eq!(
        area.brief,
        "“Atölye” olayının yeni materyallerinden paylaşım hazırla"
    );
    assert_eq!(area.start_at, Some(minutes(31)));
    assert_eq!(
        area.sources
            .iter()
            .map(|s| s.material_id)
            .collect::<Vec<_>>(),
        [first.id, second.id]
    );
    assert_eq!(area.hints.formats.first(), Some(&PostFormat::FeedPost));
    assert!(area.needs_agent(minutes(31)));

    // The request is kept as the record of what was asked for, answered at once: no agent is
    // asked for posts, and the area is the content agent's work.
    let s = w.uow.snapshot();
    let request = s
        .posts
        .requests
        .iter()
        .find(|q| q.trigger == PackageTrigger::Olay)
        .expect("the trigger's record");
    assert_eq!(request.status, PackageStatus::Answered);
    let OpenedBy::System { key, .. } = &area.opened_by else {
        panic!()
    };
    assert_eq!(&request.key, key);
    let a = agent_at(&w, minutes(31));
    assert!(
        studio_work::pending(&w.d, &a)
            .await
            .unwrap()
            .post_requests
            .is_empty()
    );
    let items = work::pending(&w.d, &a).await.unwrap().items;
    assert!(items.iter().any(
        |i| matches!(i.kind, WorkKind::ContentArea { project_id, .. } if project_id == area.id)
    ));
    assert!(
        !items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::StudioPostRequest { .. }))
    );

    // Later runs open nothing twice; a new material, once settled, opens an area of its own.
    plan(&w, minutes(60)).await;
    plan(&w, minutes(300)).await;
    assert_eq!(opened(&w, AreaTrigger::Olay).len(), 1);
    let third = material(&w, &o, minutes(310)).await;
    plan(&w, minutes(341)).await;
    let areas = opened(&w, AreaTrigger::Olay);
    assert_eq!(areas.len(), 2);
    assert_eq!(
        areas[1]
            .sources
            .iter()
            .map(|s| s.material_id)
            .collect::<Vec<_>>(),
        [third.id]
    );
}

#[tokio::test]
async fn a_quiet_channel_gets_one_area_until_it_is_made_and_no_one_is_asked_to_shoot() {
    let w = content_world().await;
    // No material at all: the agent may make the visual itself (the setting is on).
    plan(&w, minutes(0)).await;
    let areas = opened(&w, AreaTrigger::Floor);
    assert_eq!(areas.len(), 1);
    let area = &areas[0];
    assert!(area.sources.is_empty());
    assert_eq!(area.hints.capability_ids, [w.f.slot.capability_id]);
    assert!(
        area.brief
            .ends_with("hesabında henüz paylaşım yok; ilk paylaşımı hazırla"),
        "{}",
        area.brief
    );
    let unfilled = |w: &World| {
        w.uow
            .snapshot()
            .materials
            .shoot_requests
            .iter()
            .filter(|q| matches!(q.reason, ShootReason::SlotUnfilled { .. }))
            .count()
    };
    assert_eq!(unfilled(&w), 0);
    // The days go by and the area is not finished: the channel asks for no second one.
    for day in 1..=3 {
        plan(&w, FIXED_NOW + Duration::days(day)).await;
    }
    assert_eq!(opened(&w, AreaTrigger::Floor).len(), 1);

    // Where the workspace wants a real capture in every content, the channel asks for one.
    let w = content_world().await;
    library::material_policy_set(
        &w.d,
        &w.ctx,
        serde_json::from_value(
            json!({"lead_days":21,"reuse_days":14,"recap_days":30,"ai_standalone":false}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    plan(&w, minutes(0)).await;
    assert!(opened(&w, AreaTrigger::Floor).is_empty());
    assert_eq!(unfilled(&w), 1);
}

#[tokio::test]
async fn without_the_social_module_materials_still_open_areas_and_no_channel_is_watched() {
    let w = content_world().await;
    modules::remove(&w.d, &w.ctx, modules::SOCIAL)
        .await
        .unwrap();
    let o = workshop(&w).await;
    material(&w, &o, minutes(0)).await;
    plan(&w, minutes(31)).await;
    assert_eq!(opened(&w, AreaTrigger::Olay).len(), 1);
    assert!(opened(&w, AreaTrigger::Floor).is_empty());
    // A person's brake stops the triggers altogether.
    let w = content_world().await;
    jt_app::usecases::studio::control::brake(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"engaged":true,"lane":"organic","expected_revision":0}))
            .unwrap(),
    )
    .await
    .unwrap();
    let o = workshop(&w).await;
    material(&w, &o, minutes(0)).await;
    plan(&w, minutes(31)).await;
    assert!(opened(&w, AreaTrigger::Olay).is_empty());
    assert!(opened(&w, AreaTrigger::Floor).is_empty());
}
