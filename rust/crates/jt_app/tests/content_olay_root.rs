//! One module with the olay at its root (design 2026-11-18): a person's upload with no olay waits
//! unfiled and the analysis files it, an olay opened for a person's real upload is confirmed by
//! the owner's rule, an area knows its olay and keeps the step history of its attempt, and the
//! page reads its tree, its production line and one olay in one call each.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, world::World};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{UnitOfWork, materials::*, production_projects::*},
    usecases::{
        content::{
            self,
            pipeline::{StageKey, StageState},
            views::{NeedKind, QueueStage, WaitReason},
        },
        studio::{files, library, projects},
        work::{self, WorkKind},
    },
};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, UserId};
use serde_json::{Value, json};
use uuid::Uuid;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn owner(w: &World) -> UserId {
    match w.ctx.actor {
        Actor::Human { user_id } => user_id,
        _ => unreachable!("the world's caller is its owner"),
    }
}

fn agent(w: &World) -> Ctx {
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id: owner(w),
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

async fn upload(w: &World, key: &str, n: u8) -> jt_studio::FileId {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.push(n);
    files::file_upload(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":key,"filename":"m.png","mime":"image/png",
            "content":{"kind":"bytes_base64","data":STANDARD.encode(&png)}}),
        ),
    )
    .await
    .unwrap()
    .id
}

/// A file a person drops in the panel, with no form: unfiled, no permission.
async fn dropped(w: &World, key: &str, n: u8, origin: Value) -> Material {
    let file = upload(w, key, n).await;
    library::material_add(
        &w.d,
        &w.ctx,
        input(json!({"request_key":key,"file_id":file,"origin":origin,"depicts":[]})),
    )
    .await
    .unwrap()
    .material
}

async fn claim(w: &World, a: &Ctx, m: &Material) -> library::MaterialAnalysisClaimOut {
    library::material_analysis_claim(
        &w.d,
        a,
        input(json!({"material_id":m.id,"expected_revision":m.revision})),
    )
    .await
    .unwrap()
}

fn complete(c: &library::MaterialAnalysisClaimOut, filing: Option<Value>) -> Value {
    let mut v = json!({"material_id":c.material.id,"expected_revision":c.expected_revision,
        "claim_token":c.claim_token,"description":"Figures on a workshop table","labels":["atölye"],
        "date_source":"unknown"});
    if let Some(f) = filing {
        v["filing"] = f;
    }
    v
}

fn new_olay() -> Value {
    json!({"new_olay":{"kind":"workshop","title":"Kasım atölyesi","starts_on":"2026-11-16",
        "ends_on":"2026-11-16","place":"Kadıköy"}})
}

fn ledger(w: &World, action: &str) -> Vec<Value> {
    w.uow
        .snapshot()
        .ledger
        .into_iter()
        .filter(|row| row.entry.action.as_str() == action)
        .map(|row| row.entry.payload)
        .collect()
}

#[tokio::test]
async fn a_persons_drop_waits_unfiled_and_an_agent_still_names_its_olay() {
    let (w, _) = publishing_world().await;
    let m = dropped(&w, "drop", 1, json!({"kind":"real"})).await;
    assert_eq!(m.binding, Binding::Unfiled);
    assert!(m.share.is_none());
    // An agent adds nothing unfiled: it names the olay or genel, as before.
    let file = upload(&w, "agent-file", 2).await;
    let e = library::material_add(
        &w.d,
        &agent(&w),
        input(json!({"request_key":"agent-add","file_id":file,"origin":{"kind":"real"}})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "olay_or_genel");
    // Unfiled, it is no content's: not an area's source.
    let e = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"area","brief":"Show it","material_ids":[m.id]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "material_unfiled");
    // The agent's check-in says it is unfiled; the queue lists it as waiting.
    let pending = work::pending(&w.d, &agent(&w)).await.unwrap();
    assert!(pending.items.iter().any(|i| matches!(i.kind,
        WorkKind::StudioMaterialAnalysis { material_id, unfiled: true, .. } if material_id == m.id)));
    let queue = content::analysis_queue(&w.d, &w.ctx).await.unwrap();
    let item = queue.items.iter().find(|i| i.material.id == m.id).unwrap();
    assert!(item.unfiled);
    assert_eq!(item.stage, QueueStage::Waiting);
    // A person files it by hand; nothing is bound back to unfiled.
    let o = library::olay_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"o","kind":"workshop","title":"Atölye",
            "starts_on":"2026-11-16","ends_on":"2026-11-16"})),
    )
    .await
    .unwrap();
    let bound = library::material_bind(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":m.revision,
            "binding":{"kind":"olay","olay_id":o.id}})),
    )
    .await
    .unwrap();
    assert_eq!(bound.olay_id(), Some(o.id));
    assert_eq!(ledger(&w, "studio.material.bound")[0]["was_unfiled"], true);
    let e = library::material_bind(
        &w.d,
        &w.ctx,
        input(
            json!({"material_id":m.id,"expected_revision":bound.revision,
            "binding":{"kind":"unfiled"}}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "unfiled_is_not_a_binding");
}

#[tokio::test]
async fn filing_a_persons_real_upload_into_a_new_olay_confirms_it_by_rule() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let m = dropped(&w, "real", 1, json!({"kind":"real"})).await;
    let c = claim(&w, &a, &m).await;
    let out = library::material_analysis_complete(&w.d, &a, input(complete(&c, Some(new_olay()))))
        .await
        .unwrap();
    let o = out.olay.unwrap();
    assert_eq!(out.material.olay_id(), Some(o.id));
    assert_eq!(o.status, OlayStatus::Confirmed);
    assert_eq!(o.confirmed.as_ref().unwrap().by, owner(&w));
    assert_eq!(o.client, None);
    let created = ledger(&w, "studio.olay.created");
    let entry = created
        .iter()
        .find(|p| p["olay_id"] == json!(o.id))
        .unwrap();
    assert_eq!(
        entry["confirmed_by_rule"],
        json!({"rule":"person_upload","uploaded_by":owner(&w)})
    );
    assert_eq!(entry["material_id"], json!(m.id));
    assert_eq!(
        ledger(&w, "studio.material.filed")[0]["olay_id"],
        json!(o.id)
    );
    // The olay confirmed, the material is filed: still no permission, so still not usable.
    assert!(out.material.share.is_none());
    // A second filing of the same material is refused.
    let again = library::material_analysis_retry(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":out.material.revision})),
    )
    .await
    .unwrap();
    assert_eq!(again.intelligence.status, AnalysisStatus::Pending);
    let c = claim(&w, &a, &out.material).await;
    let e = library::material_analysis_complete(&w.d, &a, input(complete(&c, Some(new_olay()))))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "material_already_filed");
}

#[tokio::test]
async fn an_ai_upload_opens_a_proposed_olay_and_an_existing_proposed_olay_stays_proposed() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let ai = dropped(
        &w,
        "ai",
        1,
        json!({"kind":"ai_generated","generator":"codex"}),
    )
    .await;
    assert_eq!(ai.binding, Binding::Unfiled);
    let c = claim(&w, &a, &ai).await;
    let out = library::material_analysis_complete(&w.d, &a, input(complete(&c, Some(new_olay()))))
        .await
        .unwrap();
    let proposed = out.olay.unwrap();
    assert_eq!(proposed.status, OlayStatus::Proposed);
    assert!(proposed.confirmed.is_none());
    let created = ledger(&w, "studio.olay.created");
    assert_eq!(created.last().unwrap()["confirmed_by_rule"], Value::Null);
    // A real upload filed into that existing, proposed olay does not confirm it.
    let real = dropped(&w, "real", 2, json!({"kind":"real"})).await;
    let c = claim(&w, &a, &real).await;
    let out = library::material_analysis_complete(
        &w.d,
        &a,
        input(complete(&c, Some(json!({"olay_id":proposed.id})))),
    )
    .await
    .unwrap();
    assert_eq!(out.olay.unwrap().status, OlayStatus::Proposed);
    assert_eq!(out.material.olay_id(), Some(proposed.id));
    let stored = w
        .uow
        .tenant(w.f.ws)
        .await
        .unwrap()
        .studio_materials()
        .get_olay(proposed.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, OlayStatus::Proposed);
}

#[tokio::test]
async fn genel_filing_needs_a_person_for_a_real_photo_and_no_filing_leaves_it_to_a_person() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let real = dropped(&w, "real", 1, json!({"kind":"real"})).await;
    let c = claim(&w, &a, &real).await;
    let e = library::material_analysis_complete(
        &w.d,
        &a,
        input(complete(&c, Some(json!({"genel":true})))),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details["field"], "filing");
    // Two choices at once are malformed.
    let e = library::material_analysis_complete(
        &w.d,
        &a,
        input(complete(
            &c,
            Some(json!({"genel":true,"olay_id":Uuid::now_v7()})),
        )),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "one_filing");
    // The daily routine's call, without a filing: analysed, still unfiled, for a person to file.
    let out = library::material_analysis_complete(&w.d, &a, input(complete(&c, None)))
        .await
        .unwrap();
    assert_eq!(out.material.binding, Binding::Unfiled);
    assert!(out.olay.is_none());
    let queue = content::analysis_queue(&w.d, &w.ctx).await.unwrap();
    let item = queue
        .items
        .iter()
        .find(|i| i.material.id == real.id)
        .unwrap();
    assert_eq!(item.stage, QueueStage::NeedsFiling);
    let before = content::tree(&w.d, &w.ctx).await.unwrap();
    // An AI image may go genel.
    let ai = dropped(
        &w,
        "ai",
        2,
        json!({"kind":"ai_generated","generator":"codex"}),
    )
    .await;
    let c = claim(&w, &a, &ai).await;
    let out = library::material_analysis_complete(
        &w.d,
        &a,
        input(complete(&c, Some(json!({"genel":true})))),
    )
    .await
    .unwrap();
    assert_eq!(out.material.binding, Binding::Genel);
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    // The AI image left the queue for Genel; the real photo still waits there.
    assert_eq!(tree.analysis_queue, before.analysis_queue);
    assert_eq!(tree.genel.files, before.genel.files + 1);
    let queue = content::analysis_queue(&w.d, &w.ctx).await.unwrap();
    assert!(queue.items.iter().all(|i| i.material.id != ai.id));
}

/// An area of the seeded olay, with its material, claimed by `a`.
async fn olay_area(w: &World, a: &Ctx) -> (ProductionProject, Material, String) {
    let m = jt_testkit::studio_contract::seed_material(&w.uow, w.f.ws).await;
    let p = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"area","brief":"Show the workshop",
            "material_ids":[m.id],"olay_id":m.olay_id()})),
    )
    .await
    .unwrap();
    assert_eq!(p.olay_id, m.olay_id());
    let c = content::area_claim(
        &w.d,
        a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    (c.project, m, c.claim_token)
}

async fn report(
    w: &World,
    a: &Ctx,
    p: &ProductionProject,
    token: &str,
    extra: Value,
) -> ProductionProject {
    let mut v = json!({"project_id":p.id,"claim_token":token});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    content::area_progress(&w.d, a, input(v))
        .await
        .unwrap()
        .project
}

#[tokio::test]
async fn an_area_keeps_one_report_per_step_for_its_attempt_and_a_redo_starts_another() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let (p, m, token) = olay_area(&w, &a).await;
    // An old caller's report: no output, no materials.
    report(&w, &a, &p, &token, json!({"step":1,"note":"Amaç"})).await;
    report(
        &w,
        &a,
        &p,
        &token,
        json!({"step":3,"note":"Biçim","output":"Instagram ·\n Reels"}),
    )
    .await;
    report(
        &w,
        &a,
        &p,
        &token,
        json!({"step":6,"note":"Mesaj","output":"Elle boyanır"}),
    )
    .await;
    let p = report(
        &w,
        &a,
        &p,
        &token,
        json!({"step":9,"note":"Dosyalar","material_ids":[m.id]}),
    )
    .await;
    assert_eq!(
        p.steps.iter().map(|s| s.step).collect::<Vec<_>>(),
        vec![1, 3, 6, 9]
    );
    assert_eq!(p.steps[1].output.as_deref(), Some("Instagram · Reels"));
    assert_eq!(p.steps[3].material_ids, vec![m.id]);
    assert_eq!(p.progress.as_ref().unwrap().step, 9);
    // Going back to step 5 drops what came after it.
    let p = report(
        &w,
        &a,
        &p,
        &token,
        json!({"step":5,"note":"Yeni fikir","output":"Üç sahne"}),
    )
    .await;
    assert_eq!(
        p.steps.iter().map(|s| s.step).collect::<Vec<_>>(),
        vec![1, 3, 5]
    );
    // A long or empty output, and an unknown material, are refused.
    for bad in [
        json!({"step":6,"note":"x","output":"x".repeat(241)}),
        json!({"step":6,"note":"x","output":"  "}),
        json!({"step":9,"note":"x","material_ids":[Uuid::now_v7()]}),
    ] {
        let mut v = json!({"project_id":p.id,"claim_token":token});
        v.as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        assert!(content::area_progress(&w.d, &a, input(v)).await.is_err());
    }
    // The delivered package keeps the steps that made it.
    let delivered = content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":token,"request_key":"d1",
            "summary":"Ready","versions":[{"format":"feed_post","text":"A moment from our workshop",
            "material_ids":[m.id],"hypothesis_id":w.f.slot.chain.hypothesis_id}]}),
        ),
    )
    .await
    .unwrap()
    .project;
    assert_eq!(delivered.packages[0].steps, delivered.steps);
    // The production line shows the package done, waiting for a time.
    let line = content::areas(&w.d, &w.ctx, projects::ProjectQuery::default())
        .await
        .unwrap();
    let row = line.areas.iter().find(|r| r.area.id == p.id).unwrap();
    let state = |k: StageKey| row.pipeline.stage(k).unwrap().state;
    for k in [
        StageKey::Hazirlik,
        StageKey::Fikir,
        StageKey::Metin,
        StageKey::Gorsel,
        StageKey::Paket,
    ] {
        assert_eq!(state(k), StageState::Done, "{k:?}");
    }
    assert_eq!(state(StageKey::Onay), StageState::Current);
    assert_eq!(state(StageKey::Yayin), StageState::Todo);
    assert_eq!(state(StageKey::Sonuc), StageState::Todo);
    let hazirlik = row.pipeline.stage(StageKey::Hazirlik).unwrap();
    assert_eq!(hazirlik.steps.len(), 2);
    assert_eq!(
        row.pipeline
            .stage(StageKey::Paket)
            .unwrap()
            .package
            .as_ref()
            .unwrap()
            .versions
            .len(),
        1
    );
    // "Olmamış": a new attempt, with no reports; the old package keeps its own.
    let redone = content::area_redo(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"package_revision":1,"note":"Daha yakın"})),
    )
    .await
    .unwrap()
    .project;
    assert!(redone.steps.is_empty());
    assert_eq!(redone.packages[0].steps.len(), 3);
    let line = content::areas(&w.d, &w.ctx, projects::ProjectQuery::default())
        .await
        .unwrap();
    let row = line.areas.iter().find(|r| r.area.id == p.id).unwrap();
    assert!(
        row.pipeline
            .stages
            .iter()
            .all(|s| s.state == StageState::Todo && s.steps.is_empty())
    );
}

#[tokio::test]
async fn areas_are_listed_by_olay_and_the_page_reads_an_olay_in_one_call() {
    let (w, _) = publishing_world().await;
    let a = agent(&w);
    let (p, m, token) = olay_area(&w, &a).await;
    let olay_id = m.olay_id().unwrap();
    let genel = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"genel","brief":"Anything"})),
    )
    .await
    .unwrap();
    assert_eq!(genel.olay_id, None);
    let unknown = projects::project_create(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"unknown","brief":"x","olay_id":Uuid::now_v7()})),
    )
    .await
    .unwrap_err();
    assert_eq!(unknown.code, ErrorCode::NotFound);
    let of = |filter: Value| {
        let q: projects::ProjectQuery = input(json!({ "olay_id": filter }));
        projects::project_list(&w.d, &w.ctx, q)
    };
    let mine = of(json!(olay_id)).await.unwrap().projects;
    assert_eq!(mine.iter().map(|p| p.id).collect::<Vec<_>>(), vec![p.id]);
    let none = of(json!("genel")).await.unwrap().projects;
    assert_eq!(
        none.iter().map(|p| p.id).collect::<Vec<_>>(),
        vec![genel.id]
    );
    // The agent asks for a capture: the area waits for a person, and the olay's "Eksikler"
    // names the content that asked.
    let p = content::area_progress(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":token,"step":9,"note":"Yakın plan lazım"})),
    )
    .await
    .unwrap()
    .project;
    projects::project_request(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"shot",
            "text":"Boyama anından yakın plan"}),
        ),
    )
    .await
    .unwrap();
    let view = content::olay_view(&w.d, &w.ctx, input(json!({"olay_id":olay_id})))
        .await
        .unwrap();
    assert_eq!(view.olay.as_ref().unwrap().id, olay_id);
    assert_eq!(view.flow.files, 1);
    assert_eq!(view.flow.contents, 1);
    let contents = view.contents.unwrap();
    assert_eq!(
        contents[0].pipeline.stage(StageKey::Gorsel).unwrap().state,
        StageState::WaitingPerson
    );
    let files = view.files.unwrap();
    assert_eq!(files[0].used_in, vec![p.id]);
    let need = view
        .needs
        .iter()
        .find(|n| n.kind == NeedKind::MaterialRequest)
        .unwrap();
    assert_eq!(need.project_id, Some(p.id));
    assert_eq!(need.project_title.as_deref(), Some(p.title.as_str()));
    // The tree marks the olay as waiting for that capture, and counts it.
    let tree = content::tree(&w.d, &w.ctx).await.unwrap();
    let node = tree.olays.iter().find(|o| o.olay.id == olay_id).unwrap();
    assert_eq!(node.folder.areas, 1);
    assert!(node.folder.waits.contains(&WaitReason::MaterialRequest));
    assert!(tree.areas >= 2);
    assert!(tree.genel.areas >= 1);
    assert!(tree.waiting.shoot_requests >= 1);
    // "Genel" reads the same way; a content-only caller gets no files.
    let content_only = Ctx {
        permissions: [jt_tenancy::Permission::ContentWork].into(),
        ..w.ctx.clone()
    };
    let view = content::olay_view(&w.d, &content_only, input(json!({"olay_id":"genel"})))
        .await
        .unwrap();
    assert!(view.olay.is_none());
    assert!(view.files.is_none());
    assert_eq!(view.contents.unwrap().len(), 1);
    // The queue is the library's: a content-only caller may not read it.
    assert_eq!(
        content::analysis_queue(&w.d, &content_only)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
}
