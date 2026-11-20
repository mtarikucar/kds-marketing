//! The in-memory knowledge base, with the constraints migration `0046_knowledge_base` enforces:
//! one settings row per workspace (a second insert does nothing), the limits of every list and
//! text, one card per key, a revision once per subject, card and revision and only of a card of
//! the workspace, never changed or removed, a closed note always with its close time, a decided
//! proposal always with its decision time, a `card_edit` always naming a card of the workspace,
//! and one pending proposal per kind, card and body.
//!
//! As PostgreSQL meets them: a row its checks refuse spoils the bundle (`INTERNAL`); a duplicate
//! insert is `CONFLICT` and leaves the bundle usable (`on conflict do nothing`); a reference that
//! points nowhere spoils it.
//!
//! Every `lock_*` takes the bundle's studio lock, as the execution frame's does, so two bundles
//! that lock the knowledge base run one after the other and the second reads what the first
//! committed (a concurrent seeding then finds the settings and seeds nothing).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::knowledge::KnowledgeRepo;
use jt_knowledge::{
    Card, KnowledgeCardId, KnowledgeNoteId, KnowledgeProposalId, KnowledgeSettings,
    MAX_CARD_ATTACHMENTS, MAX_CARD_BODY_CHARS, MAX_CARD_TITLE_CHARS, MAX_GOALS, MAX_NOTE_FILES,
    MAX_NOTE_LINKS, MAX_NOTE_TEXT_CHARS, MAX_POST_APPROVAL_ACCOUNTS, MAX_PROHIBITIONS,
    MAX_PROPOSAL_REASON_CHARS, Note, NoteStatus, Proposal, ProposalKind, ProposalStatus, Proposer,
    Revision, Subject, valid_key,
};
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, exists, same_workspace, unique};
use super::tenant::MemTenant;

/// The workspaces' knowledge bases, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemKnowledge {
    pub settings: Vec<KnowledgeSettings>,
    pub cards: Vec<(WorkspaceId, Card)>,
    pub revisions: Vec<(WorkspaceId, Revision)>,
    pub notes: Vec<(WorkspaceId, Note)>,
    pub proposals: Vec<(WorkspaceId, Proposal)>,
}

fn check(ok: bool, what: &str) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::internal(format!("check constraint: {what}")))
    }
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// The checks of `knowledge_settings`.
fn check_settings(s: &KnowledgeSettings) -> Result<(), AppError> {
    check(s.prohibitions.len() <= MAX_PROHIBITIONS, "prohibitions")?;
    check(s.goals.len() <= MAX_GOALS, "goals")?;
    check(
        s.post_approval_accounts.len() <= MAX_POST_APPROVAL_ACCOUNTS,
        "post_approval_accounts",
    )?;
    check(s.closing_topic_ids.len() <= 200, "closing_topic_ids")?;
    check(s.rules_revision > 0, "rules_revision")?;
    check(s.goals_revision > 0, "goals_revision")?;
    check(
        i64::try_from(s.revision).is_ok()
            && i64::try_from(s.posting_revision).is_ok()
            && i64::try_from(s.prospecting_revision).is_ok(),
        "revision range",
    )
}

/// The checks of `knowledge_cards`.
fn check_card(c: &Card) -> Result<(), AppError> {
    check(c.key.as_deref().is_none_or(valid_key), "key")?;
    check(
        (1..=MAX_CARD_TITLE_CHARS).contains(&chars(&c.title)),
        "title",
    )?;
    check(chars(&c.body) <= MAX_CARD_BODY_CHARS, "body")?;
    check(c.attachments.len() <= MAX_CARD_ATTACHMENTS, "attachments")?;
    check(i32::try_from(c.position).is_ok(), "position")?;
    check(c.revision > 0, "revision")
}

/// The checks of `knowledge_notes`.
fn check_note(n: &Note) -> Result<(), AppError> {
    check((1..=MAX_NOTE_TEXT_CHARS).contains(&chars(&n.text)), "text")?;
    check(n.links.len() <= MAX_NOTE_LINKS, "links")?;
    check(n.file_ids.len() <= MAX_NOTE_FILES, "file_ids")?;
    check(n.revision > 0, "revision")?;
    check(
        n.closed_at.is_none() == (n.status == NoteStatus::Open),
        "knowledge_notes_closed_rule",
    )
}

/// The checks of `knowledge_proposals` but its card reference.
fn check_proposal(p: &Proposal) -> Result<(), AppError> {
    check(
        p.title
            .as_deref()
            .is_none_or(|t| (1..=MAX_CARD_TITLE_CHARS).contains(&chars(t))),
        "title",
    )?;
    check((1..=MAX_CARD_BODY_CHARS).contains(&chars(&p.body)), "body")?;
    check(
        (1..=MAX_PROPOSAL_REASON_CHARS).contains(&chars(&p.reason)),
        "reason",
    )?;
    check(
        (p.kind == ProposalKind::CardEdit) == p.card_id.is_some(),
        "knowledge_proposals_card_rule",
    )?;
    check(
        p.decided_at.is_none() == (p.status == ProposalStatus::Pending),
        "knowledge_proposals_decided_rule",
    )
}

fn has_card(s: &MemState, ws: WorkspaceId, id: KnowledgeCardId) -> bool {
    s.knowledge
        .cards
        .iter()
        .any(|(w, c)| *w == ws && c.id == id)
}

impl MemTenant {
    fn kb(&self) -> &MemKnowledge {
        &self.state().knowledge
    }

    fn settings_of(&self) -> Option<KnowledgeSettings> {
        self.kb()
            .settings
            .iter()
            .find(|s| s.workspace_id == self.ws)
            .cloned()
    }

    fn card_of(&self, id: KnowledgeCardId) -> Option<Card> {
        self.kb()
            .cards
            .iter()
            .find(|(w, c)| *w == self.ws && c.id == id)
            .map(|(_, c)| c.clone())
    }

    fn note_of(&self, id: KnowledgeNoteId) -> Option<Note> {
        self.kb()
            .notes
            .iter()
            .find(|(w, n)| *w == self.ws && n.id == id)
            .map(|(_, n)| n.clone())
    }

    fn proposal_of(&self, id: KnowledgeProposalId) -> Option<Proposal> {
        self.kb()
            .proposals
            .iter()
            .find(|(w, p)| *w == self.ws && p.id == id)
            .map(|(_, p)| p.clone())
    }
}

#[async_trait]
impl KnowledgeRepo for MemTenant {
    async fn settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError> {
        Ok(self.settings_of())
    }

    async fn lock_settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError> {
        self.tx.journal_lock("knowledge_settings");
        self.tx.lock_studio().await;
        Ok(self.settings_of())
    }

    async fn insert_settings(&mut self, settings: &KnowledgeSettings) -> Result<bool, AppError> {
        self.tx.lock_studio().await;
        let settings = settings.clone();
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, settings.workspace_id)?;
            check_settings(&settings)?;
            exists(
                this.state().workspace(ws).is_some(),
                "knowledge_settings.workspace_id",
            )?;
            if this.settings_of().is_some() {
                return Ok(false);
            }
            this.tx.write(move |s| {
                // `on conflict do nothing`, as the database answers a row committed meanwhile.
                if !s.knowledge.settings.iter().any(|x| x.workspace_id == ws) {
                    s.knowledge.settings.push(settings.clone());
                }
            });
            Ok(true)
        })
    }

    async fn save_settings(&mut self, settings: &KnowledgeSettings) -> Result<(), AppError> {
        let settings = settings.clone();
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, settings.workspace_id)?;
            check_settings(&settings)?;
            if this.settings_of().is_none() {
                return Err(AppError::not_found("the knowledge base is not seeded"));
            }
            this.tx.write(move |s| {
                if let Some(x) = s
                    .knowledge
                    .settings
                    .iter_mut()
                    .find(|x| x.workspace_id == ws)
                {
                    *x = settings.clone();
                }
            });
            Ok(())
        })
    }

    async fn cards(&mut self) -> Result<Vec<Card>, AppError> {
        let mut cards: Vec<Card> = self
            .kb()
            .cards
            .iter()
            .filter(|(w, _)| *w == self.ws)
            .map(|(_, c)| c.clone())
            .collect();
        cards.sort_by(|a, b| {
            (a.position, a.created_at, a.id).cmp(&(b.position, b.created_at, b.id))
        });
        Ok(cards)
    }

    async fn card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError> {
        Ok(self.card_of(id))
    }

    async fn lock_card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError> {
        self.tx.lock_studio().await;
        Ok(self.card_of(id))
    }

    async fn insert_card(&mut self, card: &Card) -> Result<(), AppError> {
        let card = card.clone();
        let ws = self.ws;
        self.call(|_| check_card(&card))?;
        unique(
            !self.kb().cards.iter().any(|(w, c)| {
                *w == ws && (c.id == card.id || (card.key.is_some() && c.key == card.key))
            }),
            "the card id or key is taken",
        )?;
        self.call(|this| {
            exists(
                this.state().workspace(ws).is_some(),
                "knowledge_cards.workspace_id",
            )?;
            this.tx
                .write(move |s| s.knowledge.cards.push((ws, card.clone())));
            Ok(())
        })
    }

    async fn save_card(&mut self, card: &Card) -> Result<(), AppError> {
        let card = card.clone();
        self.call(|this| {
            let ws = this.ws;
            check_card(&card)?;
            if this.card_of(card.id).is_none() {
                return Err(AppError::not_found("no such card"));
            }
            this.tx.write(move |s| {
                if let Some((_, c)) = s
                    .knowledge
                    .cards
                    .iter_mut()
                    .find(|(w, c)| *w == ws && c.id == card.id)
                {
                    c.title = card.title.clone();
                    c.body = card.body.clone();
                    c.attachments = card.attachments.clone();
                    c.position = card.position;
                    c.revision = card.revision;
                    c.updated_at = card.updated_at;
                    c.updated_by = card.updated_by.clone();
                    c.archived_at = card.archived_at;
                }
            });
            Ok(())
        })
    }

    async fn append_revision(&mut self, revision: &Revision) -> Result<(), AppError> {
        let revision = revision.clone();
        let ws = self.ws;
        self.call(|_| {
            check(revision.revision > 0, "revision")?;
            check(
                (revision.subject == Subject::Card) == revision.card_id.is_some(),
                "knowledge_revisions_subject_rule",
            )?;
            check(revision.content.is_object(), "content")
        })?;
        unique(
            !self.kb().revisions.iter().any(|(w, r)| {
                *w == ws
                    && (r.id == revision.id
                        || (r.subject == revision.subject
                            && r.card_id == revision.card_id
                            && r.revision == revision.revision))
            }),
            "the revision is already recorded",
        )?;
        self.call(|this| {
            if let Some(card) = revision.card_id {
                exists(
                    has_card(this.state(), ws, card),
                    "knowledge_revisions.card_id",
                )?;
            }
            this.tx
                .write(move |s| s.knowledge.revisions.push((ws, revision.clone())));
            Ok(())
        })
    }

    async fn revisions(
        &mut self,
        subject: Subject,
        card_id: Option<KnowledgeCardId>,
        before: Option<u64>,
        limit: u32,
    ) -> Result<Vec<Revision>, AppError> {
        let mut out: Vec<Revision> = self
            .kb()
            .revisions
            .iter()
            .filter(|(w, r)| {
                *w == self.ws
                    && r.subject == subject
                    && r.card_id == card_id
                    && before.is_none_or(|b| r.revision < b)
            })
            .map(|(_, r)| r.clone())
            .collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.revision));
        out.truncate(limit as usize);
        Ok(out)
    }

    async fn notes(
        &mut self,
        status: Option<NoteStatus>,
        limit: u32,
    ) -> Result<Vec<Note>, AppError> {
        let mut out: Vec<Note> = self
            .kb()
            .notes
            .iter()
            .filter(|(w, n)| *w == self.ws && status.is_none_or(|s| n.status == s))
            .map(|(_, n)| n.clone())
            .collect();
        out.sort_by_key(|n| std::cmp::Reverse((n.created_at, n.id)));
        out.truncate(limit as usize);
        Ok(out)
    }

    async fn note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError> {
        Ok(self.note_of(id))
    }

    async fn lock_note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError> {
        self.tx.lock_studio().await;
        Ok(self.note_of(id))
    }

    async fn insert_note(&mut self, note: &Note) -> Result<(), AppError> {
        let note = note.clone();
        let ws = self.ws;
        self.call(|_| check_note(&note))?;
        unique(self.note_of(note.id).is_none(), "the note id is taken")?;
        self.call(|this| {
            exists(
                this.state().workspace(ws).is_some(),
                "knowledge_notes.workspace_id",
            )?;
            this.tx
                .write(move |s| s.knowledge.notes.push((ws, note.clone())));
            Ok(())
        })
    }

    async fn save_note(&mut self, note: &Note) -> Result<(), AppError> {
        let note = note.clone();
        self.call(|this| {
            let ws = this.ws;
            check_note(&note)?;
            if this.note_of(note.id).is_none() {
                return Err(AppError::not_found("no such note"));
            }
            this.tx.write(move |s| {
                if let Some((_, n)) = s
                    .knowledge
                    .notes
                    .iter_mut()
                    .find(|(w, n)| *w == ws && n.id == note.id)
                {
                    n.status = note.status;
                    n.claim = note.claim.clone();
                    n.revision = note.revision;
                    n.closed_at = note.closed_at;
                    n.closed_by_user = note.closed_by_user;
                    n.closed_by_connection = note.closed_by_connection;
                    n.outcome = note.outcome.clone();
                }
            });
            Ok(())
        })
    }

    async fn proposals(
        &mut self,
        status: Option<ProposalStatus>,
    ) -> Result<Vec<Proposal>, AppError> {
        let mut out: Vec<Proposal> = self
            .kb()
            .proposals
            .iter()
            .filter(|(w, p)| *w == self.ws && status.is_none_or(|s| p.status == s))
            .map(|(_, p)| p.clone())
            .collect();
        out.sort_by_key(|p| std::cmp::Reverse((p.proposed_at, p.id)));
        Ok(out)
    }

    async fn proposal(&mut self, id: KnowledgeProposalId) -> Result<Option<Proposal>, AppError> {
        Ok(self.proposal_of(id))
    }

    async fn lock_proposal(
        &mut self,
        id: KnowledgeProposalId,
    ) -> Result<Option<Proposal>, AppError> {
        self.tx.lock_studio().await;
        Ok(self.proposal_of(id))
    }

    async fn insert_proposal(&mut self, proposal: &Proposal) -> Result<(), AppError> {
        let proposal = proposal.clone();
        let ws = self.ws;
        self.call(|_| check_proposal(&proposal))?;
        let pending_twin = proposal.status == ProposalStatus::Pending
            && self.kb().proposals.iter().any(|(w, p)| {
                *w == ws
                    && p.status == ProposalStatus::Pending
                    && p.kind == proposal.kind
                    && p.card_id == proposal.card_id
                    && p.body == proposal.body
            });
        unique(
            self.proposal_of(proposal.id).is_none() && !pending_twin,
            "the proposal id is taken, or the same proposal is pending",
        )?;
        self.call(|this| {
            exists(
                this.state().workspace(ws).is_some(),
                "knowledge_proposals.workspace_id",
            )?;
            if let Some(card) = proposal.card_id {
                exists(
                    has_card(this.state(), ws, card),
                    "knowledge_proposals.card_id",
                )?;
            }
            this.tx
                .write(move |s| s.knowledge.proposals.push((ws, proposal.clone())));
            Ok(())
        })
    }

    async fn save_proposal(&mut self, proposal: &Proposal) -> Result<(), AppError> {
        let proposal = proposal.clone();
        self.call(|this| {
            let ws = this.ws;
            check_proposal(&proposal)?;
            if this.proposal_of(proposal.id).is_none() {
                return Err(AppError::not_found("no such proposal"));
            }
            this.tx.write(move |s| {
                if let Some((_, p)) = s
                    .knowledge
                    .proposals
                    .iter_mut()
                    .find(|(w, p)| *w == ws && p.id == proposal.id)
                {
                    p.status = proposal.status;
                    p.decided_at = proposal.decided_at;
                    p.decided_by = proposal.decided_by;
                    p.applied_revision = proposal.applied_revision;
                }
            });
            Ok(())
        })
    }

    async fn proposals_by(
        &mut self,
        connection: AgentConnectionId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let n = self
            .kb()
            .proposals
            .iter()
            .filter(|(w, p)| {
                *w == self.ws
                    && p.proposed_by
                        == Proposer::Agent {
                            connection_id: connection,
                        }
                    && p.proposed_at >= since
            })
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn expire_proposals(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let due = self
            .kb()
            .proposals
            .iter()
            .filter(|(w, p)| *w == ws && p.status == ProposalStatus::Pending && p.expires_at <= now)
            .count();
        if due > 0 {
            self.tx.write(move |s| {
                for (w, p) in s.knowledge.proposals.iter_mut() {
                    if *w == ws && p.status == ProposalStatus::Pending && p.expires_at <= now {
                        p.status = ProposalStatus::Expired;
                        p.decided_at = Some(now);
                    }
                }
            });
        }
        Ok(due as u64)
    }
}
