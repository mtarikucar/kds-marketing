//! Project preparation is durable, revisioned and never grants publication permission.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{material_productions::ProductionStatus, production_projects::ProductionProject},
    usecases::studio::{files, library, projects},
};
use jt_ledger::Actor;
use jt_studio::Material;
use jt_tenancy::{AgentConnectionId, Permission};
use serde_json::{Value, json};
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}
async fn create(w: &World, key: &str) -> ProductionProject {
    projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"title":"Launch","brief":"Real product details"})),
    )
    .await
    .unwrap()
}
async fn material(w: &World, key: &str) -> Material {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(key.as_bytes());
    let f=files::file_upload(&w.d,&w.ctx,input(json!({"request_key":format!("file-{key}"),"filename":"source.png","mime":"image/png","content":{"kind":"bytes_base64","data":STANDARD.encode(bytes)}}))).await.unwrap();
    library::material_add(&w.d,&w.ctx,input(json!({"request_key":key,"file_id":f.id,"origin":{"kind":"ai_generated","generator":"fixture"},"genel":true,"share":"shareable","depicts":[]}))).await.unwrap().material
}
async fn attach(w: &World, p: &ProductionProject, m: &Material) -> ProductionProject {
    projects::project_materials(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"add":[m.id]})),
    )
    .await
    .unwrap()
}
fn agent(w: &World) -> Ctx {
    let id = AgentConnectionId::new_v7();
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    Ctx {
        actor: Actor::Agent {
            connection_id: id,
            user_id,
        },
        agent_connection_id: Some(id),
        ..w.ctx.clone()
    }
}
#[tokio::test]
async fn idempotent_creation_revision_conflicts_and_manage_permission() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "same").await;
    assert_eq!(create(&w, "same").await, p);
    let updated = projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"brief":"Updated"})),
    )
    .await
    .unwrap();
    assert_eq!(updated.revision, 2);
    let e = projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"brief":"stale"})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let mut read = w.ctx.clone();
    read.permissions.remove(&Permission::ContentManage);
    assert!(
        projects::project_get(&w.d, &read, projects::ProjectIdInput { project_id: p.id })
            .await
            .is_ok()
    );
    assert_eq!(
        projects::project_create(
            &w.d,
            &read,
            input(json!({"request_key":"refused","title":"X","brief":""}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
}
#[tokio::test]
async fn a_request_needs_real_delivery_and_replay_does_not_duplicate() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "request-project").await;
    let v = json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"need","text":"Upload the close-up"});
    let p = projects::project_request(&w.d, &w.ctx, input(v.clone()))
        .await
        .unwrap();
    assert_eq!(
        projects::project_request(&w.d, &w.ctx, input(v))
            .await
            .unwrap()
            .requests
            .len(),
        1
    );
    let q = p.requests[0].id;
    let v = json!({"project_id":p.id,"request_id":q,"expected_revision":p.revision,"status":"done","material_ids":[]});
    assert_eq!(
        projects::project_request_update(&w.d, &w.ctx, input(v))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let m = material(&w, "delivered").await;
    let p=projects::project_request_update(&w.d,&w.ctx,input(json!({"project_id":p.id,"request_id":q,"expected_revision":p.revision,"status":"done","material_ids":[m.id]}))).await.unwrap();
    assert_eq!(p.requests[0].material_ids, vec![m.id]);
    assert!(p.requests[0].resolved_at.is_some());
    assert_eq!(p.sources[0].revision, m.revision);
}
#[tokio::test]
async fn source_removal_cancels_owned_production_and_revokes_lease_atomically() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "source").await;
    let p = attach(&w, &create(&w, "edit-project").await, &m).await;
    let request = json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"edit","kind":"crop","instructions":"Square crop","material_ids":[m.id]});
    let out = projects::project_production(&w.d, &w.ctx, input(request.clone()))
        .await
        .unwrap();
    let again = projects::project_production(&w.d, &w.ctx, input(request))
        .await
        .unwrap();
    assert_eq!(out.production.id, again.production.id);
    assert_eq!(again.project.production_ids.len(), 1);
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(
            json!({"production_id":out.production.id,"expected_revision":out.production.revision}),
        ),
    )
    .await
    .unwrap();
    let p=projects::project_materials(&w.d,&w.ctx,input(json!({"project_id":out.project.id,"expected_revision":out.project.revision,"remove":[m.id]}))).await.unwrap();
    assert!(p.sources.is_empty());
    assert_eq!(p.invalidated_production_ids, vec![out.production.id]);
    let detail = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap();
    assert_eq!(detail.productions[0].status, ProductionStatus::Cancelled);
    assert_eq!(library::material_production_complete(&w.d,&a,input(json!({"production_id":out.production.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":m.id}))).await.unwrap_err().code,ErrorCode::Conflict);
}
#[tokio::test]
async fn archive_cancels_pending_generation_and_only_explicit_unarchive_allows_edit() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "archive-source").await;
    let p = attach(&w, &create(&w, "archive").await, &m).await;
    let o=projects::project_production(&w.d,&w.ctx,input(json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"archive-edit","kind":"edit","instructions":"Adjust light","material_ids":[m.id]}))).await.unwrap();
    let p = projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":o.project.revision,"archived":true})),
    )
    .await
    .unwrap();
    assert!(p.archived);
    let d = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap();
    assert_eq!(d.productions[0].status, ProductionStatus::Cancelled);
    assert_eq!(
        projects::project_update(
            &w.d,
            &w.ctx,
            input(json!({"project_id":p.id,"expected_revision":p.revision,"title":"Cannot edit"}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    let p = projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"archived":false})),
    )
    .await
    .unwrap();
    assert!(!p.archived);
}
#[tokio::test]
async fn cursor_pages_do_not_hide_older_active_projects() {
    let (w, _) = publishing_world().await;
    for i in 0..101 {
        create(&w, &format!("page-{i}")).await;
    }
    let a = projects::project_list(&w.d, &w.ctx, input(json!({})))
        .await
        .unwrap();
    assert_eq!(a.projects.len(), 100);
    let b = projects::project_list(
        &w.d,
        &w.ctx,
        input(json!({"before":a.next_cursor.unwrap()})),
    )
    .await
    .unwrap();
    assert_eq!(b.projects.len(), 1);
    assert!(b.next_cursor.is_none());
    assert!(!a.projects.iter().any(|p| p.id == b.projects[0].id));
}
#[tokio::test]
async fn failed_production_link_leaves_no_orphan_job() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "no-source").await;
    let m = material(&w, "unattached").await;
    assert_eq!(projects::project_production(&w.d,&w.ctx,input(json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"unattached-edit","kind":"edit","instructions":"Edit","material_ids":[m.id]}))).await.unwrap_err().code,ErrorCode::Validation);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert!(
        r.studio_productions()
            .list_productions()
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        r.studio_projects()
            .get_project(p.id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        p.revision
    );
}
#[tokio::test]
async fn agent_cannot_create_derivative_by_project_route() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "agent-source").await;
    let p = attach(&w, &create(&w, "agent-project").await, &m).await;
    let a = agent(&w);
    let e=projects::project_production(&w.d,&a,input(json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"agent-edit","kind":"edit","instructions":"Edit","material_ids":[m.id]}))).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn stale_attached_revision_requires_explicit_refresh_before_generation() {
    let (w, _) = publishing_world().await;
    let mut m = material(&w, "stale-source").await;
    let p = attach(&w, &create(&w, "stale-project").await, &m).await;
    let old = m.revision;
    m.revision += 1;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.studio_materials()
        .update_material(m.clone(), old)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let req = json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"stale-edit","kind":"crop","instructions":"Square crop","material_ids":[m.id]});
    assert!(
        projects::project_production(&w.d, &w.ctx, input(req))
            .await
            .is_err()
    );
    let p = attach(&w, &p, &m).await;
    let req = json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"fresh-edit","kind":"crop","instructions":"Square crop","material_ids":[m.id]});
    assert!(
        projects::project_production(&w.d, &w.ctx, input(req))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn completed_derivative_becomes_history_after_brief_change() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "history-source").await;
    let p = attach(&w, &create(&w, "history-project").await, &m).await;
    let o=projects::project_production(&w.d,&w.ctx,input(json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"history-edit","kind":"crop","instructions":"Square crop","material_ids":[m.id]}))).await.unwrap();
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":o.production.id,"expected_revision":o.production.revision})),
    )
    .await
    .unwrap();
    let output = material(&w, "history-output").await;
    library::material_production_complete(&w.d,&a,input(json!({"production_id":o.production.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap();
    let p=projects::project_update(&w.d,&w.ctx,input(json!({"project_id":p.id,"expected_revision":o.project.revision,"brief":"Use the revised brand message"}))).await.unwrap();
    assert_eq!(p.invalidated_production_ids, vec![o.production.id]);
    let detail = projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: p.id })
        .await
        .unwrap();
    assert_eq!(detail.productions[0].status, ProductionStatus::Completed);
    assert!(detail.materials.iter().any(|m| m.id == output.id));
    let req = json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"history-reuse","kind":"edit","instructions":"Reuse old result","material_ids":[output.id]});
    assert_eq!(
        projects::project_production(&w.d, &w.ctx, input(req))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
}

#[tokio::test]
async fn archive_revokes_an_inflight_external_worker_lease() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "inflight-source").await;
    let p = attach(&w, &create(&w, "inflight-project").await, &m).await;
    let o=projects::project_production(&w.d,&w.ctx,input(json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"inflight-edit","kind":"crop","instructions":"Square crop","material_ids":[m.id]}))).await.unwrap();
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":o.production.id,"expected_revision":o.production.revision})),
    )
    .await
    .unwrap();
    projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":o.project.revision,"archived":true})),
    )
    .await
    .unwrap();
    let output = material(&w, "inflight-output").await;
    assert_eq!(library::material_production_complete(&w.d,&a,input(json!({"production_id":o.production.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap_err().code,ErrorCode::Conflict);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let row = r
        .studio_productions()
        .get_production(o.production.id)
        .await
        .unwrap()
        .unwrap();
    assert!(row.lease.is_none());
    assert!(!row.claimable(w.ctx.now));
}

#[tokio::test]
async fn pending_project_work_respects_work_permission_and_archival() {
    use jt_app::usecases::work::{self, WorkKind};
    let (w, _) = publishing_world().await;
    let p = create(&w, "work-project").await;
    let a = agent(&w);
    let pending = work::pending(&w.d, &a).await.unwrap();
    assert!(
        pending
            .items
            .iter()
            .any(|i| matches!(i.kind,WorkKind::ContentArea{project_id,..} if project_id==p.id))
    );
    let mut read = a.clone();
    read.permissions.remove(&Permission::ContentWork);
    assert!(
        !work::pending(&w.d, &read)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentArea { .. }))
    );
    projects::project_update(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"archived":true})),
    )
    .await
    .unwrap();
    assert!(
        !work::pending(&w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentArea { .. }))
    );
}
