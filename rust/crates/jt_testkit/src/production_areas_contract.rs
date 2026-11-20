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
        pending_files: vec![],
        olay_id: None,
        steps: vec![],
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        start_at: Some(FIXED_NOW + Duration::minutes(start_minutes)),
        opened_by: OpenedBy::Human,
        requested_by: None,
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
        steps: vec![],
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
        withdrawn: vec![],
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
        r.studio_projects()
            .list_areas(false, None, None)
            .await
            .unwrap(),
        open[..200]
    );
    let page = r
        .studio_projects()
        .list_areas(true, None, None)
        .await
        .unwrap();
    assert_eq!(page, done[..51]);
    let last = &page[49];
    let cursor = DoneCursor {
        at: last.done_at().unwrap(),
        id: last.id,
    };
    assert_eq!(
        r.studio_projects()
            .list_areas(true, Some(cursor), None)
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
        cancelled: None,
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
        withdrawn: vec![],
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
                .list_areas(finished, None, None)
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
    // Paylaşımlar's read (design 2026-11-19 §3.9): every live area at once, past the open list's
    // 200, newest first and never the archived one; the area holding a version, by its id.
    let live = r.studio_projects().list_live_areas().await.unwrap();
    let mut expected: Vec<Uuid> = open
        .iter()
        .chain(&done)
        .map(|p| p.id)
        .chain([waiting.id, scheduled.id, unfinished.id])
        .filter(|id| *id != open[0].id)
        .collect();
    expected.sort_by_key(|id| std::cmp::Reverse(*id));
    assert!(expected.len() > 200);
    assert_eq!(live.iter().map(|p| p.id).collect::<Vec<_>>(), expected);
    let found = r
        .studio_projects()
        .find_area_by_version(scheduled.packages[0].versions[0].id)
        .await
        .unwrap();
    assert_eq!(found.map(|p| p.id), Some(scheduled.id));
    assert_eq!(
        r.studio_projects()
            .find_area_by_version(Uuid::now_v7())
            .await
            .unwrap(),
        None
    );
    drop(r);

    // The tree's reads (design 2026-11-18): the areas counted by olay, with their open captures,
    // and, without their documents, those held or with planned posts, each post with whether it
    // is of the current package. An olay's held area, an olay's area asking for two captures,
    // and an area with posts in both of its packages join the areas above.
    let olay = jt_studio::OlayId::new_v7();
    let mut held = area(ws, 400);
    held.olay_id = Some(olay);
    held.refused = MAX_REFUSALS;
    let mut asking = area(ws, 401);
    asking.olay_id = Some(olay);
    for status in [
        RequestStatus::Open,
        RequestStatus::Open,
        RequestStatus::Done,
    ] {
        asking.requests.push(ProjectMaterialRequest {
            id: Uuid::now_v7(),
            text: "A photo".into(),
            status,
            material_ids: vec![],
            created_at: FIXED_NOW,
            resolved_at: None,
        });
    }
    let mut both = delivered(area(ws, 402), 402);
    both.packages[0].versions = vec![version(Some(jt_studio::SlotId::new_v7()))];
    both = delivered(both, 403);
    both.packages[1].versions = vec![version(None), version(Some(jt_studio::SlotId::new_v7()))];
    let mut r = uow.tenant(ws).await.unwrap();
    for p in [&held, &asking, &both] {
        r.studio_projects()
            .save_project(p.clone(), None)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let mut live: Vec<ProductionProject> = Vec::new();
    let mut before = None;
    loop {
        let page = r
            .studio_projects()
            .list_projects(false, before, None)
            .await
            .unwrap();
        let more = page.len() > 100;
        live.extend(page.into_iter().take(100));
        if !more {
            break;
        }
        before = live.last().map(|p| p.id);
    }
    let mut counts: Vec<AreaCount> = Vec::new();
    for p in &live {
        let open = p
            .requests
            .iter()
            .filter(|q| q.status == RequestStatus::Open)
            .count() as u64;
        match counts.iter_mut().find(|c| c.olay_id == p.olay_id) {
            Some(c) => {
                c.areas += 1;
                c.open_requests += open;
            }
            None => counts.push(AreaCount {
                olay_id: p.olay_id,
                areas: 1,
                open_requests: open,
            }),
        }
    }
    counts.sort_by_key(|c| c.olay_id);
    let got = r.studio_projects().area_counts().await.unwrap();
    assert_eq!(got, counts);
    assert_eq!(
        got.iter().find(|c| c.olay_id == Some(olay)),
        Some(&AreaCount {
            olay_id: Some(olay),
            areas: 2,
            open_requests: 2
        })
    );
    let mut posts: Vec<AreaPosts> = live.iter().filter_map(AreaPosts::of).collect();
    posts.sort_by_key(|a| a.id);
    let got = r.studio_projects().area_posts().await.unwrap();
    assert_eq!(got, posts);
    let of = |id: Uuid| got.iter().find(|a| a.id == id).cloned();
    let held_posts = of(held.id).expect("a held area is listed");
    assert!(held_posts.held && !held_posts.done && held_posts.posts.is_empty());
    assert!(of(asking.id).is_none(), "neither held nor with posts");
    let both_posts = of(both.id).unwrap();
    assert!(both_posts.done);
    assert_eq!(
        both_posts
            .posts
            .iter()
            .map(|p| (p.version_id, p.current))
            .collect::<Vec<_>>(),
        vec![
            (both.packages[0].versions[0].id, false),
            (both.packages[1].versions[1].id, true)
        ]
    );
    assert!(of(unfinished.id).is_none(), "its one version has no post");
    drop(r);

    // The materials some area holds, archived or not: its sources, and those a version of any of
    // its packages shows (an earlier package's too); a material no area holds is not listed.
    let id = jt_studio::MaterialId::new_v7;
    let (source, shown, earlier, archived_source, free) = (id(), id(), id(), id(), id());
    let source_of = |material_id| ProjectSource {
        material_id,
        revision: 1,
    };
    let mut holder = delivered(area(ws, 500), 500);
    holder.sources.push(source_of(source));
    let mut old = version(None);
    old.material_ids = vec![earlier];
    holder.packages[0].versions = vec![old];
    holder = delivered(holder, 501);
    let mut current = version(None);
    current.material_ids = vec![shown, source];
    holder.packages[1].versions = vec![current];
    let mut gone = area(ws, 502);
    gone.archived = true;
    gone.sources.push(source_of(archived_source));
    let mut r = uow.tenant(ws).await.unwrap();
    for p in [&holder, &gone] {
        r.studio_projects()
            .save_project(p.clone(), None)
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.studio_projects()
            .materials_in_areas(&[source, shown, earlier, archived_source, free])
            .await
            .unwrap(),
        [source, shown, earlier, archived_source]
            .into_iter()
            .collect()
    );
    assert!(
        r.studio_projects()
            .materials_in_areas(&[free])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        r.studio_projects()
            .materials_in_areas(&[])
            .await
            .unwrap()
            .is_empty()
    );
}
