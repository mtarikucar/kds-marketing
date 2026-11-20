//! Reading the knowledge base (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4.11.1, §4.12,
//! §5.4, §8.1): `strategy.knowledge_get` (seeding on the first call, the cards, the rules with
//! their accounts named, the goals, the notes, whether an agent can take the owner's notes, the
//! frame agents send back verbatim), `strategy.get`'s compatibility projection field by field,
//! and `inbox.context` carrying the knowledge base with or without a frame.

mod support;

use jt_app::ports::UnitOfWork;
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::inbox::{context, people};
use jt_app::usecases::knowledge::cards::{CardUpdateInput, card_update};
use jt_app::usecases::knowledge::notes::{
    NoteAddInput, NoteClaimInput, NoteWithdrawInput, note_add, note_claim, note_withdraw,
};
use jt_app::usecases::knowledge::read::{AttachmentOut, KnowledgeOut, knowledge_get};
use jt_app::usecases::knowledge::rules::{
    GoalsInput, PostApprovalInput, RulesInput, goals_save, post_approval_set, rules_save,
};
use jt_app::usecases::strategy;
use jt_app::usecases::studio::owner_request;
use jt_app::usecases::wake::{self, ReachState, SetWake, WakeKind};
use jt_inbox::*;
use jt_knowledge::frame as kframe;
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_strategy::{
    ANY_CHANNEL, Hypothesis, HypothesisState, Sections, StrategyVersion, StrategyVersionId,
    VersionStatus,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::{World, world};
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

/// Stores a version of `status` with `sections` and `hypotheses`, straight to the repos.
async fn version(
    w: &World,
    number: i32,
    status: VersionStatus,
    sections: Sections,
    hypotheses: Vec<Hypothesis>,
) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let approved = status != VersionStatus::Draft;
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number,
            status,
            sections,
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: w.owner },
            submitted_at: Some(FIXED_NOW),
            approved_at: approved.then_some(FIXED_NOW),
            approved_by: approved.then_some(w.owner),
            archived_at: None,
        })
        .await
        .unwrap();
    t.hypotheses().replace_all(id, hypotheses).await.unwrap();
    t.commit().await.unwrap();
    id
}

async fn settings(w: &World) -> Option<KnowledgeSettings> {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge().settings().await.unwrap()
}

fn card<'a>(kb: &'a KnowledgeOut, key: &str) -> &'a jt_app::usecases::knowledge::read::CardOut {
    kb.cards
        .iter()
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

/// A key with `scopes` whose agent checked in `ago` before the fixed time, with no wake address.
async fn checked_in_agent(
    w: &World,
    name: &str,
    scopes: &[&str],
    ago: Duration,
) -> jt_tenancy::ApiKeyId {
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
        FIXED_NOW - ago,
    )
    .await
    .unwrap();
    key.id
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
// strategy.knowledge_get
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_first_read_seeds_once_and_answers_the_cards_rules_goals_and_frame() {
    let w = world().await;
    let (s, h) = v5();
    let v = version(&w, 5, VersionStatus::Approved, s.clone(), h.clone()).await;
    assert!(settings(&w).await.is_none());

    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(kb.revision, 1);
    assert!(!kb.empty);
    for (key, _) in SEED_CARDS {
        card(&kb, key);
    }
    assert_eq!(card(&kb, "products_prices").body, s.identity.product);
    assert_eq!(kb.rules.prohibitions, s.prohibitions);
    assert_eq!(kb.rules.revision, 1);
    assert_eq!(kb.goals.items.len(), s.goals.kpis.len());
    assert!(
        kb.rules.ad_cap.is_some(),
        "the approved paid lane is the ad cap"
    );
    assert_eq!(
        kb.rules.message_cap.as_ref().map(|c| c.amount_minor),
        Some(0),
        "the organic lane of 0 is the paid-message limit"
    );
    let frame = kb.frame.as_ref().expect("the frame in force");
    assert_eq!((frame.id, frame.number), (v, 5));
    assert_eq!(frame.revision, 1);
    assert!(
        frame.derive_due.is_empty(),
        "the cards were made from the frame"
    );
    assert_eq!(frame.audience, s.audience);
    assert_eq!(frame.objective, s.goals.objective);
    let live: Vec<_> = h
        .iter()
        .filter(|x| x.state.is_live() && !owner_request::is(w.ws, x.id))
        .map(|x| x.id)
        .collect();
    assert_eq!(frame.topics.iter().map(|t| t.id).collect::<Vec<_>>(), live);
    assert!(frame.closing.is_empty());
    assert!(frame.topics.iter().all(|t| !t.has_posts));
    assert_eq!(frame.prospecting, s.prospecting);

    // A second read writes nothing and answers the same.
    let entries = w.ledger("").len();
    let again = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(again, kb);
    assert_eq!(w.ledger("").len(), entries);

    // Every member and every key reads it (workspace.read).
    let agent = w.agent(&["workspace.read"]).await;
    assert_eq!(knowledge_get(&w.deps, &agent).await.unwrap().revision, 1);
}

#[tokio::test]
async fn an_empty_workspace_reads_blank_cards_no_frame_and_no_agent() {
    let w = world().await;
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(kb.empty);
    assert!(kb.frame.is_none());
    assert_eq!(kb.cards.len(), SEED_CARDS.len());
    assert!(kb.cards.iter().all(|c| c.body.is_empty()));
    assert!(kb.rules.prohibitions.is_empty() && kb.rules.ad_cap.is_none());
    assert!(kb.notes.is_empty() && kb.proposals.is_empty());
    assert_eq!(kb.notes_agent.state, ReachState::None);
    assert!(!kb.rules.tiktok_connected && !kb.rules.metered);
    assert_eq!(settings(&w).await.unwrap().seed_source, SeedSource::Empty);
}

#[tokio::test]
async fn the_note_line_says_whether_an_agent_can_take_the_owners_notes() {
    let w = world().await;
    let read = || async {
        knowledge_get(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .notes_agent
    };
    assert_eq!(read().await.state, ReachState::None);

    // A key that only reads takes no note.
    checked_in_agent(&w, "reader", &["workspace.read"], Duration::minutes(5)).await;
    assert_eq!(read().await.state, ReachState::None);

    // An agent with a work permission, seen five minutes ago, without a wake address: it files
    // the note at its next run, at the workspace's interval after it was seen.
    let key = checked_in_agent(&w, "content", &["content.work"], Duration::minutes(5)).await;
    let asleep = read().await;
    assert_eq!(asleep.state, ReachState::Asleep);
    let next = asleep.next_at.expect("its next expected check-in");
    assert!(next > FIXED_NOW);

    // Expected already: late.
    let mut late_ctx = w.owner_ctx.clone();
    late_ctx.now = next + Duration::minutes(1);
    let late = knowledge_get(&w.deps, &late_ctx).await.unwrap().notes_agent;
    assert_eq!((late.state, late.next_at), (ReachState::Late, Some(next)));

    // With a wake address it is woken: the note is taken now.
    wake::set(
        &w.deps,
        &w.owner_ctx,
        SetWake {
            api_key_id: key,
            kind: WakeKind::ClaudeRoutine,
            routine_id: Some("trig_01content".into()),
            token: Some("sk-ant-oat01-routine-token".into()),
            url: None,
            secret: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(read().await.state, ReachState::Ok);
}

#[tokio::test]
async fn the_read_shows_the_open_notes_and_the_last_five_closed_never_a_claims_token() {
    let w = world().await;
    let mut added = Vec::new();
    for i in 0..8 {
        let mut ctx = w.owner_ctx.clone();
        ctx.now = FIXED_NOW + Duration::minutes(i);
        added.push(
            note_add(
                &w.deps,
                &ctx,
                note(&format!("note-{i}"), &format!("Not {i}")),
            )
            .await
            .unwrap(),
        );
    }
    // Six taken back: two open remain, and five of the six closed are shown.
    for n in &added[..6] {
        note_withdraw(
            &w.deps,
            &w.owner_ctx,
            n.id,
            NoteWithdrawInput {
                expected_revision: n.revision,
            },
        )
        .await
        .unwrap();
    }
    let agent = w.agent(&["content.work"]).await;
    let claimed = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: added[7].id,
            expected_revision: added[7].revision,
        },
    )
    .await
    .unwrap();

    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let texts: Vec<&str> = kb.notes.iter().map(|n| n.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Not 7", "Not 6", "Not 5", "Not 4", "Not 3", "Not 2", "Not 1"
        ]
    );
    assert_eq!(kb.notes[0].claimed_until, Some(claimed.until));
    assert_eq!(kb.notes[0].status, NoteStatus::Open);
    assert_eq!(kb.notes[2].status, NoteStatus::Withdrawn);
    let shown = serde_json::to_string(&kb).unwrap();
    assert!(!shown.contains("token_hash"), "a claim's token never shows");
}

#[tokio::test]
async fn the_rules_name_the_accounts_whose_posts_wait_and_what_the_lines_need() {
    let w = world().await;
    let x = w.declare("x", "Kahve X").await.capability;
    knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let rules = post_approval_set(
        &w.deps,
        &w.owner_ctx,
        PostApprovalInput {
            capability_id: x.id,
            required: true,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(rules.post_approval_accounts, [x.id]);
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(kb.rules.post_approval_accounts.len(), 1);
    let listed = &kb.rules.post_approval_accounts[0];
    assert_eq!(
        (
            listed.capability_id,
            listed.name.as_str(),
            listed.kind.as_str()
        ),
        (x.id, "Kahve X", "x")
    );
    // A declared TikTok account is not connected; an SMS line is metered.
    w.declare("tiktok", "Kahve TikTok").await;
    assert!(
        !knowledge_get(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .rules
            .tiktok_connected
    );
    w.declare("sms_line", "SMS").await;
    assert!(
        knowledge_get(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .rules
            .metered
    );
}

// ---------------------------------------------------------------------------------------------
// strategy.get, the compatibility projection (§5.4)
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn strategy_get_answers_the_owners_live_words_in_the_old_shape() {
    let w = world().await;
    let (s, mut h) = v5();
    // The owner's request is in the frame (an earlier person's post) and one topic is closing.
    h.push(owner_request::hypothesis(w.ws, HypothesisState::Kept));
    let v = version(&w, 5, VersionStatus::Approved, s.clone(), h.clone()).await;
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let closing = h.iter().find(|x| x.state.is_live()).unwrap().id;
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        let mut k = t.knowledge().lock_settings().await.unwrap().unwrap();
        k.closing_topic_ids = vec![closing];
        t.knowledge().save_settings(&k).await.unwrap();
        t.commit().await.unwrap();
    }

    // The owner's edits: two cards, the rules, the goals. None of them makes a version.
    let who = card(&kb, "who_we_are");
    card_update(
        &w.deps,
        &w.owner_ctx,
        who.id,
        body(who.revision, "Mahalle kavurucusu."),
    )
    .await
    .unwrap();
    let products = card(&kb, "products_prices");
    card_update(
        &w.deps,
        &w.owner_ctx,
        products.id,
        body(products.revision, "Filtre kahve 250 g: 300 TL."),
    )
    .await
    .unwrap();
    rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            expected_revision: kb.rules.revision,
            prohibitions: vec!["Rakip adı anma".into()],
            ad_budget: kb.rules.ad_cap.as_ref().map(|c| CapInput {
                amount_minor: c.amount_minor,
                period: Some(c.period),
            }),
            message_budget: kb.rules.message_cap.as_ref().map(|c| CapInput {
                amount_minor: c.amount_minor,
                period: Some(c.period),
            }),
            post_approval: kb.rules.post_approval,
            post_approval_accounts: None,
        },
    )
    .await
    .unwrap();
    goals_save(
        &w.deps,
        &w.owner_ctx,
        GoalsInput {
            expected_revision: kb.goals.revision,
            items: vec!["Ayda 40 sipariş".into()],
        },
    )
    .await
    .unwrap();

    let out = strategy::get(&w.deps, &w.owner_ctx).await.unwrap();
    let approved = out.approved.as_ref().expect("the frame in force");
    assert_eq!((approved.id, approved.number), (v, 5));
    assert_eq!(approved.status, VersionStatus::Approved);
    let sections = &approved.sections;
    assert_eq!(sections.identity.product, "Filtre kahve 250 g: 300 TL.");
    assert_eq!(sections.identity.positioning, "Mahalle kavurucusu.");
    assert_eq!(sections.identity.usp, s.identity.usp, "the frame's own");
    assert_eq!(
        sections.identity.voice,
        card(&kb, "voice").body,
        "the voice card's text"
    );
    assert_eq!(sections.prohibitions, ["Rakip adı anma"]);
    assert_eq!(sections.goals.objective, s.goals.objective);
    assert_eq!(
        sections.goals.kpis,
        [jt_strategy::Kpi {
            name: "Ayda 40 sipariş".into(),
            target: String::new(),
        }]
    );
    assert_eq!(sections.channels, kframe::any_channels());
    assert_eq!(sections.channels[0].channel, ANY_CHANNEL);
    assert_eq!(sections.audience, s.audience);
    assert_eq!(sections.prospecting, s.prospecting);
    assert_eq!(sections.budget_frame, s.budget_frame, "the frame's lanes");
    assert_eq!(sections.paid_enabled, s.paid_enabled);
    assert!(
        approved
            .hypotheses
            .iter()
            .all(|x| !owner_request::is(w.ws, x.id) && x.id != closing),
        "without the owner's request and the closing topic"
    );
    assert_eq!(approved.hypotheses.len(), h.len() - 2);
    assert!(approved.gaps.is_empty() && approved.assumptions.is_empty());
    assert!(out.draft.is_none() && out.gaps.is_empty());
    assert_eq!(
        out.knowledge.as_ref().unwrap(),
        &knowledge_get(&w.deps, &w.owner_ctx).await.unwrap()
    );
    // The frame itself is as it was: a reading never writes one.
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let stored = t.strategy().current_approved().await.unwrap().unwrap();
    assert_eq!((stored.id, stored.sections), (v, s));
}

#[tokio::test]
async fn strategy_get_before_seeding_answers_the_versions_as_stored_and_seeds_nothing() {
    let w = world().await;
    let (s, h) = v5();
    version(&w, 5, VersionStatus::Approved, s.clone(), h).await;
    let mut draft_sections = s.clone();
    draft_sections
        .prohibitions
        .push("Taslakta yeni yasak".into());
    let draft = version(
        &w,
        6,
        VersionStatus::Draft,
        draft_sections.clone(),
        Vec::new(),
    )
    .await;

    let out = strategy::get(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(out.knowledge.is_none());
    assert_eq!(out.approved.unwrap().sections, s);
    let open = out.draft.expect("an older routine's draft stays readable");
    assert_eq!((open.id, open.sections), (draft, draft_sections));
    assert!(
        settings(&w).await.is_none(),
        "reading the strategy seeds nothing"
    );
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(t.strategy().current_draft().await.unwrap().is_some());
}

// ---------------------------------------------------------------------------------------------
// inbox.context (§4.12)
// ---------------------------------------------------------------------------------------------

async fn conversation(w: &World) -> ConversationId {
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let p = people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap(),
    )
    .await
    .unwrap();
    let cap = w.declare("sms_line", "SMS").await;
    let id = ConversationId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: w.ws,
            person_id: p.person.id,
            capability_id: cap.capability.id,
            kind_key: "sms_line".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(w.owner_ctx.now),
            last_outbound_at: None,
            created_at: w.owner_ctx.now,
            updated_at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}

#[tokio::test]
async fn inbox_context_carries_the_knowledge_base_with_or_without_a_frame() {
    let w = world().await;
    let id = conversation(&w).await;
    let agent = w.agent(&["inbox.work"]).await;

    // Not seeded: nothing of the knowledge base, no frame.
    let before = context::context(&w.deps, &agent, id).await.unwrap();
    assert!(before.knowledge.is_none() && before.strategy_guidance.is_none());

    // The owner writes a rule and a note before any card: no frame yet, and both bind at once.
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            expected_revision: kb.rules.revision,
            prohibitions: vec!["Fiyat pazarlığı yapma".into()],
            ad_budget: None,
            message_budget: None,
            post_approval: false,
            post_approval_accounts: None,
        },
    )
    .await
    .unwrap();
    note_add(&w.deps, &w.owner_ctx, note("n1", "Yarın dükkan kapalı."))
        .await
        .unwrap();
    let out = context::context(&w.deps, &agent, id).await.unwrap();
    assert!(out.strategy_guidance.is_none());
    assert!(
        out.prohibitions
            .contains(&"Fiyat pazarlığı yapma".to_owned())
    );
    let k = out.knowledge.expect("answered without a frame");
    assert_eq!(k.rules, ["Fiyat pazarlığı yapma"]);
    assert_eq!(k.notes, ["Yarın dükkan kapalı."]);
    assert!(k.cards.is_empty(), "only cards with text");

    // The first card text bootstraps the frame: the guidance says who the business is from the
    // cards, and a long card is cut with its flag.
    let who = card(&kb, "who_we_are");
    let long = "Kahve. ".repeat(400);
    card_update(&w.deps, &w.owner_ctx, who.id, body(who.revision, &long))
        .await
        .unwrap();
    let out = context::context(&w.deps, &agent, id).await.unwrap();
    let guidance = out.strategy_guidance.expect("a frame now");
    assert_eq!(guidance.summary.positioning, cut(long.trim(), 2_000));
    assert_eq!(guidance.hypotheses.len(), 1, "the bootstrap topic");
    let k = out.knowledge.unwrap();
    assert_eq!(k.cards.len(), 1);
    assert_eq!(k.cards[0].key.as_deref(), Some("who_we_are"));
    assert!(k.cards[0].truncated);
    assert_eq!(k.cards[0].body.chars().count(), 2_000);
    assert_eq!(k.revision, settings(&w).await.unwrap().revision);
}

#[tokio::test]
async fn a_cards_file_reads_with_a_short_lived_link() {
    let w = world().await;
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let file = jt_studio::FileId::new_v7();
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.studio()
            .save_file(jt_app::ports::files::StoredFile {
                id: file,
                workspace_id: w.ws,
                mime: "application/pdf".into(),
                filename: "fiyat-listesi.pdf".into(),
                sha256: "0".repeat(64),
                created_at: FIXED_NOW,
                cleanup_due_at: None,
                deleted_at: None,
                size_bytes: 10,
            })
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let products = card(&kb, "products_prices");
    card_update(
        &w.deps,
        &w.owner_ctx,
        products.id,
        CardUpdateInput {
            expected_revision: products.revision,
            attachments: Some(vec![AttachmentInput::File { file_id: file }]),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
    let kb = knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    match &card(&kb, "products_prices").attachments[..] {
        [
            AttachmentOut::File {
                file_id,
                name,
                mime,
                url,
                expires_at,
            },
        ] => {
            assert_eq!(
                (*file_id, name.as_str(), mime.as_str()),
                (file, "fiyat-listesi.pdf", "application/pdf")
            );
            if url.is_some() {
                assert_eq!(*expires_at, Some(FIXED_NOW + Duration::minutes(30)));
            }
        }
        other => panic!("{other:?}"),
    }
}
