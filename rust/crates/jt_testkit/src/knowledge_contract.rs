//! The knowledge base's repository contract (`jt_app::ports::knowledge`), the same for the
//! PostgreSQL and the in-memory repository: one settings row per workspace, cards by position
//! with one per key, a revision once per subject, card and revision, paged newest first, notes
//! newest first by status, one pending proposal per kind, card and body, an agent's proposals
//! counted, and expiry. A duplicate insert is `CONFLICT` and leaves the bundle usable (`on
//! conflict do nothing`): what the bundle writes after it commits. Every bundle that meets any
//! other refusal is dropped (the fake spoils it, as Postgres aborts a transaction on a failed
//! check).
use crate::fakes::FIXED_NOW;
use jt_app::{error::ErrorCode, ports::UnitOfWork};
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde_json::json;
use time::Duration;

fn by() -> Actor {
    Actor::Human {
        user_id: UserId::new_v7(),
    }
}

/// A card of `key` at `position`.
pub fn card(key: Option<&str>, position: u32) -> Card {
    Card {
        id: KnowledgeCardId::new_v7(),
        key: key.map(str::to_owned),
        title: "Biz kimiz".into(),
        body: "Figür yaparız.".into(),
        attachments: vec![Attachment::Link {
            url: "https://figurunica.example".into(),
            title: None,
        }],
        position,
        revision: 1,
        created_at: FIXED_NOW,
        created_by: Actor::System {
            component: BACKFILL_COMPONENT.into(),
        },
        updated_at: FIXED_NOW,
        updated_by: by(),
        archived_at: None,
    }
}

/// A revision of `subject` (of `card` for a card's) at `revision`.
pub fn revision(subject: Subject, card: Option<KnowledgeCardId>, revision: u64) -> Revision {
    Revision {
        id: KnowledgeRevisionId::new_v7(),
        subject,
        card_id: card,
        revision,
        kb_revision: revision,
        content: json!({ "body": format!("r{revision}") }),
        cause: Cause::Owner,
        source_id: None,
        at: FIXED_NOW + Duration::minutes(revision as i64),
        by: Actor::Agent {
            connection_id: AgentConnectionId::new_v7(),
            user_id: UserId::new_v7(),
        },
    }
}

/// An open note written `minutes` after the fixed time.
pub fn note(minutes: i64) -> Note {
    Note {
        id: KnowledgeNoteId::new_v7(),
        text: format!("Not {minutes}"),
        links: vec!["https://figurunica.example/katalog".into()],
        file_ids: vec![],
        status: NoteStatus::Open,
        claim: None,
        revision: 1,
        created_at: FIXED_NOW + Duration::minutes(minutes),
        created_by: UserId::new_v7(),
        closed_at: None,
        closed_by_user: None,
        closed_by_connection: None,
        outcome: None,
    }
}

/// A pending proposal of `kind` by `by`.
pub fn proposal(
    kind: ProposalKind,
    card: Option<KnowledgeCardId>,
    body: &str,
    by: Proposer,
) -> Proposal {
    Proposal {
        id: KnowledgeProposalId::new_v7(),
        kind,
        card_id: card,
        title: (kind == ProposalKind::CardNew).then(|| "SSS".to_owned()),
        body: body.into(),
        reason: "Müşteriler soruyor".into(),
        status: ProposalStatus::Pending,
        base_revision: card.map(|_| 1),
        proposed_at: FIXED_NOW,
        proposed_by: by,
        expires_at: FIXED_NOW + AGENT_PROPOSAL_TTL,
        decided_at: None,
        decided_by: None,
        applied_revision: None,
    }
}

/// Runs the contract in workspace `ws`, `other` being another workspace of the same store.
pub async fn exercise(uow: &dyn UnitOfWork, ws: WorkspaceId, other: WorkspaceId) {
    // Settings: one row, a second insert does nothing; saved whole.
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.knowledge().settings().await.unwrap(), None);
    let mut s = KnowledgeSettings::new(ws, SeedSource::Approved, FIXED_NOW);
    assert!(r.knowledge().insert_settings(&s).await.unwrap());
    assert!(!r.knowledge().insert_settings(&s).await.unwrap());
    s.revision = 3;
    s.prohibitions = vec!["Rakip kötülenmez".into()];
    s.goals = vec!["Ayda 12 sipariş".into()];
    s.ad_cap = Some(Cap {
        amount_minor: 500_000,
        period: jt_strategy::Period::Monthly,
        currency: "TRY".into(),
    });
    s.post_approval = true;
    s.post_approval_accounts = vec![uuid::Uuid::now_v7()];
    s.closing_topic_ids = vec![jt_strategy::HypothesisId::new_v7()];
    s.post_gate_seeded_at = Some(FIXED_NOW);
    s.changed_at = Some(FIXED_NOW);
    s.changed_by = Some(UserId::new_v7());
    r.knowledge().save_settings(&s).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.knowledge().lock_settings().await.unwrap(),
        Some(s.clone())
    );
    drop(r);
    let mut r = uow.tenant(other).await.unwrap();
    assert_eq!(r.knowledge().settings().await.unwrap(), None, "scoped");
    let e = r
        .knowledge()
        .save_settings(&KnowledgeSettings::new(other, SeedSource::Empty, FIXED_NOW))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    drop(r);

    // Cards: by position, one per key, a save keeps the key.
    let (a, b, c) = (card(Some("who_we_are"), 1), card(None, 0), card(None, 2));
    let mut r = uow.tenant(ws).await.unwrap();
    for x in [&a, &b, &c] {
        r.knowledge().insert_card(x).await.unwrap();
    }
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let ids: Vec<KnowledgeCardId> = r
        .knowledge()
        .cards()
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec![b.id, a.id, c.id]);
    let mut dup = card(Some("who_we_are"), 9);
    let e = r.knowledge().insert_card(&dup).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "one card per key");
    // The duplicate left the bundle usable: what it writes next commits.
    let d = card(None, 3);
    r.knowledge().insert_card(&d).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.knowledge().card(d.id).await.unwrap(), Some(d));
    drop(r);
    let mut r = uow.tenant(ws).await.unwrap();
    dup.key = None;
    dup.id = a.id;
    assert_eq!(
        r.knowledge().insert_card(&dup).await.unwrap_err().code,
        ErrorCode::Conflict,
        "one card per id"
    );
    drop(r);
    let mut r = uow.tenant(ws).await.unwrap();
    let mut edited = r.knowledge().lock_card(a.id).await.unwrap().unwrap();
    assert_eq!(edited, a);
    edited.title = "Biz".into();
    edited.body = "Yeni metin".into();
    edited.attachments.clear();
    edited.position = 5;
    edited.revision = 2;
    edited.updated_at = FIXED_NOW + Duration::hours(1);
    edited.archived_at = Some(FIXED_NOW + Duration::hours(1));
    let mut sneaky = edited.clone();
    sneaky.key = Some("voice".into());
    r.knowledge().save_card(&sneaky).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.knowledge().card(a.id).await.unwrap(),
        Some(edited.clone())
    );
    assert_eq!(
        r.knowledge()
            .save_card(&card(None, 0))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(r);
    let mut r = uow.tenant(other).await.unwrap();
    assert!(r.knowledge().cards().await.unwrap().is_empty(), "scoped");
    assert_eq!(r.knowledge().card(a.id).await.unwrap(), None);
    drop(r);

    // Revisions: once per subject, card and revision; newest first, paged.
    let mut r = uow.tenant(ws).await.unwrap();
    for n in 1..=5 {
        r.knowledge()
            .append_revision(&revision(Subject::Card, Some(a.id), n))
            .await
            .unwrap();
    }
    r.knowledge()
        .append_revision(&revision(Subject::Card, Some(b.id), 1))
        .await
        .unwrap();
    r.knowledge()
        .append_revision(&revision(Subject::Rules, None, 1))
        .await
        .unwrap();
    r.knowledge()
        .append_revision(&revision(Subject::Goals, None, 1))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let page = r
        .knowledge()
        .revisions(Subject::Card, Some(a.id), None, 2)
        .await
        .unwrap();
    assert_eq!(
        page.iter().map(|x| x.revision).collect::<Vec<_>>(),
        vec![5, 4]
    );
    let next = r
        .knowledge()
        .revisions(Subject::Card, Some(a.id), Some(4), 10)
        .await
        .unwrap();
    assert_eq!(
        next.iter().map(|x| x.revision).collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
    let rules = r
        .knowledge()
        .revisions(Subject::Rules, None, None, 10)
        .await
        .unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].subject, Subject::Rules);
    let e = r
        .knowledge()
        .append_revision(&revision(Subject::Card, Some(a.id), 3))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "a revision is recorded once");
    r.knowledge()
        .append_revision(&revision(Subject::Card, Some(a.id), 6))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.knowledge()
            .revisions(Subject::Card, Some(a.id), None, 1)
            .await
            .unwrap()[0]
            .revision,
        6,
        "the bundle that met the duplicate committed what followed"
    );
    drop(r);
    let mut r = uow.tenant(ws).await.unwrap();
    let e = r
        .knowledge()
        .append_revision(&revision(Subject::Card, Some(KnowledgeCardId::new_v7()), 1))
        .await
        .unwrap_err();
    assert_eq!(
        e.code,
        ErrorCode::Internal,
        "only of a card of the workspace"
    );
    drop(r);
    let mut r = uow.tenant(other).await.unwrap();
    assert!(
        r.knowledge()
            .revisions(Subject::Rules, None, None, 10)
            .await
            .unwrap()
            .is_empty(),
        "scoped"
    );
    drop(r);

    // Notes: newest first, by status; closed with their close time.
    let (old, new, third) = (note(1), note(2), note(3));
    let mut r = uow.tenant(ws).await.unwrap();
    for n in [&old, &new, &third] {
        r.knowledge().insert_note(n).await.unwrap();
    }
    let mut filed = r.knowledge().lock_note(third.id).await.unwrap().unwrap();
    filed.status = NoteStatus::Filed;
    filed.closed_at = Some(FIXED_NOW + Duration::hours(2));
    filed.closed_by_connection = Some(AgentConnectionId::new_v7());
    filed.revision = 3;
    filed.claim = None;
    filed.outcome = Some(NoteOutcome {
        summary: Some("Ürünler kartına eklendi".into()),
        rules: vec!["Kargo süresi söz verilmez".into()],
        ..NoteOutcome::default()
    });
    r.knowledge().save_note(&filed).await.unwrap();
    let mut claimed = new.clone();
    claimed.claim = Some(NoteClaim {
        connection_id: AgentConnectionId::new_v7(),
        token_hash: "hash".into(),
        until: FIXED_NOW + NOTE_CLAIM_LEASE,
    });
    claimed.revision = 2;
    r.knowledge().save_note(&claimed).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let all: Vec<KnowledgeNoteId> = r
        .knowledge()
        .notes(None, 10)
        .await
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(all, vec![third.id, new.id, old.id]);
    let open = r
        .knowledge()
        .notes(Some(NoteStatus::Open), 1)
        .await
        .unwrap();
    assert_eq!(open, vec![claimed.clone()]);
    assert_eq!(r.knowledge().note(third.id).await.unwrap(), Some(filed));
    let mut broken = old.clone();
    broken.status = NoteStatus::Dismissed;
    let e = r.knowledge().save_note(&broken).await.unwrap_err();
    assert_eq!(
        e.code,
        ErrorCode::Internal,
        "a closed note has its close time"
    );
    drop(r);
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.knowledge().save_note(&note(9)).await.unwrap_err().code,
        ErrorCode::NotFound
    );
    drop(r);
    let mut r = uow.tenant(other).await.unwrap();
    assert!(
        r.knowledge().notes(None, 10).await.unwrap().is_empty(),
        "scoped"
    );
    drop(r);

    // Proposals: one pending per kind, card and body; decided ones free it; counted; expired.
    let agent = AgentConnectionId::new_v7();
    let mine = Proposer::Agent {
        connection_id: agent,
    };
    let system = Proposer::System {
        component: BACKFILL_COMPONENT.into(),
    };
    let edit = proposal(
        ProposalKind::CardEdit,
        Some(b.id),
        "Yeni metin",
        mine.clone(),
    );
    let rule = proposal(
        ProposalKind::RuleAdd,
        None,
        "Kargo süresi söz verilmez",
        mine.clone(),
    );
    let mut seeded = proposal(ProposalKind::GoalAdd, None, "Ayda 12", system);
    seeded.expires_at = FIXED_NOW + SYSTEM_PROPOSAL_TTL;
    seeded.proposed_at = FIXED_NOW - Duration::days(3);
    let mut r = uow.tenant(ws).await.unwrap();
    for p in [&edit, &rule, &seeded] {
        r.knowledge().insert_proposal(p).await.unwrap();
    }
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let twin = proposal(
        ProposalKind::RuleAdd,
        None,
        "Kargo süresi söz verilmez",
        mine.clone(),
    );
    assert_eq!(
        r.knowledge().insert_proposal(&twin).await.unwrap_err().code,
        ErrorCode::Conflict,
        "one pending per kind, card and body"
    );
    // The same bundle goes on: skipping the pending one frees its place, and both commit.
    let mut skipped = r.knowledge().lock_proposal(rule.id).await.unwrap().unwrap();
    skipped.status = ProposalStatus::Skipped;
    skipped.decided_at = Some(FIXED_NOW);
    skipped.decided_by = Some(UserId::new_v7());
    r.knowledge().save_proposal(&skipped).await.unwrap();
    r.knowledge().insert_proposal(&twin).await.unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.knowledge().proposal(rule.id).await.unwrap(),
        Some(skipped)
    );
    let pending = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await
        .unwrap();
    assert_eq!(pending.len(), 3);
    assert_eq!(r.knowledge().proposals(None).await.unwrap().len(), 4);
    assert_eq!(
        r.knowledge()
            .proposals_by(agent, FIXED_NOW - Duration::days(1))
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        r.knowledge()
            .proposals_by(AgentConnectionId::new_v7(), FIXED_NOW - Duration::days(1))
            .await
            .unwrap(),
        0
    );
    // Expiry: the agent's after 14 days, the system's after 60.
    assert_eq!(
        r.knowledge()
            .expire_proposals(FIXED_NOW + AGENT_PROPOSAL_TTL)
            .await
            .unwrap(),
        2
    );
    r.commit().await.unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let left = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await
        .unwrap();
    assert_eq!(
        left.iter().map(|p| p.id).collect::<Vec<_>>(),
        vec![seeded.id]
    );
    let expired = r.knowledge().proposal(edit.id).await.unwrap().unwrap();
    assert_eq!(expired.status, ProposalStatus::Expired);
    assert_eq!(expired.decided_at, Some(FIXED_NOW + AGENT_PROPOSAL_TTL));
    assert_eq!(expired.decided_by, None);
    let mut undecided = expired.clone();
    undecided.decided_at = None;
    let e = r.knowledge().save_proposal(&undecided).await.unwrap_err();
    assert_eq!(
        e.code,
        ErrorCode::Internal,
        "a decided proposal has its decision time"
    );
    drop(r);
    let mut r = uow.tenant(ws).await.unwrap();
    let orphan = proposal(
        ProposalKind::CardEdit,
        Some(KnowledgeCardId::new_v7()),
        "x",
        mine,
    );
    assert_eq!(
        r.knowledge()
            .insert_proposal(&orphan)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal,
        "a card edit names a card of the workspace"
    );
    drop(r);
    let mut r = uow.tenant(other).await.unwrap();
    assert!(
        r.knowledge().proposals(None).await.unwrap().is_empty(),
        "scoped"
    );
}
