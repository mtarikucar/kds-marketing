//! The knowledge base where the Studio reads it, and the wakes of PR 2 (design 2026-11-19
//! "Paylaşımlar and Bilgi bankası" §4.10.6, §4.12, §5.3, D40): a closing topic is offered no new
//! post, `studio.slot_get`'s brand rules and `studio.overview`'s goals are the owner's live words,
//! and a person resuming posting or reconnecting an account a waiting post can go out on wakes
//! the social agent at once.
#[path = "support/studio.rs"]
mod support;

use jt_app::ctx::Ctx;
use jt_app::ports::connectors::{Asset, PublishReceipt};
use jt_app::ports::files::StoredFile;
use jt_app::ports::production_projects::ProductionProject;
use jt_app::ports::wake::WakeReason;
use jt_app::ports::{MembershipView, UnitOfWork};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::auth::Principal;
use jt_app::usecases::connector::{self, CompleteOAuth, ConfirmAssets, OAuthCallback};
use jt_app::usecases::knowledge::cards::{CardUpdateInput, card_update};
use jt_app::usecases::knowledge::notes::{NoteAddInput, note_add};
use jt_app::usecases::knowledge::read::knowledge_get;
use jt_app::usecases::knowledge::rules::{GoalsInput, RulesInput, goals_save, rules_save};
use jt_app::usecases::studio::views::{StudioQuery, overview};
use jt_app::usecases::studio::work::slot_get;
use jt_app::usecases::wake::{self, SetWake, WakeKind};
use jt_app::usecases::{
    content, social,
    studio::{projects, publish},
};
use jt_capability::StoredStatus;
use jt_connector::{Credential, ProbeResult, Provider};
use jt_knowledge::CapInput;
use jt_ledger::Actor;
use jt_strategy::LaneKind;
use jt_studio::*;
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, RoleDef, RoleId, SessionId, SystemRole,
    UserId, WorkspaceStatus,
};
use jt_testkit::fakes::{
    FIXED_NOW, FakeAppConfig, FixedClock, ScriptedConnector, ScriptedOAuth, ScriptedRegistry,
    files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::World;
use time::{Duration, OffsetDateTime, macros::datetime};
use uuid::Uuid;

/// When the agent gives a version its time: past every format's lead from [`FIXED_NOW`],
/// outside the quiet hours.
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

/// The Studio world with a real file store, an empty library, every module installed, its
/// owner a member (so a key the owner issues acts with the owner's permissions), its X
/// account's scripted provider and OAuth, and every provider app configured.
struct Social {
    w: World,
    x: Arc<ScriptedConnector>,
    x_oauth: Arc<ScriptedOAuth>,
}

async fn social_world() -> Social {
    let mut w = support::world().await;
    let x = Arc::new(ScriptedConnector::new(Provider::X).with_hosts(&["api.x.com"]));
    let x_oauth = Arc::new(ScriptedOAuth::new(Provider::X));
    w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(w.ads.clone())
            .with_connector(x.clone())
            .with_oauth(x_oauth.clone()),
    );
    w.d.apps = Arc::new(FakeAppConfig::with_all_apps());
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
    Social { w, x, x_oauth }
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

/// A shareable, publishable image with its bytes stored, of a confirmed olay on the fixed day.
async fn material(w: &World) -> Material {
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
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials().insert_olay(olay).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

/// An area an agent opened and finished with one feed post of `m` on the fixture's topic. An
/// agent's: a person's content would go out under the owner's request on any account (design
/// §3.5) and its delivery would wake the social agent.
async fn finished(w: &World, key: &str, m: &Material) -> ProductionProject {
    let p = projects::project_create(
        &w.d,
        &agent(w),
        input(json!({"request_key":key,"brief":"Yeni sezonu duyur","material_ids":[m.id]})),
    )
    .await
    .unwrap();
    let a = agent(w);
    let c = content::area_claim(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap();
    content::area_deliver(
        &w.d,
        &a,
        input(json!({"project_id":p.id,"claim_token":c.claim_token,"request_key":format!("{key}-delivery"),
            "summary":"Hazır","versions":[{"format":"feed_post","text":"Yeni sezon başlıyor",
            "tags":["seramik"],"material_ids":[m.id],"hypothesis_id":w.f.slot.chain.hypothesis_id}]})),
    )
    .await
    .unwrap()
    .project
}

/// The accounts the waiting version could go out on, and why none can.
async fn waiting(w: &World) -> (Vec<jt_capability::CapabilityId>, Option<&'static str>) {
    let out = social::versions_waiting(&w.d, &agent(w), input(json!({})))
        .await
        .unwrap();
    let v = &out[0].versions[0];
    (v.accounts.clone(), v.blocked)
}

// ---------------------------------------------------------------------------------------------
// Closing topics (§4.10.6)
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_closing_topic_is_offered_no_new_post_and_its_planned_post_goes_on() {
    let s = social_world().await;
    let w = &s.w;
    knowledge_get(&w.d, &w.ctx).await.unwrap();
    let m = material(w).await;
    finished(w, "closing", &m).await;
    assert_eq!(waiting(w).await, (vec![w.f.slot.capability_id], None));

    // A derivation left the fixture's topic out while its post is planned: it is closing.
    let topic = w.f.slot.chain.hypothesis_id;
    {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut k = r.knowledge().lock_settings().await.unwrap().unwrap();
        k.closing_topic_ids = vec![topic];
        r.knowledge().save_settings(&k).await.unwrap();
        r.commit().await.unwrap();
    }
    // No account takes a new post of it: the frame has no other topic.
    assert_eq!(waiting(w).await, (vec![], Some("hypothesis_does_not_post")));
    let kb = knowledge_get(&w.d, &w.ctx).await.unwrap();
    let frame = kb.frame.unwrap();
    assert!(frame.topics.iter().all(|t| t.id != topic));
    assert_eq!(frame.closing.len(), 1);
    assert_eq!(frame.closing[0].id, topic);
    // Its planned post keeps its chain: the slot is as it was, the topic live in the frame.
    let s = w.uow.snapshot();
    let slot = s.studio.slots.iter().find(|x| x.id == w.f.slot.id).unwrap();
    assert_eq!(slot.state, SlotState::Ready);
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let v = r.strategy().current_approved().await.unwrap().unwrap();
    let h = r.hypotheses().list(v.id).await.unwrap();
    assert!(h.iter().any(|x| x.id == topic && x.state.is_live()));
}

// ---------------------------------------------------------------------------------------------
// The Studio's reads (§4.12)
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_brand_rules_and_the_goals_are_the_owners_live_words() {
    let s = social_world().await;
    let w = &s.w;
    // Before the workspace is seeded, the frame's words.
    let before = slot_get(&w.d, &agent(w), w.f.slot.id).await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let frame = r.strategy().current_approved().await.unwrap().unwrap();
    drop(r);
    assert_eq!(before.brand_rules.identity, frame.sections.identity);
    assert_eq!(before.brand_rules.knowledge_revision, 0);

    let kb = knowledge_get(&w.d, &w.ctx).await.unwrap();
    let voice = kb
        .cards
        .iter()
        .find(|c| c.key.as_deref() == Some("voice"))
        .unwrap();
    card_update(
        &w.d,
        &w.ctx,
        voice.id,
        CardUpdateInput {
            expected_revision: voice.revision,
            body: Some("Samimi, kısa cümleler.".into()),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
    let products = kb
        .cards
        .iter()
        .find(|c| c.key.as_deref() == Some("products_prices"))
        .unwrap();
    card_update(
        &w.d,
        &w.ctx,
        products.id,
        CardUpdateInput {
            expected_revision: products.revision,
            body: Some("El yapımı kupa: 450 TL.".into()),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
    let cap = |c: &Option<jt_knowledge::Cap>| {
        c.as_ref().map(|c| CapInput {
            amount_minor: c.amount_minor,
            period: Some(c.period),
        })
    };
    rules_save(
        &w.d,
        &w.ctx,
        RulesInput {
            expected_revision: kb.rules.revision,
            prohibitions: vec!["Rakip markaları anma".into()],
            ad_budget: cap(&kb.rules.ad_cap),
            message_budget: cap(&kb.rules.message_cap),
            post_approval: kb.rules.post_approval,
            post_approval_accounts: None,
        },
    )
    .await
    .unwrap();
    goals_save(
        &w.d,
        &w.ctx,
        GoalsInput {
            expected_revision: kb.goals.revision,
            items: vec!["Haftada 3 paylaşım".into()],
        },
    )
    .await
    .unwrap();
    note_add(
        &w.d,
        &w.ctx,
        NoteAddInput {
            request_key: "n1".into(),
            text: "Bu hafta indirim yok.".into(),
            links: Vec::new(),
            file_ids: Vec::new(),
        },
    )
    .await
    .unwrap();

    let out = slot_get(&w.d, &agent(w), w.f.slot.id).await.unwrap();
    let rules = &out.brand_rules;
    assert_eq!(rules.identity.product, "El yapımı kupa: 450 TL.");
    assert_eq!(rules.identity.voice, "Samimi, kısa cümleler.");
    assert_eq!(rules.voice, "Samimi, kısa cümleler.");
    assert_eq!(rules.identity.usp, frame.sections.identity.usp);
    assert_eq!(rules.prohibitions, ["Rakip markaları anma"]);
    assert_eq!(rules.notes, ["Bu hafta indirim yok."]);
    let revision = knowledge_get(&w.d, &w.ctx).await.unwrap().revision;
    assert_eq!(rules.knowledge_revision, revision);

    let view = overview(
        &w.d,
        &w.ctx,
        StudioQuery {
            from: FIXED_NOW - Duration::days(7),
            until: FIXED_NOW + Duration::days(7),
            hypothesis_id: None,
            lane: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        view.goals.kpis,
        [jt_strategy::Kpi {
            name: "Haftada 3 paylaşım".into(),
            target: String::new(),
        }]
    );
    assert_eq!(view.goals.objective, frame.sections.goals.objective);
}

// ---------------------------------------------------------------------------------------------
// Wakes (D40)
// ---------------------------------------------------------------------------------------------

/// The design's journey `stopping_all_posting_is_said_and_resumed` (§8.2), on the server: while
/// posting is stopped no account is offered and the version says why; resuming wakes the social
/// agent, which gives the version its time, and it goes out.
#[tokio::test]
async fn stopping_all_posting_is_said_and_resumed() {
    let mut s = social_world().await;
    let w = &s.w;
    let social = routine_agent(w, "social", &["social.work"]).await;
    let content = routine_agent(w, "content", &["content.work"]).await;
    let m = material(w).await;
    let p = finished(w, "brake", &m).await;
    // The content agent was woken for the person's request; the social agent was not (the
    // delivery's wake is PR 4's, §3.6). Start from no pending wake.
    assert!(pending(w, social).is_none());
    w.uow
        .edit(|st| st.agent_wakes.iter_mut().for_each(|x| x.row.pending = None));

    let stopped = w.brake(true, Some(LaneKind::Organic), 0).await;
    assert!(
        pending(w, social).is_none(),
        "stopping gives an agent no work"
    );
    assert_eq!(waiting(w).await, (vec![], Some("braked")));
    // The paid lane alone resumed: posts stay stopped.
    let paid = w.brake(true, Some(LaneKind::Paid), stopped.revision).await;
    let paid = w.brake(false, Some(LaneKind::Paid), paid.revision).await;
    assert!(pending(w, social).is_none());

    w.brake(false, Some(LaneKind::Organic), paid.revision).await;
    assert_eq!(
        pending(w, social),
        Some((vec![WakeReason::PostingResumed], vec![owner_of(w)]))
    );
    assert!(pending(w, content).is_none(), "only the work it opens");

    // The woken agent gives the version its time; it goes out then.
    assert_eq!(waiting(w).await, (vec![w.f.slot.capability_id], None));
    goes_out(&mut s, &p, "brake").await;
}

/// The agent schedules the first version of `p` on the fixture's account and the unchanged
/// publisher sends it at its time.
async fn goes_out(s: &mut Social, p: &ProductionProject, key: &str) {
    let w = &s.w;
    let out = social::version_schedule(
        &w.d,
        &agent(w),
        input(
            json!({"project_id":p.id,"version_id":p.packages.last().unwrap().versions[0].id,
            "capability_id":w.f.slot.capability_id,
            "publish_at":WHEN.format(&time::format_description::well_known::Rfc3339).unwrap(),
            "request_key":key}),
        ),
    )
    .await
    .unwrap();
    let slot = out.publication.slot.id;
    assert_eq!(out.publication.slot.state, SlotState::Ready);
    s.w.d.clock = Arc::new(FixedClock(WHEN));
    s.x.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    }));
    assert_eq!(publish::publish_due(&s.w.d, s.w.f.ws).await.unwrap(), 1);
    let st = s.w.uow.snapshot();
    assert!(st.studio.publications.iter().any(|x| x.slot_id == slot));
}

/// The design's journey `reconnecting_frees_the_waiting_post_at_once` (§8.2), on the server:
/// the only account lapses, the version says why; the owner reconnects it and the social agent is
/// woken at once; the agent gives the version its time and it goes out.
#[tokio::test]
async fn reconnecting_frees_the_waiting_post_at_once() {
    let mut s = social_world().await;
    let w = &s.w;
    let social = routine_agent(w, "social", &["social.work"]).await;
    let m = material(w).await;
    let p = finished(w, "reconnect", &m).await;
    // Delivering a content a person asked for wakes nobody in this PR (§3.6 is PR 4's).
    assert!(pending(w, social).is_none());
    let account = w.f.slot.capability_id;

    // The only X account lapsed: the version waits, saying why.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r.capabilities().find(account).await.unwrap().unwrap();
    c.status = StoredStatus::Unreachable;
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(waiting(w).await, (vec![], Some("no_connected_account")));

    // The owner reconnects it: a flow bound to the account, signed in again, the account chosen.
    let started = connector::reconnect(&w.d, &w.ctx, account).await.unwrap();
    let state = url::Url::parse(&started.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .unwrap();
    let credential = Credential::OAuth {
        access_token: "x-access-2".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["tweet.read".into(), "tweet.write".into()],
    };
    s.x_oauth.push_exchange(Ok(credential.clone()));
    s.x_oauth.push_assets(Ok(vec![Asset {
        kind_key: "x".into(),
        external_id: "account".into(),
        name: "@studio".into(),
        credential,
        public: json!({ "username": "studio" }),
    }]));
    let owner = owner_of(w);
    let principal = Principal {
        session_id: SessionId::new_v7(),
        user_id: owner,
        email: Email::parse("owner@studio.test").unwrap(),
        display_name: "Owner".into(),
        current_workspace: Some(w.f.ws),
        memberships: vec![MembershipView {
            membership_id: MembershipId::new_v7(),
            workspace_id: w.f.ws,
            workspace_name: "studio".into(),
            workspace_slug: w.f.ws.to_string(),
            workspace_status: WorkspaceStatus::Active,
            role_key: "owner".into(),
            permissions: SystemRole::Owner.permissions(),
        }],
    };
    let assets = connector::complete_oauth(
        &w.d,
        CompleteOAuth {
            callback: OAuthCallback::X,
            state,
            code: "code-x".into(),
            principal: &principal,
        },
    )
    .await
    .unwrap();
    // Signing in alone changes no account: nobody is woken yet.
    assert!(pending(w, social).is_none());
    s.x.push_probe(ProbeResult::success(
        42,
        json!({ "account_id": "account", "followers": 10 }),
    ));
    let out = connector::confirm_assets(
        &w.d,
        &w.ctx,
        ConfirmAssets {
            pending_id: assets.pending_id,
            selected: vec!["account".into()],
        },
    )
    .await
    .unwrap();
    assert_eq!(out[0].capability.status, StoredStatus::Verified);
    assert_eq!(waiting(w).await, (vec![account], None));
    assert_eq!(
        pending(w, social),
        Some((vec![WakeReason::AccountConnected], vec![owner]))
    );
    goes_out(&mut s, &p, "reconnect").await;
}

#[tokio::test]
async fn connecting_an_account_no_waiting_post_needs_wakes_nobody() {
    let s = social_world().await;
    let w = &s.w;
    let social = routine_agent(w, "social", &["social.work"]).await;
    // Nothing waits for a time: a new connection gives the social agent no work.
    let started = connector::start_oauth(
        &w.d,
        &w.ctx,
        connector::StartOAuth {
            kind_key: "x".into(),
            flow: None,
        },
    )
    .await
    .unwrap();
    let state = url::Url::parse(&started.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .unwrap();
    let credential = Credential::OAuth {
        access_token: "x-access-3".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["tweet.read".into(), "tweet.write".into()],
    };
    s.x_oauth.push_exchange(Ok(credential.clone()));
    s.x_oauth.push_assets(Ok(vec![Asset {
        kind_key: "x".into(),
        external_id: "second".into(),
        name: "@second".into(),
        credential,
        public: json!({}),
    }]));
    let principal = Principal {
        session_id: SessionId::new_v7(),
        user_id: owner_of(w),
        email: Email::parse("owner@studio.test").unwrap(),
        display_name: "Owner".into(),
        current_workspace: Some(w.f.ws),
        memberships: vec![MembershipView {
            membership_id: MembershipId::new_v7(),
            workspace_id: w.f.ws,
            workspace_name: "studio".into(),
            workspace_slug: w.f.ws.to_string(),
            workspace_status: WorkspaceStatus::Active,
            role_key: "owner".into(),
            permissions: SystemRole::Owner.permissions(),
        }],
    };
    let assets = connector::complete_oauth(
        &w.d,
        CompleteOAuth {
            callback: OAuthCallback::X,
            state,
            code: "code-y".into(),
            principal: &principal,
        },
    )
    .await
    .unwrap();
    s.x.push_probe(ProbeResult::success(1, json!({ "account_id": "second" })));
    connector::confirm_assets(
        &w.d,
        &w.ctx,
        ConfirmAssets {
            pending_id: assets.pending_id,
            selected: vec!["second".into()],
        },
    )
    .await
    .unwrap();
    assert!(pending(w, social).is_none());
}
