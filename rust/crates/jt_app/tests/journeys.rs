//! Journeys (design 2026-11-19 §7): a person's request walked from end to end, per platform, with
//! the existing fakes and no network. Each journey asserts that the work never dead-ends: every
//! stop along the way names its true cause, and it clears by itself once that cause is gone.
//!
//! **Adding a platform**: add a [`Platform`] (its kind, provider, format, a fitting material, the
//! scopes it is connected with, the person's step before a post goes out) and call [`journey`]
//! with it in a test of its own. **Adding a gate**: make [`journey`] (or the variant it belongs
//! to) meet it, assert the reason it gives, clear its cause, and assert the work goes on.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    ports::{
        UnitOfWork,
        connectors::{MediaUpload, PublishReceipt, TiktokCreator, TiktokPost, TiktokPostMode},
        files::StoredFile,
        production_projects::ProductionProject,
        studio::{ApprovalTarget, StrategyChange},
    },
    usecases::{
        content,
        knowledge::{rules as kb_rules, seed},
        social,
        social::{
            ready::StopCode,
            schedule::{Attribution, HumanGate, WaitingVersion},
        },
        studio::{
            control::{ApprovalInput, approve},
            owner_request, planner, projects, publish,
            tiktok::{TiktokPostInput, tiktok_post},
        },
        work::{self, WorkKind},
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_ledger::Actor;
use jt_strategy::{
    ChannelChoice, Hypothesis, HypothesisId, HypothesisState, StrategyVersionId, VersionStatus,
};
use jt_studio::*;
use jt_tenancy::AgentConnectionId;
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::World;
use time::{Duration, OffsetDateTime, macros::datetime};
use uuid::Uuid;

/// When the agent gives a version its time: past every format's lead from [`FIXED_NOW`], outside
/// the quiet hours.
const WHEN: OffsetDateTime = datetime!(2026-10-24 10:00 UTC);

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------------------------

/// One platform a journey walks.
#[derive(Clone, Copy)]
struct Platform {
    kind: &'static str,
    provider: Provider,
    format: PostFormat,
    /// A material the platform takes in `format`.
    media: fn() -> MediaUpload,
    /// What it is connected with.
    scopes: &'static [&'static str],
    /// The account asks for a person's approval of each post (its policy).
    approval: bool,
}

impl Platform {
    /// The person's step before a post goes out there.
    fn gate(&self) -> Option<HumanGate> {
        if self.kind == "tiktok" {
            Some(HumanGate::PostingScreen)
        } else if self.approval {
            Some(HumanGate::Approval)
        } else {
            None
        }
    }
}

fn image() -> MediaUpload {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(Uuid::now_v7().as_bytes());
    MediaUpload {
        bytes,
        mime: "image/png".into(),
        filename: "figur.png".into(),
    }
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// A 30-second MP4: its file type and a movie header (timescale 1000), and bytes of its own.
fn video() -> MediaUpload {
    let mut mvhd = vec![0; 12];
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&30_000u32.to_be_bytes());
    mvhd.extend_from_slice(&[0; 80]);
    MediaUpload {
        bytes: [
            mp4_box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41"),
            mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)),
            mp4_box(b"free", Uuid::now_v7().as_bytes()),
        ]
        .concat(),
        mime: "video/mp4".into(),
        filename: "figur.mp4".into(),
    }
}

const TIKTOK: Platform = Platform {
    kind: "tiktok",
    provider: Provider::Tiktok,
    format: PostFormat::TiktokVideo,
    media: video,
    scopes: &[
        "user.info.basic",
        "video.publish",
        "video.upload",
        "video.list",
        "user.info.stats",
    ],
    approval: false,
};

const X: Platform = Platform {
    kind: "x",
    provider: Provider::X,
    format: PostFormat::FeedPost,
    media: image,
    scopes: &["tweet.read", "tweet.write"],
    approval: false,
};

const X_APPROVED: Platform = Platform {
    approval: true,
    ..X
};

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

/// A workspace with the Studio fixture, its X account, and an account of `p` (the X account
/// itself for X), whose strategy chooses `any` channel but has no hypothesis posting on `p`'s
/// kind: as the owner's strategy was on 2026-11-19 (all hypotheses on another platform).
struct Journey {
    w: World,
    p: Platform,
    connector: Arc<ScriptedConnector>,
    account: CapabilityId,
    /// The strategy's own hypothesis, which posts on another platform.
    other: HypothesisId,
}

/// The kind the strategy's hypothesis posts on: never the journey's.
fn elsewhere(p: Platform) -> &'static str {
    if p.kind == "x" { "tiktok" } else { "x" }
}

async fn world_for(p: Platform) -> Journey {
    let mut w = support::world().await;
    let x = Arc::new(ScriptedConnector::new(Provider::X));
    let connector = if p.provider == Provider::X {
        x.clone()
    } else {
        Arc::new(ScriptedConnector::new(p.provider))
    };
    let mut registry = ScriptedRegistry::new()
        .with_connector(w.ads.clone())
        .with_connector(x);
    if p.provider != Provider::X {
        registry = registry.with_connector(connector.clone());
    }
    w.d.connectors = Arc::new(registry);
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());

    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    // The strategy in force: any channel chosen, its one hypothesis on another platform.
    let mut v = r.strategy().find(w.current).await.unwrap().unwrap();
    v.sections.channels = vec![
        ChannelChoice {
            channel: elsewhere(p).into(),
            rationale: "test".into(),
            group_id: None,
        },
        ChannelChoice {
            channel: "any".into(),
            rationale: "test".into(),
            group_id: None,
        },
        ChannelChoice {
            channel: "meta_ads".into(),
            rationale: "test".into(),
            group_id: None,
        },
    ];
    // An approved version is not edited: the one with these sections replaces it, as approving
    // a new version does (the version before archived).
    let mut h = r.hypotheses().list(v.id).await.unwrap().remove(0);
    let user = v.approved_by.unwrap();
    r.strategy()
        .set_status(v.id, VersionStatus::Archived, FIXED_NOW, Some(user))
        .await
        .unwrap();
    v.id = StrategyVersionId::new_v7();
    v.number += 1;
    r.strategy().insert(v.clone()).await.unwrap();
    h.channel = elsewhere(p).into();
    let other = h.id;
    r.hypotheses().upsert(v.id, h).await.unwrap();
    w.current = v.id;

    let account = if p.kind == "x" {
        w.f.slot.capability_id
    } else {
        let mut c = Capability::new(
            CapabilityId::new_v7(),
            w.f.ws,
            NewCapability {
                kind_key: p.kind.into(),
                name: format!("{} hesabı", p.kind),
                external_id: Some(format!("{}-account", p.kind)),
                connector_public: json!({"access":{"scopes":p.scopes,"expires_at":null}}),
                ..Default::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        c.status = StoredStatus::Verified;
        c.last_verified_at = Some(FIXED_NOW);
        let cred = Credential::OAuth {
            access_token: "token".into(),
            refresh_token: None,
            expires_at: None,
            scopes: p.scopes.iter().map(|s| (*s).to_owned()).collect(),
        };
        let sealed =
            w.d.seal
                .seal(w.f.ws, &serde_json::to_vec(&cred).unwrap())
                .unwrap();
        r.capabilities()
            .insert(c.clone(), Some(sealed))
            .await
            .unwrap();
        c.id
    };
    r.commit().await.unwrap();
    if p.approval {
        w.approval_of(account, true).await;
    }
    Journey {
        w,
        p,
        connector,
        account,
        other,
    }
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

/// A shareable, publishable material of `upload`, of a confirmed olay on [`FIXED_NOW`]'s day.
async fn material(w: &World, upload: MediaUpload) -> Material {
    let mime = upload.mime.clone();
    let file: StoredFile =
        w.d.files
            .put(w.f.ws, FileId::new_v7(), upload)
            .await
            .unwrap();
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    m.mime = mime;
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

impl Journey {
    /// The account's stops as `social.accounts_list` gives them.
    async fn stops(&self) -> Vec<StopCode> {
        social::accounts_list(&self.w.d, &self.w.ctx, input(json!({})))
            .await
            .unwrap()
            .into_iter()
            .find(|a| a.capability_id == self.account)
            .expect("the account is listed")
            .stops
            .into_iter()
            .map(|s| s.code)
            .collect()
    }

    /// A content asked for by `ctx` (a person, or an agent's key) naming the journey's account and
    /// format, with `materials` as its sources.
    async fn ask(&self, ctx: &Ctx, key: &str, materials: &[&Material]) -> ProductionProject {
        projects::project_create(
            &self.w.d,
            ctx,
            input(json!({"request_key":key,"brief":"Bu figürleri paylaş",
                "capability_ids":[self.account],"formats":[self.p.format],
                "material_ids":materials.iter().map(|m| m.id).collect::<Vec<_>>()})),
        )
        .await
        .unwrap()
    }

    /// The agent claims area `p` and delivers one version for the journey's account, showing
    /// `m`, under `hypothesis`.
    async fn deliver(
        &self,
        p: &ProductionProject,
        m: &Material,
        hypothesis: HypothesisId,
        key: &str,
    ) -> ProductionProject {
        let a = agent(&self.w);
        let now = projects::project_get(&self.w.d, &a, input(json!({"project_id":p.id})))
            .await
            .unwrap()
            .project;
        let c = content::area_claim(
            &self.w.d,
            &a,
            input(json!({"project_id":p.id,"expected_revision":now.revision})),
        )
        .await
        .unwrap();
        content::area_deliver(
            &self.w.d,
            &a,
            input(json!({"project_id":p.id,"claim_token":c.claim_token,
                "request_key":format!("{key}-delivery"),"summary":"Hazır",
                "versions":[{"format":self.p.format,"capability_id":self.account,
                    "text":"Yeni figürler hazır","material_ids":[m.id],
                    "hypothesis_id":hypothesis}]})),
        )
        .await
        .unwrap_or_else(|e| panic!("{e:?}"))
        .project
    }

    /// Area `p`'s waiting version as `social.versions_waiting` gives it to the agent.
    async fn waiting(&self, p: &ProductionProject) -> Option<WaitingVersion> {
        social::versions_waiting(&self.w.d, &agent(&self.w), input(json!({})))
            .await
            .unwrap()
            .into_iter()
            .find(|k| k.project_id == p.id)
            .and_then(|k| k.versions.into_iter().next())
    }

    /// The agent gives area `p`'s current version its time on the journey's account.
    async fn schedule(&self, p: &ProductionProject, key: &str) -> Slot {
        let version = p.packages.last().unwrap().versions[0].id;
        social::version_schedule(
            &self.w.d,
            &agent(&self.w),
            input(json!({"project_id":p.id,"version_id":version,
                "capability_id":self.account,"publish_at":rfc3339(WHEN),"request_key":key})),
        )
        .await
        .unwrap_or_else(|e| panic!("{e:?}"))
        .publication
        .slot
    }

    /// Area `p`'s row on the content page.
    async fn row(&self, p: &ProductionProject) -> content::views::AreaRow {
        content::areas(&self.w.d, &self.w.ctx, projects::ProjectQuery::default())
            .await
            .unwrap()
            .areas
            .into_iter()
            .find(|r| r.area.id == p.id)
            .expect("the content is on the page")
    }

    /// Whether a planned post of area `p` waits for the owner (its Onay stage).
    async fn waits_for_owner(&self, p: &ProductionProject) -> bool {
        self.row(p).await.pipeline.awaits_approval()
    }

    /// The owner's one step for `slot`, where the platform or the account asks for one.
    async fn complete(&self, slot: &Slot) {
        match self.p.gate() {
            Some(HumanGate::PostingScreen) => {
                self.connector.push_creator_info(Ok(Some(creator())));
                tiktok_post(
                    &self.w.d,
                    &self.w.ctx,
                    TiktokPostInput {
                        slot_id: slot.id,
                        expected_revision: slot.revision,
                        post: TiktokPost {
                            mode: TiktokPostMode::DirectPost,
                            title: "Yeni figürler hazır".into(),
                            privacy_level: "PUBLIC_TO_EVERYONE".into(),
                            allow_comment: true,
                            allow_duet: false,
                            allow_stitch: false,
                            disclose_commercial: false,
                            your_brand: false,
                            branded_content: false,
                        },
                    },
                )
                .await
                .unwrap_or_else(|e| panic!("{e:?}"));
            }
            Some(HumanGate::Approval) => {
                approve(
                    &self.w.d,
                    &self.w.ctx,
                    ApprovalInput {
                        target: ApprovalTarget::Slot(slot.id),
                        expected_revision: slot.revision,
                    },
                )
                .await
                .unwrap_or_else(|e| panic!("{e:?}"));
            }
            None => {}
        }
    }

    /// At its time, the publisher sends `slot` to the platform.
    async fn send(&mut self, slot: &Slot) {
        self.w.d.clock = Arc::new(FixedClock(WHEN));
        self.connector.push_publish(Ok(PublishReceipt {
            external_id: format!("post-{}", slot.id.0),
            url: None,
        }));
        assert_eq!(
            publish::publish_due(&self.w.d, self.w.f.ws).await.unwrap(),
            1
        );
        let sent: Vec<_> = self
            .connector
            .calls()
            .into_iter()
            .filter(|c| matches!(c, ConnectorCall::Publish { .. }))
            .collect();
        assert_eq!(sent.len(), 1, "one post went to the platform");
        assert!(
            self.w
                .uow
                .snapshot()
                .studio
                .attempts
                .iter()
                .any(|a| a.slot_id() == slot.id),
            "the post was sent"
        );
    }

    /// Approves a new strategy version in which `added` join the hypotheses in force (kept), as
    /// `strategy.approve` does: the version before archived, the transition applied.
    async fn next_strategy(&mut self, added: Vec<Hypothesis>, retired: Vec<HypothesisId>) {
        let w = &mut self.w;
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        let mut v = r.strategy().find(w.current).await.unwrap().unwrap();
        let user = v.approved_by.unwrap();
        let previous = v.id;
        let mut list = r.hypotheses().list(previous).await.unwrap();
        r.strategy()
            .set_status(previous, VersionStatus::Archived, FIXED_NOW, Some(user))
            .await
            .unwrap();
        v.id = StrategyVersionId::new_v7();
        v.number += 1;
        r.strategy().insert(v.clone()).await.unwrap();
        for h in &mut list {
            h.state = if retired.contains(&h.id) {
                HypothesisState::Retired
            } else {
                HypothesisState::Kept
            };
        }
        list.extend(added.iter().cloned());
        let change = StrategyChange {
            previous: Some(previous),
            current: Some(v.id),
            kept: list
                .iter()
                .filter(|h| h.state == HypothesisState::Kept)
                .map(|h| h.id)
                .collect(),
            retired,
            added: added.iter().map(|h| h.id).collect(),
            at: FIXED_NOW,
        };
        for h in list {
            r.hypotheses().upsert(v.id, h).await.unwrap();
        }
        w.d.transition_hook
            .apply(r.as_mut(), &change)
            .await
            .unwrap();
        r.commit().await.unwrap();
        w.current = v.id;
    }

    /// A hypothesis of the same segment as the strategy's own, posting on the journey's kind.
    async fn hypothesis_here(&self) -> Hypothesis {
        let mut r = self.w.uow.tenant(self.w.f.ws).await.unwrap();
        let h = r
            .hypotheses()
            .list(self.w.current)
            .await
            .unwrap()
            .into_iter()
            .find(|h| h.id == self.other)
            .unwrap();
        Hypothesis {
            id: HypothesisId::new_v7(),
            title: format!("{} ({})", h.title, self.p.kind),
            channel: self.p.kind.into(),
            state: HypothesisState::Added,
            ..h
        }
    }

    /// The owner saves Kurallar as `edit` changes the box as stored, in person.
    async fn rules(&self, edit: impl FnOnce(&mut kb_rules::RulesInput)) {
        let s = {
            let mut r = self.w.uow.tenant(self.w.f.ws).await.unwrap();
            r.knowledge().settings().await.unwrap().unwrap()
        };
        let cap = |c: &Option<jt_knowledge::Cap>| {
            c.as_ref().map(|c| jt_knowledge::CapInput {
                amount_minor: c.amount_minor,
                period: Some(c.period),
            })
        };
        let mut input = kb_rules::RulesInput {
            expected_revision: s.rules_revision,
            prohibitions: s.prohibitions.clone(),
            ad_budget: cap(&s.ad_cap),
            message_budget: cap(&s.message_cap),
            post_approval: s.post_approval,
            post_approval_accounts: None,
        };
        edit(&mut input);
        kb_rules::rules_save(&self.w.d, &self.w.ctx, input)
            .await
            .unwrap_or_else(|e| panic!("{e:?}"));
    }

    fn attributed(&self, slot: &Slot) -> Option<Value> {
        self.w
            .uow
            .snapshot()
            .ledger
            .into_iter()
            .map(|row| row.entry)
            .find(|e| {
                e.action.as_str() == "social.version.attributed"
                    && e.subject
                        .as_ref()
                        .is_some_and(|s| s.id == slot.id.to_string())
            })
            .map(|e| e.payload)
    }
}

fn creator() -> TiktokCreator {
    TiktokCreator {
        nickname: Some("Figürünica".into()),
        username: Some("figurunica".into()),
        avatar_url: Some("https://p16.tiktokcdn.test/avatar.jpeg".parse().unwrap()),
        privacy_level_options: vec!["PUBLIC_TO_EVERYONE".into(), "SELF_ONLY".into()],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: Some(600),
        cannot_post: None,
    }
}

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------

/// Connect an account of `p`'s kind with a strategy that has no hypothesis on it → the owner asks
/// for a content for it with a fitting material → the agent delivers → the version gets a time →
/// the owner does their one step → it is sent.
async fn journey(p: Platform) {
    let mut j = world_for(p).await;

    // Said at once, when the account is there: what every post there will meet. No stop names a
    // channel or a topic: every connected account is used (design 2026-11-19 K6).
    let stops = j.stops().await;
    assert!(!stops.contains(&StopCode::Reconnect), "{stops:?}");
    assert!(!stops.contains(&StopCode::KnowledgeEmpty), "{stops:?}");
    match p.gate() {
        Some(HumanGate::PostingScreen) => {
            assert!(stops.contains(&StopCode::PostingScreen), "{stops:?}");
            assert!(stops.contains(&StopCode::OnlyFormat), "{stops:?}");
        }
        Some(HumanGate::Approval) => assert!(stops.contains(&StopCode::Approval), "{stops:?}"),
        None => {
            assert!(!stops.contains(&StopCode::Approval), "{stops:?}");
            assert!(!stops.contains(&StopCode::PostingScreen), "{stops:?}");
        }
    }

    // The owner asks, in person, naming the account, with a material the platform takes: the
    // content says nothing is missing.
    let m = material(&j.w, (p.media)()).await;
    let area = j.ask(&j.w.ctx, "journey", &[&m]).await;
    assert!(area.requested_by.is_some());
    let row = j.row(&area).await;
    let checks: Vec<StopCode> = row.checks[0].stops.iter().map(|s| s.code).collect();
    assert!(!checks.contains(&StopCode::MediaMissing), "{checks:?}");

    // The agent delivers under the strategy's own hypothesis (which posts elsewhere). The version
    // is offered on the account, under the owner's request, with the person's step named.
    let area = j.deliver(&area, &m, j.other, "journey").await;
    let v = j
        .waiting(&area)
        .await
        .expect("the version waits for a time");
    assert_eq!(v.blocked, None);
    assert_eq!(v.accounts, [j.account]);
    assert_eq!(v.choices[0].attribution, Attribution::OwnerRequest);
    assert_eq!(v.choices[0].human_gate, p.gate());
    assert!(
        work::pending(&j.w.d, &agent(&j.w))
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::SocialSchedule { project_id, .. } if project_id == area.id)),
        "the agent is told"
    );

    // The version gets its time: attributed to the owner's request, measured on its own arm.
    let slot = j.schedule(&area, "journey-time").await;
    assert_eq!(slot.state, SlotState::Ready);
    assert_eq!(slot.chain.hypothesis_id, owner_request::id(j.w.f.ws));
    assert_eq!(
        j.attributed(&slot).expect("the attribution is recorded")["attribution"],
        "owner_request"
    );
    assert!(
        social::versions_waiting(&j.w.d, &agent(&j.w), input(json!({})))
            .await
            .unwrap()
            .iter()
            .all(|k| k.project_id != area.id)
    );
    // The strategy does not show it: it is the system's, not the strategy's.
    let strategy = jt_app::usecases::strategy::get(&j.w.d, &j.w.ctx)
        .await
        .unwrap();
    assert!(
        strategy
            .approved
            .unwrap()
            .hypotheses
            .iter()
            .all(|h| h.id != owner_request::id(j.w.f.ws))
    );

    // The owner's one step, then it goes out.
    assert_eq!(j.waits_for_owner(&area).await, p.gate().is_some());
    assert!(!j.row(&area).await.pipeline.has_problem());
    j.complete(&slot).await;
    assert!(!j.waits_for_owner(&area).await);
    j.send(&slot).await;
}

#[tokio::test]
async fn tiktok_a_content_the_owner_asked_for_goes_out_without_a_tiktok_hypothesis() {
    journey(TIKTOK).await;
}

#[tokio::test]
async fn x_a_content_the_owner_asked_for_goes_out_without_an_x_hypothesis() {
    journey(X).await;
}

#[tokio::test]
async fn x_with_approval_a_content_the_owner_asked_for_waits_for_their_approval_once() {
    journey(X_APPROVED).await;
}

// ---------------------------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------------------------

/// What happened on 2026-11-19: versions delivered under a strategy with no TikTok hypothesis
/// (an agent's content, so the owner's request does not apply) are blocked with the true reason;
/// a strategy adding TikTok hypotheses is approved; the versions are schedulable at once, under
/// the new hypothesis of their segment, with no revision.
#[tokio::test]
async fn a_strategy_change_mid_way_unblocks_the_delivered_versions_without_a_redo() {
    let mut j = world_for(TIKTOK).await;
    let m = material(&j.w, video()).await;
    let a = agent(&j.w);
    let area = j.ask(&a, "agents", &[&m]).await;
    assert!(
        area.requested_by.is_none(),
        "an agent's key asks for nobody"
    );
    let area = j.deliver(&area, &m, j.other, "agents").await;
    let v = j.waiting(&area).await.unwrap();
    assert_eq!(v.accounts, Vec::<CapabilityId>::new());
    assert_eq!(v.blocked, Some("hypothesis_does_not_post"));

    let tiktok = j.hypothesis_here().await;
    j.next_strategy(vec![tiktok.clone()], vec![]).await;
    let v = j.waiting(&area).await.unwrap();
    assert_eq!(v.blocked, None);
    assert_eq!(v.accounts, [j.account]);
    assert_eq!(v.choices[0].attribution, Attribution::Segment);

    let slot = j.schedule(&area, "agents-time").await;
    assert_eq!(slot.chain.hypothesis_id, tiktok.id);
    assert_eq!(slot.chain.born_version_id, j.w.current);
    let attributed = j.attributed(&slot).unwrap();
    assert_eq!(attributed["attribution"], "segment");
    assert_eq!(attributed["version_hypothesis_id"], json!(j.other));
    j.complete(&slot).await;
    j.send(&slot).await;
}

/// A strategy change that retires the hypothesis a planned post was born under takes the post
/// back; its version waits again by itself, under the strategy now in force.
#[tokio::test]
async fn a_post_taken_back_by_a_strategy_change_waits_again_by_itself() {
    let mut j = world_for(TIKTOK).await;
    let first = j.hypothesis_here().await;
    j.next_strategy(vec![first.clone()], vec![]).await;
    let m = material(&j.w, video()).await;
    let area = j.ask(&agent(&j.w), "retired", &[&m]).await;
    let area = j.deliver(&area, &m, first.id, "retired").await;
    let slot = j.schedule(&area, "retired-time").await;
    assert_eq!(slot.chain.hypothesis_id, first.id);

    let second = j.hypothesis_here().await;
    j.next_strategy(vec![second.clone()], vec![first.id]).await;
    let s = j.w.uow.snapshot();
    assert!(
        s.studio
            .slots
            .iter()
            .any(|x| x.id == slot.id && x.state == SlotState::Retired)
    );
    let v = j.waiting(&area).await.expect("the version waits again");
    assert_eq!(v.blocked, None);
    assert_eq!(v.accounts, [j.account]);
    let slot = j.schedule(&area, "retired-time-2").await;
    assert_eq!(slot.chain.hypothesis_id, second.id);
}

/// A person pauses the account while the version waits: the reason says so, and it goes on its
/// own when they resume.
#[tokio::test]
async fn an_account_paused_and_resumed_mid_way_goes_on_by_itself() {
    let mut j = world_for(TIKTOK).await;
    let m = material(&j.w, video()).await;
    let area = j.ask(&j.w.ctx, "paused", &[&m]).await;
    let area = j.deliver(&area, &m, j.other, "paused").await;
    let pause = |paused: bool, revision: u64| {
        input(json!({"capability_id":j.account,"paused":paused,"expected_revision":revision}))
    };
    let settings = social::account_pause(&j.w.d, &j.w.ctx, pause(true, 0))
        .await
        .unwrap();
    assert_eq!(
        j.waiting(&area).await.unwrap().blocked,
        Some("account_paused")
    );
    assert!(j.stops().await.contains(&StopCode::Paused));
    social::account_pause(&j.w.d, &j.w.ctx, pause(false, settings.revision))
        .await
        .unwrap();
    assert!(!j.stops().await.contains(&StopCode::Paused));
    let v = j.waiting(&area).await.unwrap();
    assert_eq!((v.blocked, v.accounts.clone()), (None, vec![j.account]));
    let slot = j.schedule(&area, "paused-time").await;
    j.complete(&slot).await;
    j.send(&slot).await;
}

/// A material is deleted while its version waits: the reason is that, not another; a revision
/// with a new material goes on.
#[tokio::test]
async fn a_material_deleted_mid_way_says_so_and_a_revision_goes_on() {
    let mut j = world_for(TIKTOK).await;
    let m = material(&j.w, video()).await;
    let fresh = material(&j.w, video()).await;
    let area = j.ask(&j.w.ctx, "deleted", &[&m, &fresh]).await;
    let area = j.deliver(&area, &m, j.other, "deleted").await;
    let mut r = j.w.uow.tenant(j.w.f.ws).await.unwrap();
    let mut gone = r
        .studio_materials()
        .get_material(m.id)
        .await
        .unwrap()
        .unwrap();
    let revision = gone.revision;
    gone.erased_at = Some(FIXED_NOW);
    gone.revision += 1;
    r.studio_materials()
        .update_material(gone, revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        j.waiting(&area).await.unwrap().blocked,
        Some("material_removed")
    );

    content::area_redo(
        &j.w.d,
        &j.w.ctx,
        input(json!({"project_id":area.id,"package_revision":1,"note":"Yeni videoyu kullan"})),
    )
    .await
    .unwrap();
    let area = j.deliver(&area, &fresh, j.other, "deleted-2").await;
    let v = j.waiting(&area).await.unwrap();
    assert_eq!((v.blocked, v.accounts.clone()), (None, vec![j.account]));
    let slot = j.schedule(&area, "deleted-time").await;
    j.complete(&slot).await;
    j.send(&slot).await;
}

/// A revision asked for after the version got its time takes the post back; the next delivery
/// waits for a time and goes out, with nothing stale left on the way.
#[tokio::test]
async fn a_revision_after_scheduling_takes_the_post_back_and_the_next_delivery_goes_out() {
    let mut j = world_for(X_APPROVED).await;
    let m = material(&j.w, image()).await;
    let area = j.ask(&j.w.ctx, "redo", &[&m]).await;
    let area = j.deliver(&area, &m, j.other, "redo").await;
    let first = j.schedule(&area, "redo-time").await;
    assert!(j.waits_for_owner(&area).await);
    content::area_redo(
        &j.w.d,
        &j.w.ctx,
        input(json!({"project_id":area.id,"package_revision":1,"note":"Daha kısa yaz"})),
    )
    .await
    .unwrap();
    assert!(
        !j.waits_for_owner(&area).await,
        "nothing waits for a post taken back"
    );
    assert!(
        j.waiting(&area).await.is_none(),
        "nothing waits while the redo stands"
    );
    let area = j.deliver(&area, &m, j.other, "redo-2").await;
    let v = j.waiting(&area).await.unwrap();
    assert_eq!((v.blocked, v.accounts.clone()), (None, vec![j.account]));
    let slot = j.schedule(&area, "redo-time-2").await;
    assert_ne!(slot.id, first.id);
    j.complete(&slot).await;
    j.send(&slot).await;
}

/// The owner never fills TikTok's screen in time: the post passes its grace unsent, and its
/// version waits for a new time by itself instead of staying failed.
#[tokio::test]
async fn a_post_that_waited_for_the_owner_past_its_grace_waits_for_a_new_time() {
    let j = world_for(TIKTOK).await;
    let m = material(&j.w, video()).await;
    let area = j.ask(&j.w.ctx, "grace", &[&m]).await;
    let area = j.deliver(&area, &m, j.other, "grace").await;
    let slot = j.schedule(&area, "grace-time").await;
    planner::plan(&j.w.d, j.w.f.ws, WHEN + Duration::hours(7))
        .await
        .unwrap();
    let s = j.w.uow.snapshot();
    assert!(s.posts.posts.iter().any(|p| {
        p.slot_id == slot.id
            && p.retired
                .is_some_and(|x| x.reason == RetirementReason::MissedGrace)
    }));
    let v = j.waiting(&area).await.expect("the version waits again");
    assert_eq!((v.blocked, v.accounts.clone()), (None, vec![j.account]));
}

/// The agent never comes: the content is queued, not a problem, the agent's check-in lists it,
/// and what it will meet on the account was said when the owner asked.
#[tokio::test]
async fn a_content_no_agent_took_is_queued_and_says_what_it_will_meet() {
    let j = world_for(TIKTOK).await;
    let m = material(&j.w, image()).await;
    let area = j.ask(&j.w.ctx, "waiting", &[&m]).await;
    let row = j.row(&area).await;
    assert!(!row.pipeline.has_problem());
    // An image for TikTok: said now, with its fix, not later as a blocked version.
    let media = row.checks[0]
        .stops
        .iter()
        .find(|s| s.code == StopCode::MediaMissing)
        .expect("TikTok takes a video");
    assert_eq!(media.format, Some(PostFormat::TiktokVideo));
    assert!(
        work::pending(&j.w.d, &agent(&j.w))
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentArea { project_id, .. } if project_id == area.id))
    );
}

/// Kurallar's post approval (design 2026-11-19 §4.6.3, §4.6.5), on X, whose account asks nothing
/// of a post by itself. "Her paylaşım onayıma gelsin" on: the post waits for the owner, who
/// approves it, and it is sent. Switched off with X in the account list: the post still waits;
/// taken off the list by the owner, it goes out at its time with nothing asked. Neither ever
/// holds a comment reply on the account (`inbox_public_reply.rs`,
/// `the_post_approval_switch_and_list_never_hold_a_comment_reply`).
#[tokio::test]
async fn the_approval_switch_holds_and_releases_posts() {
    // The switch on.
    let mut j = world_for(X).await;
    seed::ensure(&j.w.d, &j.w.ctx).await.unwrap();
    j.rules(|i| i.post_approval = true).await;
    let m = material(&j.w, image()).await;
    let area = j.ask(&j.w.ctx, "switch", &[&m]).await;
    let area = j.deliver(&area, &m, j.other, "switch").await;
    let v = j.waiting(&area).await.unwrap();
    assert_eq!(v.choices[0].human_gate, Some(HumanGate::Approval));
    let slot = j.schedule(&area, "switch-time").await;
    assert!(
        j.waits_for_owner(&area).await,
        "the post waits for the owner"
    );
    approve(
        &j.w.d,
        &j.w.ctx,
        ApprovalInput {
            target: ApprovalTarget::Slot(slot.id),
            expected_revision: slot.revision,
        },
    )
    .await
    .unwrap_or_else(|e| panic!("{e:?}"));
    assert!(!j.waits_for_owner(&area).await);
    j.send(&slot).await;

    // The switch off, X in the account list.
    let mut j = world_for(X).await;
    seed::ensure(&j.w.d, &j.w.ctx).await.unwrap();
    let account = j.account;
    j.rules(|i| {
        i.post_approval = false;
        i.post_approval_accounts = Some(vec![account]);
    })
    .await;
    let m = material(&j.w, image()).await;
    let area = j.ask(&j.w.ctx, "listed", &[&m]).await;
    let area = j.deliver(&area, &m, j.other, "listed").await;
    let slot = j.schedule(&area, "listed-time").await;
    assert!(
        j.waits_for_owner(&area).await,
        "a listed account's post waits"
    );
    // Taken off the list: the same post goes out at its time.
    let revision = {
        let mut r = j.w.uow.tenant(j.w.f.ws).await.unwrap();
        r.knowledge()
            .settings()
            .await
            .unwrap()
            .unwrap()
            .rules_revision
    };
    kb_rules::post_approval_set(
        &j.w.d,
        &j.w.ctx,
        kb_rules::PostApprovalInput {
            capability_id: account,
            required: false,
            expected_revision: revision,
        },
    )
    .await
    .unwrap();
    assert!(!j.waits_for_owner(&area).await);
    j.send(&slot).await;
}
