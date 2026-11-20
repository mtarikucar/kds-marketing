//! Paylaşımlar's server side (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §3, §8.1, PR 4):
//! the read model (`content.posts`, `content.post_get`), the composer (`content.post_request`)
//! with the person-upload share rule (D5), the four small writes, the person-request attribution
//! (§3.5, D11), the delivery's wake of the social agent and the person's post cancel (D13).
#[path = "support/studio.rs"]
mod support;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::files::StoredFile;
use jt_app::ports::production_projects::ProductionProject;
use jt_app::ports::wake::WakeReason;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::content::{
    self,
    compose::{PostRequestOut, VersionCancelOut},
    posts::{PostRow, PostsOut, RowKind, RowStatus, WaitCode},
};
use jt_app::usecases::social;
use jt_app::usecases::studio::{library, projects, work};
use jt_app::usecases::wake::{self, SetWake, WakeKind};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, MembershipId, Permission, RoleDef, RoleId, SystemRole, UserId,
};
use jt_testkit::fakes::{FIXED_NOW, files::MemoryFiles};
use serde_json::{Value, json};
use std::sync::Arc;
use support::World;
use time::{OffsetDateTime, macros::datetime};
use uuid::Uuid;

/// When the agent gives a version its time: past every format's lead from [`FIXED_NOW`].
const WHEN: OffsetDateTime = datetime!(2026-10-24 10:00 UTC);

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn owner_of(w: &World) -> UserId {
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!("the world's owner is a person")
    };
    user_id
}

fn agent(w: &World) -> Ctx {
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            user_id: owner_of(w),
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

/// A person holding only `permissions`, in person.
fn member(w: &World, permissions: &[Permission]) -> Ctx {
    Ctx {
        actor: Actor::Human {
            user_id: UserId::new_v7(),
        },
        permissions: permissions.iter().copied().collect(),
        role_key: Some("member".into()),
        ..w.ctx.clone()
    }
}

/// The Studio world with a real file store, an empty library, every module installed and its
/// owner a member (so a key the owner issues acts with the owner's permissions).
async fn page_world() -> World {
    let mut w = support::world().await;
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    jt_testkit::studio_contract::install_all_modules(&w.uow, w.f.ws).await;
    let owner = owner_of(&w);
    let role = RoleDef {
        id: RoleId::new_v7(),
        key: SystemRole::Owner.key().to_owned(),
        name: "Sahip".into(),
        permissions: SystemRole::Owner.permissions(),
        is_system: true,
    };
    let mut u = w.uow.user().await.unwrap();
    u.roles_create_system(w.f.ws, std::slice::from_ref(&role))
        .await
        .unwrap();
    u.memberships_insert_active(MembershipId::new_v7(), w.f.ws, owner, role.id, FIXED_NOW)
        .await
        .unwrap();
    u.commit().await.unwrap();
    w
}

/// A key with `scopes` the owner issued, with a routine to wake.
async fn routine_agent(w: &World, name: &str, scopes: &[&str]) -> ApiKeyId {
    let key = api_keys::create(
        &w.d,
        &w.ctx,
        CreateKey {
            name: name.into(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    wake::set(
        &w.d,
        &w.ctx,
        SetWake {
            api_key_id: key.id,
            kind: WakeKind::ClaudeRoutine,
            routine_id: Some(format!("trig_01{name}")),
            token: Some("sk-ant-oat01-routine-token".into()),
            url: None,
            secret: None,
        },
    )
    .await
    .unwrap();
    key.id
}

/// Key `key`'s pending wake's reasons and who caused it.
fn pending(w: &World, key: ApiKeyId) -> Option<(Vec<WakeReason>, Vec<UserId>)> {
    w.uow
        .snapshot()
        .agent_wakes
        .into_iter()
        .find(|s| s.workspace_id == w.f.ws && s.row.api_key_id == key)
        .and_then(|s| s.row.pending)
        .map(|p| (p.reasons, p.caused_by))
}

/// A stored PDF, as a knowledge attachment's upload leaves it (its bytes are never read here).
async fn pdf(w: &World) -> StoredFile {
    let f = StoredFile {
        id: FileId::new_v7(),
        workspace_id: w.f.ws,
        mime: "application/pdf".into(),
        filename: "fiyat.pdf".into(),
        sha256: format!("{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple()),
        created_at: FIXED_NOW,
        cleanup_due_at: None,
        deleted_at: None,
        size_bytes: 9,
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(f.clone()).await.unwrap();
    r.commit().await.unwrap();
    f
}

/// The fixture's slot as it is stored now.
async fn fixture_slot(w: &World) -> Slot {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().get_slot(w.f.slot.id).await.unwrap().unwrap()
}

/// A stored file of `mime` with bytes of its own, as `studio.file_upload` leaves it.
async fn file(w: &World, mime: &str) -> StoredFile {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(Uuid::now_v7().as_bytes());
    let f: StoredFile =
        w.d.files
            .put(
                w.f.ws,
                FileId::new_v7(),
                MediaUpload {
                    bytes,
                    mime: mime.into(),
                    filename: "upload".into(),
                },
            )
            .await
            .unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(f.clone()).await.unwrap();
    r.commit().await.unwrap();
    f
}

async fn compose(w: &World, ctx: &Ctx, key: &str, text: &str, files: &[FileId]) -> PostRequestOut {
    content::post_request(
        &w.d,
        ctx,
        input(json!({"request_key":key,"text":text,"file_ids":files})),
    )
    .await
    .unwrap()
}

async fn read(w: &World, ctx: &Ctx, q: Value) -> PostsOut {
    content::posts(&w.d, ctx, input(q)).await.unwrap()
}

fn area(w: &World, id: Uuid) -> ProductionProject {
    w.uow
        .snapshot()
        .production_projects
        .into_iter()
        .find(|p| p.id == id)
        .expect("the area is stored")
}

fn stored_material(w: &World, id: MaterialId) -> Material {
    w.uow
        .snapshot()
        .materials
        .materials
        .into_iter()
        .find(|m| m.id == id)
        .expect("the material is stored")
}

fn row<'a>(out: &'a PostsOut, id: &str) -> &'a PostRow {
    out.rows.iter().find(|r| r.id == id).unwrap_or_else(|| {
        panic!(
            "row {id} is listed: {:?}",
            out.rows.iter().map(|r| &r.id).collect::<Vec<_>>()
        )
    })
}

/// The materials agent completes its analysis of `m`: `depicts` found, `checked` as it says.
async fn analysed(w: &World, m: MaterialId, depicts: &[&str], checked: bool) {
    let a = agent(w);
    let current = stored_material(w, m);
    let claim = library::material_analysis_claim(
        &w.d,
        &a,
        input(json!({"material_id":m,"expected_revision":current.revision})),
    )
    .await
    .unwrap();
    library::material_analysis_complete(
        &w.d,
        &a,
        input(json!({"material_id":m,"claim_token":claim.claim_token,
            "expected_revision":claim.expected_revision,"description":"Bir figür",
            "labels":[],"date_source":"unknown","depicts":depicts,
            "sensitive_checked":checked})),
    )
    .await
    .unwrap();
}

/// An agent delivers person area `p` with one feed post showing its sources, `hypothesis`
/// named or not.
async fn delivered(w: &World, p: &ProductionProject, key: &str, hypothesis: Option<Value>) {
    let a = agent(w);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let mut version = json!({"format":"feed_post","text":"Yeni sezon başlıyor",
        "material_ids":p.sources.iter().map(|s| s.material_id).collect::<Vec<_>>()});
    if let Some(h) = hypothesis {
        version["hypothesis_id"] = h;
    }
    content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":key,
            "summary":"Hazır","versions":[version]}),
        ),
    )
    .await
    .unwrap();
}

/// A composer request with one image, analysed and shared by rule: its area, ready to deliver.
async fn shared_request(w: &World, key: &str) -> ProductionProject {
    let f = file(w, "image/png").await;
    let out = compose(w, &w.ctx, key, "Yılbaşı için hediye figürü", &[f.id]).await;
    let id = out.row.area_id.unwrap();
    let m = area(w, id).pending_files[0];
    analysed(w, m, &[], true).await;
    area(w, id)
}

#[tokio::test]
async fn a_text_request_opens_a_person_content_and_wakes_the_content_agent() {
    let w = page_world().await;
    let content_key = routine_agent(&w, "content", &["content.work"]).await;
    let materials_key = routine_agent(&w, "materials", &["materials.work"]).await;
    let out = compose(
        &w,
        &w.ctx,
        "req-1",
        "  Yılbaşı için kurumsal hediye figürü  ",
        &[],
    )
    .await;
    assert_eq!(out.row.kind, RowKind::Content);
    assert_eq!(out.row.status, RowStatus::Preparing);
    let id = out.row.area_id.unwrap();
    let p = area(&w, id);
    assert_eq!(p.brief, "Yılbaşı için kurumsal hediye figürü");
    assert_eq!(p.requested_by, Some(owner_of(&w)));
    assert!(p.hints.formats.is_empty() && p.hints.capability_ids.is_empty());
    assert!(p.pending_files.is_empty());
    assert!(p.needs_agent(FIXED_NOW));
    assert_eq!(
        pending(&w, content_key).map(|p| p.0),
        Some(vec![WakeReason::ContentRequested])
    );
    assert_eq!(pending(&w, materials_key), None);
    let ledger = w.uow.snapshot().ledger;
    assert!(
        ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "content.post_requested"
                && e.entry.payload["files"] == 0)
    );
    // The same key answers the same row; nothing more is made.
    let again = compose(
        &w,
        &w.ctx,
        "req-1",
        "  Yılbaşı için kurumsal hediye figürü  ",
        &[],
    )
    .await;
    assert_eq!(again.row.id, out.row.id);
    assert_eq!(w.uow.snapshot().production_projects.len(), 1);
    // The page lists it, first among what is being made.
    let page = read(&w, &w.ctx, json!({})).await;
    assert_eq!(row(&page, &out.row.id).kind, RowKind::Content);
    assert!(page.composer.allowed);
}

#[tokio::test]
async fn the_composer_is_a_persons_and_takes_only_media() {
    let w = page_world().await;
    let e = content::post_request(
        &w.d,
        &agent(&w),
        input(json!({"request_key":"a","text":"Bir paylaşım","file_ids":[]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details["reason"], "human_required");
    let pdf = pdf(&w).await;
    let e = content::post_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"b","text":"Bir paylaşım","file_ids":[pdf.id]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "file_not_media");
    let img = file(&w, "image/png").await;
    let e = content::post_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"c","text":"Bir paylaşım","file_ids":[img.id, img.id]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "duplicate");
    let e = content::post_request(
        &w.d,
        &w.ctx,
        input(json!({"request_key":"d","text":"Bir paylaşım","file_ids":[FileId::new_v7()]})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(e.details["index"], 0);
    assert!(w.uow.snapshot().production_projects.is_empty());
}

#[tokio::test]
async fn a_photo_with_the_request_is_shared_by_rule_and_the_content_goes_on() {
    let w = page_world().await;
    let content_key = routine_agent(&w, "content", &["content.work"]).await;
    let materials_key = routine_agent(&w, "materials", &["materials.work"]).await;
    let f = file(&w, "image/png").await;
    let out = compose(&w, &w.ctx, "req-1", "Yılbaşı için hediye figürü", &[f.id]).await;
    let id = out.row.area_id.unwrap();
    let p = area(&w, id);
    assert_eq!(p.pending_files.len(), 1);
    assert!(!p.needs_agent(FIXED_NOW), "the agent waits for the files");
    let m = stored_material(&w, p.pending_files[0]);
    assert_eq!(m.binding, Binding::Genel);
    assert_eq!(m.freed.as_ref().map(|f| f.by), Some(owner_of(&w)));
    assert_eq!(m.share, None);
    assert_eq!(m.tags.quality, Some(Quality::Publishable));
    assert_eq!(m.upload_for.as_ref().and_then(|u| u.area_id), Some(id));
    // The materials agent is woken for the analysis, not yet the content agent.
    assert_eq!(
        pending(&w, materials_key).map(|p| p.0),
        Some(vec![WakeReason::MaterialUploaded])
    );
    assert_eq!(pending(&w, content_key), None);
    let page = read(&w, &w.ctx, json!({})).await;
    let r = row(&page, &out.row.id);
    assert!(
        matches!(r.sub_state, Some(content::posts::SubState::FilesAnalysing)),
        "{:?}",
        r.sub_state
    );
    // Checked, nobody found: shared by rule, with no person's name on it.
    analysed(&w, m.id, &[], true).await;
    let m = stored_material(&w, m.id);
    let share = m.share.clone().expect("shared by rule");
    assert_eq!(share.permission, SharePermission::Shareable);
    assert_eq!(share.by, None);
    assert_eq!(share.rule.as_deref(), Some(PERSON_UPLOAD_RULE));
    let p = area(&w, id);
    assert!(p.pending_files.is_empty());
    assert!(p.needs_agent(FIXED_NOW));
    let (reasons, by) = pending(&w, content_key).expect("the content agent is woken");
    assert_eq!(reasons, [WakeReason::ContentRequested]);
    assert_eq!(by, [owner_of(&w)], "on behalf of the uploader");
    assert!(
        w.uow
            .snapshot()
            .ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "studio.material.shared_by_rule")
    );
}

#[tokio::test]
async fn a_face_waits_for_the_owners_permission_once() {
    let w = page_world().await;
    let f = file(&w, "image/png").await;
    let out = compose(&w, &w.ctx, "req-1", "Ekibimizle bir paylaşım", &[f.id]).await;
    let id = out.row.area_id.unwrap();
    let m = area(&w, id).pending_files[0];
    analysed(&w, m, &["face"], true).await;
    assert_eq!(stored_material(&w, m).share, None);
    let page = read(&w, &w.ctx, json!({})).await;
    let r = row(&page, &out.row.id);
    assert_eq!(r.status, RowStatus::WaitingYou);
    let wait = r
        .waits
        .iter()
        .find(|x| x.code == WaitCode::FilesPermission)
        .expect("the files wait for a permission");
    assert_eq!(wait.facts["found"], json!(["face"]));
    assert_eq!(r.actions.permit_files.len(), 1);
    assert!(page.counts.you >= 1);
    // İzin ver: the person's decision clears it.
    let rev = r.actions.permit_files[0].expected_revision;
    library::material_permission(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m,"expected_revision":rev,"permission":"shareable"})),
    )
    .await
    .unwrap();
    assert!(area(&w, id).pending_files.is_empty());
    let page = read(&w, &w.ctx, json!({})).await;
    assert!(
        !row(&page, &out.row.id)
            .waits
            .iter()
            .any(|x| x.code == WaitCode::FilesPermission)
    );
}

#[tokio::test]
async fn an_analysis_without_sensitive_checked_or_no_materials_agent_asks_at_once() {
    let w = page_world().await;
    // No agent can analyse: the permission is asked for at once.
    let f = file(&w, "image/png").await;
    let out = compose(&w, &w.ctx, "req-1", "Bir paylaşım", &[f.id]).await;
    let page = read(&w, &w.ctx, json!({})).await;
    let wait = row(&page, &out.row.id)
        .waits
        .iter()
        .find(|x| x.code == WaitCode::FilesPermission)
        .cloned()
        .expect("unchecked");
    assert_eq!(wait.facts["found"], json!([]));
    // An analysis that did not look for people leaves the share to a person.
    let m = area(&w, out.row.area_id.unwrap()).pending_files[0];
    analysed(&w, m, &[], false).await;
    assert_eq!(stored_material(&w, m).share, None);
    assert_eq!(area(&w, out.row.area_id.unwrap()).pending_files, [m]);
}

#[tokio::test]
async fn going_on_without_a_file_or_deleting_it_frees_the_content() {
    let w = page_world().await;
    let content_key = routine_agent(&w, "content", &["content.work"]).await;
    let (a, b) = (file(&w, "image/png").await, file(&w, "image/png").await);
    let first = compose(&w, &w.ctx, "req-1", "Bir paylaşım", &[a.id]).await;
    let second = compose(&w, &w.ctx, "req-2", "Başka bir paylaşım", &[b.id]).await;
    // Bu dosya olmadan devam et.
    let p = area(&w, first.row.area_id.unwrap());
    projects::project_materials(
        &w.d,
        &w.ctx,
        input(
            json!({"project_id":p.id,"expected_revision":p.revision,"remove":[p.pending_files[0]]}),
        ),
    )
    .await
    .unwrap();
    let p = area(&w, p.id);
    assert!(p.pending_files.is_empty() && p.sources.is_empty());
    assert!(p.needs_agent(FIXED_NOW));
    assert!(pending(&w, content_key).is_some());
    // Deleting the other file in Dosyalar takes it off its content.
    let q = area(&w, second.row.area_id.unwrap());
    let m = stored_material(&w, q.pending_files[0]);
    library::material_delete(
        &w.d,
        &w.ctx,
        input(json!({"material_id":m.id,"expected_revision":m.revision,"confirm":true})),
    )
    .await
    .unwrap();
    let q = area(&w, q.id);
    assert!(q.pending_files.is_empty() && q.sources.is_empty());
    assert!(q.needs_agent(FIXED_NOW));
}

#[tokio::test]
async fn a_persons_delivery_without_a_topic_is_the_owners_request_on_every_account() {
    let w = page_world().await;
    let social_key = routine_agent(&w, "social", &["social.work"]).await;
    let p = shared_request(&w, "req-1").await;
    delivered(&w, &p, "d-1", None).await;
    let p = area(&w, p.id);
    let v = &p.packages[0].versions[0];
    assert_eq!(
        v.hypothesis_id,
        jt_app::usecases::studio::owner_request::id(w.f.ws)
    );
    // The social agent is woken on the owner's behalf for its time.
    let (reasons, by) = pending(&w, social_key).expect("the social agent is woken");
    assert_eq!(reasons, [WakeReason::ContentDelivered]);
    assert_eq!(by, [owner_of(&w)]);
    // It is offered on the workspace's account, under the owner's request.
    let waiting = social::versions_waiting(&w.d, &agent(&w), input(json!({})))
        .await
        .unwrap();
    let choice = &waiting[0].versions[0].choices[0];
    assert_eq!(choice.capability_id, w.f.slot.capability_id);
    assert_eq!(
        choice.attribution,
        jt_app::usecases::social::schedule::Attribution::OwnerRequest
    );
    // The page shows the version waiting for its time.
    let page = read(&w, &w.ctx, json!({})).await;
    let r = row(&page, &format!("version:{}", v.id));
    assert_eq!(r.kind, RowKind::Version);
    assert_eq!(r.status, RowStatus::Scheduling);
    assert!(r.actions.pick_time.is_some());
    assert!(matches!(
        r.actions.cancel,
        Some(content::posts::CancelRef::Version { .. })
    ));
    // Scheduled, it goes out under the owner's request.
    let out = social::version_schedule(
        &w.d,
        &agent(&w),
        input(
            json!({"project_id":p.id,"version_id":v.id,"capability_id":w.f.slot.capability_id,
            "publish_at":WHEN.format(&time::format_description::well_known::Rfc3339).unwrap(),
            "request_key":"t-1"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        out.publication.post.hypothesis_id,
        jt_app::usecases::studio::owner_request::id(w.f.ws)
    );
    let page = read(&w, &w.ctx, json!({})).await;
    let r = row(&page, &format!("slot:{}", out.publication.slot.id));
    assert_eq!(r.kind, RowKind::Post);
    assert_eq!(r.title, "Yeni sezon başlıyor");
}

#[tokio::test]
async fn an_agent_areas_delivery_still_names_a_topic() {
    let w = page_world().await;
    let a = agent(&w);
    let p = projects::project_create(
        &w.d,
        &a,
        input(json!({"request_key":"agent-1","brief":"Bir ajan içeriği"})),
    )
    .await
    .unwrap();
    assert_eq!(p.requested_by, None);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    let e = content::area_deliver(
        &w.d,
        &a,
        input(
            json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":"d-1",
            "summary":"Hazır","versions":[{"format":"feed_post","text":"Metin",
            "material_ids":[MaterialId::new_v7()]}]}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["field"], "versions[0].hypothesis_id");
    assert_eq!(
        area(&w, p.id).refused,
        0,
        "a malformed delivery is not a refusal"
    );
}

#[tokio::test]
async fn a_version_with_no_post_is_cancelled_and_its_content_archived_when_nothing_is_left() {
    let w = page_world().await;
    let p = shared_request(&w, "req-1").await;
    delivered(&w, &p, "d-1", None).await;
    let p = area(&w, p.id);
    let v = p.packages[0].versions[0].id;
    let stale = content::version_cancel(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"version_id":v,"package_revision":9})),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    let out: VersionCancelOut = content::version_cancel(
        &w.d,
        &w.ctx,
        input(json!({"project_id":p.id,"version_id":v,"package_revision":1})),
    )
    .await
    .unwrap();
    assert!(out.archived);
    let cancel = out.project.packages[0].versions[0]
        .cancelled
        .clone()
        .unwrap();
    assert_eq!(cancel.slot_id, None);
    assert_eq!(cancel.reason, "Sahibi iptal etti");
    let page = read(&w, &w.ctx, json!({})).await;
    assert!(
        page.rows.iter().all(|r| r.area_id != Some(p.id)),
        "archived contents are not listed"
    );
    // The row is still reachable, gone from every list, with no action.
    let detail = content::post_get(
        &w.d,
        &w.ctx,
        input(json!({"row_id":format!("version:{v}")})),
    )
    .await
    .unwrap();
    assert!(!detail.listed);
    assert_eq!(detail.row.actions, Default::default());
    assert!(detail.cancelled.is_some());
}

#[tokio::test]
async fn a_post_that_neither_failed_nor_is_a_draft_is_not_acknowledged() {
    let w = page_world().await;
    let s = fixture_slot(&w).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let post = r.studio_posts().get_post(s.id).await.unwrap();
    drop(r);
    let e = content::post_dismiss(
        &w.d,
        &w.ctx,
        input(json!({"slot_id":s.id,"expected_revision":s.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.code,
        if post.is_some() {
            ErrorCode::Conflict
        } else {
            ErrorCode::NotFound
        }
    );
    let e = content::post_dismiss(
        &w.d,
        &agent(&w),
        input(json!({"slot_id":s.id,"expected_revision":s.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "human_required");
}

#[tokio::test]
async fn skipping_a_special_day_disables_it_this_year() {
    let w = page_world().await;
    let year = istanbul_day(FIXED_NOW).year();
    let entry = Calendar::effective(year..=year, &[])
        .entries
        .into_iter()
        .find(|e| e.window().is_some())
        .expect("a default day");
    let out = content::special_day_skip(&w.d, &w.ctx, input(json!({"key":entry.key,"year":year})))
        .await
        .unwrap();
    assert!(!out.enabled);
    assert_eq!(out.name, entry.name);
    let e = content::special_day_skip(
        &w.d,
        &member(&w, &[Permission::ContentWork]),
        input(json!({"key":entry.key,"year":year})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert!(
        w.uow
            .snapshot()
            .ledger
            .iter()
            .any(|e| e.entry.action.as_str() == "content.special_day.skipped")
    );
}

#[tokio::test]
async fn a_persons_post_cancel_needs_a_manage_permission() {
    let w = page_world().await;
    let s = fixture_slot(&w).await;
    let e = work::slot_cancel(
        &w.d,
        &member(&w, &[Permission::SocialWork]),
        input(json!({"slot_id":s.id,"expected_revision":s.revision,"reason":"Gerek yok"})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    work::slot_cancel(
        &w.d,
        &member(&w, &[Permission::ContentManage]),
        input(json!({"slot_id":s.id,"expected_revision":s.revision,"reason":"Gerek yok"})),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_read_validates_its_filter_and_cursor_and_takes_no_lock() {
    let w = page_world().await;
    for n in 0..3 {
        compose(&w, &w.ctx, &format!("req-{n}"), "Bir paylaşım", &[]).await;
    }
    let e = content::posts(&w.d, &w.ctx, input(json!({"filter":"nope"})))
        .await
        .unwrap_err();
    assert_eq!(e.details["field"], "filter");
    let e = content::posts(&w.d, &w.ctx, input(json!({"cursor":"nope"})))
        .await
        .unwrap_err();
    assert_eq!(e.details["field"], "cursor");
    let before = w.uow.lock_journal().len();
    let first = read(&w, &w.ctx, json!({"filter":"hazirlik","limit":2})).await;
    assert!(
        w.uow.lock_journal()[before..].is_empty(),
        "the read takes no lock: {:?}",
        &w.uow.lock_journal()[before..]
    );
    assert_eq!(first.rows.len(), 2);
    assert!(first.counts.all >= 3);
    assert_eq!(
        first.counts.stages[&content::pipeline::StageKey::Hazirlik],
        3
    );
    let cursor = first.next_cursor.clone().expect("a next page");
    let second = read(
        &w,
        &w.ctx,
        json!({"filter":"hazirlik","limit":2,"cursor":cursor}),
    )
    .await;
    assert_eq!(second.rows.len(), 1);
    assert!(second.next_cursor.is_none());
    let mut ids: Vec<_> = first
        .rows
        .iter()
        .chain(&second.rows)
        .map(|r| r.id.clone())
        .collect();
    ids.dedup();
    assert_eq!(ids.len(), 3);
    // A cursor of another filter is refused.
    let e = content::posts(
        &w.d,
        &w.ctx,
        input(json!({"filter":"you","cursor":first.next_cursor})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["field"], "cursor");
    // A stage filter keeps only its stage's rows.
    assert!(
        read(&w, &w.ctx, json!({"filter":"sonuc"}))
            .await
            .rows
            .is_empty()
    );
}

#[tokio::test]
async fn a_read_only_member_sees_every_row_and_no_action() {
    let w = page_world().await;
    let out = compose(&w, &w.ctx, "req-1", "Bir paylaşım", &[]).await;
    let viewer = member(&w, &[Permission::ContentWork]);
    let page = read(&w, &viewer, json!({})).await;
    let r = row(&page, &out.row.id);
    assert_eq!(r.actions, Default::default());
    assert!(!page.composer.allowed);
    let e = content::posts(
        &w.d,
        &member(&w, &[Permission::InboxWork]),
        input(json!({})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_capture_answered_with_a_file_waits_for_its_share() {
    let w = page_world().await;
    let content_key = routine_agent(&w, "content", &["content.work"]).await;
    let out = compose(&w, &w.ctx, "req-1", "Bir paylaşım", &[]).await;
    let p = area(&w, out.row.area_id.unwrap());
    let p = projects::project_request(
        &w.d,
        &agent(&w),
        input(
            json!({"project_id":p.id,"expected_revision":p.revision,"request_key":"cap-1",
            "text":"Atölyeden bir fotoğraf"}),
        ),
    )
    .await
    .unwrap();
    let q = p.requests[0].id;
    let page = read(&w, &w.ctx, json!({})).await;
    let r = row(&page, &out.row.id);
    assert_eq!(r.waits[0].code, WaitCode::Capture);
    assert!(matches!(
        r.actions.add_files,
        Some(content::posts::FilesTarget::Capture { .. })
    ));
    let before = pending(&w, content_key);
    let f = file(&w, "image/png").await;
    content::files_add(
        &w.d,
        &w.ctx,
        input(
            json!({"request_key":"files-1","target":{"kind":"capture","project_id":p.id,
            "request_id":q},"file_ids":[f.id]}),
        ),
    )
    .await
    .unwrap();
    let p = area(&w, p.id);
    assert_eq!(
        p.requests[0].status,
        jt_app::ports::production_projects::RequestStatus::Done
    );
    assert_eq!(p.pending_files.len(), 1);
    assert!(
        !p.needs_agent(FIXED_NOW),
        "the area waits for its file's share"
    );
    assert_eq!(pending(&w, content_key), before);
    analysed(&w, p.pending_files[0], &[], true).await;
    let p = area(&w, p.id);
    assert!(p.needs_agent(FIXED_NOW));
    assert!(
        pending(&w, content_key).is_some_and(|(r, _)| r.contains(&WakeReason::CaptureAnswered))
    );
}
