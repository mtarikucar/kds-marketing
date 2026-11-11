//! Analysis work is leased to external agents; stale analysis cannot overwrite human corrections.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{UnitOfWork, materials::*},
    usecases::studio::{files, library},
};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, FixedTokenGen};
use serde_json::{Value, json};
use std::sync::Arc;
use time::Duration;
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}
async fn setup() -> (World, Ctx, Material) {
    let (mut w, _) = publishing_world().await;
    w.d.tokens = Arc::new(FixedTokenGen::new(
        (0..20).map(|n| format!("analysis-token-{n}")),
    ));
    let connection_id = AgentConnectionId::new_v7();
    let user_id = match w.ctx.actor {
        Actor::Human { user_id } => user_id,
        _ => unreachable!(),
    };
    let ctx = Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    };
    let file = files::file_upload(&w.d, &w.ctx, input(json!({"request_key":"analysis-upload","filename":"test.png","mime":"image/png","content":{"kind":"bytes_base64","data":"iVBORw0KGgpzbW9rZQ=="}}))).await.unwrap();
    let material = library::material_add(&w.d, &w.ctx, input(json!({"request_key":"analysis-material","file_id":file.id,"origin":{"kind":"real"},"genel":true,"share":"shareable","quality":"publishable"}))).await.unwrap().material;
    (w, ctx, material)
}
async fn claim(w: &World, ctx: &Ctx, m: &Material) -> library::MaterialAnalysisClaimOut {
    library::material_analysis_claim(
        &w.d,
        ctx,
        input(json!({"material_id":m.id,"expected_revision":m.revision})),
    )
    .await
    .unwrap()
}
fn complete(c: &library::MaterialAnalysisClaimOut) -> library::MaterialAnalysisCompleteInput {
    input(
        json!({"material_id":c.material.id,"expected_revision":c.expected_revision,"claim_token":c.claim_token,
        "title":"Observed photo","description":"Two ceramics on a table","labels":[" CERAMICS ","ceramics","Table"],"group_name":"Product photography","date_source":"unknown","quality":"publishable"}),
    )
}
#[tokio::test]
async fn upload_queues_external_work_and_completion_normalizes_results_without_creating_events() {
    let (w, ctx, m) = setup().await;
    let olay_count = w.uow.snapshot().materials.olays.len();
    let before =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap();
    assert_eq!(before.intelligence.status, AnalysisStatus::Pending);
    assert_eq!(w.uow.snapshot().materials.intelligence.len(), 1);
    let c = claim(&w, &ctx, &m).await;
    assert_eq!(c.intelligence.status, AnalysisStatus::Running);
    assert_eq!(c.lease_expires_at, ctx.now + Duration::minutes(10));
    assert!(!c.preview.url.is_empty());
    let public = serde_json::to_string(
        &library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!public.contains("claim_token"));
    assert!(!public.contains("token_hash"));
    assert!(!public.contains(&c.claim_token));
    let result = library::material_analysis_complete(&w.d, &ctx, complete(&c))
        .await
        .unwrap();
    assert_eq!(
        result.material.tags.labels,
        ["ceramics".to_owned(), "table".to_owned()].into()
    );
    assert_eq!(result.material.title, "Observed photo");
    assert_eq!(result.material.revision, m.revision + 1);
    assert_eq!(result.intelligence.status, AnalysisStatus::Completed);
    assert_eq!(
        result.intelligence.group_name.as_deref(),
        Some("Product photography")
    );
    assert_eq!(w.uow.snapshot().materials.olays.len(), olay_count);
    assert_eq!(
        library::material_analysis_complete(&w.d, &ctx, complete(&c))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}
#[tokio::test]
async fn claim_is_agent_bound_and_manual_changes_revoke_it_without_losing_corrections() {
    let (w, ctx, m) = setup().await;
    assert_eq!(
        library::material_analysis_claim(
            &w.d,
            &w.ctx,
            input(json!({"material_id":m.id,"expected_revision":m.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
    let c = claim(&w, &ctx, &m).await;
    let other = Ctx {
        agent_connection_id: Some(AgentConnectionId::new_v7()),
        ..ctx.clone()
    };
    assert_eq!(
        library::material_analysis_complete(&w.d, &other, complete(&c))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let corrected=library::material_tag(&w.d,&w.ctx,input(json!({"material_id":m.id,"expected_revision":m.revision,"title":"Owner correction","labels":["approved category"]}))).await.unwrap();
    assert_eq!(
        library::material_analysis_complete(&w.d, &ctx, complete(&c))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let current =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap();
    assert_eq!(current.material.title, "Owner correction");
    assert_eq!(current.intelligence.status, AnalysisStatus::Pending);
    assert!(current.intelligence.manual_fields.contains("title"));
    let fresh = claim(&w, &ctx, &corrected).await;
    let result = library::material_analysis_complete(&w.d, &ctx, complete(&fresh))
        .await
        .unwrap();
    assert_eq!(result.material.title, "Owner correction");
    assert_eq!(
        result.material.tags.labels,
        ["approved category".to_owned()].into()
    );
}
#[tokio::test]
async fn human_metadata_and_capture_corrections_before_claim_remain_locked() {
    let (w, ctx, m) = setup().await;
    let m=library::material_tag(&w.d,&w.ctx,input(json!({"material_id":m.id,"expected_revision":m.revision,"captured_at":"2026-10-01T10:00:00Z"}))).await.unwrap();
    let updated=library::material_intelligence_update(&w.d,&w.ctx,input(json!({"material_id":m.id,"expected_revision":m.revision,"description":"Owner's description","group_name":"Owner group"}))).await.unwrap();
    let c = claim(&w, &ctx, &updated.material).await;
    let mut completion = complete(&c);
    completion.captured_at = Some(FIXED_NOW - Duration::days(2));
    completion.date_source = DateSource::AgentInferred;
    let result = library::material_analysis_complete(&w.d, &ctx, completion)
        .await
        .unwrap();
    assert_eq!(result.intelligence.description, "Owner's description");
    assert_eq!(
        result.intelligence.group_name.as_deref(),
        Some("Owner group")
    );
    assert_eq!(result.material.captured_at, m.captured_at);
    assert_eq!(result.intelligence.date_source, DateSource::Manual);
    assert_eq!(library::material_intelligence_update(&w.d,&ctx,input(json!({"material_id":m.id,"expected_revision":result.material.revision,"description":"Agent overwrites"}))).await.unwrap_err().code,ErrorCode::Forbidden);
}
#[tokio::test]
async fn leases_expire_and_failure_requires_explicit_retry() {
    let (w, ctx, m) = setup().await;
    let first = claim(&w, &ctx, &m).await;
    assert_eq!(
        library::material_analysis_claim(
            &w.d,
            &ctx,
            input(json!({"material_id":m.id,"expected_revision":m.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    let later = Ctx {
        now: ctx.now + Duration::minutes(11),
        ..ctx.clone()
    };
    assert_eq!(
        library::material_analysis_complete(&w.d, &later, complete(&first))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let second = claim(&w, &later, &m).await;
    assert_ne!(first.claim_token, second.claim_token);
    assert_eq!(
        library::material_analysis_complete(&w.d, &later, complete(&first))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let failed=library::material_analysis_fail(&w.d,&later,input(json!({"material_id":m.id,"expected_revision":m.revision,"claim_token":second.claim_token,"error_code":"unsupported_media"}))).await.unwrap();
    assert_eq!(failed.intelligence.status, AnalysisStatus::Failed);
    assert_eq!(
        library::material_analysis_claim(
            &w.d,
            &later,
            input(json!({"material_id":m.id,"expected_revision":m.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    let retried = library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":m.revision})),
    )
    .await
    .unwrap();
    assert_eq!(retried.intelligence.status, AnalysisStatus::Pending);
    assert_eq!(retried.intelligence.attempts, 2);
}
#[tokio::test]
async fn invalid_results_are_atomic_and_new_privacy_findings_clear_permission() {
    let (w, ctx, m) = setup().await;
    let c = claim(&w, &ctx, &m).await;
    let mut invalid = complete(&c);
    invalid.description = "x".repeat(4001);
    assert_eq!(
        library::material_analysis_complete(&w.d, &ctx, invalid)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let mut result = complete(&c);
    result.depicts = Some([Depicts::Face].into());
    let out = library::material_analysis_complete(&w.d, &ctx, result)
        .await
        .unwrap();
    assert!(out.material.share.is_none());
    assert!(out.material.tags.depicts.contains(&Depicts::Face));
    assert!(out.material.tags_reviewed_by.is_none());
}
#[tokio::test]
async fn reads_and_claims_obey_tenant_permission_status_and_erasure() {
    let (w, ctx, m) = setup().await;
    let mut forbidden = w.ctx.clone();
    forbidden.permissions = Default::default();
    assert_eq!(
        library::material_preview(&w.d, &forbidden, input(json!({"material_id":m.id})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    let other = Ctx {
        workspace_id: WorkspaceId::new_v7(),
        ..ctx.clone()
    };
    assert!(
        library::material_intelligence_get(&w.d, &other, input(json!({"material_id":m.id})))
            .await
            .is_err()
    );
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":m.revision,"confirm":true})),
    )
    .await
    .unwrap();
    assert_eq!(
        library::material_preview(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(w.uow.snapshot().materials.intelligence.is_empty());
    assert!(
        library::material_intelligence_list(&w.d, &w.ctx)
            .await
            .unwrap()
            .iter()
            .all(|row| row.material.id != m.id)
    );
    let mut platform = w.uow.platform().await.unwrap();
    platform
        .workspace_set_status(
            w.ctx.workspace_id,
            WorkspaceStatus::Suspended,
            "test status transition",
            &Actor::System {
                component: "test".into(),
            },
        )
        .await
        .unwrap();
    platform.commit().await.unwrap();
    assert_eq!(
        library::material_intelligence_list(&w.d, &w.ctx)
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceInactive
    );
}

#[tokio::test]
async fn upload_request_replay_and_enqueue_do_not_reset_completed_analysis() {
    let (w, ctx, m) = setup().await;
    let c = claim(&w, &ctx, &m).await;
    let done = library::material_analysis_complete(&w.d, &ctx, complete(&c))
        .await
        .unwrap();
    let replay=library::material_add(&w.d,&w.ctx,input(json!({"request_key":"analysis-material","file_id":m.file_id,"origin":{"kind":"real"},"genel":true,"share":"shareable","quality":"publishable"}))).await.unwrap();
    assert_eq!(replay.material.id, m.id);
    let mut tx = w.uow.tenant(w.ctx.workspace_id).await.unwrap();
    tx.studio_control().lock_control().await.unwrap();
    library::enqueue_material_analysis(
        tx.as_mut(),
        &done.material,
        ctx.now + Duration::minutes(1),
        DateSource::Unknown,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let after =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap();
    assert_eq!(after.intelligence, done.intelligence);
    assert_eq!(after.material.revision, done.material.revision);
}
#[tokio::test]
async fn agreeing_inference_cannot_downgrade_exif_and_later_replace_authoritative_capture() {
    let (w, ctx, mut m) = setup().await;
    let at = ctx.now - Duration::days(2);
    let mut tx = w.uow.tenant(ctx.workspace_id).await.unwrap();
    tx.studio_control().lock_control().await.unwrap();
    m.captured_at = Some(at);
    m.revision += 1;
    tx.studio_materials()
        .update_material(m.clone(), m.revision - 1)
        .await
        .unwrap();
    let mut row = tx
        .studio_materials()
        .get_intelligence(m.id)
        .await
        .unwrap()
        .unwrap();
    row.intelligence.date_source = DateSource::Exif;
    tx.studio_materials().save_intelligence(row).await.unwrap();
    tx.commit().await.unwrap();
    let c = claim(&w, &ctx, &m).await;
    let mut same = complete(&c);
    same.captured_at = Some(at);
    same.date_source = DateSource::AgentInferred;
    let done = library::material_analysis_complete(&w.d, &ctx, same)
        .await
        .unwrap();
    assert_eq!(done.intelligence.date_source, DateSource::Exif);
    library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":done.material.revision})),
    )
    .await
    .unwrap();
    let c = claim(&w, &ctx, &done.material).await;
    let mut changed = complete(&c);
    changed.captured_at = Some(at - Duration::days(1));
    changed.date_source = DateSource::AgentInferred;
    assert_eq!(
        library::material_analysis_complete(&w.d, &ctx, changed)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let current =
        library::material_intelligence_get(&w.d, &w.ctx, input(json!({"material_id":m.id})))
            .await
            .unwrap();
    assert_eq!(current.material.captured_at, Some(at));
    assert_eq!(current.intelligence.date_source, DateSource::Exif);
}

#[tokio::test]
async fn first_analysis_of_legacy_material_preserves_populated_fields_without_inventing_date_provenance()
 {
    let (w, ctx, mut m) = setup().await;
    let mut tx = w.uow.tenant(ctx.workspace_id).await.unwrap();
    tx.studio_control().lock_control().await.unwrap();
    tx.studio_materials()
        .delete_intelligence(m.id)
        .await
        .unwrap();
    m.title = "Existing owner title".into();
    m.tags.labels = ["existing category".to_owned()].into();
    m.tags.quality = Some(Quality::Publishable);
    m.captured_at = Some(ctx.now - Duration::days(30));
    m.revision += 1;
    tx.studio_materials()
        .update_material(m.clone(), m.revision - 1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let listed = library::material_intelligence_list(&w.d, &w.ctx)
        .await
        .unwrap();
    let existing = listed.iter().find(|r| r.material.id == m.id).unwrap();
    assert_eq!(existing.intelligence.date_source, DateSource::Unknown);
    assert_eq!(
        existing.intelligence.manual_fields,
        ["title", "labels", "quality", "captured_at"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    let c = claim(&w, &ctx, &m).await;
    let mut completion = complete(&c);
    completion.captured_at = Some(ctx.now);
    completion.date_source = DateSource::AgentInferred;
    completion.quality = Some(Quality::NeedsCrop);
    let done = library::material_analysis_complete(&w.d, &ctx, completion)
        .await
        .unwrap();
    assert_eq!(done.material.title, m.title);
    assert_eq!(done.material.tags.labels, m.tags.labels);
    assert_eq!(done.material.tags.quality, m.tags.quality);
    assert_eq!(done.material.captured_at, m.captured_at);
    assert_eq!(done.intelligence.date_source, DateSource::Unknown);
    assert_eq!(
        done.intelligence.group_name.as_deref(),
        Some("Product photography")
    );
}
