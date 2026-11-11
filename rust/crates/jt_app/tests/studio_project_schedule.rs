//! Project scheduling commits the output link and the canonical post together, without
//! weakening existing publishing gates or creating a parallel scheduler.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, production_projects::ProductionProject},
    usecases::studio::{project_schedule::*, projects},
};
use jt_studio::{Binding, HumanMark, Material, PackageTrigger, SlotState};
use jt_tenancy::{Permission, UserId};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::{World, world};
use time::Duration;

async fn prepared() -> (World, ProductionProject, Material) {
    let w = world().await;
    let mut material = jt_testkit::studio_contract::seed_material(&w.uow, w.f.ws).await;
    material.binding = Binding::Genel;
    material.freed = Some(HumanMark {
        by: UserId::new_v7(),
        at: FIXED_NOW,
    });
    material.revision += 1;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .update_material(material.clone(), material.revision - 1)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let project = projects::project_create(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "request_key":"schedule-project","title":"New product", "brief":"Show the product",
            "material_ids":[material.id]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let project = projects::project_update(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "project_id":project.id,"expected_revision":project.revision,
            "outputs":[{"title":"Product post","format":"feed_post",
                "target_at":(FIXED_NOW+Duration::days(2)).format(&time::format_description::well_known::Rfc3339).unwrap(),
                "capability_id":w.f.slot.capability_id}]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    (w, project, material)
}

fn input(w: &World, p: &ProductionProject, m: &Material) -> ProjectScheduleInput {
    ProjectScheduleInput {
        project_id: p.id,
        output_id: p.outputs[0].id,
        expected_revision: p.revision,
        request_key: "schedule-output".into(),
        hypothesis_id: w.f.slot.chain.hypothesis_id,
        content_type: Some("text".into()),
        material_ids: vec![m.id],
    }
}

#[tokio::test]
async fn schedules_real_canonical_post_and_replays_without_duplicate() {
    let (w, p, m) = prepared().await;
    let i = input(&w, &p, &m);
    let out = project_schedule(&w.d, &w.ctx, i.clone()).await.unwrap();
    assert_eq!(out.project.revision, p.revision + 1);
    assert_eq!(
        out.project.outputs[0].slot_id,
        Some(out.publication.slot.id)
    );
    assert_eq!(out.publication.slot.state, SlotState::Planned);
    assert_eq!(out.publication.post.material_ids, vec![m.id]);
    assert_eq!(
        out.publication.post.publish_at,
        p.outputs[0].target_at.unwrap()
    );
    let replay = project_schedule(&w.d, &w.ctx, i.clone()).await.unwrap();
    assert_eq!(replay.publication.slot.id, out.publication.slot.id);
    let state = w.uow.snapshot();
    assert_eq!(state.posts.posts.len(), 1);
    assert_eq!(state.posts.requests.len(), 1);
    assert_eq!(state.posts.requests[0].trigger, PackageTrigger::Project);
    let mut again = i;
    again.request_key = "another-request".into();
    again.expected_revision = out.project.revision;
    let error = project_schedule(&w.d, &w.ctx, again).await.unwrap_err();
    assert_eq!(error.details["reason"], "project_output_already_scheduled");
    assert_eq!(w.uow.snapshot().posts.posts.len(), 1);
}

#[tokio::test]
async fn rejects_stale_project_and_source_before_scheduling() {
    let (w, p, mut m) = prepared().await;
    let mut stale = input(&w, &p, &m);
    stale.expected_revision -= 1;
    assert_eq!(
        project_schedule(&w.d, &w.ctx, stale)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let before = m.revision;
    m.revision += 1;
    m.title = "Updated after project selected it".into();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .update_material(m.clone(), before)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let error = project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
        .await
        .unwrap_err();
    assert_eq!(error.details["reason"], "project_source_changed");
    assert!(w.uow.snapshot().posts.posts.is_empty());
    assert!(w.uow.snapshot().posts.requests.is_empty());
}

#[tokio::test]
async fn existing_material_gate_refusal_rolls_back_request_and_project_link() {
    let (w, p, mut m) = prepared().await;
    let before = m.revision;
    m.revision += 1;
    m.share = None;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .update_material(m.clone(), before)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let p = projects::project_materials(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "project_id":p.id,"expected_revision":p.revision,"add":[m.id]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let error = project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
        .await
        .unwrap_err();
    assert_eq!(error.details["reason"], "package_refused");
    assert!(w.uow.snapshot().posts.posts.is_empty());
    assert!(w.uow.snapshot().posts.requests.is_empty());
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let stored = r
        .studio_projects()
        .get_project(p.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.revision, p.revision);
    assert_eq!(stored.outputs[0].slot_id, None);
}

#[tokio::test]
async fn refuses_other_tenant_and_missing_manage_permission() {
    let (w, p, m) = prepared().await;
    let mut ctx = w.ctx.clone();
    ctx.permissions.remove(&Permission::SocialManage);
    assert_eq!(
        project_schedule(&w.d, &ctx, input(&w, &p, &m))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    let mut ctx = w.ctx.clone();
    ctx.workspace_id = other.ws;
    assert_eq!(
        project_schedule(&w.d, &ctx, input(&w, &p, &m))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert!(w.uow.snapshot().posts.posts.is_empty());
}

#[tokio::test]
async fn rejects_unspecified_target_and_archived_project() {
    let (w, p, m) = prepared().await;
    let p = projects::project_update(&w.d, &w.ctx, serde_json::from_value(json!({
        "project_id":p.id,"expected_revision":p.revision,
        "outputs":[{"id":p.outputs[0].id,"title":"Draft","format":"feed_post","capability_id":null}]
    })).unwrap()).await.unwrap();
    let error = project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
        .await
        .unwrap_err();
    assert_eq!(error.details["reason"], "project_output_channel_required");
    let p = projects::project_update(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "project_id":p.id,"expected_revision":p.revision,"archived":true
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(w.uow.snapshot().posts.requests.is_empty());
}

#[tokio::test]
async fn canonical_lead_time_and_strategy_gates_still_apply() {
    let (w, p, m) = prepared().await;
    let p = projects::project_update(&w.d, &w.ctx, serde_json::from_value(json!({
        "project_id":p.id,"expected_revision":p.revision,
        "outputs":[{"id":p.outputs[0].id,"title":"Too soon","format":"feed_post",
            "target_at":(FIXED_NOW+Duration::minutes(1)).format(&time::format_description::well_known::Rfc3339).unwrap(),
            "capability_id":w.f.slot.capability_id}]
    })).unwrap()).await.unwrap();
    let error = project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
        .await
        .unwrap_err();
    assert_eq!(error.details["reason"], "package_refused");
    assert_eq!(error.details["items"][0]["reason"], "lead_too_short");
    assert!(w.uow.snapshot().posts.requests.is_empty());
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.strategy()
        .set_status(
            w.current,
            jt_strategy::VersionStatus::Archived,
            FIXED_NOW,
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        project_schedule(&w.d, &w.ctx, input(&w, &p, &m))
            .await
            .unwrap_err()
            .code,
        ErrorCode::StrategyRequired
    );
    assert!(w.uow.snapshot().posts.posts.is_empty());
}
