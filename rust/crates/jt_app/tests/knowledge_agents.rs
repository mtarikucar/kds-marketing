//! The agents' side of the knowledge base (design 2026-11-19 "Paylaşımlar and Bilgi bankası"
//! §4.10.3, §5.1-§5.3, §8.1, §8.2): `strategy.frame_apply` as agents call it (its refusals before
//! anything is read, its answer, replay and the item it clears), `work.pending`'s knowledge state
//! and its four kinds (each listed only to who can clear it), the wakes of knowledge writes, and
//! the journeys `a_card_edit_is_derived_after_a_burst` and `a_note_is_filed_and_derived`.

mod support;

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::wake::WakeReason;
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::knowledge::cards::{CardUpdateInput, card_update};
use jt_app::usecases::knowledge::derive::{FrameApplyInput, FrameApplyOut, frame_apply};
use jt_app::usecases::knowledge::notes::{
    ExistingCardInput, FiledCardInput, NoteAddInput, NoteClaimInput, NoteFileInput,
    NoteReleaseInput, note_add, note_claim, note_file, note_release,
};
use jt_app::usecases::knowledge::proposals::{ProposalCreateInput, proposal_create};
use jt_app::usecases::knowledge::read::knowledge_get;
use jt_app::usecases::knowledge::settle;
use jt_app::usecases::wake::{self, SetWake, WakeKind};
use jt_app::usecases::work::{self, PendingOut, WorkKind};
use jt_knowledge::frame::DerivePart;
use jt_knowledge::{Card, KnowledgeSettings, ProposalKind};
use jt_ledger::Actor;
use jt_strategy::{Hypothesis, Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::ApiKeyId;
use jt_testkit::fakes::{FIXED_NOW, ScriptedRegistry, ScriptedWaker};
use serde_json::{Value, json};
use support::{World, err, world};
use time::Duration;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// A fictional business's strategy (a coffee roastery) in the shape of a live version 5.
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

/// `w`, active with every module installed and a scripted waker; seeded from the sample and
/// normalised once, so the frame in force is version 6 and nothing is due.
async fn derived_world() -> World {
    let w = empty_world().await;
    let (s, h) = v5();
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number: 5,
            status: VersionStatus::Approved,
            sections: s,
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: w.owner },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(w.owner),
            archived_at: None,
        })
        .await
        .unwrap();
    t.hypotheses().replace_all(id, h).await.unwrap();
    t.commit().await.unwrap();
    let job = Ctx {
        workspace_id: w.ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    settle::settle(&w.deps, &job).await.unwrap();
    w
}

/// `w`, active with every module installed and a scripted waker, with no strategy.
async fn empty_world() -> World {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    jt_testkit::studio_contract::install_all_modules(&w.uow, w.ws).await;
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_waker(ScriptedWaker::new()));
    w
}

/// An agent: a key with `scopes`, connected an hour ago, with a routine to wake; its key and the
/// context it calls with.
async fn agent(w: &World, name: &str, scopes: &[&str]) -> (ApiKeyId, Ctx) {
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
    let connection = agents::register_initialize(
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
    (
        key.id,
        api_keys::ctx_for_agent(&principal, connection, FIXED_NOW),
    )
}

/// Key `key`'s pending wake: its reasons and who caused it.
fn woken(w: &World, key: ApiKeyId) -> Option<(Vec<WakeReason>, Vec<jt_tenancy::UserId>)> {
    w.uow
        .snapshot()
        .agent_wakes
        .into_iter()
        .find(|s| s.workspace_id == w.ws && s.row.api_key_id == key)
        .and_then(|s| s.row.pending)
        .map(|p| (p.reasons, p.caused_by))
}

async fn settings(w: &World) -> KnowledgeSettings {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge().settings().await.unwrap().unwrap()
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

/// The frame in force and its hypotheses.
async fn frame(w: &World) -> (StrategyVersion, Vec<Hypothesis>) {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let v = t.strategy().current_approved().await.unwrap().unwrap();
    let h = t.hypotheses().list(v.id).await.unwrap();
    (v, h)
}

/// The owner rewrites card `key`'s body.
async fn edit(w: &World, key: &str, text: &str) {
    let card = card_of(w, key).await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        card.id,
        CardUpdateInput {
            expected_revision: card.revision,
            body: Some(text.into()),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
}

/// A derivation's arguments as an agent sends them.
fn input(v: Value) -> FrameApplyInput {
    serde_json::from_value(v).unwrap()
}

/// Every live topic of `h` (but the owner's request) as a derivation sends it unchanged.
fn sent(w: &World, h: &[Hypothesis]) -> Vec<Value> {
    h.iter()
        .filter(|t| t.state.is_live() && !jt_app::usecases::studio::owner_request::is(w.ws, t.id))
        .map(|t| {
            json!({
                "id": t.id, "title": t.title, "segment_key": t.segment_key,
                "angle": t.angle, "metric": t.metric,
            })
        })
        .collect()
}

async fn pending(w: &World, ctx: &Ctx) -> PendingOut {
    work::pending(&w.deps, ctx).await.unwrap()
}

fn derive_items(out: &PendingOut) -> Vec<(u64, DerivePart)> {
    out.items
        .iter()
        .filter_map(|i| match i.kind {
            WorkKind::KnowledgeDerive { kb_revision, part } => Some((kb_revision, part)),
            _ => None,
        })
        .collect()
}

fn note_items(out: &PendingOut) -> Vec<(jt_knowledge::KnowledgeNoteId, u64)> {
    out.items
        .iter()
        .filter_map(|i| match i.kind {
            WorkKind::KnowledgeNote {
                note_id,
                expected_revision,
            } => Some((note_id, expected_revision)),
            _ => None,
        })
        .collect()
}

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

fn note(key: &str, text: &str) -> NoteAddInput {
    NoteAddInput {
        request_key: key.into(),
        text: text.into(),
        links: Vec::new(),
        file_ids: Vec::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// jeeta.strategy.frame_apply
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_derivation_is_refused_before_anything_is_read_when_it_is_not_the_callers() {
    let w = derived_world().await;
    let rev = settings(&w).await.revision;
    let (_, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let (_, social) = agent(&w, "social", &["workspace.read", "social.work"]).await;
    let both = w
        .agent(&["workspace.read", "content.work", "prospects.work"])
        .await;
    let posting = || input(json!({ "request_key": "k", "kb_revision": rev, "parts": ["posting"] }));

    // A person never derives.
    let e = err(frame_apply(&w.deps, &w.owner_ctx, posting()).await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Forbidden, "agent_only"));
    // Each part needs its own work permission.
    let e = err(frame_apply(&w.deps, &social, posting()).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Forbidden, "part_permission")
    );
    assert_eq!(e.details["part"], "posting");
    assert_eq!(e.details["permission"], "content.work");
    let prospecting =
        input(json!({ "request_key": "k", "kb_revision": rev, "parts": ["prospecting"] }));
    let e = err(frame_apply(&w.deps, &content, prospecting).await);
    assert_eq!(e.details["permission"], "prospects.work");
    let (_, h) = frame(&w).await;
    let paid = input(json!({
        "request_key": "k", "kb_revision": rev,
        "paid_cadence": [{ "topic_id": h[0].id, "cadence": { "slots_per_week": 1, "content_types": [] } }],
    }));
    let e = err(frame_apply(&w.deps, &content, paid).await);
    assert_eq!(
        (e.code, reason(&e), e.details["permission"].as_str()),
        (ErrorCode::Forbidden, "part_permission", Some("ads.work"))
    );
    // Nothing to answer.
    let e = err(frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "k", "kb_revision": rev })),
    )
    .await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Validation, "parts_required")
    );
    // A field of a part not listed.
    let e = err(frame_apply(
        &w.deps,
        &both,
        input(json!({
            "request_key": "k", "kb_revision": rev, "parts": ["prospecting"], "topics": [],
        })),
    )
    .await);
    assert_eq!(
        (e.code, reason(&e), e.details["field"].as_str()),
        (ErrorCode::Validation, "part_not_listed", Some("topics"))
    );
    // Shapes: every gap at once, each naming the caller's own path.
    let e = err(
        frame_apply(
            &w.deps,
            &both,
            input(json!({
                "request_key": "k", "kb_revision": rev, "parts": ["posting", "prospecting"],
                "topics": [
                    { "title": "Kavurma günü", "segment_key": "x", "angle": "a", "metric": "m" },
                    { "title": "Fazla", "segment_key": "x", "angle": "a", "metric": "m", "channel": "instagram" },
                ],
                "audience": [{ "key": "ev", "name": "Ev", "description": "d", "size": 3 }],
                "prospecting": { "icp": [{ "bogus": 1 }], "rubric": { "criteria": [], "qualify_at": 50 } },
            })),
        )
        .await,
    );
    assert_eq!(e.code, ErrorCode::Validation);
    let fields: Vec<&str> = e.details["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["field"].as_str().unwrap())
        .collect();
    assert!(fields.contains(&"topics[1]"), "{fields:?}");
    assert!(
        fields.iter().any(|f| f.starts_with("audience[0]")),
        "{fields:?}"
    );
    assert!(
        fields.iter().any(|f| f.starts_with("prospecting.icp[0]")),
        "{fields:?}"
    );
    assert!(!fields.contains(&"topics[0]"), "{fields:?}");
    // The merge's own gaps name the input's index too.
    let e = err(
        frame_apply(
            &w.deps,
            &content,
            input(json!({
                "request_key": "k", "kb_revision": rev, "parts": ["posting"],
                "topics": [{ "title": "Kavurma günü", "segment_key": h[0].segment_key, "angle": " ", "metric": "m" }],
            })),
        )
        .await,
    );
    assert!(
        e.details["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["field"] == "topics[0].angle"),
        "{}",
        e.details
    );
    // Nothing was written by any of them.
    assert_eq!(frame(&w).await.0.number, 6);
    assert!(w.entries("strategy.frame_applied").len() == 1);
}

#[tokio::test]
async fn nothing_to_derive_from_an_empty_knowledge_base() {
    let w = empty_world().await;
    knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let (_, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let e = err(frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "k", "kb_revision": 1, "parts": ["posting"] })),
    )
    .await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "knowledge_empty")
    );
}

#[tokio::test]
async fn a_derivation_answers_its_item_replays_and_keeps_ids() {
    let w = derived_world().await;
    let (content_key, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let (social_key, social) = agent(&w, "social", &["workspace.read", "social.work"]).await;
    let (_, research) = agent(&w, "research", &["workspace.read", "prospects.work"]).await;
    assert!(derive_items(&pending(&w, &content).await).is_empty());

    // The owner changes the post ideas: the posting derivation is due, listed at once to the
    // posting agent only, which is woken for it on the owner's behalf.
    edit(&w, "post_ideas", "• Kavurma günü\n• Demleme rehberi").await;
    let rev = settings(&w).await.revision;
    let out = pending(&w, &content).await;
    assert_eq!(out.knowledge.revision, rev);
    assert_eq!(out.knowledge.frame, Some(6));
    assert_eq!(out.knowledge.derive_due, [DerivePart::Posting]);
    assert_eq!(derive_items(&out), [(rev, DerivePart::Posting)]);
    let item = out
        .items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::KnowledgeDerive { .. }))
        .unwrap();
    assert_eq!(item.priority, 2);
    assert!(item.hint.is_ascii());
    assert!(
        item.hint.contains("jeeta.strategy.frame_apply"),
        "{}",
        item.hint
    );
    assert!(
        item.hint.contains("never resubmit or replace"),
        "{}",
        item.hint
    );
    assert!(derive_items(&pending(&w, &social).await).is_empty());
    assert!(derive_items(&pending(&w, &research).await).is_empty());
    assert_eq!(
        woken(&w, content_key),
        Some((vec![WakeReason::KnowledgeChanged], vec![w.owner]))
    );
    assert_eq!(
        woken(&w, social_key),
        None,
        "the social agent derives nothing"
    );

    // Nothing changed: parts alone acknowledges, writes no version, clears the item.
    let unchanged =
        input(json!({ "request_key": "same", "kb_revision": rev, "parts": ["posting"] }));
    let out = frame_apply(&w.deps, &content, unchanged.clone())
        .await
        .unwrap();
    assert!(!out.applied && !out.text_only);
    assert_eq!(out.number, 6);
    assert_eq!(out.topics.len(), 7);
    let listed = pending(&w, &content).await;
    assert!(derive_items(&listed).is_empty());
    assert!(listed.knowledge.derive_due.is_empty());
    // The same call again is its first answer; another under the same key is refused.
    assert_eq!(
        frame_apply(&w.deps, &content, unchanged).await.unwrap(),
        out
    );
    let e = err(
        frame_apply(
            &w.deps,
            &content,
            input(json!({ "request_key": "same", "kb_revision": rev, "parts": ["posting"], "objective": "x" })),
        )
        .await,
    );
    assert_eq!(e.code, ErrorCode::Conflict);

    // A new topic beside every kept one: a version, ids kept, approved by the key's issuer, the
    // social agent woken on behalf of the owner whose edit it answers.
    edit(
        &w,
        "post_ideas",
        "• Kavurma günü\n• Demleme rehberi\n• Çekirdek hikâyesi",
    )
    .await;
    let rev = settings(&w).await.revision;
    let (_, h) = frame(&w).await;
    let mut topics = sent(&w, &h);
    topics.push(json!({
        "title": "Çekirdek hikâyesi", "segment_key": h[0].segment_key,
        "angle": "Çekirdeğin geldiği çiftlik", "metric": "Kaydetme",
    }));
    let out: FrameApplyOut = frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "new-topic", "kb_revision": rev, "parts": ["posting"], "topics": topics })),
    )
    .await
    .unwrap();
    assert!(out.applied);
    assert_eq!((out.number, out.kept, out.added, out.retired), (7, 7, 1, 0));
    let (v7, after) = frame(&w).await;
    assert_eq!(v7.number, 7);
    assert_eq!(v7.approved_by, Some(w.owner), "the key's issuer");
    for t in h.iter().filter(|t| t.state.is_live()) {
        assert!(
            after.iter().any(|a| a.id == t.id && a.state.is_live()),
            "{t:?}"
        );
    }
    assert!(out.topics.iter().any(|t| t.title == "Çekirdek hikâyesi"));
    let (reasons, by) = woken(&w, social_key).expect("the social agent is woken");
    assert_eq!(reasons, [WakeReason::KnowledgeApplied]);
    assert_eq!(by, [w.owner]);
    assert!(derive_items(&pending(&w, &content).await).is_empty());
}

#[tokio::test]
async fn which_card_wakes_which_agent() {
    let w = derived_world().await;
    let (content_key, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let (research_key, research) =
        agent(&w, "research", &["workspace.read", "prospects.work"]).await;

    // The voice is read live: no derivation, nobody woken.
    edit(&w, "voice", "Samimi, kısa cümleler.").await;
    assert!(derive_items(&pending(&w, &content).await).is_empty());
    assert!(derive_items(&pending(&w, &research).await).is_empty());
    assert_eq!(woken(&w, content_key), None);
    assert_eq!(woken(&w, research_key), None);

    // Whom the business looks for: the research agent's derivation only.
    edit(&w, "who_we_seek", "• Kafeler: İzmir.").await;
    let rev = settings(&w).await.revision;
    assert!(derive_items(&pending(&w, &content).await).is_empty());
    let out = pending(&w, &research).await;
    assert_eq!(derive_items(&out), [(rev, DerivePart::Prospecting)]);
    assert!(
        out.items
            .iter()
            .any(|i| i.hint.contains("frame.prospecting.icp")),
        "{:?}",
        out.items
    );
    assert_eq!(woken(&w, content_key), None);
    assert_eq!(
        woken(&w, research_key),
        Some((vec![WakeReason::KnowledgeChanged], vec![w.owner]))
    );
}

// ---------------------------------------------------------------------------------------------
// Notes and proposals in work.pending
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_note_is_listed_to_every_work_permission_until_another_agent_claims_it() {
    let w = derived_world().await;
    let (content_key, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let (research_key, _) = agent(&w, "research", &["workspace.read", "prospects.work"]).await;
    let inbox = w.agent(&["workspace.read", "inbox.work"]).await;
    let reader = w.agent(&["workspace.read"]).await;

    let n = note_add(
        &w.deps,
        &w.owner_ctx,
        note("n1", "Yılbaşı siparişleri 15 Aralık'ta kapanıyor"),
    )
    .await
    .unwrap();
    // The agents that file notes are woken for it.
    assert_eq!(
        woken(&w, content_key),
        Some((vec![WakeReason::KnowledgeNote], vec![w.owner]))
    );
    assert_eq!(
        woken(&w, research_key),
        Some((vec![WakeReason::KnowledgeNote], vec![w.owner]))
    );
    assert_eq!(note_items(&pending(&w, &content).await), [(n.id, 1)]);
    assert_eq!(note_items(&pending(&w, &inbox).await), [(n.id, 1)]);
    assert!(note_items(&pending(&w, &reader).await).is_empty());
    assert!(note_items(&pending(&w, &w.owner_ctx).await).is_empty());
    let hint = pending(&w, &inbox)
        .await
        .items
        .into_iter()
        .find(|i| matches!(i.kind, WorkKind::KnowledgeNote { .. }))
        .unwrap()
        .hint;
    assert!(
        hint.is_ascii() && hint.contains("jeeta.strategy.note_claim"),
        "{hint}"
    );

    // Claimed: listed to the claimant (to file it), not to another agent.
    let claim = note_claim(
        &w.deps,
        &content,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(note_items(&pending(&w, &content).await), [(n.id, 2)]);
    assert!(note_items(&pending(&w, &inbox).await).is_empty());
    // A lapsed claim frees it again.
    let later = Ctx {
        now: FIXED_NOW + Duration::minutes(31),
        ..inbox.clone()
    };
    assert_eq!(note_items(&pending(&w, &later).await), [(n.id, 2)]);
    // Given back: open to everyone.
    note_release(
        &w.deps,
        &content,
        NoteReleaseInput {
            note_id: n.id,
            claim_token: claim.claim_token,
        },
    )
    .await
    .unwrap();
    assert_eq!(note_items(&pending(&w, &inbox).await), [(n.id, 3)]);
}

#[tokio::test]
async fn the_owner_is_asked_for_a_first_card_and_for_each_proposal() {
    let w = empty_world().await;
    knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let rep = w.member("rep").await;
    let (_, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;

    let out = pending(&w, &w.owner_ctx).await;
    assert!(out.knowledge.empty);
    assert_eq!(out.knowledge.frame, None);
    let empty = out
        .items
        .iter()
        .find(|i| i.kind == WorkKind::KnowledgeEmpty)
        .expect("the owner is asked for a card");
    assert_eq!(empty.priority, 1);
    assert!(
        !pending(&w, &rep)
            .await
            .items
            .iter()
            .any(|i| i.kind == WorkKind::KnowledgeEmpty)
    );
    assert!(
        !pending(&w, &content)
            .await
            .items
            .iter()
            .any(|i| i.kind == WorkKind::KnowledgeEmpty)
    );
    // Without a frame there is nothing to derive, and no area is offered.
    assert!(derive_items(&pending(&w, &content).await).is_empty());
    assert!(
        !pending(&w, &content)
            .await
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ContentArea { .. }))
    );

    // An agent's proposal is the owner's to decide: listed to them, not to the agent or a rep.
    let p = proposal_create(
        &w.deps,
        &content,
        ProposalCreateInput {
            request_key: "p1".into(),
            kind: ProposalKind::CardNew,
            card_id: None,
            title: Some("Sık sorulanlar".into()),
            body: "Kargo iki günde gelir.".into(),
            reason: "Müşteriler sık soruyor.".into(),
        },
    )
    .await
    .unwrap();
    let listed = |out: &PendingOut| {
        out.items
            .iter()
            .filter(|i| i.kind == WorkKind::KnowledgeProposal { proposal_id: p.id })
            .map(|i| i.priority)
            .collect::<Vec<_>>()
    };
    assert_eq!(listed(&pending(&w, &w.owner_ctx).await), [3]);
    assert!(listed(&pending(&w, &content).await).is_empty());
    assert!(listed(&pending(&w, &rep).await).is_empty());

    // The first card text: the frame exists, the knowledge base is no longer empty.
    edit(&w, "who_we_are", "Küçük bir kahve kavurma atölyesi.").await;
    let out = pending(&w, &w.owner_ctx).await;
    assert!(!out.knowledge.empty);
    assert!(out.knowledge.frame.is_some());
    assert!(!out.items.iter().any(|i| i.kind == WorkKind::KnowledgeEmpty));
    for i in &out.items {
        assert!(i.hint.is_ascii(), "{i:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Journeys (§8.2)
// ---------------------------------------------------------------------------------------------

/// Three `Paylaşım fikirleri` edits in a burst wake the posting agent once, for the latest
/// revision; its derivation keeps every id; a second apply with `parts` alone answers `applied:
/// false`; a `Ses tonu` edit makes no item.
#[tokio::test]
async fn a_card_edit_is_derived_after_a_burst() {
    let w = derived_world().await;
    let (content_key, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    for (i, text) in [
        "• Kavurma günü",
        "• Kavurma günü\n• Demleme",
        "• Kavurma günü\n• Demleme\n• Hediye paketi",
    ]
    .into_iter()
    .enumerate()
    {
        let at = Ctx {
            now: FIXED_NOW + Duration::seconds(10 * i as i64),
            ..w.owner_ctx.clone()
        };
        let card = card_of(&w, "post_ideas").await;
        card_update(
            &w.deps,
            &at,
            card.id,
            CardUpdateInput {
                expected_revision: card.revision,
                body: Some(text.into()),
                ..CardUpdateInput::default()
            },
        )
        .await
        .unwrap();
    }
    // One pending wake, one reason, the owner its cause; one item for the latest revision.
    assert_eq!(
        woken(&w, content_key),
        Some((vec![WakeReason::KnowledgeChanged], vec![w.owner]))
    );
    let rev = settings(&w).await.revision;
    assert_eq!(
        derive_items(&pending(&w, &content).await),
        [(rev, DerivePart::Posting)]
    );

    // The agent derives: the same topics plus one; ids kept.
    let (_, h) = frame(&w).await;
    let mut topics = sent(&w, &h);
    topics.push(json!({
        "title": "Hediye paketi", "segment_key": h[0].segment_key,
        "angle": "Yılbaşı hediye kutuları", "metric": "Mesaj",
    }));
    let out = frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "burst", "kb_revision": rev, "parts": ["posting"], "topics": topics.clone() })),
    )
    .await
    .unwrap();
    assert!(out.applied);
    let ids: Vec<_> = frame(&w).await.1.iter().map(|t| t.id).collect();
    for t in &h {
        assert!(ids.contains(&t.id));
    }
    // Asked again with nothing new: applied false.
    let again = frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "burst-2", "kb_revision": rev, "parts": ["posting"] })),
    )
    .await
    .unwrap();
    assert!(!again.applied);
    assert_eq!(again.number, out.number);
    // The voice: read live, no item.
    edit(&w, "voice", "Sıcak ve kısa.").await;
    assert!(derive_items(&pending(&w, &content).await).is_empty());
}

/// The owner adds a note; the posting agent files it into `products_prices`, re-checks in and
/// sees `knowledge_derive` at once; its derivation wakes the social agent on the owner's behalf.
#[tokio::test]
async fn a_note_is_filed_and_derived() {
    let w = derived_world().await;
    let (content_key, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let (social_key, _) = agent(&w, "social", &["workspace.read", "social.work"]).await;

    let n = note_add(
        &w.deps,
        &w.owner_ctx,
        note("n1", "Soğuk demleme 1 L şişe çıktı: 450 TL."),
    )
    .await
    .unwrap();
    // The agent checks in (the note's wake is read), claims and files.
    let seen = work::checkin(&w.deps, &content).await.unwrap();
    assert_eq!(note_items(&seen), [(n.id, 1)]);
    assert_eq!(woken(&w, content_key), None, "the check-in read the note");
    let claim = note_claim(
        &w.deps,
        &content,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let products = card_of(&w, "products_prices").await;
    note_file(
        &w.deps,
        &content,
        NoteFileInput {
            note_id: n.id,
            claim_token: claim.claim_token,
            request_key: Some("file-1".into()),
            summary: Some("Ürünler ve fiyat kartına soğuk demleme eklendi.".into()),
            cards: vec![FiledCardInput::Existing(ExistingCardInput {
                card_id: products.id,
                expected_revision: products.revision,
                title: None,
                body: format!("{}\n• Soğuk demleme 1 L: 450 TL", products.body),
            })],
            attachments: Vec::new(),
            rules: Vec::new(),
            goals: Vec::new(),
            post_request: None,
            proposals: Vec::new(),
            dismiss: None,
        },
    )
    .await
    .unwrap();
    // The filing is the owner's change: the filer is woken for the derivation on their behalf,
    // and its next check-in lists it at once.
    assert_eq!(
        woken(&w, content_key),
        Some((vec![WakeReason::KnowledgeChanged], vec![w.owner]))
    );
    let rev = settings(&w).await.revision;
    let next = work::checkin(&w.deps, &content).await.unwrap();
    assert_eq!(derive_items(&next), [(rev, DerivePart::Posting)]);
    assert!(note_items(&next).is_empty(), "filed");
    // An edit after that check-in asks again, and stays asked.
    edit(&w, "customers", "Ev kahvecileri ve kafeler.").await;
    assert!(woken(&w, content_key).is_some());

    // The derivation: a new topic, the social agent woken on the owner's behalf.
    let rev = settings(&w).await.revision;
    let (_, h) = frame(&w).await;
    let mut topics = sent(&w, &h);
    topics.push(json!({
        "title": "Soğuk demleme", "segment_key": h[0].segment_key,
        "angle": "Yaz için hazır şişe", "metric": "Sipariş",
    }));
    let out = frame_apply(
        &w.deps,
        &content,
        input(json!({ "request_key": "derive-1", "kb_revision": rev, "parts": ["posting"], "topics": topics })),
    )
    .await
    .unwrap();
    assert!(out.applied);
    let (reasons, by) = woken(&w, social_key).expect("the social agent is woken");
    assert!(
        reasons.contains(&WakeReason::KnowledgeApplied),
        "{reasons:?}"
    );
    assert_eq!(by, [w.owner]);
}

/// A note asking for a post cannot be filed as one yet (design §7.4: PR 4's composer write):
/// refused `not_available` before anything is read, so the agent dismisses it.
#[tokio::test]
async fn a_post_request_outcome_waits_for_the_composer() {
    let w = derived_world().await;
    let (_, content) = agent(&w, "content", &["workspace.read", "content.work"]).await;
    let n = note_add(
        &w.deps,
        &w.owner_ctx,
        note("n1", "Yılbaşı için bir paylaşım yap"),
    )
    .await
    .unwrap();
    let claim = note_claim(
        &w.deps,
        &content,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let e = err(note_file(
        &w.deps,
        &content,
        NoteFileInput {
            note_id: n.id,
            claim_token: claim.claim_token,
            request_key: Some("post".into()),
            summary: Some("Paylaşım istendi.".into()),
            cards: Vec::new(),
            attachments: Vec::new(),
            rules: Vec::new(),
            goals: Vec::new(),
            post_request: Some(json!({})),
            proposals: Vec::new(),
            dismiss: None,
        },
    )
    .await);
    assert_eq!(
        (e.code, reason(&e), e.details["field"].as_str()),
        (ErrorCode::Validation, "not_available", Some("post_request"))
    );
}
