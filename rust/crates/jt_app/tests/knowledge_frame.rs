//! The internal frame the system applies from the knowledge base (design 2026-11-19
//! "Paylaşımlar and Bilgi bankası" §4.10, §4.3.4, §8.1): `knowledge::frame::apply` for every cause
//! (an agent's derivation, the bootstrap from the first card text, the rules' mirror, the
//! housekeeping's normalisation and close), `knowledge_settle`, an approval through the old
//! strategy tools re-syncing the knowledge base, research tasks carried across frames (K5), and
//! a frame without a paid-message limit (D3).

#[path = "support/studio.rs"]
mod studio_support;
mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::wake::WakeReason;
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::jobs::{self, Job};
use jt_app::usecases::knowledge::cards::{
    CardCreateInput, CardUpdateInput, card_create, card_update,
};
use jt_app::usecases::knowledge::frame::{self, Applied, Request, Waking, bootstrap_id};
use jt_app::usecases::knowledge::notes::{
    ExistingCardInput, FiledCardInput, NoteAddInput, NoteClaimInput, NoteFileInput, note_add,
    note_claim, note_file,
};
use jt_app::usecases::knowledge::proposals::proposal_accept;
use jt_app::usecases::knowledge::rules::{GoalsInput, goals_save};
use jt_app::usecases::knowledge::{seed, settle};
use jt_app::usecases::strategy::{self, ApproveInput, ArchiveInput};
use jt_app::usecases::studio::owner_request;
use jt_app::usecases::wake::{self, SetWake, WakeKind};
use jt_knowledge::frame::{
    BOOTSTRAP_TITLE, DerivePart, FrameCause, FrameParts, ProspectingInput, TopicInput,
};
use jt_knowledge::seed::RESYNC_REASON;
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_prospects::{TaskKind, TaskStatus};
use jt_strategy::{
    ANY_CHANNEL, Area, ContentTypeShare, Criterion, Hypothesis, HypothesisCadence, HypothesisId,
    HypothesisState, IcpEntry, LaneKind, Prospecting, Rubric, Sections, Segment, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_tenancy::ApiKeyId;
use jt_testkit::fakes::{FIXED_NOW, ScriptedRegistry, ScriptedWaker};
use serde_json::{Value, json};
use support::{World, err, world};
use time::Duration;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// A sample strategy of a fictional business (a coffee roastery) in the shape of a live one,
/// version 5: channels instagram, mailbox, tiktok and four `any`, topics on instagram and tiktok,
/// a paid lane of 5.000 TRY a month and an organic lane of 0, a channel mix.
fn v5() -> (Sections, Vec<Hypothesis>) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../domain/jt_knowledge/tests/fixtures/strategy-sample.json"
    ))
    .unwrap();
    (
        serde_json::from_value(fixture["sections"].clone()).unwrap(),
        serde_json::from_value(fixture["hypotheses"].clone()).unwrap(),
    )
}

/// Stores a version of `status` with `sections` and `hypotheses` in workspace `ws`, straight to
/// the repos (a draft is stored submitted).
async fn version_in(
    uow: &dyn UnitOfWork,
    ws: jt_tenancy::WorkspaceId,
    by: jt_tenancy::UserId,
    number: i32,
    status: VersionStatus,
    sections: Sections,
    hypotheses: Vec<Hypothesis>,
) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = uow.tenant(ws).await.unwrap();
    let approved = status != VersionStatus::Draft;
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: ws,
            number,
            status,
            sections,
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: by },
            submitted_at: Some(FIXED_NOW),
            approved_at: approved.then_some(FIXED_NOW),
            approved_by: approved.then_some(by),
            archived_at: (status == VersionStatus::Archived).then_some(FIXED_NOW),
        })
        .await
        .unwrap();
    t.hypotheses().replace_all(id, hypotheses).await.unwrap();
    t.commit().await.unwrap();
    id
}

async fn version(
    w: &World,
    number: i32,
    status: VersionStatus,
    sections: Sections,
    hypotheses: Vec<Hypothesis>,
) -> StrategyVersionId {
    version_in(&w.uow, w.ws, w.owner, number, status, sections, hypotheses).await
}

/// The context of the `knowledge_settle` job in `w`'s workspace.
fn job(w: &World) -> Ctx {
    Ctx {
        workspace_id: w.ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    }
}

async fn settle_now(w: &World) -> settle::Settled {
    settle::settle(&w.deps, &job(w)).await.unwrap()
}

async fn settings_of(uow: &dyn UnitOfWork, ws: jt_tenancy::WorkspaceId) -> KnowledgeSettings {
    let mut t = uow.tenant(ws).await.unwrap();
    t.knowledge().settings().await.unwrap().unwrap()
}

async fn settings(w: &World) -> KnowledgeSettings {
    settings_of(&w.uow, w.ws).await
}

/// The frame in force and its hypotheses.
async fn frame_of(
    uow: &dyn UnitOfWork,
    ws: jt_tenancy::WorkspaceId,
) -> Option<(StrategyVersion, Vec<Hypothesis>)> {
    let mut t = uow.tenant(ws).await.unwrap();
    let v = t.strategy().current_approved().await.unwrap()?;
    let h = t.hypotheses().list(v.id).await.unwrap();
    Some((v, h))
}

async fn frame_now(w: &World) -> Option<(StrategyVersion, Vec<Hypothesis>)> {
    frame_of(&w.uow, w.ws).await
}

async fn card_of(w: &World, key: &str) -> Card {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge()
        .cards()
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key} card"))
}

fn body(expected_revision: u64, body: &str) -> CardUpdateInput {
    CardUpdateInput {
        expected_revision,
        body: Some(body.into()),
        ..CardUpdateInput::default()
    }
}

/// An agent's derivation, applied in its own bundle as `jeeta.strategy.frame_apply` will, by
/// `ctx` on behalf of the knowledge base's last editor.
async fn derive_in(
    uow: &dyn UnitOfWork,
    deps: &jt_app::usecases::Deps,
    ctx: &Ctx,
    next: FrameParts,
) -> Result<Applied, AppError> {
    let mut r = uow.tenant(ctx.workspace_id).await?;
    let changed_by = r.knowledge().settings().await?.and_then(|s| s.changed_by);
    let issuer = match &ctx.actor {
        Actor::Human { user_id } | Actor::Agent { user_id, .. } => Some(*user_id),
        _ => None,
    };
    let out = frame::apply(
        deps,
        ctx,
        r.as_mut(),
        Request {
            cause: FrameCause::Derive,
            next: &next,
            approver: issuer,
            waking: changed_by.map_or(Waking::Nobody, Waking::For),
        },
    )
    .await?;
    r.commit().await?;
    Ok(out)
}

async fn derive(w: &World, next: FrameParts) -> Result<Applied, AppError> {
    derive_in(&w.uow, &w.deps, &w.owner_ctx, next).await
}

/// A posting derivation read at `kb_revision`.
fn posting(kb_revision: u64, topics: Option<Vec<TopicInput>>) -> FrameParts {
    FrameParts {
        kb_revision,
        parts: vec![DerivePart::Posting],
        topics,
        ..FrameParts::default()
    }
}

/// The topic `h` as a derivation sends it, unchanged.
fn sent(h: &Hypothesis) -> TopicInput {
    TopicInput {
        id: Some(h.id),
        title: h.title.clone(),
        segment_key: h.segment_key.clone(),
        angle: h.angle.clone(),
        metric: h.metric.clone(),
        prior_confidence: None,
        cadence: None,
    }
}

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

fn live(h: &[Hypothesis]) -> Vec<HypothesisId> {
    h.iter()
        .filter(|x| x.state.is_live())
        .map(|x| x.id)
        .collect()
}

/// `w` with a scripted waker, active, every module installed.
async fn waking_world() -> (World, Arc<ScriptedWaker>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    jt_testkit::studio_contract::install_all_modules(&w.uow, w.ws).await;
    let waker = ScriptedWaker::new();
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_waker(waker.clone()));
    (w, waker)
}

/// A key with `scopes` whose agent connected an hour ago and has a routine to wake.
async fn routine_agent(w: &World, name: &str, scopes: &[&str]) -> ApiKeyId {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: name.into(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    let principal = api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap();
    agents::register_initialize(
        &w.deps,
        &principal,
        ClientInfo {
            name: "claude-code".into(),
            version: "2.1".into(),
            protocol_version: "2025-06-18".into(),
        },
        FIXED_NOW - Duration::hours(1),
    )
    .await
    .unwrap();
    wake::set(
        &w.deps,
        &w.owner_ctx,
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

/// Key `key`'s pending wake: its reasons and who caused it.
fn pending(w: &World, key: ApiKeyId) -> Option<(Vec<WakeReason>, Vec<jt_tenancy::UserId>)> {
    w.uow
        .snapshot()
        .agent_wakes
        .into_iter()
        .find(|s| s.workspace_id == w.ws && s.row.api_key_id == key)
        .and_then(|s| s.row.pending)
        .map(|p| (p.reasons, p.caused_by))
}

// ---------------------------------------------------------------------------------------------
// knowledge_settle: seeding, normalising once, carrying the research tasks
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_first_tick_seeds_and_normalises_a_v5_frame_once_with_every_topic_and_task_kept() {
    let w = world().await;
    let (s, h) = v5();
    let v5_id = version(&w, 5, VersionStatus::Approved, s.clone(), h.clone()).await;
    jt_app::usecases::research::plan(&w.deps, &job(&w))
        .await
        .unwrap();
    let tasks_before: Vec<_> = w
        .uow
        .snapshot()
        .prospects
        .tasks
        .into_iter()
        .filter(|t| t.workspace_id == w.ws)
        .collect();
    assert_eq!(tasks_before.len(), s.prospecting.icp.len());

    let out = settle_now(&w).await;
    assert!(out.seeded);
    let applied = out.applied.clone().expect("a frame applied");
    assert!(applied.applied);
    assert_eq!(applied.cause, FrameCause::Normalize);
    assert_eq!(applied.number, 6);
    assert_eq!((applied.kept, applied.added, applied.retired), (7, 0, 0));
    assert!(out.changed());

    let (v6, topics) = frame_now(&w).await.unwrap();
    assert_eq!(v6.number, 6);
    assert_eq!(v6.approved_by, None, "the system's own housekeeping");
    assert_eq!(v6.sections.channels.len(), 1);
    assert_eq!(v6.sections.channels[0].channel, ANY_CHANNEL);
    assert!(v6.sections.cadence.channel_mix.is_empty());
    assert_eq!(
        v6.sections
            .budget_frame
            .lanes
            .iter()
            .map(|l| (l.lane, l.cap_minor, l.currency.as_str()))
            .collect::<Vec<_>>(),
        [
            (LaneKind::Paid, 500_000, "TRY"),
            (LaneKind::Organic, 0, "TRY")
        ],
        "the same two lanes: the ad cap and the paid-message limit of 0 (D3)"
    );
    assert!(v6.sections.paid_enabled);
    assert_eq!(v6.sections.audience, s.audience);
    assert_eq!(v6.sections.prospecting, s.prospecting);
    assert_eq!(
        topics.iter().map(|t| t.id).collect::<Vec<_>>(),
        h.iter().map(|t| t.id).collect::<Vec<_>>()
    );
    for (before, after) in h.iter().zip(&topics) {
        assert_eq!(after.state, HypothesisState::Kept);
        assert_eq!(after.channel, ANY_CHANNEL);
        assert_eq!(after.cadence, before.cadence, "the same organic cadences");
        assert_eq!(after.title, before.title);
    }
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let old = t.strategy().find(v5_id).await.unwrap().unwrap();
    assert_eq!(old.status, VersionStatus::Archived);
    drop(t);

    // The seven standing tasks are carried: same ids, open, under version 6; none superseded.
    let tasks_after: Vec<_> = w
        .uow
        .snapshot()
        .prospects
        .tasks
        .into_iter()
        .filter(|t| t.workspace_id == w.ws)
        .collect();
    assert_eq!(tasks_after.len(), tasks_before.len());
    for t in &tasks_after {
        assert_eq!(t.status, TaskStatus::Open);
        assert_eq!(t.strategy_version_id, v6.id);
        assert!(tasks_before.iter().any(|b| b.id == t.id));
    }
    assert_eq!(w.entries("research.task_carried").len(), 7);
    assert!(w.entries("research.task_closed").is_empty());

    let applied_entries = w.entries("strategy.frame_applied");
    assert_eq!(applied_entries.len(), 1);
    let p = support::payload(&applied_entries[0]);
    assert_eq!(p["cause"], "normalize");
    assert_eq!(p["number"], 6);
    assert_eq!(p["kept"], 7);
    assert_eq!(
        applied_entries[0].strategy_version_id,
        Some(v6.id.as_uuid())
    );

    // A second tick applies nothing.
    let again = settle_now(&w).await;
    assert!(!again.seeded);
    assert!(again.applied.is_none());
    assert!(!again.changed());
    assert_eq!(frame_now(&w).await.unwrap().0.id, v6.id);
    assert_eq!(w.entries("strategy.frame_applied").len(), 1);
}

#[tokio::test]
async fn the_job_settles_every_workspace_and_counts_what_it_changed() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let (s, h) = v5();
    version(&w, 5, VersionStatus::Approved, s, h).await;
    assert_eq!(Job::KnowledgeSettle.name(), "knowledge_settle");
    let report = jobs::run_knowledge_settle(&w.deps, FIXED_NOW).await;
    assert_eq!((report.touched, report.changed, report.failed), (1, 1, 0));
    let report = jobs::run_knowledge_settle(&w.deps, FIXED_NOW).await;
    assert_eq!(
        (
            report.touched,
            report.changed,
            report.skipped,
            report.failed
        ),
        (1, 0, 1, 0)
    );
}

#[tokio::test]
async fn a_frame_with_31_topics_and_the_owners_request_is_normalised() {
    let w = world().await;
    let (s, h) = v5();
    let mut many: Vec<Hypothesis> = (0..31)
        .map(|i| Hypothesis {
            id: HypothesisId::new_v7(),
            title: format!("Konu {i}"),
            ..h[0].clone()
        })
        .collect();
    many.push(owner_request::hypothesis(w.ws, HypothesisState::Kept));
    version(&w, 5, VersionStatus::Approved, s, many).await;
    let applied = settle_now(&w).await.applied.unwrap();
    assert!(applied.applied);
    let (_, topics) = frame_now(&w).await.unwrap();
    assert_eq!(live(&topics).len(), 32);
    assert!(topics.iter().any(|t| owner_request::is(w.ws, t.id)));
    assert_eq!(applied.kept, 31, "the owner's request is not counted");
}

#[tokio::test]
async fn expired_proposals_are_closed_by_the_job() {
    let w = world().await;
    let (s, _) = v5();
    version(&w, 1, VersionStatus::Draft, s, vec![]).await;
    settle_now(&w).await;
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let pending = t
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await
        .unwrap();
    drop(t);
    assert!(!pending.is_empty(), "the draft's parts wait as proposals");
    let later = Ctx {
        now: FIXED_NOW + SYSTEM_PROPOSAL_TTL + Duration::minutes(1),
        ..job(&w)
    };
    let out = settle::settle(&w.deps, &later).await.unwrap();
    assert_eq!(out.expired, pending.len() as u64);
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        t.knowledge()
            .proposals(Some(ProposalStatus::Pending))
            .await
            .unwrap()
            .is_empty()
    );
}

// ---------------------------------------------------------------------------------------------
// The bootstrap (D4)
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_first_card_text_bootstraps_the_frame_in_the_same_write() {
    let (w, _) = waking_world().await;
    let content = routine_agent(&w, "Content", &["workspace.read", "content.work"]).await;
    let social = routine_agent(&w, "Social", &["workspace.read", "social.work"]).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(frame_now(&w).await.is_none());

    // A rule or a goal first: saved, and still no frame (the knowledge base is still empty).
    goals_save(
        &w.deps,
        &w.owner_ctx,
        GoalsInput {
            expected_revision: 1,
            items: vec!["Ayda 40 abonelik".into()],
        },
    )
    .await
    .unwrap();
    assert!(frame_now(&w).await.is_none());
    // A card without text: still none.
    let who = card_of(&w, "who_we_are").await;
    let who = card_update(&w.deps, &w.owner_ctx, who.id, body(who.revision, "   "))
        .await
        .unwrap();
    assert!(frame_now(&w).await.is_none());
    assert!(is_empty(std::slice::from_ref(&who)));

    // The first text: the frame, in the same write.
    let who = card_update(
        &w.deps,
        &w.owner_ctx,
        who.id,
        body(who.revision, "Ege'de küçük bir kavurma atölyesiyiz."),
    )
    .await
    .unwrap();
    let (v, topics) = frame_now(&w).await.expect("the bootstrap frame");
    assert_eq!(v.number, 1);
    assert_eq!(v.approved_by, Some(w.owner));
    assert_eq!(
        v.sections.identity.product, who.body,
        "the first card with text"
    );
    assert_eq!(v.sections.channels[0].channel, ANY_CHANNEL);
    assert_eq!(
        v.sections
            .goals
            .kpis
            .iter()
            .map(|k| k.name.as_str())
            .collect::<Vec<_>>(),
        ["Ayda 40 abonelik"]
    );
    assert_eq!(v.sections.audience.len(), 1);
    assert_eq!(v.sections.audience[0].key, "genel");
    assert_eq!(topics.len(), 1);
    assert_eq!(topics[0].id, bootstrap_id(w.ws));
    assert_eq!(topics[0].title, BOOTSTRAP_TITLE);
    assert!(
        v.sections.budget_frame.lanes.is_empty(),
        "no caps: no lanes"
    );
    let s = settings(&w).await;
    assert!(
        s.posting_revision > s.posting_derived,
        "the posting derivation is due"
    );
    assert!(
        s.prospecting_revision > s.prospecting_derived,
        "the prospecting derivation is due"
    );
    assert!(s.frame_applied_at.is_some());
    let entries = w.entries("strategy.frame_applied");
    assert_eq!(entries.len(), 1);
    assert_eq!(support::payload(&entries[0])["cause"], "bootstrap");
    // The work that waited for a frame is offered: content and social are woken, in person.
    let (reasons, by) = pending(&w, content).expect("the content agent is woken");
    assert!(reasons.contains(&WakeReason::KnowledgeApplied));
    assert_eq!(by, [w.owner]);
    assert!(
        pending(&w, social)
            .unwrap()
            .0
            .contains(&WakeReason::KnowledgeApplied)
    );

    // Another card write applies nothing more.
    let voice = card_of(&w, "voice").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        voice.id,
        body(voice.revision, "Samimi"),
    )
    .await
    .unwrap();
    assert_eq!(frame_now(&w).await.unwrap().0.id, v.id);
    assert_eq!(w.entries("strategy.frame_applied").len(), 1);
}

#[tokio::test]
async fn a_new_card_with_text_bootstraps_too() {
    let w = world().await;
    card_create(
        &w.deps,
        &w.owner_ctx,
        CardCreateInput {
            title: "Pastalar".into(),
            body: "Doğum günü pastaları yapıyoruz.".into(),
            attachments: vec![],
            position: None,
        },
    )
    .await
    .unwrap();
    let (v, _) = frame_now(&w).await.expect("the bootstrap frame");
    assert_eq!(
        v.sections.identity.product,
        "Doğum günü pastaları yapıyoruz."
    );
}

#[tokio::test]
async fn a_draft_only_workspace_has_no_frame_until_the_owner_adds_a_proposal() {
    let w = world().await;
    let (s, h) = v5();
    version(&w, 1, VersionStatus::Draft, s, h).await;
    let out = settle_now(&w).await;
    assert!(out.seeded);
    assert!(
        out.applied.is_none(),
        "no frame from text never approved (D15)"
    );
    assert!(frame_now(&w).await.is_none());
    assert_eq!(settings(&w).await.seed_source, SeedSource::Draft);
    // A second tick still writes none.
    settle_now(&w).await;
    assert!(frame_now(&w).await.is_none());

    // Adding the who-we-are proposal bootstraps it.
    let who = card_of(&w, "who_we_are").await;
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let proposal = t
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.card_id == Some(who.id))
        .expect("a proposal for who_we_are");
    drop(t);
    proposal_accept(&w.deps, &w.owner_ctx, proposal.id)
        .await
        .unwrap();
    let (v, topics) = frame_now(&w).await.expect("the bootstrap frame");
    assert_eq!(v.approved_by, Some(w.owner));
    assert_eq!(topics[0].id, bootstrap_id(w.ws));
}

#[tokio::test]
async fn a_skipped_bootstrap_is_repaired_by_the_job_and_wakes_nobody() {
    let (w, _) = waking_world().await;
    let content = routine_agent(&w, "Content", &["workspace.read", "content.work"]).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    // A card got its text without the bootstrap (written past the use case).
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let mut card = t
        .knowledge()
        .cards()
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.key.as_deref() == Some("products_prices"))
        .unwrap();
    card.body = "Filtre kahve 250 g".into();
    card.revision += 1;
    t.knowledge().save_card(&card).await.unwrap();
    let mut s = t.knowledge().lock_settings().await.unwrap().unwrap();
    s.changed_by = Some(w.owner);
    t.knowledge().save_settings(&s).await.unwrap();
    t.commit().await.unwrap();
    assert!(frame_now(&w).await.is_none());

    let out = settle_now(&w).await;
    let applied = out.applied.unwrap();
    assert!(applied.applied);
    assert_eq!(applied.cause, FrameCause::Bootstrap);
    let (v, _) = frame_now(&w).await.unwrap();
    assert_eq!(v.approved_by, Some(w.owner), "approved by changed_by");
    assert_eq!(v.sections.identity.product, "Filtre kahve 250 g");
    assert!(pending(&w, content).is_none(), "the repair wakes nobody");
}

// ---------------------------------------------------------------------------------------------
// A derivation (the core of `jeeta.strategy.frame_apply`)
// ---------------------------------------------------------------------------------------------

/// A world seeded from the sample and normalised: the frame in force is version 6.
async fn normalised() -> World {
    let w = world().await;
    let (s, h) = v5();
    version(&w, 5, VersionStatus::Approved, s, h).await;
    settle_now(&w).await;
    w
}

#[tokio::test]
async fn a_derivation_is_a_compare_and_set_on_the_revision_it_read() {
    let w = normalised().await;
    let rev = settings(&w).await.revision;
    let e = err(derive(&w, posting(rev + 1, None)).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "kb_revision_ahead")
    );

    // The owner edits a posting card: the derivation becomes due.
    let ideas = card_of(&w, "post_ideas").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        ideas.id,
        body(ideas.revision, "• Kavurma günü"),
    )
    .await
    .unwrap();
    let s = settings(&w).await;
    assert_eq!(s.revision, rev + 1);
    assert_eq!(s.posting_revision, rev + 1);
    assert!(s.posting_revision > s.posting_derived);
    assert_eq!(
        s.prospecting_revision, rev,
        "post ideas feed no prospecting"
    );

    // Nothing changed: `parts` alone acknowledges, and writes no version.
    let before = frame_now(&w).await.unwrap().0;
    let out = derive(&w, posting(rev + 1, None)).await.unwrap();
    assert!(!out.applied && !out.text_only);
    assert_eq!(out.number, before.number);
    let s = settings(&w).await;
    assert_eq!(s.posting_derived, rev + 1, "the item is cleared");
    assert_eq!(frame_now(&w).await.unwrap().0.id, before.id);

    // An older derivation after a newer one is refused, and the frame stays.
    let (_, h) = frame_now(&w).await.unwrap();
    let e = err(derive(&w, posting(rev, Some(vec![sent(&h[0])]))).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "derivation_stale")
    );
    assert_eq!(frame_now(&w).await.unwrap().0.id, before.id);
    assert_eq!(live(&frame_now(&w).await.unwrap().1).len(), 7);
}

#[tokio::test]
async fn a_derivation_keeps_ids_and_skips_when_only_texts_moved() {
    let w = normalised().await;
    let rev = settings(&w).await.revision;
    let (v6, h) = frame_now(&w).await.unwrap();
    // The same topics, titles given without ids, and every angle reworded: matched by title,
    // texts only, no version.
    let reworded: Vec<TopicInput> = h
        .iter()
        .map(|t| TopicInput {
            id: None,
            angle: format!("{} — başka sözlerle", t.angle),
            ..sent(t)
        })
        .collect();
    let out = derive(
        &w,
        FrameParts {
            objective: Some("Yeni amaç cümlesi".into()),
            ..posting(rev, Some(reworded))
        },
    )
    .await
    .unwrap();
    assert!(!out.applied);
    assert!(out.text_only);
    assert_eq!(frame_now(&w).await.unwrap().0.id, v6.id);
    assert_eq!(
        out.topics.iter().map(|t| t.id).collect::<Vec<_>>(),
        h.iter().map(|t| t.id).collect::<Vec<_>>()
    );

    // A real change: one topic left out, one new. Ids stay, the new one is added.
    let mut topics: Vec<TopicInput> = h[..6].iter().map(sent).collect();
    topics.push(TopicInput {
        id: None,
        title: "Kavurma günü canlı yayın".into(),
        ..sent(&h[0])
    });
    let out = derive(&w, posting(rev, Some(topics.clone())))
        .await
        .unwrap();
    assert!(out.applied);
    assert_eq!((out.kept, out.added, out.retired), (6, 1, 1));
    assert_eq!(out.number, 7);
    let (v7, h7) = frame_now(&w).await.unwrap();
    assert_eq!(v7.number, 7);
    assert_eq!(v7.approved_by, Some(w.owner), "the key's issuer");
    let added = h7
        .iter()
        .find(|t| t.state == HypothesisState::Added)
        .unwrap();
    assert_eq!(added.channel, ANY_CHANNEL);
    assert_eq!(
        h7.iter().find(|t| t.id == h[6].id).map(|t| t.state),
        Some(HypothesisState::Retired)
    );
    let entries = w.entries("strategy.frame_applied");
    let p = support::payload(entries.last().unwrap());
    assert_eq!(p["cause"], "derive");
    assert_eq!(p["parts"], json!(["posting"]));
    assert_eq!(
        (p["kept"].clone(), p["added"].clone(), p["retired"].clone()),
        (json!(6), json!(1), json!(1))
    );

    // The same derivation again, now with the new topic's id: nothing to apply.
    let mut again: Vec<TopicInput> = h[..6].iter().map(sent).collect();
    again.push(sent(added));
    let out = derive(&w, posting(rev, Some(again))).await.unwrap();
    assert!(!out.applied);
    assert_eq!(frame_now(&w).await.unwrap().0.id, v7.id);
}

#[tokio::test]
async fn acknowledgements_take_the_max_and_name_only_what_was_derived() {
    let w = normalised().await;
    let ideas = card_of(&w, "post_ideas").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        ideas.id,
        body(ideas.revision, "• Kavurma"),
    )
    .await
    .unwrap();
    let seek = card_of(&w, "who_we_seek").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        seek.id,
        body(seek.revision, "• Kafeler"),
    )
    .await
    .unwrap();
    let s = settings(&w).await;
    let (posting_rev, prospecting_rev) = (s.posting_revision, s.prospecting_revision);
    assert!(prospecting_rev > posting_rev);
    // The posting part, read at the newest revision.
    derive(&w, posting(s.revision, None)).await.unwrap();
    let s2 = settings(&w).await;
    assert_eq!(s2.posting_derived, s.revision);
    assert!(
        s2.prospecting_derived < prospecting_rev,
        "prospecting still due"
    );
    // A prospecting derivation read earlier (before the posting acknowledgement, after its own
    // card) acknowledges only what it read; the posting mark never goes back.
    let out = derive(
        &w,
        FrameParts {
            kb_revision: prospecting_rev,
            parts: vec![DerivePart::Prospecting],
            ..FrameParts::default()
        },
    )
    .await
    .unwrap();
    assert!(!out.applied);
    let s3 = settings(&w).await;
    assert_eq!(s3.prospecting_derived, prospecting_rev);
    assert_eq!(s3.posting_derived, s.revision);
}

#[tokio::test]
async fn a_derivation_refuses_what_it_cannot_take() {
    // No frame: nothing to derive.
    let w = world().await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let e = err(derive(&w, posting(0, None)).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "knowledge_empty")
    );

    let w = normalised().await;
    let rev = settings(&w).await.revision;
    let (_, h) = frame_now(&w).await.unwrap();
    // Gaps name the caller's input.
    let mut bad = sent(&h[1]);
    bad.angle = String::new();
    let e = err(derive(&w, posting(rev, Some(vec![sent(&h[0]), bad]))).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["gaps"][0]["field"], "topics[1].angle");
    // The owner's request is no topic.
    let mut reserved = sent(&h[0]);
    reserved.id = Some(owner_request::id(w.ws));
    let e = err(derive(&w, posting(rev, Some(vec![reserved]))).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Forbidden, "hypothesis_reserved")
    );
    assert_eq!(frame_now(&w).await.unwrap().0.number, 6);
}

#[tokio::test]
async fn a_derivation_wakes_for_what_changed_on_behalf_of_the_last_editor() {
    let (w, _) = waking_world().await;
    let social = routine_agent(&w, "Social", &["workspace.read", "social.work"]).await;
    let ads = routine_agent(&w, "Ads", &["workspace.read", "ads.work"]).await;
    let research = routine_agent(&w, "Research", &["workspace.read", "prospects.work"]).await;
    let (s, h) = v5();
    version(&w, 5, VersionStatus::Approved, s.clone(), h).await;
    settle_now(&w).await;
    assert!(pending(&w, social).is_none(), "normalising wakes nobody");
    let editor = w.member("manager").await;
    let ideas = card_of(&w, "post_ideas").await;
    card_update(
        &w.deps,
        &editor,
        ideas.id,
        body(ideas.revision, "• Kavurma"),
    )
    .await
    .unwrap();
    let rev = settings(&w).await.revision;
    let (_, h) = frame_now(&w).await.unwrap();
    // The agent drops a topic: the topics changed, nothing paid, nothing of prospecting.
    let agent = w.agent(&["workspace.read", "content.work"]).await;
    let out = derive_in(
        &w.uow,
        &w.deps,
        &agent,
        posting(rev, Some(h[..6].iter().map(sent).collect())),
    )
    .await
    .unwrap();
    assert!(out.applied);
    let Actor::Human { user_id: manager } = editor.actor else {
        panic!()
    };
    let (reasons, by) = pending(&w, social).expect("social is woken");
    assert_eq!(reasons, [WakeReason::KnowledgeApplied]);
    assert_eq!(
        by,
        [manager],
        "on behalf of the knowledge base's last editor"
    );
    assert!(pending(&w, ads).is_none());
    assert!(pending(&w, research).is_none());
    // A prospecting change wakes research.
    let mut icp = s.prospecting.icp.clone();
    icp.truncate(3);
    let out = derive_in(
        &w.uow,
        &w.deps,
        &agent,
        FrameParts {
            kb_revision: rev,
            parts: vec![DerivePart::Prospecting],
            prospecting: Some(ProspectingInput {
                icp,
                rubric: s.prospecting.rubric.clone(),
                segments: vec![],
            }),
            ..FrameParts::default()
        },
    )
    .await
    .unwrap();
    assert!(out.applied);
    assert!(pending(&w, research).is_some());
    assert!(pending(&w, ads).is_none());
}

#[tokio::test]
async fn a_dropped_segment_an_icp_entry_uses_is_carried() {
    let w = normalised().await;
    let rev = settings(&w).await.revision;
    let (v6, h) = frame_now(&w).await.unwrap();
    // The agent sends an audience of only the segments its topics use.
    let used: Vec<Segment> = v6
        .sections
        .audience
        .iter()
        .filter(|g| h.iter().any(|t| t.segment_key == g.key))
        .cloned()
        .collect();
    assert!(used.len() < v6.sections.audience.len());
    let out = derive(
        &w,
        FrameParts {
            audience: Some(used),
            ..posting(rev, Some(h.iter().map(sent).collect()))
        },
    )
    .await
    .unwrap();
    assert!(!out.kept_segments.is_empty());
    let (now, _) = frame_now(&w).await.unwrap();
    for e in &now.sections.prospecting.icp {
        assert!(
            now.sections.audience.iter().any(|g| g.key == e.segment_key),
            "{} is still a segment",
            e.segment_key
        );
    }
}

// ---------------------------------------------------------------------------------------------
// What a post, a binding or an ad still names (D9)
// ---------------------------------------------------------------------------------------------

/// The Studio world (an X account, a ready post of the topic "test" on the content type "text",
/// a frame with a paid lane), seeded: the frame in force is the fixture's.
async fn studio() -> studio_support::World {
    let w = studio_support::world().await;
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    w
}

/// A derivation in the Studio world sending `topics` on the segment `all`.
async fn studio_derive(
    w: &studio_support::World,
    topics: Vec<TopicInput>,
) -> Result<Applied, AppError> {
    let rev = settings_of(&w.uow, w.f.ws).await.revision;
    derive_in(
        &w.uow,
        &w.d,
        &w.ctx,
        FrameParts {
            audience: Some(vec![Segment {
                key: "all".into(),
                name: "Herkes".into(),
                description: String::new(),
            }]),
            ..posting(rev, Some(topics))
        },
    )
    .await
}

fn studio_topic(id: Option<HypothesisId>, title: &str, content_type: &str) -> TopicInput {
    TopicInput {
        id,
        title: title.into(),
        segment_key: "all".into(),
        angle: "help".into(),
        metric: "reply".into(),
        prior_confidence: None,
        cadence: Some(BTreeMap::from([(
            LaneKind::Organic,
            HypothesisCadence {
                slots_per_week: 3,
                exploration_bps: 0,
                content_types: vec![ContentTypeShare {
                    key: content_type.into(),
                    min_bps: 0,
                    max_bps: 10_000,
                }],
            },
        )])),
    }
}

#[tokio::test]
async fn a_derivation_that_drops_a_content_type_leaves_the_ready_post_sendable() {
    let w = studio().await;
    w.permit().await.expect("the ready post is sendable before");
    let topic = w.f.slot.chain.hypothesis_id;
    let out = studio_derive(&w, vec![studio_topic(Some(topic), "test", "general")])
        .await
        .unwrap();
    assert!(out.applied);
    let (v, h) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert_ne!(v.id, w.current);
    let kept = h.iter().find(|t| t.id == topic).unwrap();
    let organic = &kept.cadence[&LaneKind::Organic];
    assert!(
        organic
            .content_types
            .iter()
            .any(|t| t.key == "text" && t.max_bps > 0),
        "the type its ready post uses stays"
    );
    w.permit().await.expect("the ready post is still sendable");
}

#[tokio::test]
async fn a_left_out_topic_with_a_ready_post_is_closing_and_retired_once_nothing_names_it() {
    let w = studio().await;
    let topic = w.f.slot.chain.hypothesis_id;
    let out = studio_derive(&w, vec![studio_topic(None, "Yeni konu", "general")])
        .await
        .unwrap();
    assert!(out.applied);
    assert_eq!(out.closing, [topic]);
    assert!(out.topics.iter().all(|t| t.id != topic), "not offered");
    let s = settings_of(&w.uow, w.f.ws).await;
    assert_eq!(s.closing_topic_ids, [topic]);
    let (_, h) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert_eq!(
        h.iter().find(|t| t.id == topic).map(|t| t.state),
        Some(HypothesisState::Kept)
    );
    w.permit().await.expect("its planned post keeps its chain");

    // The housekeeping keeps it while the post is ready...
    let ctx = Ctx {
        workspace_id: w.f.ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let before = frame_of(&w.uow, w.f.ws).await.unwrap().0.id;
    settle::settle(&w.d, &ctx).await.unwrap();
    assert_eq!(frame_of(&w.uow, w.f.ws).await.unwrap().0.id, before);
    // ...and retires it once nothing names it (its post went out or, here, was cancelled), with
    // no knowledge edit in between.
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let slot = r.studio().get_slot(w.f.slot.id).await.unwrap().unwrap();
    r.studio()
        .retire_slot(slot.id, slot.revision, "cancelled")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let out = settle::settle(&w.d, &ctx).await.unwrap();
    let applied = out.applied.unwrap();
    assert!(applied.applied);
    assert_eq!(applied.cause, FrameCause::Close);
    assert_eq!(applied.retired, 1);
    let (_, h) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert_eq!(
        h.iter().find(|t| t.id == topic).map(|t| t.state),
        Some(HypothesisState::Retired)
    );
    assert!(
        settings_of(&w.uow, w.f.ws)
            .await
            .closing_topic_ids
            .is_empty()
    );
}

#[tokio::test]
async fn a_derivation_leaving_out_a_paid_topic_with_a_binding_keeps_it_and_does_not_brake() {
    let w = studio().await;
    let (b, _) = w.paid().await;
    let topic = b.chain.hypothesis_id;
    let out = studio_derive(&w, vec![studio_topic(None, "Yeni konu", "general")])
        .await
        .unwrap();
    assert_eq!(out.closing, [topic]);
    let (v, h) = frame_of(&w.uow, w.f.ws).await.unwrap();
    let kept = h.iter().find(|t| t.id == topic).unwrap();
    assert_eq!(kept.state, HypothesisState::Kept);
    assert!(
        kept.cadence.contains_key(&LaneKind::Paid),
        "its paid cadence stays"
    );
    assert!(v.sections.paid_enabled);
    let control = w.uow.snapshot().studio.controls;
    assert!(
        control.iter().all(|c| !c.is_braked(LaneKind::Paid)),
        "nothing braked the paid lane"
    );
}

// ---------------------------------------------------------------------------------------------
// The rules' mirror and the paid-message limit (D3)
// ---------------------------------------------------------------------------------------------

/// A cash item with a unit price of 3 linked to the Studio world's X account (its sends are
/// metered), capped at 1.000 a month.
async fn metered(w: &studio_support::World) {
    let item = jt_app::usecases::budget::create_item(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"name":"Mesaj","kind":"cash",
            "unit":{"kind":"currency","value":"TRY"},"cap":1000,"period":"monthly",
            "unit_cost_minor":3}))
        .unwrap(),
    )
    .await
    .unwrap()
    .item
    .id;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.budget().link(w.f.slot.capability_id, item).await.unwrap();
    r.commit().await.unwrap();
}

/// Reserves `units` metered sends (3 each) on the X account; the refusal's reason otherwise.
async fn send(w: &studio_support::World, key: &str, units: u64) -> Result<(), String> {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    jt_app::usecases::studio::budget::reserve_metered_for(
        r.as_mut(),
        &cap,
        None,
        Some(units),
        key.into(),
        FIXED_NOW,
        Some("inbox"),
    )
    .await
    .map_err(|e| e.details["reason"].as_str().unwrap_or("?").to_owned())?
    .expect("a metered send reserves");
    r.commit().await.unwrap();
    Ok(())
}

/// Applies the rules' mirror in the Studio world after `edit` changed the settings.
async fn mirror(w: &studio_support::World, edit: impl FnOnce(&mut KnowledgeSettings)) -> Applied {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.strategy().lock_draft().await.unwrap();
    r.strategy().lock_execution_frame().await.unwrap();
    let mut s = r.knowledge().lock_settings().await.unwrap().unwrap();
    edit(&mut s);
    r.knowledge().save_settings(&s).await.unwrap();
    let out = frame::apply(
        &w.d,
        &w.ctx,
        r.as_mut(),
        Request {
            cause: FrameCause::Rules,
            next: &FrameParts::default(),
            approver: None,
            waking: Waking::InPerson,
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    out
}

#[tokio::test]
async fn the_paid_message_limit_is_carried_and_a_frame_without_one_has_no_lane_cap() {
    let w = studio().await;
    metered(&w).await;
    let s = settings_of(&w.uow, w.f.ws).await;
    assert_eq!(
        s.message_cap.as_ref().map(|c| c.amount_minor),
        Some(100),
        "the approved organic lane is the paid-message limit"
    );
    // The first tick normalises the frame; the limit still binds: 40 sends (120) are refused.
    let ctx = Ctx {
        workspace_id: w.f.ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let out = settle::settle(&w.d, &ctx).await.unwrap();
    assert!(out.applied.unwrap().applied);
    assert!(send(&w, "too-many", 40).await.is_err());
    send(&w, "within", 30).await.unwrap();

    // No limit of its own: the frame loses its organic lane, and a send meets only its item's
    // cap (1.000) and the account's own.
    let out = mirror(&w, |s| s.message_cap = None).await;
    assert!(out.applied);
    let (v, _) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert!(
        v.sections
            .budget_frame
            .lanes
            .iter()
            .all(|l| l.lane != LaneKind::Organic)
    );
    send(&w, "no-lane", 40).await.unwrap();
    assert!(
        send(&w, "past-the-item", 300).await.is_err(),
        "the item's cap (1.000) still binds"
    );

    // "Reklam yok": no paid lane, `paid_enabled` off.
    let out = mirror(&w, |s| s.ad_cap = None).await;
    assert!(out.applied);
    let (v, _) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert!(!v.sections.paid_enabled);
    assert!(v.sections.budget_frame.lanes.is_empty());
}

#[tokio::test]
async fn a_rules_mirror_of_an_unchanged_cap_writes_no_version() {
    let w = studio().await;
    let ctx = Ctx {
        workspace_id: w.f.ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    settle::settle(&w.d, &ctx).await.unwrap();
    let before = frame_of(&w.uow, w.f.ws).await.unwrap().0.id;
    let out = mirror(&w, |_| {}).await;
    assert!(!out.applied);
    assert_eq!(frame_of(&w.uow, w.f.ws).await.unwrap().0.id, before);
    // A lower cap is a version, with the person as approver... the caller's (the owner here).
    let out = mirror(&w, |s| {
        if let Some(c) = s.ad_cap.as_mut() {
            c.amount_minor = 50_000;
        }
    })
    .await;
    assert!(out.applied);
    let (v, _) = frame_of(&w.uow, w.f.ws).await.unwrap();
    assert_eq!(
        v.sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid)
            .map(|l| l.cap_minor),
        Some(50_000)
    );
}

// ---------------------------------------------------------------------------------------------
// Approvals through the old tools (§4.3.4)
// ---------------------------------------------------------------------------------------------

/// Submits a draft of `sections` and `hypotheses` (number `number`) and approves it through
/// `strategy.approve`, as an old routine would.
async fn old_approval(
    w: &World,
    number: i32,
    sections: Sections,
    hypotheses: Vec<Hypothesis>,
) -> Result<StrategyVersionId, AppError> {
    let id = version(w, number, VersionStatus::Draft, sections, hypotheses).await;
    strategy::approve(
        &w.deps,
        &w.owner_ctx,
        ApproveInput {
            version_id: id,
            submitted_at: FIXED_NOW,
        },
    )
    .await
    .map(|_| id)
}

#[tokio::test]
async fn an_old_approval_resyncs_the_cards_the_owner_did_not_change() {
    let w = normalised().await;
    // The owner rewrites the voice card.
    let voice = card_of(&w, "voice").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        voice.id,
        body(voice.revision, "Bizim sesimiz"),
    )
    .await
    .unwrap();
    let products_before = card_of(&w, "products_prices").await;
    let caps_before = settings(&w).await;

    // An old routine approves a draft: a new product text, a new voice, one more prohibition, a
    // lower paid lane and a higher organic lane.
    let (mut s, h) = v5();
    // The draft names channels no account of this workspace has: the approval writes every
    // account into it (`any`) before it is validated.
    s.identity.product = "Yeni ürün listesi: filtre, espresso, hediye kutusu".into();
    s.identity.voice = "Resmî ve kısa".into();
    s.prohibitions
        .push("Hiçbir paylaşımda indirim sözü verilmez".into());
    s.budget_frame.lanes[0].cap_minor = 300_000;
    s.budget_frame.lanes[1].cap_minor = 50_000;
    let id = old_approval(&w, 7, s, h).await.unwrap();

    let (v, topics) = frame_now(&w).await.unwrap();
    assert_eq!(v.id, id);
    // Already shaped as the frame: channels any, topics on any, no mix, lanes from the caps
    // after the lowering (the organic lane is never raised).
    assert_eq!(v.sections.channels.len(), 1);
    assert_eq!(v.sections.channels[0].channel, ANY_CHANNEL);
    assert!(v.sections.cadence.channel_mix.is_empty());
    assert!(
        topics
            .iter()
            .filter(|t| t.state.is_live())
            .all(|t| t.channel == ANY_CHANNEL)
    );
    assert_eq!(
        v.sections
            .budget_frame
            .lanes
            .iter()
            .map(|l| (l.lane, l.cap_minor))
            .collect::<Vec<_>>(),
        [(LaneKind::Paid, 300_000), (LaneKind::Organic, 0)]
    );

    // The products card was the seed's: rewritten from the version.
    let products = card_of(&w, "products_prices").await;
    assert_eq!(products.body, v.sections.identity.product);
    assert_eq!(products.revision, products_before.revision + 1);
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let rev = t
        .knowledge()
        .revisions(Subject::Card, Some(products.id), None, 1)
        .await
        .unwrap();
    assert_eq!(rev[0].cause, Cause::Resync);
    // The voice card is the owner's: left, with a proposal carrying the version's text.
    let proposals = t
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await
        .unwrap();
    drop(t);
    assert_eq!(card_of(&w, "voice").await.body, "Bizim sesimiz");
    let p = proposals
        .iter()
        .find(|p| p.card_id == Some(voice.id))
        .expect("a proposal for the voice card");
    assert_eq!(p.body, "Resmî ve kısa");
    assert_eq!(p.reason, RESYNC_REASON);
    assert_eq!(
        p.proposed_by,
        Proposer::System {
            component: RESYNC_COMPONENT.into()
        }
    );

    // The rules: the new prohibition appended, the ad cap lowered, the message cap never
    // raised; nothing left to derive.
    let s = settings(&w).await;
    assert!(
        s.prohibitions
            .contains(&"Hiçbir paylaşımda indirim sözü verilmez".to_owned())
    );
    assert_eq!(s.prohibitions.len(), caps_before.prohibitions.len() + 1);
    assert_eq!(s.ad_cap.as_ref().unwrap().amount_minor, 300_000);
    assert_eq!(s.message_cap, caps_before.message_cap);
    assert_eq!(s.posting_revision, s.revision);
    assert_eq!(s.prospecting_revision, s.revision);
    assert_eq!(s.posting_derived, s.revision);
    assert_eq!(s.prospecting_derived, s.revision);
    assert!(
        v.sections
            .prohibitions
            .contains(&"Hiçbir paylaşımda indirim sözü verilmez".to_owned())
    );

    // A later approval with a higher lane never raises the cap.
    let (mut s2, h2) = v5();
    s2.budget_frame.lanes[0].cap_minor = 900_000;
    old_approval(&w, 8, s2, h2).await.unwrap();
    assert_eq!(settings(&w).await.ad_cap.unwrap().amount_minor, 300_000);
    let (v8, _) = frame_now(&w).await.unwrap();
    assert_eq!(
        v8.sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid)
            .map(|l| l.cap_minor),
        Some(300_000)
    );
}

#[tokio::test]
async fn an_old_approval_seeds_a_workspace_not_seeded_yet() {
    let w = world().await;
    // A draft an old routine wrote for every connected account (no account is connected here).
    let (mut s, mut h) = v5();
    s.channels = jt_knowledge::frame::any_channels();
    s.cadence.channel_mix.clear();
    for t in &mut h {
        t.channel = ANY_CHANNEL.into();
    }
    let id = old_approval(&w, 1, s.clone(), h).await.unwrap();
    let k = settings(&w).await;
    assert_eq!(k.seed_source, SeedSource::Approved);
    assert_eq!(
        card_of(&w, "products_prices").await.body,
        s.identity.product
    );
    assert_eq!(frame_now(&w).await.unwrap().0.id, id);
}

#[tokio::test]
async fn archiving_the_frame_is_refused_once_the_knowledge_base_is_seeded() {
    let w = normalised().await;
    let (v, _) = frame_now(&w).await.unwrap();
    let e = err(strategy::archive(
        &w.deps,
        &w.owner_ctx,
        ArchiveInput {
            version_id: v.id,
            confirm: true,
        },
    )
    .await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Conflict, "use_brake"));
    assert_eq!(frame_now(&w).await.unwrap().0.id, v.id);
}

// ---------------------------------------------------------------------------------------------
// Research tasks survive (K5)
// ---------------------------------------------------------------------------------------------

fn entry(key: &str, sector: &str) -> IcpEntry {
    IcpEntry {
        key: key.into(),
        segment_key: "kafeler".into(),
        sectors: vec![sector.into()],
        areas: vec![Area {
            city: "İzmir".into(),
            district: None,
        }],
        signals: vec!["yeni şube".into()],
        exclusions: vec![],
        size_hint: String::new(),
        language: Some("tr".into()),
        daily_cap: 10,
        backlog_target: 50,
    }
}

fn prospecting(icp: Vec<IcpEntry>) -> Sections {
    Sections {
        identity: jt_strategy::Identity {
            product: "Kahve".into(),
            ..Default::default()
        },
        audience: vec![Segment {
            key: "kafeler".into(),
            name: "Kafeler".into(),
            description: "mahalle kafeleri".into(),
        }],
        prospecting: Prospecting {
            icp,
            rubric: Rubric {
                criteria: vec![Criterion {
                    key: "fit".into(),
                    description: "kahve sunuyor".into(),
                    weight: 100,
                }],
                qualify_at: 60,
            },
        },
        ..Sections::default()
    }
}

#[tokio::test]
async fn a_standing_task_whose_entry_is_unchanged_is_carried_and_the_others_superseded() {
    let w = world().await;
    let topic = owner_request::hypothesis(w.ws, HypothesisState::Kept);
    version(
        &w,
        1,
        VersionStatus::Approved,
        prospecting(vec![
            entry("kafe", "kafe"),
            entry("pastane", "pastane"),
            entry("otel", "otel"),
        ]),
        vec![topic],
    )
    .await;
    jt_app::usecases::research::plan(&w.deps, &job(&w))
        .await
        .unwrap();
    settle_now(&w).await;
    let tasks = |w: &World| -> Vec<jt_prospects::ResearchTask> {
        w.uow
            .snapshot()
            .prospects
            .tasks
            .into_iter()
            .filter(|t| t.workspace_id == w.ws)
            .collect()
    };
    let first = tasks(&w);
    let of = |list: &[jt_prospects::ResearchTask], key: &str| {
        list.iter()
            .find(|t| {
                matches!(&t.kind, TaskKind::Standing { icp_key } if icp_key == key)
                    && t.status == TaskStatus::Open
            })
            .cloned()
    };
    let kafe = of(&first, "kafe").unwrap();
    // An agent claims the café task.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.research_tasks()
        .set_claim(
            kafe.id,
            Some(&jt_prospects::Claim {
                by: jt_prospects::Recorder::Human { user_id: w.owner },
                until: FIXED_NOW + Duration::hours(1),
            }),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();

    // A prospecting derivation: the café entry unchanged, the patisserie's brief changed, the
    // hotel's gone.
    let rev = settings(&w).await.revision;
    let (frame, _) = frame_now(&w).await.unwrap();
    let mut changed = entry("pastane", "pastane");
    changed.sectors = vec!["pastane ve fırın".into()];
    let out = derive(
        &w,
        FrameParts {
            kb_revision: rev,
            parts: vec![DerivePart::Prospecting],
            prospecting: Some(ProspectingInput {
                icp: vec![frame.sections.prospecting.icp[0].clone(), changed],
                rubric: frame.sections.prospecting.rubric.clone(),
                segments: vec![],
            }),
            ..FrameParts::default()
        },
    )
    .await
    .unwrap();
    assert!(out.applied);
    let (now, _) = frame_now(&w).await.unwrap();
    let after = tasks(&w);
    let carried = of(&after, "kafe").expect("the café task stays open");
    assert_eq!(carried.id, kafe.id);
    assert_eq!(carried.strategy_version_id, now.id);
    assert!(carried.claim.is_some(), "its claim stays");
    let pastane = of(&after, "pastane").expect("a new patisserie task");
    assert_ne!(pastane.id, of(&first, "pastane").unwrap().id);
    assert_eq!(pastane.strategy_version_id, now.id);
    assert!(of(&after, "otel").is_none());
    for old in ["pastane", "otel"] {
        let t = after
            .iter()
            .find(|t| t.id == of(&first, old).unwrap().id)
            .unwrap();
        assert_eq!(t.status, TaskStatus::Superseded, "{old}");
    }
    let carried_entries: Vec<_> = w
        .entries("research.task_carried")
        .into_iter()
        .filter(|e| support::payload(e)["task_id"] == json!(kafe.id))
        .collect();
    assert!(!carried_entries.is_empty());
}

#[tokio::test]
async fn the_hourly_planner_waits_for_an_apply_and_supersedes_nothing_it_carried() {
    let w = world().await;
    let topic = owner_request::hypothesis(w.ws, HypothesisState::Kept);
    version(
        &w,
        1,
        VersionStatus::Approved,
        prospecting(vec![entry("kafe", "kafe")]),
        vec![topic],
    )
    .await;
    jt_app::usecases::research::plan(&w.deps, &job(&w))
        .await
        .unwrap();
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let task = w.uow.snapshot().prospects.tasks[0].id;

    // An apply holds the frame lock (a normalisation, carrying the task) while the planner runs.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let applied = frame::apply(
        &w.deps,
        &job(&w),
        r.as_mut(),
        Request {
            cause: FrameCause::Normalize,
            next: &FrameParts::default(),
            approver: None,
            waking: Waking::Nobody,
        },
    )
    .await
    .unwrap();
    assert!(applied.applied);
    let deps = w.deps.clone();
    let ctx = job(&w);
    let planner = tokio::spawn(async move { jt_app::usecases::research::plan(&deps, &ctx).await });
    tokio::task::yield_now().await;
    assert!(
        !planner.is_finished(),
        "the planner waits on the frame lock"
    );
    r.commit().await.unwrap();
    let planned = planner.await.unwrap().unwrap().unwrap();
    assert_eq!((planned.superseded, planned.created), (0, 0));
    let t = w
        .uow
        .snapshot()
        .prospects
        .tasks
        .into_iter()
        .find(|t| t.id == task)
        .unwrap();
    assert_eq!(t.status, TaskStatus::Open);
    assert_eq!(t.strategy_version_id, frame_now(&w).await.unwrap().0.id);
}

#[tokio::test]
async fn a_note_filed_into_a_card_bootstraps_the_frame_as_the_notes_persons() {
    let (w, _) = waking_world().await;
    let content = routine_agent(&w, "Content", &["workspace.read", "content.work"]).await;
    let manager = w.member("manager").await;
    let Actor::Human { user_id: person } = manager.actor else {
        panic!()
    };
    let n = note_add(
        &w.deps,
        &manager,
        NoteAddInput {
            request_key: "n-1".into(),
            text: "Filtre kahve satıyoruz, 250 g 240 TL".into(),
            links: vec![],
            file_ids: vec![],
        },
    )
    .await
    .unwrap();
    assert!(frame_now(&w).await.is_none());
    let agent = w.agent(&["workspace.read", "content.work"]).await;
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: n.revision,
        },
    )
    .await
    .unwrap();
    let products = card_of(&w, "products_prices").await;
    note_file(
        &w.deps,
        &agent,
        NoteFileInput {
            note_id: n.id,
            claim_token: claim.claim_token,
            request_key: Some("f-1".into()),
            summary: Some("Ürünler ve fiyat kartına eklendi".into()),
            cards: vec![FiledCardInput::Existing(ExistingCardInput {
                card_id: products.id,
                expected_revision: products.revision,
                title: None,
                body: "Filtre kahve 250 g 240 TL".into(),
            })],
            attachments: vec![],
            rules: vec![],
            goals: vec![],
            post_request: None,
            proposals: vec![],
            dismiss: None,
        },
    )
    .await
    .unwrap();
    let (v, topics) = frame_now(&w).await.expect("the bootstrap frame");
    assert_eq!(v.approved_by, Some(person), "the note's person's");
    assert_eq!(v.sections.identity.product, "Filtre kahve 250 g 240 TL");
    assert_eq!(topics[0].id, bootstrap_id(w.ws));
    let (reasons, by) = pending(&w, content).expect("content is woken");
    assert!(reasons.contains(&WakeReason::KnowledgeApplied));
    assert_eq!(by, [person], "on the note's person's behalf");
}
