//! The knowledge base's use cases (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4), not
//! registered yet: seeding from each kind of strategy history, the owner's cards, rules and
//! goals, the notes agents file, and the proposals the owner adds or skips.

#[path = "support/studio.rs"]
mod studio_support;
mod support;

use std::collections::BTreeSet;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::files::StoredFile;
use jt_app::ports::production_projects::PackageVersion;
use jt_app::usecases::budget::{self, BudgetItemInput};
use jt_app::usecases::knowledge::cards::{
    CardArchiveInput, CardCreateInput, CardUpdateInput, card_archive, card_create, card_history,
    card_update,
};
use jt_app::usecases::knowledge::notes::{
    DismissInput, ExistingCardInput, FiledCardInput, NewCard, NewCardInput, NoteAddInput,
    NoteClaimInput, NoteFileInput, NoteReleaseInput, NoteWithdrawInput, note_add, note_claim,
    note_file, note_release, note_withdraw,
};
use jt_app::usecases::knowledge::proposals::{
    ProposalCreateInput, proposal_accept, proposal_create, proposal_skip,
};
use jt_app::usecases::knowledge::rules::{
    GoalsInput, PostApprovalInput, RulesInput, goals_save, post_approval_set, rules_save,
};
use jt_app::usecases::knowledge::seed;
use jt_capability::{BudgetKind, Period, Unit};
use jt_knowledge::seed::{ARCHIVED_REASON, DRAFT_CLOSED_NOTE, DRAFT_REASON};
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_strategy::{
    ConsultationEntry, ConsultationKind, Hypothesis, Sections, StrategyVersion, StrategyVersionId,
    VersionStatus,
};
use jt_studio::FileId;
use jt_tenancy::{Permission, UserId};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::{World, at, err, human, world};
use time::Duration;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// A sample strategy of a fictional business (a coffee roastery) in the shape of a live one,
/// version 5.
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
            submitted_at: approved.then_some(FIXED_NOW),
            approved_at: approved.then_some(FIXED_NOW),
            approved_by: approved.then_some(w.owner),
            archived_at: (status == VersionStatus::Archived).then_some(FIXED_NOW),
        })
        .await
        .unwrap();
    t.hypotheses().replace_all(id, hypotheses).await.unwrap();
    t.commit().await.unwrap();
    id
}

/// The sample strategy, approved.
async fn approved_v5(w: &World) -> StrategyVersionId {
    let (s, h) = v5();
    version(w, 5, VersionStatus::Approved, s, h).await
}

async fn settings(w: &World) -> KnowledgeSettings {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge().settings().await.unwrap().unwrap()
}

async fn cards(w: &World) -> Vec<Card> {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge().cards().await.unwrap()
}

async fn card_of(w: &World, key: &str) -> Card {
    cards(w)
        .await
        .into_iter()
        .find(|c| c.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key} card"))
}

async fn proposals(w: &World) -> Vec<Proposal> {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let mut list = t.knowledge().proposals(None).await.unwrap();
    list.sort_by_key(|p| p.id);
    list
}

async fn revisions(w: &World, subject: Subject, card: Option<KnowledgeCardId>) -> Vec<Revision> {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.knowledge()
        .revisions(subject, card, None, 100)
        .await
        .unwrap()
}

/// `details.reason` of an error.
fn reason(e: &jt_app::error::AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

/// A person holding `permissions` with the role `role`.
fn person_with(w: &World, role: &str, permissions: &[Permission]) -> Ctx {
    human(
        w.ws,
        UserId::new_v7(),
        role,
        permissions.iter().copied().collect::<BTreeSet<_>>(),
    )
}

fn create(title: &str, body: &str) -> CardCreateInput {
    CardCreateInput {
        title: title.into(),
        body: body.into(),
        attachments: vec![],
        position: None,
    }
}

fn body(expected_revision: u64, body: &str) -> CardUpdateInput {
    CardUpdateInput {
        expected_revision,
        body: Some(body.into()),
        ..CardUpdateInput::default()
    }
}

fn rules(expected_revision: u64) -> RulesInput {
    RulesInput {
        expected_revision,
        prohibitions: vec![],
        ad_budget: None,
        message_budget: None,
        post_approval: false,
        post_approval_accounts: None,
        auto_reply: None,
    }
}

fn note(key: &str, text: &str) -> NoteAddInput {
    NoteAddInput {
        request_key: key.into(),
        text: text.into(),
        links: vec!["https://kahve.example/fiyat".into()],
        file_ids: vec![],
    }
}

fn filing(note: KnowledgeNoteId, token: &str, key: &str) -> NoteFileInput {
    NoteFileInput {
        note_id: note,
        claim_token: token.into(),
        request_key: Some(key.into()),
        summary: Some("Ürünler ve fiyat kartına eklendi".into()),
        cards: vec![],
        attachments: vec![],
        rules: vec![],
        goals: vec![],
        post_request: None,
        proposals: vec![],
        dismiss: None,
    }
}

fn propose(
    key: &str,
    kind: ProposalKind,
    card: Option<KnowledgeCardId>,
    body: &str,
) -> ProposalCreateInput {
    ProposalCreateInput {
        request_key: key.into(),
        kind,
        card_id: card,
        title: (kind == ProposalKind::CardNew).then(|| "Sık sorulanlar".into()),
        body: body.into(),
        reason: "Müşteriler bunu soruyor".into(),
    }
}

/// A stored studio file of the workspace of type `mime`.
async fn stored_file(w: &World, mime: &str) -> FileId {
    let id = FileId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.studio()
        .save_file(StoredFile {
            id,
            workspace_id: w.ws,
            mime: mime.into(),
            filename: "fiyat-listesi.pdf".into(),
            sha256: "a".repeat(64),
            created_at: FIXED_NOW,
            cleanup_due_at: None,
            deleted_at: None,
            size_bytes: 1024,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    id
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_workspace_without_a_strategy_is_seeded_with_blank_cards_once() {
    let w = world().await;
    assert!(seed::ensure(&w.deps, &w.owner_ctx).await.unwrap());
    assert!(!seed::ensure(&w.deps, &w.owner_ctx).await.unwrap());
    let s = settings(&w).await;
    assert_eq!(s.seed_source, SeedSource::Empty);
    assert_eq!((s.revision, s.rules_revision, s.goals_revision), (1, 1, 1));
    assert_eq!(
        (
            s.posting_revision,
            s.prospecting_revision,
            s.posting_derived,
            s.prospecting_derived
        ),
        (0, 0, 0, 0),
        "no frame: nothing derived"
    );
    assert!(s.prohibitions.is_empty() && s.goals.is_empty());
    assert_eq!((s.ad_cap, s.message_cap), (None, None));
    assert_eq!(s.post_gate_seeded_at, Some(FIXED_NOW));
    let all = cards(&w).await;
    assert_eq!(
        all.iter()
            .map(|c| (c.key.as_deref().unwrap(), c.title.as_str(), c.position))
            .collect::<Vec<_>>(),
        SEED_CARDS
            .iter()
            .zip(0..)
            .map(|((k, t), p)| (*k, *t, p))
            .collect::<Vec<_>>()
    );
    assert!(is_empty(&all));
    for c in &all {
        let r = revisions(&w, Subject::Card, Some(c.id)).await;
        assert_eq!(r.len(), 1);
        assert_eq!(
            (r[0].cause, r[0].kb_revision, r[0].revision),
            (Cause::Seed, 1, 1)
        );
        assert_eq!(
            r[0].by,
            Actor::System {
                component: BACKFILL_COMPONENT.into()
            }
        );
    }
    assert_eq!(revisions(&w, Subject::Rules, None).await.len(), 1);
    assert_eq!(revisions(&w, Subject::Goals, None).await.len(), 1);
    assert!(proposals(&w).await.is_empty());
    assert_eq!(w.entries("strategy.knowledge_seeded").len(), 1);
    assert_eq!(w.entries("strategy.knowledge_changed").len(), 9);
    assert_eq!(w.entries("strategy.rules_changed").len(), 1);
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        t.strategy().current_approved().await.unwrap().is_none(),
        "no frame"
    );
}

#[tokio::test]
async fn the_owners_strategy_seeds_its_texts_caps_and_nothing_to_derive() {
    let w = world().await;
    let v = approved_v5(&w).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let s = settings(&w).await;
    assert_eq!(s.seed_source, SeedSource::Approved);
    assert_eq!(
        (
            s.revision,
            s.posting_revision,
            s.prospecting_revision,
            s.posting_derived,
            s.prospecting_derived
        ),
        (1, 1, 1, 1, 1),
        "the cards were made from the frame: nothing to derive"
    );
    let (sections, _) = v5();
    assert_eq!(s.prohibitions, sections.prohibitions);
    assert_eq!(s.goals.len(), 5);
    assert_eq!(s.goals[0], "Ofis aboneliği: 3 ayda 8 yeni abone ofis");
    let monthly = jt_strategy::Period::Monthly;
    assert_eq!(
        s.ad_cap,
        Some(Cap {
            amount_minor: 500_000,
            period: monthly,
            currency: "TRY".into()
        })
    );
    assert_eq!(
        s.message_cap,
        Some(Cap {
            amount_minor: 0,
            period: monthly,
            currency: "TRY".into()
        }),
        "the approved organic lane, as it is"
    );
    assert!(
        !s.post_approval && s.post_approval_accounts.is_empty(),
        "no social account"
    );
    let who = card_of(&w, "who_we_are").await;
    assert!(
        who.body
            .starts_with("Kavrulmuş Kahve Atölyesi: Taze kavrulur, aynı hafta içilir.")
    );
    assert!(who.body.contains("\n\nBizi farklı kılan: "));
    assert_eq!(
        card_of(&w, "products_prices").await.body,
        sections.identity.product
    );
    assert_eq!(card_of(&w, "references").await.body, "");
    assert_eq!(
        cards(&w).await.len(),
        8,
        "no consultation log: no past conversations"
    );
    assert!(!is_empty(&cards(&w).await));
    let r = revisions(&w, Subject::Card, Some(who.id)).await;
    assert_eq!(r[0].cause, Cause::Backfill);
    // No general ad budget yet: one is made in the paid lane's currency and period, at 0, so no
    // campaign that could not open before opens now; the owner raises it in Bütçe.
    let items = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    let general: Vec<_> = items.iter().filter(|i| i.item.general).collect();
    assert_eq!(general.len(), 1);
    let g = &general[0].item;
    assert_eq!(
        (g.name.as_str(), g.kind, g.cap, g.period, &g.unit),
        (
            "Reklam bütçesi",
            BudgetKind::AdBudget,
            0,
            Period::Monthly,
            &Unit::Currency("TRY".into())
        )
    );
    let created = w.entries("budget.items.create");
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].payload["reason"], "knowledge_backfill");
    assert_eq!(created[0].strategy_version_id, Some(v.as_uuid()));
    let seeded = w.entries("strategy.knowledge_seeded");
    assert_eq!(seeded[0].payload["source"], "approved");
    assert_eq!(seeded[0].payload["draft_closed"], Value::Null);
    assert_eq!(seeded[0].strategy_version_id, Some(v.as_uuid()));
    for e in w.entries("strategy.knowledge_changed") {
        assert_eq!(e.payload["cause"], "backfill");
        assert!(
            !e.payload.to_string().contains("Kavrulmuş"),
            "no text in the ledger"
        );
    }
}

async fn general(w: &World, cap: i64, period: Period) {
    budget::create_item(
        &w.deps,
        &w.owner_ctx,
        BudgetItemInput {
            name: "Reklam".into(),
            kind: BudgetKind::AdBudget,
            unit: Unit::Currency("TRY".into()),
            cap,
            unit_cost_minor: None,
            period,
            general: true,
        },
    )
    .await
    .unwrap();
}

async fn general_cap(w: &World) -> i64 {
    general_item(w).await.cap
}

/// The live general ad budget as stored.
async fn general_item(w: &World) -> jt_capability::BudgetItem {
    budget::list_items(&w.deps, &w.owner_ctx)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.item.general && i.item.retired_at.is_none())
        .unwrap()
        .item
}

#[tokio::test]
async fn a_general_ad_budget_below_the_lane_is_the_ad_cap_and_held_to_it() {
    let w = world().await;
    // 50.000 a week is 214.285 a month: below the lane's 500.000.
    general(&w, 50_000, Period::Weekly).await;
    approved_v5(&w).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let cap = settings(&w).await.ad_cap.unwrap();
    assert_eq!(cap.amount_minor, 214_285);
    // Brought back to a week as `check_general` prorates it, the cap allows 49.999: the item is
    // held to that, so the cap, the item and the lane agree and an edit of the item still passes.
    let g = general_cap(&w).await;
    assert_eq!(g, 49_999);
    assert!(i128::from(cap.amount_minor) * 7 / 30 >= i128::from(g));
    let update = w.entries("budget.items.update");
    assert_eq!(update.len(), 1);
    assert_eq!(
        update[0].payload,
        json!({"cap": 49_999, "previous": {"cap": 50_000}, "reason": "knowledge_backfill"})
    );
    assert!(
        w.entries("budget.items.create").len() == 1,
        "only the test's own"
    );
}

#[tokio::test]
async fn a_general_ad_budget_below_the_lane_in_its_period_stays() {
    let w = world().await;
    general(&w, 300_000, Period::Monthly).await;
    approved_v5(&w).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(settings(&w).await.ad_cap.unwrap().amount_minor, 300_000);
    assert_eq!(general_cap(&w).await, 300_000);
    assert!(w.entries("budget.items.update").is_empty());
}

#[tokio::test]
async fn a_budget_edit_committed_while_seeding_is_never_raised_back() {
    // Lowered after the seed listed the items: the lowering stands, and the cap is taken from it.
    let w = world().await;
    general(&w, 1_000_000, Period::Monthly).await;
    approved_v5(&w).await;
    let mut lowered = general_item(&w).await;
    lowered.cap = 100_000;
    w.uow.replace_budget_item_after_list(lowered);
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(general_cap(&w).await, 100_000);
    assert_eq!(settings(&w).await.ad_cap.unwrap().amount_minor, 100_000);
    assert!(w.entries("budget.items.update").is_empty());

    // Moved to a day meanwhile: 10.000 a day is 300.000 a month, below the lane, and stays a day's.
    let w = world().await;
    general(&w, 1_000_000, Period::Monthly).await;
    approved_v5(&w).await;
    let mut daily = general_item(&w).await;
    (daily.cap, daily.period) = (10_000, Period::Daily);
    w.uow.replace_budget_item_after_list(daily);
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let g = general_item(&w).await;
    assert_eq!((g.cap, g.period), (10_000, Period::Daily));
    assert_eq!(settings(&w).await.ad_cap.unwrap().amount_minor, 300_000);
    assert!(w.entries("budget.items.update").is_empty());

    // Retired meanwhile: nothing is seeded, and the next call seeds again (a new general budget).
    let w = world().await;
    general(&w, 1_000_000, Period::Monthly).await;
    approved_v5(&w).await;
    let mut retired = general_item(&w).await;
    retired.retired_at = Some(FIXED_NOW);
    w.uow.replace_budget_item_after_list(retired);
    let e = err(seed::ensure(&w.deps, &w.owner_ctx).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(t.knowledge().settings().await.unwrap().is_none());
    drop(t);
    assert!(seed::ensure(&w.deps, &w.owner_ctx).await.unwrap());
    assert_eq!(
        general_cap(&w).await,
        0,
        "made in the lane's currency, at 0"
    );
}

#[tokio::test]
async fn a_general_ad_budget_above_the_lane_is_lowered_to_it() {
    let w = world().await;
    general(&w, 200_000, Period::Weekly).await;
    approved_v5(&w).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(settings(&w).await.ad_cap.unwrap().amount_minor, 500_000);
    // 500.000 a month is 116.666 a week.
    assert_eq!(general_cap(&w).await, 116_666);
    let update = w.entries("budget.items.update");
    assert_eq!(update.len(), 1);
    assert_eq!(
        update[0].payload,
        json!({"cap": 116_666, "previous": {"cap": 200_000}, "reason": "knowledge_backfill"})
    );
}

#[tokio::test]
async fn paid_channels_off_seed_no_ad_cap_and_leave_the_budget() {
    let w = world().await;
    general(&w, 200_000, Period::Weekly).await;
    let (mut s, h) = v5();
    s.paid_enabled = false;
    version(&w, 5, VersionStatus::Approved, s, h).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(settings(&w).await.ad_cap, None);
    assert_eq!(general_cap(&w).await, 200_000);
}

#[tokio::test]
async fn an_open_draft_beside_the_approved_version_becomes_proposals_and_is_closed() {
    let w = world().await;
    approved_v5(&w).await;
    let (mut s, h) = v5();
    s.identity.voice = "Daha resmî ve kısa.".into();
    s.prohibitions.push("Fiyat pazarlığı yapılmaz.".into());
    let draft = version(&w, 6, VersionStatus::Draft, s, h).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let voice = card_of(&w, "voice").await;
    let (sections, _) = v5();
    assert_eq!(
        voice.body, sections.identity.voice,
        "the approved text is the card's"
    );
    let list = proposals(&w).await;
    assert_eq!(list.len(), 2);
    let edit = list
        .iter()
        .find(|p| p.kind == ProposalKind::CardEdit)
        .unwrap();
    assert_eq!(
        (
            edit.card_id,
            edit.body.as_str(),
            edit.base_revision,
            edit.reason.as_str()
        ),
        (Some(voice.id), "Daha resmî ve kısa.", Some(1), DRAFT_REASON)
    );
    let rule = list
        .iter()
        .find(|p| p.kind == ProposalKind::RuleAdd)
        .unwrap();
    assert_eq!(rule.body, "Fiyat pazarlığı yapılmaz.");
    for p in &list {
        assert!(p.is_system() && p.is_pending());
        assert_eq!(p.expires_at, FIXED_NOW + SYSTEM_PROPOSAL_TTL);
    }
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let closed = t.strategy().find(draft).await.unwrap().unwrap();
    assert_eq!(closed.status, VersionStatus::Archived);
    let log = t
        .consultation()
        .list_kind(draft, ConsultationKind::Archived, 10)
        .await
        .unwrap();
    assert_eq!(log[0].text, DRAFT_CLOSED_NOTE);
    drop(t);
    assert_eq!(
        w.entries("strategy.knowledge_seeded")[0].payload["draft_closed"],
        6
    );
}

#[tokio::test]
async fn a_draft_alone_gives_blank_cards_proposals_and_no_frame() {
    let w = world().await;
    let (s, h) = v5();
    let draft = version(&w, 1, VersionStatus::Draft, s, h).await;
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let answer = ConsultationEntry::new(
        draft,
        ConsultationKind::Answer,
        None,
        "Önce kurumsal müşteriler".into(),
        Actor::Human { user_id: w.owner },
        FIXED_NOW,
    )
    .unwrap();
    t.consultation().append(answer).await.unwrap();
    t.commit().await.unwrap();
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let s = settings(&w).await;
    assert_eq!(s.seed_source, SeedSource::Draft);
    assert_eq!(
        (s.ad_cap, s.message_cap, s.posting_revision),
        (None, None, 0)
    );
    assert!(
        s.prohibitions.is_empty(),
        "nothing a draft says takes effect"
    );
    assert!(is_empty(&cards(&w).await));
    let list = proposals(&w).await;
    let count = |kind| list.iter().filter(|p| p.kind == kind).count();
    assert_eq!(
        count(ProposalKind::CardEdit),
        7,
        "every seed card the draft gives text to, Hesaplar ve kanallar too"
    );
    let channels = card_of(&w, "accounts_channels").await;
    assert!(list.iter().any(|p| p.kind == ProposalKind::CardEdit
        && p.card_id == Some(channels.id)
        && p.body.starts_with("• Instagram: ")));
    assert_eq!(count(ProposalKind::RuleAdd), 7);
    assert_eq!(count(ProposalKind::GoalAdd), 5);
    let log = list
        .iter()
        .find(|p| p.kind == ProposalKind::CardNew)
        .unwrap();
    assert_eq!(
        (log.title.as_deref(), log.body.as_str()),
        (Some("Önceki görüşmeler"), "• Önce kurumsal müşteriler")
    );
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        t.strategy().current_approved().await.unwrap().is_none(),
        "no frame"
    );
    assert!(
        t.strategy().current_draft().await.unwrap().is_none(),
        "the draft is closed"
    );
}

#[tokio::test]
async fn an_archived_strategy_waits_as_proposals_to_add_back() {
    let w = world().await;
    let (s, h) = v5();
    version(&w, 5, VersionStatus::Archived, s, h).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(settings(&w).await.seed_source, SeedSource::Empty);
    let list = proposals(&w).await;
    assert_eq!(
        list.len(),
        7 + 7 + 5,
        "nothing the owner once approved is lost"
    );
    assert!(list.iter().all(|p| p.reason == ARCHIVED_REASON));
    let channels = card_of(&w, "accounts_channels").await;
    assert!(list.iter().any(|p| p.card_id == Some(channels.id)));
}

#[tokio::test]
async fn the_answers_of_an_approved_strategy_become_a_card() {
    let w = world().await;
    let v = approved_v5(&w).await;
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    for (minute, text) in [(1, "Toplu siparişte öncelik kurumsal"), (2, "Kargo dahil")] {
        let e = ConsultationEntry::new(
            v,
            ConsultationKind::Answer,
            None,
            text.into(),
            Actor::Human { user_id: w.owner },
            FIXED_NOW + Duration::minutes(minute),
        )
        .unwrap();
        t.consultation().append(e).await.unwrap();
    }
    t.commit().await.unwrap();
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let past = card_of(&w, "past_conversations").await;
    assert_eq!(
        (past.title.as_str(), past.position, past.body.as_str()),
        (
            "Önceki görüşmeler",
            8,
            "• Kargo dahil\n• Toplu siparişte öncelik kurumsal"
        )
    );
}

#[tokio::test]
async fn two_seeds_at_once_make_one() {
    let w = world().await;
    approved_v5(&w).await;
    let (a, b) = tokio::join!(
        seed::ensure(&w.deps, &w.owner_ctx),
        seed::ensure(&w.deps, &w.owner_ctx)
    );
    assert_eq!(
        [a.unwrap(), b.unwrap()].iter().filter(|s| **s).count(),
        1,
        "exactly one seeds"
    );
    assert_eq!(cards(&w).await.len(), 8);
    assert_eq!(w.entries("strategy.knowledge_seeded").len(), 1);
    assert_eq!(w.entries("budget.items.create").len(), 1);
}

#[tokio::test]
async fn the_accounts_whose_posts_wait_today_still_wait() {
    let w = studio_support::world().await;
    let account = w.f.slot.capability_id;
    w.approval(true).await;
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    let mut t = w.uow.tenant(w.f.ws).await.unwrap();
    let s = t.knowledge().settings().await.unwrap().unwrap();
    assert!(s.post_approval_accounts.contains(&account.as_uuid()));
    assert!(s.post_approval, "every postable account but TikTok waits");
    assert_eq!(s.post_gate_seeded_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn more_flagged_accounts_than_the_list_holds_hold_every_post() {
    let w = studio_support::world().await;
    let account = w.f.slot.capability_id;
    // One postable account whose posts go out (the switch would stay off), and one flagged
    // account more than the list holds.
    w.approval(false).await;
    w.uow.edit(|s| {
        let base = s
            .capabilities
            .iter()
            .find(|c| c.capability.id == account)
            .unwrap()
            .clone();
        for _ in 0..=MAX_POST_APPROVAL_ACCOUNTS {
            let mut c = base.clone();
            c.capability.id = jt_capability::CapabilityId::new_v7();
            c.capability.policy.requires_human_approval = true;
            s.capabilities.push(c);
        }
    });
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    let mut t = w.uow.tenant(w.f.ws).await.unwrap();
    let s = t.knowledge().settings().await.unwrap().unwrap();
    drop(t);
    assert_eq!(s.post_approval_accounts.len(), MAX_POST_APPROVAL_ACCOUNTS);
    assert!(
        s.post_approval,
        "every post waits: no account whose posts wait today goes out"
    );
    let seeded: Vec<_> = w
        .uow
        .snapshot()
        .ledger
        .into_iter()
        .map(|row| row.entry)
        .filter(|e| e.action.as_str() == "strategy.knowledge_seeded")
        .collect();
    assert_eq!(
        (
            &seeded[0].payload["post_approval_accounts"],
            &seeded[0].payload["post_approval_flagged"]
        ),
        (
            &json!(MAX_POST_APPROVAL_ACCOUNTS),
            &json!(MAX_POST_APPROVAL_ACCOUNTS + 1)
        )
    );
}

/// The rules box as `s` holds it, to save back.
fn as_read(s: &KnowledgeSettings) -> RulesInput {
    let cap = |c: &Option<Cap>| {
        c.as_ref().map(|c| CapInput {
            amount_minor: c.amount_minor,
            period: Some(c.period),
        })
    };
    RulesInput {
        expected_revision: s.rules_revision,
        prohibitions: s.prohibitions.clone(),
        ad_budget: cap(&s.ad_cap),
        message_budget: cap(&s.message_cap),
        post_approval: s.post_approval,
        post_approval_accounts: Some(
            s.post_approval_accounts
                .iter()
                .copied()
                .map(jt_capability::CapabilityId)
                .collect(),
        ),
        auto_reply: None,
    }
}

#[tokio::test]
async fn an_account_retired_after_it_was_listed_saves_back_and_comes_off_the_list() {
    let w = studio_support::world().await;
    let account = w.f.slot.capability_id;
    w.approval(true).await;
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    let read = |w: &studio_support::World| {
        let uow = w.uow.clone();
        let ws = w.f.ws;
        async move {
            let mut t = uow.tenant(ws).await.unwrap();
            t.knowledge().settings().await.unwrap().unwrap()
        }
    };
    let s = read(&w).await;
    assert!(s.post_approval_accounts.contains(&account.as_uuid()));
    let off = rules_save(
        &w.d,
        &w.ctx,
        RulesInput {
            post_approval: false,
            ..as_read(&s)
        },
    )
    .await
    .unwrap();
    w.uow.edit(|st| {
        st.capabilities
            .iter_mut()
            .find(|c| c.capability.id == account)
            .unwrap()
            .capability
            .status = jt_capability::StoredStatus::Retired;
    });
    // The box read back as it is still saves.
    let s = read(&w).await;
    assert_eq!(s.rules_revision, off.revision);
    let saved = rules_save(
        &w.d,
        &w.ctx,
        RulesInput {
            prohibitions: vec!["Rakip kötülenmez".into()],
            ..as_read(&s)
        },
    )
    .await
    .unwrap();
    assert!(saved.post_approval_accounts.contains(&account));
    // It comes off the list one by one, and cannot be put back.
    let set = |required, expected_revision| PostApprovalInput {
        capability_id: account,
        required,
        expected_revision,
    };
    let out = post_approval_set(&w.d, &w.ctx, set(false, saved.revision))
        .await
        .unwrap();
    assert!(!out.post_approval_accounts.contains(&account));
    let e = err(post_approval_set(&w.d, &w.ctx, set(true, out.revision)).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::NotFound, "not_a_social_account")
    );
}

#[tokio::test]
async fn an_account_whose_posts_go_out_leaves_the_switch_off() {
    let w = studio_support::world().await;
    w.approval(false).await;
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    let mut t = w.uow.tenant(w.f.ws).await.unwrap();
    let s = t.knowledge().settings().await.unwrap().unwrap();
    assert!(!s.post_approval);
    assert!(
        !s.post_approval_accounts
            .contains(&w.f.slot.capability_id.as_uuid())
    );
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_owner_adds_edits_removes_and_restores_a_card() {
    let w = world().await;
    let c = card_create(
        &w.deps,
        &w.owner_ctx,
        create("  Sık sorulanlar ", "Kargo 3 gün."),
    )
    .await
    .unwrap();
    assert_eq!(
        (c.key.as_deref(), c.title.as_str(), c.revision, c.position),
        (None, "Sık sorulanlar", 1, 8)
    );
    let s = settings(&w).await;
    assert_eq!(
        (
            s.revision,
            s.posting_revision,
            s.prospecting_revision,
            s.changed_by
        ),
        (2, 2, 2, Some(w.owner)),
        "a card of the owner's own feeds both parts"
    );
    let c = card_update(&w.deps, &w.owner_ctx, c.id, body(1, "Kargo 2 gün."))
        .await
        .unwrap();
    assert_eq!((c.revision, c.body.as_str()), (2, "Kargo 2 gün."));
    let e = err(card_update(&w.deps, &w.owner_ctx, c.id, body(1, "eski")).await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Conflict, "card_changed"));
    assert_eq!(e.details["revision"], 2);
    // The same text again writes nothing.
    let same = card_update(&w.deps, &w.owner_ctx, c.id, body(2, "Kargo 2 gün."))
        .await
        .unwrap();
    assert_eq!(same.revision, 2);
    let removed = card_archive(
        &w.deps,
        &w.owner_ctx,
        c.id,
        CardArchiveInput {
            expected_revision: 2,
            archived: true,
        },
    )
    .await
    .unwrap();
    assert!(!removed.is_live());
    let e = err(card_update(&w.deps, &w.owner_ctx, c.id, body(3, "x")).await);
    assert_eq!(reason(&e), "card_archived");
    let back = card_archive(
        &w.deps,
        &w.owner_ctx,
        c.id,
        CardArchiveInput {
            expected_revision: 3,
            archived: false,
        },
    )
    .await
    .unwrap();
    assert_eq!((back.revision, back.archived_at), (4, None));
    let history = card_history(&w.deps, &w.owner_ctx, c.id, None)
        .await
        .unwrap();
    assert_eq!(
        history
            .revisions
            .iter()
            .map(|r| r.revision)
            .collect::<Vec<_>>(),
        vec![4, 3, 2, 1]
    );
    assert!(history.revisions.iter().all(|r| r.cause == Cause::Owner));
    assert_eq!(history.revisions[2].content["body"], "Kargo 2 gün.");
    assert_eq!(history.next_before, None);
    let ledger = w.entries("strategy.knowledge_changed");
    let last = ledger.last().unwrap();
    assert_eq!(last.payload["subject"], "card");
    assert_eq!(last.payload["cause"], "owner");
    assert_eq!(last.payload["revision"], 4);
    assert!(
        !last.payload.to_string().contains("Kargo"),
        "texts stay in the revisions"
    );
    let e = err(card_history(&w.deps, &w.owner_ctx, KnowledgeCardId::new_v7(), None).await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn which_card_moves_which_derivation() {
    // A workspace with a frame: the first card text of one without would bootstrap it, which
    // makes both derivations due (design §4.10.5).
    let w = world().await;
    w.approve_strategy().await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let ideas = card_of(&w, "post_ideas").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        ideas.id,
        body(1, "• Yılbaşı hediyesi"),
    )
    .await
    .unwrap();
    let s = settings(&w).await;
    assert_eq!(
        (s.revision, s.posting_revision, s.prospecting_revision),
        (2, 2, 1)
    );
    let seek = card_of(&w, "who_we_seek").await;
    card_update(&w.deps, &w.owner_ctx, seek.id, body(1, "• Ajanslar"))
        .await
        .unwrap();
    let s = settings(&w).await;
    assert_eq!(
        (s.revision, s.posting_revision, s.prospecting_revision),
        (3, 2, 3)
    );
    let customers = card_of(&w, "customers").await;
    card_update(&w.deps, &w.owner_ctx, customers.id, body(1, "Kurumlar"))
        .await
        .unwrap();
    let s = settings(&w).await;
    assert_eq!(
        (s.revision, s.posting_revision, s.prospecting_revision),
        (4, 4, 4)
    );
    // Ses tonu feeds no derivation; a position alone moves nothing either.
    let voice = card_of(&w, "voice").await;
    card_update(&w.deps, &w.owner_ctx, voice.id, body(1, "Samimi"))
        .await
        .unwrap();
    let ideas = card_of(&w, "post_ideas").await;
    card_update(
        &w.deps,
        &w.owner_ctx,
        ideas.id,
        CardUpdateInput {
            expected_revision: 2,
            position: Some(30),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
    let s = settings(&w).await;
    assert_eq!(
        (s.revision, s.posting_revision, s.prospecting_revision),
        (6, 4, 4)
    );
}

#[tokio::test]
async fn a_knowledge_base_holds_fifty_live_cards() {
    let w = world().await;
    for i in 0..42 {
        card_create(&w.deps, &w.owner_ctx, create(&format!("Kart {i}"), ""))
            .await
            .unwrap();
    }
    let e = err(card_create(&w.deps, &w.owner_ctx, create("Fazla", "")).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "too_many_cards")
    );
    let refs = card_of(&w, "references").await;
    card_archive(
        &w.deps,
        &w.owner_ctx,
        refs.id,
        CardArchiveInput {
            expected_revision: 1,
            archived: true,
        },
    )
    .await
    .unwrap();
    card_create(&w.deps, &w.owner_ctx, create("Yer açıldı", ""))
        .await
        .unwrap();
    let e = err(card_archive(
        &w.deps,
        &w.owner_ctx,
        refs.id,
        CardArchiveInput {
            expected_revision: 2,
            archived: false,
        },
    )
    .await);
    assert_eq!(reason(&e), "too_many_cards");
}

#[tokio::test]
async fn only_an_editor_in_person_writes_cards() {
    let w = world().await;
    let agent = w.agent(&["team.manage", "content.work"]).await;
    let e = err(card_create(&w.deps, &agent, create("Ajan", "")).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Forbidden, "human_required")
    );
    let reader = person_with(&w, "rep", &[Permission::WorkspaceRead]);
    let e = err(card_create(&w.deps, &reader, create("Okur", "")).await);
    support::assert_forbidden(&e, "team.manage");
    let e = err(card_create(&w.deps, &w.owner_ctx, create("", "x")).await);
    assert_eq!(
        (e.details["field"].as_str(), reason(&e)),
        (Some("title"), "empty")
    );
    let e = err(card_create(&w.deps, &w.owner_ctx, create("t", &"x".repeat(8001))).await);
    assert_eq!(e.details["field"], "body");
    let e = err(card_update(
        &w.deps,
        &w.owner_ctx,
        KnowledgeCardId::new_v7(),
        CardUpdateInput {
            expected_revision: 1,
            ..CardUpdateInput::default()
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation, "an edit names a field");
}

#[tokio::test]
async fn a_position_past_what_the_column_holds_is_refused_by_name() {
    let w = world().await;
    let placed = |position| CardCreateInput {
        position: Some(position),
        ..create("Konum", "")
    };
    let e = err(card_create(&w.deps, &w.owner_ctx, placed(MAX_CARD_POSITION + 1)).await);
    assert_eq!(
        (e.code, e.details["field"].as_str(), reason(&e)),
        (ErrorCode::Validation, Some("position"), "out_of_range")
    );
    let last = card_create(&w.deps, &w.owner_ctx, placed(MAX_CARD_POSITION))
        .await
        .unwrap();
    let e = err(card_update(
        &w.deps,
        &w.owner_ctx,
        last.id,
        CardUpdateInput {
            expected_revision: 1,
            position: Some(u32::MAX),
            ..CardUpdateInput::default()
        },
    )
    .await);
    assert_eq!(
        (e.code, e.details["field"].as_str(), reason(&e)),
        (ErrorCode::Validation, Some("position"), "out_of_range")
    );
    // After a card at the last position, the next one stands there too (ties by creation).
    let next = card_create(&w.deps, &w.owner_ctx, create("Sonra", ""))
        .await
        .unwrap();
    assert_eq!(next.position, MAX_CARD_POSITION);
}

#[tokio::test]
async fn attachments_are_links_or_knowledge_files_of_the_workspace() {
    let w = world().await;
    let pdf = stored_file(&w, "application/pdf").await;
    let text = stored_file(&w, "text/plain").await;
    let attach = |items: Vec<AttachmentInput>| CardCreateInput {
        title: "Fiyat listesi".into(),
        body: String::new(),
        attachments: items,
        position: Some(0),
    };
    let link = AttachmentInput::Link {
        url: "https://kahve.example/fiyat".into(),
        title: Some("Fiyatlar".into()),
    };
    let c = card_create(
        &w.deps,
        &w.owner_ctx,
        attach(vec![
            link.clone(),
            AttachmentInput::File { file_id: pdf },
            link.clone(),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(c.attachments.len(), 2, "each once");
    assert_eq!(
        c.attachments[1],
        Attachment::File {
            file_id: pdf,
            name: "fiyat-listesi.pdf".into(),
            mime: "application/pdf".into()
        }
    );
    let e = err(card_create(
        &w.deps,
        &w.owner_ctx,
        attach(vec![AttachmentInput::File { file_id: text }]),
    )
    .await);
    assert_eq!(
        (e.details["field"].as_str(), reason(&e)),
        (Some("attachments[0].file_id"), "file_not_knowledge")
    );
    let e = err(card_create(
        &w.deps,
        &w.owner_ctx,
        attach(vec![AttachmentInput::File {
            file_id: FileId::new_v7(),
        }]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = err(card_create(
        &w.deps,
        &w.owner_ctx,
        attach(vec![AttachmentInput::Link {
            url: "http://kahve.example".into(),
            title: None,
        }]),
    )
    .await);
    assert_eq!(
        (e.details["field"].as_str(), reason(&e)),
        (Some("attachments[0].url"), "not_https")
    );
}

// ---------------------------------------------------------------------------------------------
// Rules and goals
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_rules_are_saved_whole_and_derive_nothing() {
    let w = world().await;
    let out = rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            prohibitions: vec![" Rakip kötülenmez ".into(), "".into()],
            ad_budget: Some(CapInput {
                amount_minor: 300_000,
                period: None,
            }),
            message_budget: Some(CapInput {
                amount_minor: 0,
                period: Some(jt_strategy::Period::Weekly),
            }),
            post_approval: true,
            ..rules(1)
        },
    )
    .await
    .unwrap();
    assert_eq!(out.revision, 2);
    assert_eq!(out.prohibitions, vec!["Rakip kötülenmez"]);
    assert_eq!(
        out.ad_cap,
        Some(Cap {
            amount_minor: 300_000,
            period: jt_strategy::Period::Monthly,
            currency: "TRY".into()
        })
    );
    assert_eq!(out.message_cap.unwrap().period, jt_strategy::Period::Weekly);
    assert!(out.post_approval);
    let s = settings(&w).await;
    assert_eq!(
        (s.revision, s.posting_revision, s.prospecting_revision),
        (2, 0, 0)
    );
    let r = revisions(&w, Subject::Rules, None).await;
    assert_eq!(r[0].revision, 2);
    assert_eq!(r[0].content["prohibitions"], json!(["Rakip kötülenmez"]));
    let ledger = w.entries("strategy.rules_changed");
    assert_eq!(
        ledger.last().unwrap().payload,
        json!({
            "prohibitions": 1,
            "ad_budget": {"amount_minor": 300_000, "period": "monthly"},
            "message_budget": {"amount_minor": 0, "period": "weekly"},
            "post_approval": true,
            "post_approval_accounts": 0,
            "revision": 2,
            "kb_revision": 2,
            "cause": "owner",
        })
    );
    // A stale save is refused; the same box again writes nothing.
    let e = err(rules_save(&w.deps, &w.owner_ctx, rules(1)).await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Conflict, "rules_changed"));
    let again = rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            prohibitions: vec!["Rakip kötülenmez".into()],
            ad_budget: Some(CapInput {
                amount_minor: 300_000,
                period: None,
            }),
            message_budget: Some(CapInput {
                amount_minor: 0,
                period: None,
            }),
            post_approval: true,
            ..rules(2)
        },
    )
    .await
    .unwrap();
    assert_eq!(again.revision, 2);
    // A rules save alone leaves the knowledge base empty and opens no frame.
    assert!(is_empty(&cards(&w).await));
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    assert!(t.strategy().current_approved().await.unwrap().is_none());
}

/// The ad cap keeps its currency (design §4.6.2): a save never takes the general budget's unit
/// for a cap in force, so no general item in another currency can turn the owner's number into
/// that currency's; the general budget follows the cap only in the cap's currency, and Bütçe
/// refuses to edit one counted in another (`rules_cap_currency`). Only a new cap takes the
/// general budget's unit.
#[tokio::test]
async fn the_ad_caps_currency_is_its_own_and_a_new_ones_the_general_budgets() {
    let w = world().await;
    budget::create_item(
        &w.deps,
        &w.owner_ctx,
        BudgetItemInput {
            name: "Ads".into(),
            kind: BudgetKind::AdBudget,
            unit: Unit::Currency("USD".into()),
            cap: 10_000,
            unit_cost_minor: None,
            period: Period::Monthly,
            general: true,
        },
    )
    .await
    .unwrap();
    approved_v5(&w).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let s = settings(&w).await;
    assert_eq!(
        s.ad_cap.as_ref().map(|c| c.currency.as_str()),
        Some("TRY"),
        "the lane's: no general budget in its currency, none made beside the USD one"
    );
    assert_eq!(general_item(&w).await.unit, Unit::Currency("USD".into()));
    let out = rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            ad_budget: Some(CapInput {
                amount_minor: 5_000,
                period: None,
            }),
            ..as_read(&s)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        out.ad_cap
            .as_ref()
            .map(|c| (c.amount_minor, c.currency.as_str())),
        Some((5_000, "TRY")),
        "the cap's own currency, whatever the general budget is counted in"
    );
    let g = general_item(&w).await;
    assert_eq!(
        (g.cap, &g.unit),
        (10_000, &Unit::Currency("USD".into())),
        "a general budget in another currency is not followed"
    );
    // Bütçe edits it no more while it sits outside the ceiling; it can stop being general.
    let e = err(budget::update_item(
        &w.deps,
        &w.owner_ctx,
        g.id,
        budget::UpdateBudgetItem {
            cap: Some(1_000),
            ..Default::default()
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details["reason"], "rules_cap_currency");
    assert_eq!(e.details["currency"], "TRY");

    // With no ad budget ("Reklam yok"), a new one takes the general budget's unit.
    let s = settings(&w).await;
    rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            ad_budget: None,
            ..as_read(&s)
        },
    )
    .await
    .unwrap();
    let s = settings(&w).await;
    let out = rules_save(
        &w.deps,
        &w.owner_ctx,
        RulesInput {
            ad_budget: Some(CapInput {
                amount_minor: 7_000,
                period: None,
            }),
            ..as_read(&s)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        out.ad_cap.map(|c| c.currency),
        Some("USD".to_owned()),
        "a new cap: the general budget's unit (design §4.6.2)"
    );
}

#[tokio::test]
async fn a_cap_is_the_budget_managers_and_lowering_approval_the_owners() {
    let w = world().await;
    let editor = person_with(&w, "editor", &[Permission::TeamManage]);
    let e = err(rules_save(
        &w.deps,
        &editor,
        RulesInput {
            ad_budget: Some(CapInput {
                amount_minor: 1,
                period: None,
            }),
            ..rules(1)
        },
    )
    .await);
    support::assert_forbidden(&e, "budget.manage");
    // Prohibitions alone need no budget permission.
    let out = rules_save(
        &w.deps,
        &editor,
        RulesInput {
            prohibitions: vec!["Rakip kötülenmez".into()],
            post_approval: true,
            ..rules(1)
        },
    )
    .await
    .unwrap();
    assert_eq!(out.revision, 2);
    // Switching approval off is an owner's or a manager's.
    let e = err(rules_save(&w.deps, &editor, rules(2)).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Forbidden, "owner_or_manager")
    );
    let manager = person_with(&w, "manager", &[Permission::TeamManage]);
    rules_save(&w.deps, &manager, rules(2)).await.unwrap();
    let agent = w.agent(&["team.manage", "budget.manage"]).await;
    let e = err(rules_save(&w.deps, &agent, rules(3)).await);
    assert_eq!(reason(&e), "human_required");
}

#[tokio::test]
async fn one_account_goes_into_and_out_of_the_approval_list() {
    let w = studio_support::world().await;
    let account = w.f.slot.capability_id;
    seed::ensure(&w.d, &w.ctx).await.unwrap();
    let rev = {
        let mut t = w.uow.tenant(w.f.ws).await.unwrap();
        t.knowledge()
            .settings()
            .await
            .unwrap()
            .unwrap()
            .rules_revision
    };
    let set = |required, expected_revision| PostApprovalInput {
        capability_id: account,
        required,
        expected_revision,
    };
    let out = post_approval_set(&w.d, &w.ctx, set(true, rev))
        .await
        .unwrap();
    assert!(out.post_approval_accounts.contains(&account));
    let rev = out.revision;
    let switched = rules_save(
        &w.d,
        &w.ctx,
        RulesInput {
            post_approval: true,
            ..rules(rev)
        },
    )
    .await
    .unwrap();
    let e = err(post_approval_set(&w.d, &w.ctx, set(false, switched.revision)).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "post_approval_all")
    );
    let off = rules_save(&w.d, &w.ctx, rules(switched.revision))
        .await
        .unwrap();
    let rep = Ctx {
        role_key: Some("rep".into()),
        ..w.ctx.clone()
    };
    let e = err(post_approval_set(&w.d, &rep, set(false, off.revision)).await);
    assert_eq!(reason(&e), "owner_or_manager");
    let out = post_approval_set(&w.d, &w.ctx, set(false, off.revision))
        .await
        .unwrap();
    assert!(!out.post_approval_accounts.contains(&account));
    let e = err(post_approval_set(
        &w.d,
        &w.ctx,
        PostApprovalInput {
            capability_id: jt_capability::CapabilityId::new_v7(),
            required: true,
            expected_revision: out.revision,
        },
    )
    .await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::NotFound, "not_a_social_account")
    );
}

#[tokio::test]
async fn the_goals_are_saved_whole() {
    let w = world().await;
    let out = goals_save(
        &w.deps,
        &w.owner_ctx,
        GoalsInput {
            expected_revision: 1,
            items: vec!["Ayda 12 sipariş".into(), " ".into()],
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (out.revision, out.items),
        (2, vec!["Ayda 12 sipariş".to_owned()])
    );
    let last = w.entries("strategy.knowledge_changed").pop().unwrap();
    assert_eq!(last.payload["subject"], "goals");
    let s = settings(&w).await;
    assert_eq!((s.posting_revision, s.prospecting_revision), (0, 0));
    let e = err(goals_save(
        &w.deps,
        &w.owner_ctx,
        GoalsInput {
            expected_revision: 1,
            items: vec![],
        },
    )
    .await);
    assert_eq!(reason(&e), "goals_changed");
    let e = err(goals_save(
        &w.deps,
        &w.owner_ctx,
        GoalsInput {
            expected_revision: 2,
            items: (0..21).map(|i| format!("hedef {i}")).collect(),
        },
    )
    .await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Validation, "too_many"));
    assert!(is_empty(&cards(&w).await), "goals are no card");
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_note_is_claimed_and_filed_as_the_owners_words() {
    let w = world().await;
    approved_v5(&w).await;
    let n = note_add(&w.deps, &w.owner_ctx, note("n-1", "Kargo artık 2 günde"))
        .await
        .unwrap();
    assert_eq!(
        (n.status, n.revision, n.created_by),
        (NoteStatus::Open, 1, w.owner)
    );
    let replay = note_add(&w.deps, &w.owner_ctx, note("n-1", "Kargo artık 2 günde"))
        .await
        .unwrap();
    assert_eq!(replay.id, n.id, "a replay answers the same note");
    let e = err(note_add(&w.deps, &w.owner_ctx, note("n-1", "başka")).await);
    assert_eq!(
        e.code,
        ErrorCode::Conflict,
        "another note under the same key"
    );

    let agent = w.agent(&["content.work"]).await;
    let other = w.agent(&["prospects.work"]).await;
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(claim.until, FIXED_NOW + NOTE_CLAIM_LEASE);
    let claimed = claim.note.claim.clone().unwrap();
    assert_ne!(
        claimed.token_hash, claim.claim_token,
        "only the hash is kept"
    );
    let e = err(note_claim(
        &w.deps,
        &other,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 2,
        },
    )
    .await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::Conflict, "note_claimed"));

    let products = card_of(&w, "products_prices").await;
    let more = format!("{}\nKargo 2 günde.", products.body);
    let mut input = filing(n.id, &claim.claim_token, "f-1");
    input.cards = vec![
        FiledCardInput::Existing(ExistingCardInput {
            card_id: products.id,
            expected_revision: 1,
            title: None,
            body: more.clone(),
        }),
        FiledCardInput::New(NewCardInput {
            new: NewCard {
                title: "Kargo".into(),
                body: "2 gün".into(),
            },
        }),
    ];
    input.attachments = vec![jt_app::usecases::knowledge::notes::FiledAttachmentInput {
        card: 1,
        file_id: None,
        url: Some("https://kahve.example/fiyat".into()),
    }];
    input.rules = vec!["Kargo süresi sitede yazandan kısa söylenmez".into()];
    input.goals = vec!["Ayda 12 sipariş".into()];
    let e = err(note_file(&w.deps, &other, input.clone()).await);
    assert_eq!(reason(&e), "not_claimed");
    let filed = note_file(&w.deps, &agent, input.clone()).await.unwrap();
    assert_eq!(
        (filed.status, filed.claim.clone()),
        (NoteStatus::Filed, None)
    );
    let outcome = filed.outcome.clone().unwrap();
    assert_eq!(outcome.cards.len(), 2);
    assert_eq!(outcome.cards[0].card_id, products.id);
    assert_eq!(outcome.rules, input.rules);
    assert_eq!(outcome.goals, input.goals);
    assert_eq!(
        outcome.summary.as_deref(),
        Some("Ürünler ve fiyat kartına eklendi")
    );
    let replay = note_file(&w.deps, &agent, input.clone()).await.unwrap();
    assert_eq!(replay, filed, "a replay answers the same note");

    let products = card_of(&w, "products_prices").await;
    assert_eq!(
        (products.revision, products.body.as_str()),
        (2, more.as_str())
    );
    let r = revisions(&w, Subject::Card, Some(products.id)).await;
    assert_eq!(
        (r[0].cause, r[0].source_id),
        (Cause::Note, Some(n.id.as_uuid()))
    );
    let new = cards(&w)
        .await
        .into_iter()
        .find(|c| c.title == "Kargo")
        .unwrap();
    assert_eq!(new.attachments.len(), 1);
    let s = settings(&w).await;
    assert_eq!(s.changed_by, Some(w.owner), "the note's person's words");
    assert!(s.prohibitions.ends_with(&input.rules));
    assert!(s.goals.ends_with(&input.goals));
    assert_eq!(s.posting_revision, s.revision, "the posting cards moved");
    assert_eq!(s.revision, 2, "one revision for the whole filing");
    assert_eq!(w.entries("strategy.note_filed").len(), 1);
}

#[tokio::test]
async fn a_filing_never_wipes_a_card_and_follows_its_claim() {
    let w = world().await;
    approved_v5(&w).await;
    let n = note_add(&w.deps, &w.owner_ctx, note("n-2", "Fiyatlar"))
        .await
        .unwrap();
    let agent = w.agent(&["content.work"]).await;
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let products = card_of(&w, "products_prices").await;
    let mut input = filing(n.id, &claim.claim_token, "f-2");
    input.cards = vec![FiledCardInput::Existing(ExistingCardInput {
        card_id: products.id,
        expected_revision: 1,
        title: None,
        body: "Kısa".into(),
    })];
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "filing_removes_text")
    );
    input.cards = vec![FiledCardInput::Existing(ExistingCardInput {
        card_id: products.id,
        expected_revision: 7,
        title: None,
        body: products.body.clone(),
    })];
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(reason(&e), "card_changed");
    input.cards = vec![];
    // A post request takes nothing of its own: the note is its text and files.
    input.post_request = Some(json!({"text": "Başka bir metin"}));
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(
        (e.code, e.details["field"].as_str(), reason(&e)),
        (ErrorCode::Validation, Some("post_request"), "invalid")
    );
    input.post_request = None;
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(reason(&e), "nothing_to_file");
    // A lapsed claim is no claim.
    input.rules = vec!["Kural".into()];
    let late = at(&agent, FIXED_NOW + NOTE_CLAIM_LEASE + Duration::seconds(1));
    let e = err(note_file(&w.deps, &late, input.clone()).await);
    assert_eq!(reason(&e), "not_claimed");
    // Released, then withdrawn by its person: no agent files it any more.
    note_release(
        &w.deps,
        &agent,
        NoteReleaseInput {
            note_id: n.id,
            claim_token: claim.claim_token.clone(),
        },
    )
    .await
    .unwrap();
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(reason(&e), "not_claimed");
    let back = note_withdraw(
        &w.deps,
        &w.owner_ctx,
        n.id,
        NoteWithdrawInput {
            expected_revision: 3,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (back.status, back.closed_by_user),
        (NoteStatus::Withdrawn, Some(w.owner))
    );
    let e = err(note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 4,
        },
    )
    .await);
    assert_eq!(reason(&e), "note_withdrawn");
}

#[tokio::test]
async fn a_note_with_nothing_to_act_on_is_dismissed_with_a_reason() {
    let w = world().await;
    let n = note_add(
        &w.deps,
        &w.owner_ctx,
        note("n-3", "Reklam bütçesini 10 bine çıkar"),
    )
    .await
    .unwrap();
    let agent = w.agent(&["ads.work"]).await;
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let mut input = filing(n.id, &claim.claim_token, "d-1");
    input.dismiss = Some(DismissInput {
        reason: "Reklam bütçesini Kurallar'dan sen değiştirirsin.".into(),
    });
    input.rules = vec!["x".into()];
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(reason(&e), "not_allowed", "a dismissal carries no outcome");
    input.rules = vec![];
    let done = note_file(&w.deps, &agent, input).await.unwrap();
    assert_eq!(done.status, NoteStatus::Dismissed);
    assert_eq!(
        done.outcome.unwrap().dismissed.as_deref(),
        Some("Reklam bütçesini Kurallar'dan sen değiştirirsin.")
    );
    assert_eq!(
        settings(&w).await.revision,
        1,
        "nothing in the knowledge base changed"
    );
}

#[tokio::test]
async fn notes_are_the_owners_to_write_and_the_agents_to_file() {
    let w = world().await;
    let n = note_add(&w.deps, &w.owner_ctx, note("n-4", "Bir not"))
        .await
        .unwrap();
    let e = err(note_claim(
        &w.deps,
        &w.owner_ctx,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(reason(&e), "agent_only");
    let reader = w.agent(&["workspace.read"]).await;
    let e = err(note_claim(
        &w.deps,
        &reader,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden, "a work permission is needed");
    let agent = w.agent(&["team.manage"]).await;
    let e = err(note_add(&w.deps, &agent, note("n-5", "x")).await);
    assert_eq!(reason(&e), "human_required");
    let stranger = person_with(&w, "rep", &[Permission::TeamManage]);
    let e = err(note_withdraw(
        &w.deps,
        &stranger,
        n.id,
        NoteWithdrawInput {
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(reason(&e), "owner_or_manager");
    let e = err(note_add(
        &w.deps,
        &w.owner_ctx,
        NoteAddInput {
            file_ids: vec![FileId::new_v7()],
            ..note("n-6", "dosyalı")
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_filing_names_its_own_proposals_and_the_notes_own_files() {
    use jt_app::usecases::knowledge::notes::FiledAttachmentInput;
    let w = world().await;
    approved_v5(&w).await;
    let pdf = stored_file(&w, "application/pdf").await;
    let elsewhere = stored_file(&w, "application/pdf").await;
    let n = note_add(
        &w.deps,
        &w.owner_ctx,
        NoteAddInput {
            file_ids: vec![pdf],
            ..note("n-8", "Fiyat listesi ekte")
        },
    )
    .await
    .unwrap();
    let agent = w.agent(&["content.work"]).await;
    let other = w.agent(&["social.work"]).await;
    let mine = proposal_create(
        &w.deps,
        &agent,
        propose(
            "p-8",
            ProposalKind::RuleAdd,
            None,
            "Listede olmayan fiyat verilmez",
        ),
    )
    .await
    .unwrap();
    let theirs = proposal_create(
        &w.deps,
        &other,
        propose("p-9", ProposalKind::GoalAdd, None, "Ayda 20 sipariş"),
    )
    .await
    .unwrap();
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let products = card_of(&w, "products_prices").await;
    let mut input = filing(n.id, &claim.claim_token, "f-8");
    input.cards = vec![FiledCardInput::Existing(ExistingCardInput {
        card_id: products.id,
        expected_revision: 1,
        title: None,
        body: format!("{}\nFiyat listesi ekte.", products.body),
    })];
    // Another agent's proposal is not this filing's to name.
    input.proposals = vec![theirs.id];
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(
        (e.code, reason(&e), e.details["field"].as_str()),
        (
            ErrorCode::NotFound,
            "no_such_proposal",
            Some("proposals[0]")
        )
    );
    // A file the note does not hold is no attachment of its filing.
    input.proposals = vec![mine.id];
    input.attachments = vec![FiledAttachmentInput {
        card: 0,
        file_id: Some(elsewhere),
        url: None,
    }];
    let e = err(note_file(&w.deps, &agent, input.clone()).await);
    assert_eq!(
        (e.code, reason(&e), e.details["field"].as_str()),
        (ErrorCode::Validation, "not_in_note", Some("attachments[0]"))
    );
    input.attachments[0].file_id = Some(pdf);
    let filed = note_file(&w.deps, &agent, input).await.unwrap();
    assert_eq!(filed.outcome.unwrap().proposals, vec![mine.id]);
    assert!(
        card_of(&w, "products_prices")
            .await
            .attachments
            .contains(&Attachment::File {
                file_id: pdf,
                name: "fiyat-listesi.pdf".into(),
                mime: "application/pdf".into()
            })
    );
    assert_eq!(
        status_of(&w, mine.id).await,
        ProposalStatus::Pending,
        "it waits for the owner"
    );
}

#[tokio::test]
async fn a_lapsed_claim_lets_another_agent_claim_the_note() {
    let w = world().await;
    let n = note_add(&w.deps, &w.owner_ctx, note("n-9", "Yeni ürün: anahtarlık"))
        .await
        .unwrap();
    let a = w.agent(&["content.work"]).await;
    let b = w.agent(&["prospects.work"]).await;
    let first = note_claim(
        &w.deps,
        &a,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let again = NoteClaimInput {
        note_id: n.id,
        expected_revision: 2,
    };
    let e = err(note_claim(&w.deps, &b, again).await);
    assert_eq!(reason(&e), "note_claimed");
    let later = FIXED_NOW + NOTE_CLAIM_LEASE + Duration::seconds(1);
    let second = note_claim(&w.deps, &at(&b, later), again).await.unwrap();
    assert_eq!(second.until, later + NOTE_CLAIM_LEASE);
    // The first agent's token files nothing now; the second's does.
    let mut input = filing(n.id, &first.claim_token, "f-9");
    input.rules = vec!["Anahtarlık fiyatı sorulursa listeye bak".into()];
    let e = err(note_file(&w.deps, &at(&a, later), input.clone()).await);
    assert_eq!(reason(&e), "not_claimed");
    input.claim_token = second.claim_token;
    let filed = note_file(&w.deps, &at(&b, later), input).await.unwrap();
    assert_eq!(filed.status, NoteStatus::Filed);
}

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_owner_adds_each_kind_of_proposal() {
    let w = world().await;
    approved_v5(&w).await;
    let agent = w.agent(&["content.work"]).await;
    let voice = {
        seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
        card_of(&w, "voice").await
    };
    let new = proposal_create(
        &w.deps,
        &agent,
        propose("p-1", ProposalKind::CardNew, None, "Kargo 2 gün"),
    )
    .await
    .unwrap();
    assert_eq!(new.expires_at, FIXED_NOW + AGENT_PROPOSAL_TTL);
    let replay = proposal_create(
        &w.deps,
        &agent,
        propose("p-1", ProposalKind::CardNew, None, "Kargo 2 gün"),
    )
    .await
    .unwrap();
    assert_eq!(replay.id, new.id);
    let edit = proposal_create(
        &w.deps,
        &agent,
        propose(
            "p-2",
            ProposalKind::CardEdit,
            Some(voice.id),
            "Samimi ve kısa.",
        ),
    )
    .await
    .unwrap();
    assert_eq!(edit.base_revision, Some(1));
    let rule = proposal_create(
        &w.deps,
        &agent,
        propose("p-3", ProposalKind::RuleAdd, None, "İndirim sözü verilmez"),
    )
    .await
    .unwrap();
    let goal = proposal_create(
        &w.deps,
        &agent,
        propose("p-4", ProposalKind::GoalAdd, None, "Ayda 15 sipariş"),
    )
    .await
    .unwrap();

    let accepted = proposal_accept(&w.deps, &w.owner_ctx, new.id)
        .await
        .unwrap();
    assert_eq!(
        (
            accepted.status,
            accepted.decided_by,
            accepted.applied_revision
        ),
        (ProposalStatus::Accepted, Some(w.owner), Some(2))
    );
    let added = cards(&w)
        .await
        .into_iter()
        .find(|c| c.title == "Sık sorulanlar")
        .unwrap();
    assert_eq!(added.body, "Kargo 2 gün");
    let r = revisions(&w, Subject::Card, Some(added.id)).await;
    assert_eq!(
        (r[0].cause, r[0].source_id),
        (Cause::Proposal, Some(new.id.as_uuid()))
    );
    proposal_accept(&w.deps, &w.owner_ctx, edit.id)
        .await
        .unwrap();
    assert_eq!(card_of(&w, "voice").await.body, "Samimi ve kısa.");
    proposal_accept(&w.deps, &w.owner_ctx, rule.id)
        .await
        .unwrap();
    proposal_accept(&w.deps, &w.owner_ctx, goal.id)
        .await
        .unwrap();
    let s = settings(&w).await;
    assert_eq!(s.prohibitions.last().unwrap(), "İndirim sözü verilmez");
    assert_eq!(s.goals.last().unwrap(), "Ayda 15 sipariş");
    assert_eq!(s.revision, 5);
    let e = err(proposal_accept(&w.deps, &w.owner_ctx, new.id).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "proposal_closed")
    );
    let e = err(proposal_accept(&w.deps, &agent, goal.id).await);
    support::assert_forbidden(&e, "team.manage");
    assert_eq!(w.entries("strategy.proposal_accepted").len(), 4);
}

#[tokio::test]
async fn proposals_are_bounded_rated_and_deduplicated() {
    let w = world().await;
    let a = w.agent(&["content.work"]).await;
    let b = w.agent(&["social.work"]).await;
    let c = w.agent(&["inbox.work"]).await;
    let rule = |key: &str, body: &str| propose(key, ProposalKind::RuleAdd, None, body);
    proposal_create(&w.deps, &a, rule("a-0", "Kural 0"))
        .await
        .unwrap();
    let e = err(proposal_create(&w.deps, &b, rule("b-dup", "Kural 0")).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "proposal_exists")
    );
    for i in 1..10 {
        proposal_create(&w.deps, &a, rule(&format!("a-{i}"), &format!("Kural a{i}")))
            .await
            .unwrap();
    }
    let e = err(proposal_create(&w.deps, &a, rule("a-10", "Kural a10")).await);
    assert_eq!(reason(&e), "proposal_rate");
    // A day later the rate is free again.
    let tomorrow = at(&a, FIXED_NOW + Duration::days(1) + Duration::seconds(1));
    proposal_create(&w.deps, &tomorrow, rule("a-11", "Kural a11"))
        .await
        .unwrap();
    for i in 0..9 {
        proposal_create(&w.deps, &b, rule(&format!("b-{i}"), &format!("Kural b{i}")))
            .await
            .unwrap();
    }
    let e = err(proposal_create(&w.deps, &c, rule("c-0", "Kural c0")).await);
    assert_eq!(reason(&e), "too_many_proposals");
    let e = err(proposal_create(
        &w.deps,
        &c,
        propose(
            "c-1",
            ProposalKind::CardEdit,
            Some(KnowledgeCardId::new_v7()),
            "x",
        ),
    )
    .await);
    assert_eq!((e.code, reason(&e)), (ErrorCode::NotFound, "no_such_card"));
    let e = err(proposal_create(&w.deps, &w.owner_ctx, rule("o-1", "Sahibin önerisi")).await);
    assert_eq!(reason(&e), "agent_only");
}

#[tokio::test]
async fn the_seedings_proposals_count_toward_no_limit() {
    let w = world().await;
    let (s, h) = v5();
    version(&w, 1, VersionStatus::Draft, s, h).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(proposals(&w).await.len(), 19, "the draft's parts wait");
    let a = w.agent(&["content.work"]).await;
    proposal_create(
        &w.deps,
        &a,
        propose("a", ProposalKind::GoalAdd, None, "Yeni hedef"),
    )
    .await
    .unwrap();
}

async fn status_of(w: &World, id: KnowledgeProposalId) -> ProposalStatus {
    proposals(w)
        .await
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
        .status
}

#[tokio::test]
async fn an_edit_of_a_card_whose_text_moved_is_superseded_not_applied() {
    let w = world().await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let voice = card_of(&w, "voice").await;
    let agent = w.agent(&["content.work"]).await;
    let first = proposal_create(
        &w.deps,
        &agent,
        propose("e-1", ProposalKind::CardEdit, Some(voice.id), "Samimi."),
    )
    .await
    .unwrap();
    // An owner's edit supersedes it at once.
    card_update(&w.deps, &w.owner_ctx, voice.id, body(1, "Resmî."))
        .await
        .unwrap();
    assert_eq!(status_of(&w, first.id).await, ProposalStatus::Superseded);
    // A note's filing that rewrites the card supersedes them too, at once.
    let second = proposal_create(
        &w.deps,
        &agent,
        propose("e-2", ProposalKind::CardEdit, Some(voice.id), "Sıcak."),
    )
    .await
    .unwrap();
    let n = note_add(&w.deps, &w.owner_ctx, note("n-7", "Ses tonu"))
        .await
        .unwrap();
    let claim = note_claim(
        &w.deps,
        &agent,
        NoteClaimInput {
            note_id: n.id,
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let mut input = filing(n.id, &claim.claim_token, "f-7");
    input.cards = vec![FiledCardInput::Existing(ExistingCardInput {
        card_id: voice.id,
        expected_revision: 2,
        title: None,
        body: "Resmî ve sıcak.".into(),
    })];
    note_file(&w.deps, &agent, input).await.unwrap();
    assert_eq!(status_of(&w, second.id).await, ProposalStatus::Superseded);
    let e = err(proposal_accept(&w.deps, &w.owner_ctx, second.id).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "proposal_closed")
    );
    assert_eq!(card_of(&w, "voice").await.body, "Resmî ve sıcak.");
    // A text that moved by a write that superseded nothing: accepting refuses, and supersedes it.
    let third = proposal_create(
        &w.deps,
        &agent,
        propose("e-3", ProposalKind::CardEdit, Some(voice.id), "Kısa."),
    )
    .await
    .unwrap();
    assert_eq!(third.base_revision, Some(3));
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let mut moved = t.knowledge().lock_card(voice.id).await.unwrap().unwrap();
    moved.body = "Başka bir ton.".into();
    moved.revision = 4;
    t.knowledge().save_card(&moved).await.unwrap();
    t.commit().await.unwrap();
    let e = err(proposal_accept(&w.deps, &w.owner_ctx, third.id).await);
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "proposal_superseded")
    );
    assert_eq!(
        status_of(&w, third.id).await,
        ProposalStatus::Superseded,
        "committed with the refusal"
    );
    assert_eq!(card_of(&w, "voice").await.body, "Başka bir ton.");
}

#[tokio::test]
async fn a_new_position_leaves_a_pending_edit_current() {
    let w = world().await;
    // Only a draft: the seeding's proposals hold its text for the blank cards.
    let (s, h) = v5();
    version(&w, 1, VersionStatus::Draft, s, h).await;
    seed::ensure(&w.deps, &w.owner_ctx).await.unwrap();
    let voice = card_of(&w, "voice").await;
    let edit = proposals(&w)
        .await
        .into_iter()
        .find(|p| p.kind == ProposalKind::CardEdit && p.card_id == Some(voice.id))
        .unwrap();
    let moved = card_update(
        &w.deps,
        &w.owner_ctx,
        voice.id,
        CardUpdateInput {
            expected_revision: 1,
            position: Some(0),
            ..CardUpdateInput::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(moved.revision, 2);
    assert_eq!(status_of(&w, edit.id).await, ProposalStatus::Pending);
    proposal_accept(&w.deps, &w.owner_ctx, edit.id)
        .await
        .unwrap();
    let voice = card_of(&w, "voice").await;
    assert_eq!(
        (voice.body.as_str(), voice.position, voice.revision),
        (edit.body.as_str(), 0, 3),
        "applied onto the card as it now is"
    );
}

#[tokio::test]
async fn a_proposal_is_skipped_or_expires() {
    let w = world().await;
    let agent = w.agent(&["content.work"]).await;
    let p = proposal_create(
        &w.deps,
        &agent,
        propose("s-1", ProposalKind::GoalAdd, None, "Hedef"),
    )
    .await
    .unwrap();
    let skipped = proposal_skip(&w.deps, &w.owner_ctx, p.id).await.unwrap();
    assert_eq!(
        (skipped.status, skipped.decided_by),
        (ProposalStatus::Skipped, Some(w.owner))
    );
    let q = proposal_create(
        &w.deps,
        &agent,
        propose("s-2", ProposalKind::GoalAdd, None, "Hedef"),
    )
    .await
    .unwrap();
    let late = at(&w.owner_ctx, FIXED_NOW + AGENT_PROPOSAL_TTL);
    let e = err(proposal_accept(&w.deps, &late, q.id).await);
    assert_eq!(reason(&e), "proposal_expired");
    let q = proposals(&w)
        .await
        .into_iter()
        .find(|x| x.id == q.id)
        .unwrap();
    assert_eq!((q.status, q.decided_by), (ProposalStatus::Expired, None));
    assert!(settings(&w).await.goals.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Tolerant reads (design §4.2)
// ---------------------------------------------------------------------------------------------

#[test]
fn a_version_cancelled_before_it_had_a_planned_post_reads() {
    let version: PackageVersion = serde_json::from_value(json!({
        "id": uuid::Uuid::now_v7(),
        "format": "feed_post",
        "capability_id": null,
        "text": "Yılbaşı",
        "title": null,
        "tags": [],
        "link": null,
        "material_ids": [],
        "hypothesis_id": uuid::Uuid::now_v7(),
        "content_type": null,
        "slot_id": null,
        "cancelled": {
            "by": UserId::new_v7(),
            "at": "2026-11-19T12:00:00Z",
            "reason": "Sahibi iptal etti",
        },
    }))
    .expect("a cancel without a planned post reads");
    assert_eq!(version.cancelled.unwrap().slot_id, None);
}
