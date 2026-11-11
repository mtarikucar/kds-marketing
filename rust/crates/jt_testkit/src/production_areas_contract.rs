//! The production line's two lists and the compare-and-swap of an area, the same for the
//! PostgreSQL and the in-memory repository.
use crate::fakes::FIXED_NOW;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, production_projects::*},
};
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use time::Duration;
use uuid::Uuid;

fn area(ws: WorkspaceId, start_minutes: i64) -> ProductionProject {
    ProductionProject {
        id: Uuid::now_v7(),
        workspace_id: ws,
        title: "Area".into(),
        brief: "A goal".into(),
        revision: 1,
        archived: false,
        sources: vec![],
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        start_at: Some(FIXED_NOW + Duration::minutes(start_minutes)),
        opened_by: OpenedBy::Human,
        hints: AreaHints::default(),
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
    }
}

fn delivered(mut p: ProductionProject, minutes: i64) -> ProductionProject {
    p.packages.push(ContentPackage {
        revision: 1,
        delivered_at: FIXED_NOW + Duration::minutes(minutes),
        by: AgentConnectionId::new_v7(),
        summary: "Ready".into(),
        versions: vec![],
        released: None,
    });
    p
}

/// 205 open areas (the list holds 200, earliest start first), 52 finished ones delivered in
/// pairs at the same minute (a page holds 50, newest first, ties by id), one with a redo
/// standing and one awaiting a material (both unfinished though they hold a package), an
/// archived one (in neither list), and a stale revision (refused).
pub async fn exercise(uow: &dyn UnitOfWork, ws: WorkspaceId) {
    let mut r = uow.tenant(ws).await.unwrap();
    let mut open = Vec::new();
    let mut done = Vec::new();
    for n in 0..203 {
        open.push(area(ws, 205 - n));
    }
    let mut redo = delivered(area(ws, 1), 5);
    redo.redo = Some(RedoRequest {
        note: "Again".into(),
        by: UserId::new_v7(),
        at: FIXED_NOW,
    });
    open.push(redo);
    let mut awaiting = delivered(area(ws, 0), 5);
    awaiting.requests.push(ProjectMaterialRequest {
        id: Uuid::now_v7(),
        text: "A photo".into(),
        status: RequestStatus::Open,
        material_ids: vec![],
        created_at: FIXED_NOW,
        resolved_at: None,
    });
    open.push(awaiting);
    for n in 0..52 {
        done.push(delivered(area(ws, n), n / 2));
    }
    for p in open.iter().chain(&done) {
        r.studio_projects()
            .save_project(p.clone(), None)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();

    let mut r = uow.tenant(ws).await.unwrap();
    open.sort_by_key(|p| (p.starts_at(), p.id));
    done.sort_by_key(|p| std::cmp::Reverse((p.done_at(), p.id)));
    assert_eq!(
        r.studio_projects().list_areas(false, None).await.unwrap(),
        open[..200]
    );
    let page = r.studio_projects().list_areas(true, None).await.unwrap();
    assert_eq!(page, done[..51]);
    let last = &page[49];
    let cursor = DoneCursor {
        at: last.done_at().unwrap(),
        id: last.id,
    };
    assert_eq!(
        r.studio_projects()
            .list_areas(true, Some(cursor))
            .await
            .unwrap(),
        done[50..]
    );

    // Waiting for a time: finished areas whose current package has a version without a post.
    // The 52 finished areas hold packages without versions; these two differ only in whether
    // their one version was scheduled. A waiting version of an earlier package does not count.
    let version = |slot_id| PackageVersion {
        id: Uuid::now_v7(),
        format: jt_studio::PostFormat::FeedPost,
        capability_id: None,
        text: "Text".into(),
        title: None,
        tags: vec![],
        link: None,
        material_ids: vec![],
        hypothesis_id: jt_strategy::HypothesisId::new_v7(),
        content_type: None,
        slot_id,
    };
    let mut waiting = delivered(area(ws, 300), 300);
    waiting.packages[0].versions = vec![version(Some(jt_studio::SlotId::new_v7())), version(None)];
    let mut scheduled = delivered(area(ws, 301), 301);
    scheduled.packages[0].versions = vec![version(None)];
    scheduled = delivered(scheduled, 302);
    scheduled.packages[1].versions = vec![version(Some(jt_studio::SlotId::new_v7()))];
    let mut unfinished = delivered(area(ws, 303), 303);
    unfinished.packages[0].versions = vec![version(None)];
    unfinished.redo = Some(RedoRequest {
        note: "Again".into(),
        by: UserId::new_v7(),
        at: FIXED_NOW,
    });
    for p in [&waiting, &scheduled, &unfinished] {
        r.studio_projects()
            .save_project(p.clone(), None)
            .await
            .unwrap();
    }
    assert_eq!(
        r.studio_projects().list_areas_waiting().await.unwrap(),
        [waiting.clone()]
    );
    assert_eq!(
        waiting.waiting_versions().map(|v| v.id).collect::<Vec<_>>(),
        [waiting.packages[0].versions[1].id]
    );

    // An archived area is on neither list, and a stale revision is refused.
    let mut archived = open[0].clone();
    archived.revision += 1;
    archived.archived = true;
    r.studio_projects()
        .save_project(archived.clone(), Some(1))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    for finished in [false, true] {
        assert!(
            !r.studio_projects()
                .list_areas(finished, None)
                .await
                .unwrap()
                .iter()
                .any(|p| p.id == archived.id)
        );
    }
    assert_eq!(
        r.studio_projects()
            .save_project(archived, Some(1))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}
