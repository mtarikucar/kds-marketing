#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::publishing_world;
use jt_app::usecases::studio::projects;
use serde_json::json;
#[tokio::test]
async fn area_create_defaults_title_and_exposes_queued_state() {
    let (w, _) = publishing_world().await;
    let input =
        serde_json::from_value(json!({"request_key":"area", "brief":"Make a launch image"}))
            .unwrap();
    let p = projects::project_create(&w.d, &w.ctx, input).await.unwrap();
    let v = serde_json::to_value(p).unwrap();
    assert_eq!(v["title"], "Make a launch image");
    // A longer goal gives its first words, cut at a word, with an ellipsis.
    let long = projects::project_create(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"request_key":"long",
            "brief":"Kış koleksiyonundaki yeni kupaları duyuran bir Instagram gönderisi hazırla"}))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        long.title,
        "Kış koleksiyonundaki yeni kupaları duyuran bir Instagram…"
    );
    assert_eq!(v["state"]["state"], "queued");
    assert_eq!(v["opened_by"], json!({"kind":"human"}));
}
use acceptance::world::World;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{UnitOfWork, production_projects::*},
    usecases::{
        content,
        work::{self, WorkKind},
    },
};
use jt_ledger::Actor;
use jt_studio::Material;
use jt_tenancy::{AgentConnectionId, Permission};
use serde_json::Value;
use time::Duration;
use uuid::Uuid;
fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
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
async fn create(w: &World, key: &str) -> ProductionProject {
    projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"brief":"Show our workshop"})),
    )
    .await
    .unwrap()
}
async fn get(w: &World, id: Uuid) -> ProductionProject {
    projects::project_get(&w.d, &w.ctx, projects::ProjectIdInput { project_id: id })
        .await
        .unwrap()
        .project
}
async fn take(w: &World, a: &Ctx, p: &ProductionProject) -> content::areas::ClaimOut {
    content::area_claim(
        &w.d,
        a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap()
}
async fn ready_area(w: &World, key: &str) -> (ProductionProject, Material) {
    let m = jt_testkit::studio_contract::seed_material(&w.uow, w.f.ws).await;
    let p = create(w, key).await;
    let p = projects::project_materials(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"add":[m.id]})),
    )
    .await
    .unwrap();
    (p, m)
}
fn version(w: &World, m: &Material) -> Value {
    json!({"format":"feed_post","text":"A moment from our workshop","material_ids":[m.id],"hypothesis_id":w.f.slot.chain.hypothesis_id})
}
fn delivery(p: &ProductionProject, token: &str, key: &str, versions: Vec<Value>) -> Value {
    json!({"project_id":p.id,"claim_token":token,"request_key":key,"summary":"Prepared the platform versions","versions":versions})
}
#[tokio::test]
async fn two_agents_race_one_claim_and_tokens_never_appear_in_project() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "race").await;
    let a = agent(&w);
    let b = agent(&w);
    let i = json!({"project_id":p.id,"expected_revision":p.revision});
    let (x, y) = tokio::join!(
        content::area_claim(&w.d, &a, input(i.clone())),
        content::area_claim(&w.d, &b, input(i))
    );
    assert_eq!(usize::from(x.is_ok()) + usize::from(y.is_ok()), 1);
    let (ok, err) = match (x, y) {
        (Ok(x), Err(e)) | (Err(e), Ok(x)) => (x, e),
        _ => panic!(),
    };
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(
        !serde_json::to_string(&get(&w, p.id).await)
            .unwrap()
            .contains(&ok.claim_token.to_string())
    );
    assert_eq!(ok.project.state(w.ctx.now), AreaState::Working);
}
#[tokio::test]
async fn expired_delivery_cannot_overwrite_a_new_agents_claim() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "expired").await;
    let a = agent(&w);
    let first = take(&w, &a, &p).await;
    let b = Ctx {
        now: a.now + Duration::minutes(31),
        ..agent(&w)
    };
    let second = take(&w, &b, &first.project).await;
    let late = Ctx { now: b.now, ..a };
    let e = content::area_deliver(
        &w.d,
        &late,
        input(delivery(
            &p,
            &first.claim_token,
            "late",
            vec![version(&w, &m)],
        )),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let after = get(&w, p.id).await;
    assert!(after.packages.is_empty());
    assert_eq!(after.claim, second.project.claim);
}
#[tokio::test]
async fn progress_extends_lease_and_release_requires_its_live_owner() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "progress").await;
    let a = agent(&w);
    let c = take(&w, &a, &p).await;
    for step in [0, 15] {
        let e=content::area_progress(&w.d,&a,input(json!({"project_id":p.id,"claim_token":c.claim_token,"step":step,"note":"Checking"}))).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation);
    }
    let later = Ctx {
        now: a.now + Duration::minutes(20),
        ..a.clone()
    };
    let out=content::area_progress(&w.d,&later,input(json!({"project_id":p.id,"claim_token":c.claim_token,"step":9,"note":"Preparing image"}))).await.unwrap();
    assert_eq!(
        out.project.claim.unwrap().lease_until,
        later.now + AREA_LEASE
    );
    let i = json!({"project_id":p.id,"claim_token":c.claim_token,"reason":"Waiting for capture"});
    assert_eq!(
        content::area_release(&w.d, &agent(&w), input(i.clone()))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let out = content::area_release(&w.d, &later, input(i)).await.unwrap();
    assert!(out.project.claim.is_none());
    assert_eq!(out.project.state(later.now), AreaState::Queued);
    assert_eq!(
        content::area_claim(
            &w.d,
            &w.ctx,
            input(json!({"project_id":p.id,"expected_revision":out.project.revision}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
}
#[tokio::test]
async fn all_versions_or_none_and_third_refusal_is_human_work() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "atomic").await;
    let a = agent(&w);
    let c = take(&w, &a, &p).await;
    let mut bad = version(&w, &m);
    bad["material_ids"] = json!([Uuid::new_v4()]);
    for n in 1..=3 {
        let i = delivery(
            &p,
            &c.claim_token,
            &format!("bad-{n}"),
            vec![version(&w, &m), bad.clone()],
        );
        let e = content::area_deliver(&w.d, &a, input(i.clone()))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(e.details["reason"], "package_refused");
        assert_eq!(e.details["versions"][0]["index"], 1);
        assert_eq!(
            e.details["versions"][0]["findings"][0]["code"],
            "material_not_in_area"
        );
        assert_eq!(
            content::area_deliver(&w.d, &a, input(i))
                .await
                .unwrap_err()
                .details,
            e.details
        );
        let p = get(&w, p.id).await;
        assert!(p.packages.is_empty());
        assert_eq!(p.refused, n);
    }
    let p = get(&w, p.id).await;
    assert_eq!(p.state(w.ctx.now), AreaState::Held);
    let human = work::pending(&w.d, &w.ctx).await.unwrap();
    assert!(
        human
            .items
            .iter()
            .any(|i| matches!(i.kind,WorkKind::ContentAreaHeld {project_id} if project_id==p.id))
    );
    assert!(
        !work::pending(&w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(
                i.kind,
                WorkKind::ContentAreaHeld { .. } | WorkKind::ContentArea { .. }
            ))
    );
}
#[tokio::test]
async fn accepted_delivery_replays_and_a_redo_during_work_survives() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "redo").await;
    let a = agent(&w);
    let c = take(&w, &a, &p).await;
    let redo = content::area_redo(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"package_revision":null,"note":"Use a closer view"})),
    )
    .await
    .unwrap();
    assert_eq!(redo.project.claim, c.project.claim);
    let i = delivery(&p, &c.claim_token, "delivery", vec![version(&w, &m)]);
    let out = content::area_deliver(&w.d, &a, input(i.clone()))
        .await
        .unwrap();
    assert_eq!(out.project.packages.len(), 1);
    assert_eq!(out.project.redo.as_ref().unwrap().note, "Use a closer view");
    assert_eq!(out.project.state(w.ctx.now), AreaState::Queued);
    assert!(out.project.done_at().is_none());
    let again = content::area_deliver(&w.d, &a, input(i)).await.unwrap();
    assert_eq!(again.project.packages.len(), 1);
    let pending = work::pending(&w.d, &a).await.unwrap();
    assert!(pending.items.iter().any(
        |i| matches!(&i.kind,WorkKind::ContentArea {redo_note:Some(n),..} if n=="Use a closer view")
    ));
    let c = take(&w, &a, &again.project).await;
    let out = content::area_deliver(
        &w.d,
        &a,
        input(delivery(
            &p,
            &c.claim_token,
            "corrected",
            vec![version(&w, &m)],
        )),
    )
    .await
    .unwrap();
    assert_eq!(out.project.packages.len(), 2);
    assert!(out.project.redo.is_none());
    assert!(out.project.claim.is_none());
    assert_eq!(out.project.refused, 0);
    assert_eq!(out.project.state(w.ctx.now), AreaState::Done);
    assert_eq!(out.project.done_at(), Some(a.now));
    assert_eq!(
        content::area_redo(
            &w.d,
            &a,
            input(json!({"project_id":p.id,"package_revision":2,"note":"no"}))
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
}
#[tokio::test]
async fn erased_unshared_and_foreign_materials_name_the_version_and_reason() {
    for mode in ["erased", "share_unset", "foreign"] {
        let (w, _) = publishing_world().await;
        let (p, mut m) = ready_area(&w, mode).await;
        let a = agent(&w);
        let c = take(&w, &a, &p).await;
        if mode != "foreign" {
            let previous = m.revision;
            m.revision += 1;
            if mode == "erased" {
                m.erased_at = Some(w.ctx.now);
            } else {
                m.share = None;
            }
            let mut r = w.uow.tenant(w.f.ws).await.unwrap();
            r.studio_materials()
                .update_material(m.clone(), previous)
                .await
                .unwrap();
            r.commit().await.unwrap();
        }
        let mut v = version(&w, &m);
        if mode == "foreign" {
            v["material_ids"] = json!([Uuid::new_v4()]);
        }
        let e = content::area_deliver(&w.d, &a, input(delivery(&p, &c.claim_token, mode, vec![v])))
            .await
            .unwrap_err();
        assert_eq!(e.details["versions"][0]["index"], 0);
        let code = if mode == "foreign" {
            "material_not_in_area"
        } else {
            mode
        };
        assert!(
            e.details["versions"][0]["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["code"] == code),
            "{e:?}"
        );
        assert!(get(&w, p.id).await.packages.is_empty());
    }
}
#[tokio::test]
async fn legacy_document_lists_opens_and_claims_and_state_precedence_is_exact() {
    let (w, _) = publishing_world().await;
    let p = create(&w, "legacy").await;
    let mut v = serde_json::to_value(&p).unwrap();
    for k in [
        "start_at",
        "opened_by",
        "hints",
        "claim",
        "progress",
        "packages",
        "redo",
        "refused",
        "state",
    ] {
        v.as_object_mut().unwrap().remove(k);
    }
    let mut old: ProductionProject = input(v);
    assert_eq!(old.starts_at(), old.created_at);
    assert!(old.needs_agent(w.ctx.now));
    old.id = Uuid::new_v4();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_projects()
        .save_project(old.clone(), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(get(&w, old.id).await.state(w.ctx.now), AreaState::Queued);
    assert!(
        projects::project_list(&w.d, &w.ctx, input(json!({"scope":"open"})))
            .await
            .unwrap()
            .projects
            .iter()
            .any(|p| p.id == old.id)
    );
    let a = agent(&w);
    let c = take(&w, &a, &old).await;
    let mut p = c.project;
    p.packages.push(ContentPackage {
        revision: 1,
        delivered_at: w.ctx.now,
        by: a.agent_connection_id.unwrap(),
        summary: "test".into(),
        versions: vec![],
        released: None,
    });
    assert_eq!(p.state(w.ctx.now), AreaState::Working);
    assert_eq!(p.state(w.ctx.now + AREA_LEASE), AreaState::Done);
    p.requests.push(ProjectMaterialRequest {
        id: Uuid::new_v4(),
        text: "capture".into(),
        status: RequestStatus::Open,
        material_ids: vec![],
        created_at: w.ctx.now,
        resolved_at: None,
    });
    assert_eq!(p.state(w.ctx.now), AreaState::WaitingMaterial);
    p.refused = 3;
    assert_eq!(p.state(w.ctx.now), AreaState::Held);
    p.archived = true;
    assert_eq!(p.state(w.ctx.now), AreaState::Archived);
    p.archived = false;
    p.refused = 0;
    p.requests.clear();
    p.claim = None;
    p.packages.clear();
    p.start_at = Some(w.ctx.now + Duration::hours(1));
    assert_eq!(p.state(w.ctx.now), AreaState::Queued);
    assert!(!p.needs_agent(w.ctx.now));
}
#[tokio::test]
async fn opening_validation_and_system_key_idempotence() {
    let (w, _) = publishing_world().await;
    for extra in [
        json!({"brief":" "}),
        json!({"brief":"x".repeat(2001)}),
        json!({"title":" "}),
        json!({"start_at":(w.ctx.now+Duration::days(366)).format(&time::format_description::well_known::Rfc3339).unwrap()}),
        json!({"capability_ids":[Uuid::new_v4()]}),
        json!({"formats":["story","story"]}),
    ] {
        let mut v = json!({"request_key":"invalid","brief":"Make a visual"});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_eq!(
            projects::project_create(&w.d, &w.ctx, input(v))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let hints = AreaHints {
        formats: vec![jt_studio::PostFormat::FeedPost],
        capability_ids: vec![w.f.slot.capability_id],
    };
    let (p, opened) = content::open_by_system(
        r.as_mut(),
        &w.ctx,
        AreaTrigger::Floor,
        "floor:one",
        "Show workshop",
        &[],
        w.ctx.now,
        hints.clone(),
    )
    .await
    .unwrap();
    assert!(opened);
    assert_eq!(p.hints, hints);
    assert_eq!(
        p.opened_by,
        OpenedBy::System {
            trigger: AreaTrigger::Floor,
            key: "floor:one".into()
        }
    );
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let (again, opened) = content::open_by_system(
        r.as_mut(),
        &w.ctx,
        AreaTrigger::Floor,
        "floor:one",
        "Show workshop",
        &[],
        w.ctx.now,
        AreaHints::default(),
    )
    .await
    .unwrap();
    assert!(!opened);
    assert_eq!(p.id, again.id);
    assert_eq!(p.revision, again.revision);
}

#[tokio::test]
async fn production_area_fake_repository_contract() {
    let (w, _) = publishing_world().await;
    jt_testkit::production_areas_contract::exercise(&w.uow, w.f.ws).await;
}

/// The scripted stand-in for a connected agent (design S26). Holding nothing but an agent key's
/// working permissions, it finds the area at check-in, takes it, makes an image, adds it to the
/// area, reports its steps and delivers; the area is done and no person acted in between.
#[tokio::test]
async fn an_agent_with_working_permissions_alone_carries_an_area_to_its_package() {
    use jt_app::usecases::studio::{files, library};
    let (w, _) = publishing_world().await;
    let p = create(&w, "scripted").await;
    let mut a = agent(&w);
    a.permissions = [
        Permission::WorkspaceRead,
        Permission::MaterialsWork,
        Permission::ContentWork,
    ]
    .into_iter()
    .collect();
    let (project_id, expected_revision) = work::pending(&w.d, &a)
        .await
        .unwrap()
        .items
        .iter()
        .find_map(|i| match &i.kind {
            WorkKind::ContentArea {
                project_id,
                expected_revision,
                redo_note: None,
            } => Some((*project_id, *expected_revision)),
            _ => None,
        })
        .expect("the area is offered at check-in");
    assert_eq!(project_id, p.id);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":project_id,"expected_revision":expected_revision})),
    )
    .await
    .unwrap();
    for step in 1..=9 {
        content::area_progress(
            &w.d,
            &a,
            input(
                json!({"project_id":p.id,"claim_token":c.claim_token,"step":step,"note":"Working"}),
            ),
        )
        .await
        .unwrap();
    }
    let file = files::file_upload(
        &w.d,
        &a,
        input(
            json!({"request_key":"scripted-file","filename":"visual.png","mime":"image/png",
                     "content":{"kind":"bytes_base64","data":"iVBORw0KGgpzY3JpcHRlZA=="}}),
        ),
    )
    .await
    .unwrap();
    let made = library::material_add(
        &w.d,
        &a,
        input(
            json!({"request_key":"scripted-material","file_id":file.id,"genel":true,
                     "origin":{"kind":"ai_generated","generator":"scripted"},
                     "title":"Launch visual","quality":"publishable","depicts":[],
                     "share":"shareable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    let area = get(&w, p.id).await;
    let area = projects::project_materials(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":area.revision,"add":[made.id]})),
    )
    .await
    .unwrap();
    // Taking a source out of the area is not the working agent's.
    assert_eq!(
        projects::project_materials(
            &w.d,
            &a,
            input(json!({"project_id":p.id,"expected_revision":area.revision,"remove":[made.id]})),
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
    let out = content::area_deliver(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":"scripted-delivery",
                     "summary":"One feed post",
                     "versions":[{"format":"feed_post","text":"A new season begins.\r\nSee you soon.",
                                  "tags":["yenisezon"],"material_ids":[made.id],
                                  "hypothesis_id":w.f.slot.chain.hypothesis_id}]})),
    )
    .await
    .unwrap()
    .project;
    assert_eq!(out.state(a.now), AreaState::Done);
    assert_eq!(out.packages.len(), 1);
    assert_eq!(
        out.packages[0].versions[0].text,
        "A new season begins.\nSee you soon."
    );
    assert_eq!(out.packages[0].by, a.agent_connection_id.unwrap());
    // Done: nothing left for the agent, and the person sees the package without having acted.
    assert!(
        !work::pending(&w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentArea { .. }))
    );
    assert_eq!(get(&w, p.id).await.state.unwrap().state, AreaState::Done);
}

#[tokio::test]
async fn a_malformed_version_is_the_callers_mistake_and_not_a_refused_delivery() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "shape").await;
    let a = agent(&w);
    let c = take(&w, &a, &p).await;
    let cases = [
        (json!({"text":"x".repeat(5001)}), "versions[0].text"),
        (json!({"title":" "}), "versions[0].title"),
        (
            json!({"tags":(0..31).map(|n| format!("t{n}")).collect::<Vec<_>>()}),
            "versions[0].tags",
        ),
        (json!({"tags":[""]}), "versions[0].tags"),
        (json!({"link":"ftp://example.com/x"}), "versions[0].link"),
        (
            json!({"link":"https://user:secret@example.com/"}),
            "versions[0].link",
        ),
        (json!({"content_type":" "}), "versions[0].content_type"),
        (json!({"material_ids":[]}), "versions[0].material_ids"),
        (
            json!({"material_ids":[m.id, m.id]}),
            "versions[0].material_ids",
        ),
    ];
    for (n, (patch, field)) in cases.into_iter().enumerate() {
        let mut v = version(&w, &m);
        v.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let e = content::area_deliver(
            &w.d,
            &a,
            input(delivery(&p, &c.claim_token, &format!("shape-{n}"), vec![v])),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{field}: {e:?}");
        assert_eq!(e.details["field"], field);
    }
    for versions in [vec![], vec![version(&w, &m); 13]] {
        let e = content::area_deliver(
            &w.d,
            &a,
            input(delivery(&p, &c.claim_token, "count", versions)),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation);
        assert_eq!(e.details["field"], "versions");
    }
    let after = get(&w, p.id).await;
    assert_eq!(after.refused, 0);
    assert_eq!(after.claim, c.project.claim);
}

#[tokio::test]
async fn an_area_keeps_its_newest_twenty_packages_and_the_stored_document_carries_no_state() {
    let (w, _) = publishing_world().await;
    let (mut p, m) = ready_area(&w, "history").await;
    let a = agent(&w);
    for n in 1..=21u32 {
        let c = take(&w, &a, &p).await;
        p = content::area_deliver(
            &w.d,
            &a,
            input(delivery(
                &p,
                &c.claim_token,
                &format!("history-{n}"),
                vec![version(&w, &m)],
            )),
        )
        .await
        .unwrap()
        .project;
        assert_eq!(p.packages.last().unwrap().revision, n);
        if n < 21 {
            p = content::area_redo(
                &w.d,
                &w.ctx,
                input(json!({"project_id":p.id,"package_revision":n,"note":"Again"})),
            )
            .await
            .unwrap()
            .project;
        }
    }
    assert_eq!(p.packages.len(), MAX_PACKAGES);
    assert_eq!(p.packages[0].revision, 2);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let stored = r
        .studio_projects()
        .get_project(p.id)
        .await
        .unwrap()
        .unwrap();
    assert!(stored.state.is_none());
    assert!(p.state.is_some());
}

/// Design B39: a workspace that turned the standalone setting off gets the earlier rule back: a
/// visual the agent made is refused as the only material, with the reason, and passes beside a
/// real one.
#[tokio::test]
async fn an_agents_visual_alone_is_refused_where_the_workspace_turned_the_setting_off() {
    use jt_app::usecases::studio::{files, library};
    let (w, _) = publishing_world().await;
    library::material_policy_set(
        &w.d,
        &w.ctx,
        input(json!({"lead_days":21,"reuse_days":14,"recap_days":30,"ai_standalone":false})),
    )
    .await
    .unwrap();
    let (p, real) = ready_area(&w, "setting-off").await;
    let a = agent(&w);
    let file = files::file_upload(
        &w.d,
        &a,
        input(
            json!({"request_key":"off-file","filename":"card.png","mime":"image/png",
                     "content":{"kind":"bytes_base64","data":"iVBORw0KGgpjYXJk"}}),
        ),
    )
    .await
    .unwrap();
    let card = library::material_add(
        &w.d,
        &a,
        input(
            json!({"request_key":"off-material","file_id":file.id,"genel":true,
                     "origin":{"kind":"ai_generated","generator":"scripted"},
                     "quality":"publishable","depicts":[],"share":"shareable"}),
        ),
    )
    .await
    .unwrap()
    .material;
    let p = projects::project_materials(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision,"add":[card.id]})),
    )
    .await
    .unwrap();
    let c = take(&w, &a, &p).await;
    let alone = json!({"format":"feed_post","text":"A card","material_ids":[card.id],
                       "hypothesis_id":w.f.slot.chain.hypothesis_id});
    let e = content::area_deliver(
        &w.d,
        &a,
        input(delivery(&p, &c.claim_token, "alone", vec![alone])),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.details["versions"][0]["findings"][0]["code"],
        "no_eligible_material"
    );
    let beside = json!({"format":"carousel","text":"A moment from our workshop",
                        "material_ids":[real.id, card.id],
                        "hypothesis_id":w.f.slot.chain.hypothesis_id});
    let out = content::area_deliver(
        &w.d,
        &a,
        input(delivery(&p, &c.claim_token, "beside", vec![beside])),
    )
    .await
    .unwrap();
    assert_eq!(out.project.packages.len(), 1);
}

/// "Olmamış" is about the package the person saw: an agent's progress reports while the person
/// writes the note do not refuse it, a newer delivery does.
#[tokio::test]
async fn a_redo_is_bound_to_the_package_seen_not_to_the_areas_revision() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "seen").await;
    let a = agent(&w);
    let c = take(&w, &a, &p).await;
    let first = content::area_deliver(
        &w.d,
        &a,
        input(delivery(
            &p,
            &c.claim_token,
            "seen-1",
            vec![version(&w, &m)],
        )),
    )
    .await
    .unwrap()
    .project;
    let redo = |package_revision: Option<u32>, note: &'static str| {
        content::area_redo(
            &w.d,
            &w.ctx,
            input(json!({"project_id":p.id,"package_revision":package_revision,"note":note})),
        )
    };
    let asked = redo(Some(1), "Closer").await.unwrap().project;
    let c = take(&w, &a, &asked).await;
    // Progress moves the area's revision, not what a person sees of the package: a second note
    // written meanwhile is taken, and it outlives the delivery that answers the first.
    let moved = content::area_progress(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":c.claim_token,"step":10,"note":"Editing"})),
    )
    .await
    .unwrap()
    .project;
    assert!(moved.revision > asked.revision);
    redo(Some(1), "Even closer").await.unwrap();
    let second = content::area_deliver(
        &w.d,
        &a,
        input(delivery(
            &p,
            &c.claim_token,
            "seen-2",
            vec![version(&w, &m)],
        )),
    )
    .await
    .unwrap()
    .project;
    assert_eq!(second.packages.len(), 2);
    assert_eq!(second.redo.as_ref().unwrap().note, "Even closer");
    // A note about a package that is no longer the current one is refused.
    for stale in [Some(1), None] {
        assert_eq!(
            redo(stale, "Stale").await.unwrap_err().code,
            ErrorCode::Conflict
        );
    }
    assert_eq!(get(&w, p.id).await.redo.unwrap().note, "Even closer");
    assert_eq!(first.packages.len(), 1);
}

/// Refuses `text` three times for the agent's claim on `p`, which holds the area.
async fn hold(
    w: &World,
    a: &Ctx,
    p: &ProductionProject,
    m: &Material,
    text: &str,
) -> ProductionProject {
    let c = take(w, a, p).await;
    for n in 1..=3 {
        let mut v = version(w, m);
        v["text"] = json!(text);
        let e = content::area_deliver(
            &w.d,
            a,
            input(delivery(p, &c.claim_token, &format!("held-{n}"), vec![v])),
        )
        .await
        .unwrap_err();
        assert_eq!(e.details["reason"], "package_refused", "{e:?}");
    }
    let held = get(w, p.id).await;
    assert_eq!(held.state(w.ctx.now), AreaState::Held);
    held
}

/// Design B9: a held area shows the person why, and the person may accept what the text check
/// alone holds. The release is theirs in person, runs the checks again, and is recorded.
#[tokio::test]
async fn a_person_sees_why_an_area_is_held_and_releases_what_only_the_text_holds() {
    let (w, _) = publishing_world().await;
    let (p, m) = ready_area(&w, "release").await;
    let a = agent(&w);
    // The material comes from an olay of one day; the text states another date.
    let held = hold(&w, &a, &p, &m, "03.01.2020 tarihinde atölyedeydik").await;
    let kept = held.refusal.clone().expect("the refused delivery is kept");
    assert_eq!(kept.by, a.agent_connection_id.unwrap());
    assert_eq!(kept.versions.len(), 1);
    assert_eq!(kept.findings[0]["index"], 0);
    assert_eq!(kept.findings[0]["findings"][0]["kind"], "text");
    assert_eq!(kept.findings[0]["findings"][0]["code"], "date_outside_olay");
    assert!(held.packages.is_empty());

    let release = |ctx: Ctx, revision: u64| {
        let d = w.d.clone();
        async move {
            content::delivery_accept(
                &d,
                &ctx,
                input(json!({"project_id":p.id,"expected_revision":revision})),
            )
            .await
        }
    };
    // Not an agent's, not without the manage permission, and only at the revision seen.
    assert_eq!(
        release(a.clone(), held.revision).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    let mut worker = w.ctx.clone();
    worker.permissions.remove(&Permission::ContentManage);
    assert_eq!(
        release(worker, held.revision).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        release(w.ctx.clone(), held.revision - 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let out = release(w.ctx.clone(), held.revision).await.unwrap().project;
    assert_eq!(out.state(w.ctx.now), AreaState::Done);
    assert_eq!(
        (out.refused, out.refusal.clone(), out.claim.clone()),
        (0, None, None)
    );
    let package = &out.packages[0];
    assert_eq!(package.by, kept.by);
    assert_eq!(package.versions, kept.versions);
    let released = package.released.as_ref().expect("who released it");
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    assert_eq!(released.by, user_id);
    assert_eq!(released.findings, kept.findings);
    // Nothing is left to release, and the agent has nothing left to do.
    assert_eq!(
        release(w.ctx.clone(), out.revision).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert!(
        !work::pending(&w.d, &w.ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentAreaHeld { .. }))
    );
}

/// What the material gate holds is never released (spec 2026-11-03 D19): the person sends the
/// area back with a note instead, which clears the refusal.
#[tokio::test]
async fn a_delivery_held_by_its_material_is_never_released() {
    let (w, _) = publishing_world().await;
    let (p, mut m) = ready_area(&w, "no-release").await;
    let a = agent(&w);
    let previous = m.revision;
    m.revision += 1;
    m.share = None;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials()
        .update_material(m.clone(), previous)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let held = hold(&w, &a, &p, &m, "A moment from our workshop").await;
    let e = content::delivery_accept(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"expected_revision":held.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "not_releasable");
    assert_eq!(
        e.details["versions"][0]["findings"][0]["code"],
        "share_unset"
    );
    assert_eq!(get(&w, p.id).await.state(w.ctx.now), AreaState::Held);
    let back = content::area_redo(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"package_revision":null,"note":"Use another photo"})),
    )
    .await
    .unwrap()
    .project;
    assert_eq!((back.refused, back.refusal.clone()), (0, None));
    assert_eq!(back.state(w.ctx.now), AreaState::Queued);
}
