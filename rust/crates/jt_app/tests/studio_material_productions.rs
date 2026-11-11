//! External-agent generation must preserve source identity, revision and consent boundaries.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::material_productions::ProductionStatus,
    usecases::studio::{files, library},
};
use jt_ledger::Actor;
use jt_studio::{Depicts, Material, SharePermission};
use jt_tenancy::AgentConnectionId;
use serde_json::{Value, json};
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}
fn agent(w: &World) -> Ctx {
    let connection_id = AgentConnectionId::new_v7();
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}
async fn material(w: &World, name: &str, ai: bool) -> Material {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(name.as_bytes());
    let file=files::file_upload(&w.d,&w.ctx,input(json!({"request_key":format!("file-{name}"),"filename":"source.png","mime":"image/png","content":{"kind":"bytes_base64","data":STANDARD.encode(bytes)}}))).await.unwrap();
    library::material_add(&w.d,&w.ctx,input(json!({"request_key":name,"file_id":file.id,"origin":if ai{json!({"kind":"ai_generated","generator":"external-agent"})}else{json!({"kind":"real"})},"genel":true,"share":"shareable","quality":"publishable","depicts":if ai{json!([])}else{json!(["face"])}}))).await.unwrap().material
}
async fn request(
    w: &World,
    m: &Material,
) -> jt_app::ports::material_productions::MaterialProduction {
    library::material_production_request(&w.d,&w.ctx,input(json!({"request_key":"derivative","kind":"poster","instructions":"Make an event poster from this photo","sources":[{"material_id":m.id,"expected_revision":m.revision}]}))).await.unwrap()
}
#[tokio::test]
async fn generation_keeps_originals_and_requires_new_output_approval() {
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    assert_eq!(
        request(&w, &source).await.id,
        p.id,
        "request replay returns same task"
    );
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let output = material(&w, "output", true).await;
    let other = agent(&w);
    let err=library::material_production_complete(&w.d,&other,input(json!({"production_id":p.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "claim bound to owning agent");
    let done=library::material_production_complete(&w.d,&a,input(json!({"production_id":p.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap();
    assert_eq!(done.status, ProductionStatus::Completed);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.studio_materials()
            .get_material(source.id)
            .await
            .unwrap()
            .unwrap(),
        source
    );
    let derived = r
        .studio_materials()
        .get_material(output.id)
        .await
        .unwrap()
        .unwrap();
    assert!(derived.share.is_none());
    assert!(derived.tags_reviewed_by.is_none());
    assert!(derived.tags.depicts.contains(&Depicts::Face));
    assert!(derived.captured_at.is_none());
}
#[tokio::test]
async fn stale_sources_and_human_claims_are_refused() {
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    assert_eq!(
        library::material_production_claim(
            &w.d,
            &w.ctx,
            input(json!({"production_id":p.id,"expected_revision":p.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
    library::material_permission(&w.d,&w.ctx,input(json!({"material_id":source.id,"expected_revision":source.revision,"permission":"not_shareable"}))).await.unwrap();
    assert_eq!(
        library::material_production_claim(
            &w.d,
            &agent(&w),
            input(json!({"production_id":p.id,"expected_revision":p.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
}
#[tokio::test]
async fn revoked_source_blocks_even_reapproved_output_and_erasure_redacts_requests() {
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let output = material(&w, "output", true).await;
    library::material_production_complete(&w.d,&a,input(json!({"production_id":p.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap();
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.studio_control().lock_control().await.unwrap();
    let mut changed = source.clone();
    changed.share.as_mut().unwrap().permission = SharePermission::NotShareable;
    changed.revision += 1;
    r.studio_materials()
        .update_material(changed, source.revision)
        .await
        .unwrap();
    assert!(
        library::blocked_derivatives(r.as_mut())
            .await
            .unwrap()
            .contains(&output.id)
    );
    library::invalidate_material_productions(r.as_mut(), source.id, w.ctx.now, true)
        .await
        .unwrap();
    let stored = r
        .studio_productions()
        .get_production(p.id)
        .await
        .unwrap()
        .unwrap();
    assert!(stored.production.instructions.is_empty());
    assert!(stored.lease.is_none());
    assert!(
        r.studio_materials()
            .get_material(output.id)
            .await
            .unwrap()
            .unwrap()
            .share
            .is_none()
    );
    r.commit().await.unwrap();
}
#[tokio::test]
async fn agents_cannot_request_and_duplicate_sources_are_rejected() {
    let (w, _) = publishing_world().await;
    let m = material(&w, "source", false).await;
    let v = json!({"request_key":"x","kind":"crop","instructions":"crop to square","sources":[{"material_id":m.id,"expected_revision":m.revision}]});
    assert_eq!(
        library::material_production_request(&w.d, &agent(&w), input(v.clone()))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    let mut duplicated = v;
    duplicated["sources"]
        .as_array_mut()
        .unwrap()
        .push(json!({"material_id":m.id,"expected_revision":m.revision}));
    assert_eq!(
        library::material_production_request(&w.d, &w.ctx, input(duplicated))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
}

#[tokio::test]
async fn source_analysis_revision_change_ends_the_task_instead_of_polling_forever() {
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.studio_control().lock_control().await.unwrap();
    let mut changed = source.clone();
    changed.title = "analyzed title".into();
    changed.revision += 1;
    r.studio_materials()
        .update_material(changed, source.revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let error = library::material_production_claim(
        &w.d,
        &agent(&w),
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let row = r
        .studio_productions()
        .get_production(p.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.production.status, ProductionStatus::Failed);
    assert_eq!(
        row.production.last_error_code.as_deref(),
        Some("source_changed")
    );
    assert!(!row.claimable(w.ctx.now));
}

#[tokio::test]
async fn setting_a_derivative_permission_does_not_rewrite_its_own_result() {
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let output = material(&w, "output", true).await;
    library::material_production_complete(&w.d, &a, input(json!({"production_id":p.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap();
    let changed = library::material_permission(&w.d, &w.ctx, input(json!({"material_id":output.id,"expected_revision":output.revision+1,"permission":"not_shareable"}))).await.unwrap();
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let stored = r
        .studio_materials()
        .get_material(output.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        changed, stored,
        "returned material must reflect exact stored revision and permission"
    );
    assert_eq!(
        stored.share.unwrap().permission,
        SharePermission::NotShareable
    );
}

#[tokio::test]
async fn linking_derivative_resets_old_analysis_and_cancels_downstream_requests() {
    use jt_app::ports::materials::{AnalysisStatus, DateSource};
    let (w, _) = publishing_world().await;
    let source = material(&w, "source", false).await;
    let p = request(&w, &source).await;
    let a = agent(&w);
    let claim = library::material_production_claim(
        &w.d,
        &a,
        input(json!({"production_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let output = material(&w, "output", true).await;
    let output = library::material_tag(&w.d, &w.ctx, input(json!({"material_id":output.id,"expected_revision":output.revision,"captured_at":"2026-10-10T12:00:00Z"}))).await.unwrap();
    let downstream = library::material_production_request(&w.d, &w.ctx, input(json!({"request_key":"downstream","kind":"crop","instructions":"crop output","sources":[{"material_id":output.id,"expected_revision":output.revision}]}))).await.unwrap();
    let old_claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":output.id,"expected_revision":output.revision})),
    )
    .await
    .unwrap();
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let mut meta = r
        .studio_materials()
        .get_intelligence(output.id)
        .await
        .unwrap()
        .unwrap();
    meta.intelligence.description = "Owner correction".into();
    meta.intelligence.group_name = Some("Campaign".into());
    meta.intelligence
        .manual_fields
        .extend(["description".into(), "group_name".into()]);
    r.studio_materials().save_intelligence(meta).await.unwrap();
    r.commit().await.unwrap();
    library::material_production_complete(&w.d, &a, input(json!({"production_id":p.id,"expected_revision":claim.production.revision,"claim_token":claim.claim_token,"output_material_id":output.id}))).await.unwrap();
    let updated =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":output.id})))
            .await
            .unwrap();
    assert_eq!(updated.intelligence.status, AnalysisStatus::Pending);
    assert_eq!(updated.intelligence.date_source, DateSource::Unknown);
    assert!(updated.material.captured_at.is_none());
    assert!(updated.intelligence.analyzed_revision.is_none());
    assert!(updated.intelligence.analyzed_at.is_none());
    assert_eq!(updated.intelligence.description, "Owner correction");
    assert_eq!(updated.intelligence.group_name.as_deref(), Some("Campaign"));
    assert!(updated.intelligence.manual_fields.contains("captured_at"));
    let stale = library::material_analysis_complete(&w.d, &a, input(json!({"material_id":output.id,"expected_revision":updated.material.revision,"claim_token":old_claim.claim_token,"description":"stale","labels":[],"date_source":"unknown"}))).await.unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.studio_productions()
            .get_production(downstream.id)
            .await
            .unwrap()
            .unwrap()
            .production
            .status,
        ProductionStatus::Cancelled
    );
    drop(r);
    let new_claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":output.id,"expected_revision":updated.material.revision})),
    )
    .await
    .unwrap();
    let analyzed = library::material_analysis_complete(&w.d, &a, input(json!({"material_id":output.id,"expected_revision":updated.material.revision,"claim_token":new_claim.claim_token,"description":"fresh","labels":[],"captured_at":"2026-10-10T12:00:00Z","date_source":"agent_inferred"}))).await.unwrap();
    assert!(analyzed.material.captured_at.is_none());
    assert_eq!(analyzed.intelligence.date_source, DateSource::Unknown);
    assert_eq!(analyzed.intelligence.description, "Owner correction");
}
