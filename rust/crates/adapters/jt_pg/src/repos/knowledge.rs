//! The knowledge base (migration `0046_knowledge_base`): `knowledge_settings`, `knowledge_cards`,
//! `knowledge_revisions` (append-only, `knowledge_revisions_append_only`), `knowledge_notes` and
//! `knowledge_proposals`. Lists, caps, attachments, claims and outcomes keep the domain's
//! encoding as JSON; who wrote a card or a revision is stored by shape, as `strategy_versions`
//! does (a human the user, an agent the user and the connection, the system the component).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::knowledge::KnowledgeRepo;
use jt_knowledge::{
    Card, Cause, KnowledgeCardId, KnowledgeNoteId, KnowledgeProposalId, KnowledgeRevisionId,
    KnowledgeSettings, Note, NoteStatus, Proposal, ProposalKind, ProposalStatus, Proposer,
    Revision, SeedSource, Subject,
};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{actor_columns, map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

fn decode<T: DeserializeOwned>(v: Value, what: &str) -> Result<T, AppError> {
    serde_json::from_value(v).map_err(|_| AppError::internal(format!("invalid stored {what}")))
}

fn encode<T: Serialize>(v: &T, what: &str) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| AppError::internal(format!("cannot encode {what}")))
}

/// A revision or count as stored (`bigint`).
fn int(n: u64, what: &str) -> Result<i64, AppError> {
    i64::try_from(n).map_err(|_| AppError::internal(format!("{what} is out of range")))
}

/// A stored `bigint` that is never negative.
fn count(n: i64, what: &str) -> Result<u64, AppError> {
    u64::try_from(n).map_err(|_| AppError::internal(format!("stored {what} is negative")))
}

/// The actor stored in the user, connection and component columns: a human the user only, an
/// agent the user (its issuer) and the connection, the system the component only.
fn actor(
    user: Option<Uuid>,
    connection: Option<Uuid>,
    component: Option<String>,
    what: &str,
) -> Result<Actor, AppError> {
    match (user, connection, component) {
        (Some(user), None, None) => Ok(Actor::Human {
            user_id: UserId(user),
        }),
        (Some(user), Some(connection), None) => Ok(Actor::Agent {
            connection_id: AgentConnectionId(connection),
            user_id: UserId(user),
        }),
        (None, None, Some(component)) => Ok(Actor::System { component }),
        _ => Err(AppError::internal(format!(
            "stored {what} actor is incomplete"
        ))),
    }
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct SettingsRecord {
    workspace_id: Uuid,
    revision: i64,
    changed_at: Option<OffsetDateTime>,
    changed_by: Option<Uuid>,
    posting_revision: i64,
    prospecting_revision: i64,
    posting_derived: i64,
    prospecting_derived: i64,
    prohibitions: Value,
    goals: Value,
    ad_cap: Option<Value>,
    message_cap: Option<Value>,
    post_approval: bool,
    post_approval_accounts: Value,
    post_gate_seeded_at: Option<OffsetDateTime>,
    closing_topic_ids: Value,
    rules_revision: i64,
    goals_revision: i64,
    frame_applied_at: Option<OffsetDateTime>,
    seeded_at: OffsetDateTime,
    seed_source: String,
}

impl SettingsRecord {
    fn into_settings(self) -> Result<KnowledgeSettings, AppError> {
        Ok(KnowledgeSettings {
            workspace_id: WorkspaceId(self.workspace_id),
            revision: count(self.revision, "knowledge revision")?,
            changed_at: self.changed_at,
            changed_by: self.changed_by.map(UserId),
            posting_revision: count(self.posting_revision, "posting revision")?,
            prospecting_revision: count(self.prospecting_revision, "prospecting revision")?,
            posting_derived: count(self.posting_derived, "posting derivation")?,
            prospecting_derived: count(self.prospecting_derived, "prospecting derivation")?,
            prohibitions: decode(self.prohibitions, "knowledge prohibitions")?,
            goals: decode(self.goals, "knowledge goals")?,
            ad_cap: self
                .ad_cap
                .map(|v| decode(v, "knowledge ad cap"))
                .transpose()?,
            message_cap: self
                .message_cap
                .map(|v| decode(v, "knowledge message cap"))
                .transpose()?,
            post_approval: self.post_approval,
            post_approval_accounts: decode(self.post_approval_accounts, "post approval accounts")?,
            post_gate_seeded_at: self.post_gate_seeded_at,
            closing_topic_ids: decode(self.closing_topic_ids, "closing topics")?,
            rules_revision: count(self.rules_revision, "rules revision")?,
            goals_revision: count(self.goals_revision, "goals revision")?,
            frame_applied_at: self.frame_applied_at,
            seeded_at: self.seeded_at,
            seed_source: stored(SeedSource::parse(&self.seed_source), "seed source")?,
        })
    }
}

const SETTINGS_COLUMNS: &str = "workspace_id, revision, changed_at, changed_by, posting_revision, \
     prospecting_revision, posting_derived, prospecting_derived, prohibitions, goals, ad_cap, \
     message_cap, post_approval, post_approval_accounts, post_gate_seeded_at, closing_topic_ids, \
     rules_revision, goals_revision, frame_applied_at, seeded_at, seed_source";

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct CardRecord {
    id: Uuid,
    key: Option<String>,
    title: String,
    body: String,
    attachments: Value,
    position: i32,
    revision: i64,
    created_at: OffsetDateTime,
    created_by_user: Option<Uuid>,
    created_by_connection: Option<Uuid>,
    created_by_component: Option<String>,
    updated_at: OffsetDateTime,
    updated_by_user: Option<Uuid>,
    updated_by_connection: Option<Uuid>,
    updated_by_component: Option<String>,
    archived_at: Option<OffsetDateTime>,
}

impl CardRecord {
    fn into_card(self) -> Result<Card, AppError> {
        Ok(Card {
            id: KnowledgeCardId(self.id),
            key: self.key,
            title: self.title,
            body: self.body,
            attachments: decode(self.attachments, "knowledge card attachments")?,
            position: u32::try_from(self.position)
                .map_err(|_| AppError::internal("stored knowledge card position is negative"))?,
            revision: count(self.revision, "knowledge card revision")?,
            created_at: self.created_at,
            created_by: actor(
                self.created_by_user,
                self.created_by_connection,
                self.created_by_component,
                "knowledge card creator",
            )?,
            updated_at: self.updated_at,
            updated_by: actor(
                self.updated_by_user,
                self.updated_by_connection,
                self.updated_by_component,
                "knowledge card editor",
            )?,
            archived_at: self.archived_at,
        })
    }
}

const CARD_COLUMNS: &str = "id, key, title, body, attachments, position, revision, created_at, \
     created_by_user, created_by_connection, created_by_component, updated_at, updated_by_user, \
     updated_by_connection, updated_by_component, archived_at";

fn position(card: &Card) -> Result<i32, AppError> {
    i32::try_from(card.position).map_err(|_| AppError::internal("card position is out of range"))
}

// ---------------------------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct RevisionRecord {
    id: Uuid,
    subject: String,
    card_id: Option<Uuid>,
    revision: i64,
    kb_revision: i64,
    content: Value,
    cause: String,
    source_id: Option<Uuid>,
    at: OffsetDateTime,
    by_user: Option<Uuid>,
    by_connection: Option<Uuid>,
    by_component: Option<String>,
}

impl RevisionRecord {
    fn into_revision(self) -> Result<Revision, AppError> {
        Ok(Revision {
            id: KnowledgeRevisionId(self.id),
            subject: stored(Subject::parse(&self.subject), "knowledge revision subject")?,
            card_id: self.card_id.map(KnowledgeCardId),
            revision: count(self.revision, "knowledge revision")?,
            kb_revision: count(self.kb_revision, "knowledge base revision")?,
            content: self.content,
            cause: stored(Cause::parse(&self.cause), "knowledge revision cause")?,
            source_id: self.source_id,
            at: self.at,
            by: actor(
                self.by_user,
                self.by_connection,
                self.by_component,
                "knowledge revision",
            )?,
        })
    }
}

const REVISION_COLUMNS: &str = "id, subject, card_id, revision, kb_revision, content, cause, \
     source_id, at, by_user, by_connection, by_component";

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct NoteRecord {
    id: Uuid,
    text: String,
    links: Value,
    file_ids: Value,
    status: String,
    claim: Option<Value>,
    revision: i64,
    created_at: OffsetDateTime,
    created_by_user: Uuid,
    closed_at: Option<OffsetDateTime>,
    closed_by_user: Option<Uuid>,
    closed_by_connection: Option<Uuid>,
    outcome: Option<Value>,
}

impl NoteRecord {
    fn into_note(self) -> Result<Note, AppError> {
        Ok(Note {
            id: KnowledgeNoteId(self.id),
            text: self.text,
            links: decode(self.links, "knowledge note links")?,
            file_ids: decode(self.file_ids, "knowledge note files")?,
            status: stored(NoteStatus::parse(&self.status), "knowledge note status")?,
            claim: self
                .claim
                .map(|v| decode(v, "knowledge note claim"))
                .transpose()?,
            revision: count(self.revision, "knowledge note revision")?,
            created_at: self.created_at,
            created_by: UserId(self.created_by_user),
            closed_at: self.closed_at,
            closed_by_user: self.closed_by_user.map(UserId),
            closed_by_connection: self.closed_by_connection.map(AgentConnectionId),
            outcome: self
                .outcome
                .map(|v| decode(v, "knowledge note outcome"))
                .transpose()?,
        })
    }
}

const NOTE_COLUMNS: &str = "id, text, links, file_ids, status, claim, revision, created_at, \
     created_by_user, closed_at, closed_by_user, closed_by_connection, outcome";

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ProposalRecord {
    id: Uuid,
    kind: String,
    card_id: Option<Uuid>,
    title: Option<String>,
    body: String,
    reason: String,
    status: String,
    base_revision: Option<i64>,
    proposed_at: OffsetDateTime,
    proposed_by_connection: Option<Uuid>,
    proposed_by_component: Option<String>,
    expires_at: OffsetDateTime,
    decided_at: Option<OffsetDateTime>,
    decided_by_user: Option<Uuid>,
    applied_revision: Option<i64>,
}

impl ProposalRecord {
    fn into_proposal(self) -> Result<Proposal, AppError> {
        let proposed_by = match (self.proposed_by_connection, self.proposed_by_component) {
            (Some(connection), None) => Proposer::Agent {
                connection_id: AgentConnectionId(connection),
            },
            (None, Some(component)) => Proposer::System { component },
            _ => {
                return Err(AppError::internal(
                    "stored knowledge proposal author is incomplete",
                ));
            }
        };
        Ok(Proposal {
            id: KnowledgeProposalId(self.id),
            kind: stored(ProposalKind::parse(&self.kind), "knowledge proposal kind")?,
            card_id: self.card_id.map(KnowledgeCardId),
            title: self.title,
            body: self.body,
            reason: self.reason,
            status: stored(
                ProposalStatus::parse(&self.status),
                "knowledge proposal status",
            )?,
            base_revision: self
                .base_revision
                .map(|n| count(n, "knowledge proposal base revision"))
                .transpose()?,
            proposed_at: self.proposed_at,
            proposed_by,
            expires_at: self.expires_at,
            decided_at: self.decided_at,
            decided_by: self.decided_by_user.map(UserId),
            applied_revision: self
                .applied_revision
                .map(|n| count(n, "knowledge proposal applied revision"))
                .transpose()?,
        })
    }
}

const PROPOSAL_COLUMNS: &str = "id, kind, card_id, title, body, reason, status, base_revision, \
     proposed_at, proposed_by_connection, proposed_by_component, expires_at, decided_at, \
     decided_by_user, applied_revision";

fn proposer_columns(p: &Proposer) -> (Option<Uuid>, Option<&str>) {
    match p {
        Proposer::Agent { connection_id } => (Some(connection_id.as_uuid()), None),
        Proposer::System { component } => (None, Some(component.as_str())),
    }
}

#[async_trait]
impl KnowledgeRepo for PgTenantRepos {
    async fn settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError> {
        let ws = self.workspace_id();
        let record: Option<SettingsRecord> = sqlx::query_as(&format!(
            "select {SETTINGS_COLUMNS} from knowledge_settings where workspace_id = $1"
        ))
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read the knowledge settings"))?;
        record.map(SettingsRecord::into_settings).transpose()
    }

    async fn lock_settings(&mut self) -> Result<Option<KnowledgeSettings>, AppError> {
        let ws = self.workspace_id();
        let record: Option<SettingsRecord> = sqlx::query_as(&format!(
            "select {SETTINGS_COLUMNS} from knowledge_settings where workspace_id = $1 for update"
        ))
        .bind(ws.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock the knowledge settings"))?;
        record.map(SettingsRecord::into_settings).transpose()
    }

    async fn insert_settings(&mut self, s: &KnowledgeSettings) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, s.workspace_id)?;
        let done = sqlx::query(
            "insert into knowledge_settings (workspace_id, revision, changed_at, changed_by, \
             posting_revision, prospecting_revision, posting_derived, prospecting_derived, \
             prohibitions, goals, ad_cap, message_cap, post_approval, post_approval_accounts, \
             post_gate_seeded_at, closing_topic_ids, rules_revision, goals_revision, \
             frame_applied_at, seeded_at, seed_source) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, \
             $18, $19, $20, $21) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(int(s.revision, "the knowledge revision")?)
        .bind(s.changed_at)
        .bind(s.changed_by.map(|u| u.as_uuid()))
        .bind(int(s.posting_revision, "the posting revision")?)
        .bind(int(s.prospecting_revision, "the prospecting revision")?)
        .bind(int(s.posting_derived, "the posting derivation")?)
        .bind(int(s.prospecting_derived, "the prospecting derivation")?)
        .bind(encode(&s.prohibitions, "the prohibitions")?)
        .bind(encode(&s.goals, "the goals")?)
        .bind(
            s.ad_cap
                .as_ref()
                .map(|c| encode(c, "the ad cap"))
                .transpose()?,
        )
        .bind(
            s.message_cap
                .as_ref()
                .map(|c| encode(c, "the message cap"))
                .transpose()?,
        )
        .bind(s.post_approval)
        .bind(encode(
            &s.post_approval_accounts,
            "the post approval accounts",
        )?)
        .bind(s.post_gate_seeded_at)
        .bind(encode(&s.closing_topic_ids, "the closing topics")?)
        .bind(int(s.rules_revision, "the rules revision")?)
        .bind(int(s.goals_revision, "the goals revision")?)
        .bind(s.frame_applied_at)
        .bind(s.seeded_at)
        .bind(s.seed_source.key())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store the knowledge settings"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn save_settings(&mut self, s: &KnowledgeSettings) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, s.workspace_id)?;
        let done = sqlx::query(
            "update knowledge_settings set revision = $2, changed_at = $3, changed_by = $4, \
             posting_revision = $5, prospecting_revision = $6, posting_derived = $7, \
             prospecting_derived = $8, prohibitions = $9, goals = $10, ad_cap = $11, \
             message_cap = $12, post_approval = $13, post_approval_accounts = $14, \
             post_gate_seeded_at = $15, closing_topic_ids = $16, rules_revision = $17, \
             goals_revision = $18, frame_applied_at = $19, seeded_at = $20, seed_source = $21 \
             where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .bind(int(s.revision, "the knowledge revision")?)
        .bind(s.changed_at)
        .bind(s.changed_by.map(|u| u.as_uuid()))
        .bind(int(s.posting_revision, "the posting revision")?)
        .bind(int(s.prospecting_revision, "the prospecting revision")?)
        .bind(int(s.posting_derived, "the posting derivation")?)
        .bind(int(s.prospecting_derived, "the prospecting derivation")?)
        .bind(encode(&s.prohibitions, "the prohibitions")?)
        .bind(encode(&s.goals, "the goals")?)
        .bind(
            s.ad_cap
                .as_ref()
                .map(|c| encode(c, "the ad cap"))
                .transpose()?,
        )
        .bind(
            s.message_cap
                .as_ref()
                .map(|c| encode(c, "the message cap"))
                .transpose()?,
        )
        .bind(s.post_approval)
        .bind(encode(
            &s.post_approval_accounts,
            "the post approval accounts",
        )?)
        .bind(s.post_gate_seeded_at)
        .bind(encode(&s.closing_topic_ids, "the closing topics")?)
        .bind(int(s.rules_revision, "the rules revision")?)
        .bind(int(s.goals_revision, "the goals revision")?)
        .bind(s.frame_applied_at)
        .bind(s.seeded_at)
        .bind(s.seed_source.key())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save the knowledge settings"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("the knowledge base is not seeded"));
        }
        Ok(())
    }

    async fn cards(&mut self) -> Result<Vec<Card>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<CardRecord> = sqlx::query_as(&format!(
            "select {CARD_COLUMNS} from knowledge_cards where workspace_id = $1 \
             order by position, created_at, id"
        ))
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list the knowledge cards"))?;
        records.into_iter().map(CardRecord::into_card).collect()
    }

    async fn card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError> {
        let ws = self.workspace_id();
        let record: Option<CardRecord> = sqlx::query_as(&format!(
            "select {CARD_COLUMNS} from knowledge_cards where workspace_id = $1 and id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read a knowledge card"))?;
        record.map(CardRecord::into_card).transpose()
    }

    async fn lock_card(&mut self, id: KnowledgeCardId) -> Result<Option<Card>, AppError> {
        let ws = self.workspace_id();
        let record: Option<CardRecord> = sqlx::query_as(&format!(
            "select {CARD_COLUMNS} from knowledge_cards where workspace_id = $1 and id = $2 \
             for update"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock a knowledge card"))?;
        record.map(CardRecord::into_card).transpose()
    }

    async fn insert_card(&mut self, card: &Card) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let (_, created_user, created_connection, created_component) =
            actor_columns(&card.created_by);
        let (_, updated_user, updated_connection, updated_component) =
            actor_columns(&card.updated_by);
        let done = sqlx::query(
            "insert into knowledge_cards (workspace_id, id, key, title, body, attachments, \
             position, revision, created_at, created_by_user, created_by_connection, \
             created_by_component, updated_at, updated_by_user, updated_by_connection, \
             updated_by_component, archived_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) \
             on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(card.id.as_uuid())
        .bind(card.key.as_deref())
        .bind(&card.title)
        .bind(&card.body)
        .bind(encode(&card.attachments, "the card's attachments")?)
        .bind(position(card)?)
        .bind(int(card.revision, "the card revision")?)
        .bind(card.created_at)
        .bind(created_user)
        .bind(created_connection)
        .bind(created_component)
        .bind(card.updated_at)
        .bind(updated_user)
        .bind(updated_connection)
        .bind(updated_component)
        .bind(card.archived_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store a knowledge card"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the card id or key is taken"));
        }
        Ok(())
    }

    async fn save_card(&mut self, card: &Card) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let (_, user, connection, component) = actor_columns(&card.updated_by);
        let done = sqlx::query(
            "update knowledge_cards set title = $3, body = $4, attachments = $5, position = $6, \
             revision = $7, updated_at = $8, updated_by_user = $9, updated_by_connection = $10, \
             updated_by_component = $11, archived_at = $12 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(card.id.as_uuid())
        .bind(&card.title)
        .bind(&card.body)
        .bind(encode(&card.attachments, "the card's attachments")?)
        .bind(position(card)?)
        .bind(int(card.revision, "the card revision")?)
        .bind(card.updated_at)
        .bind(user)
        .bind(connection)
        .bind(component)
        .bind(card.archived_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save a knowledge card"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such card"));
        }
        Ok(())
    }

    async fn append_revision(&mut self, r: &Revision) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let (_, user, connection, component) = actor_columns(&r.by);
        let done = sqlx::query(
            "insert into knowledge_revisions (workspace_id, id, subject, card_id, revision, \
             kb_revision, content, cause, source_id, at, by_user, by_connection, by_component) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(r.id.as_uuid())
        .bind(r.subject.key())
        .bind(r.card_id.map(|c| c.as_uuid()))
        .bind(int(r.revision, "the revision")?)
        .bind(int(r.kb_revision, "the knowledge revision")?)
        .bind(&r.content)
        .bind(r.cause.key())
        .bind(r.source_id)
        .bind(r.at)
        .bind(user)
        .bind(connection)
        .bind(component)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "append a knowledge revision"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the revision is already recorded"));
        }
        Ok(())
    }

    async fn revisions(
        &mut self,
        subject: Subject,
        card_id: Option<KnowledgeCardId>,
        before: Option<u64>,
        limit: u32,
    ) -> Result<Vec<Revision>, AppError> {
        let ws = self.workspace_id();
        let before = before.map(|b| int(b, "the cursor")).transpose()?;
        let records: Vec<RevisionRecord> = sqlx::query_as(&format!(
            "select {REVISION_COLUMNS} from knowledge_revisions where workspace_id = $1 \
             and subject = $2 and card_id is not distinct from $3 \
             and ($4::bigint is null or revision < $4) order by revision desc limit $5"
        ))
        .bind(ws.as_uuid())
        .bind(subject.key())
        .bind(card_id.map(|c| c.as_uuid()))
        .bind(before)
        .bind(i64::from(limit))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list knowledge revisions"))?;
        records
            .into_iter()
            .map(RevisionRecord::into_revision)
            .collect()
    }

    async fn notes(
        &mut self,
        status: Option<NoteStatus>,
        limit: u32,
    ) -> Result<Vec<Note>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<NoteRecord> = sqlx::query_as(&format!(
            "select {NOTE_COLUMNS} from knowledge_notes where workspace_id = $1 \
             and ($2::text is null or status = $2) order by created_at desc, id desc limit $3"
        ))
        .bind(ws.as_uuid())
        .bind(status.map(|s| s.key()))
        .bind(i64::from(limit))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list knowledge notes"))?;
        records.into_iter().map(NoteRecord::into_note).collect()
    }

    async fn note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError> {
        let ws = self.workspace_id();
        let record: Option<NoteRecord> = sqlx::query_as(&format!(
            "select {NOTE_COLUMNS} from knowledge_notes where workspace_id = $1 and id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read a knowledge note"))?;
        record.map(NoteRecord::into_note).transpose()
    }

    async fn lock_note(&mut self, id: KnowledgeNoteId) -> Result<Option<Note>, AppError> {
        let ws = self.workspace_id();
        let record: Option<NoteRecord> = sqlx::query_as(&format!(
            "select {NOTE_COLUMNS} from knowledge_notes where workspace_id = $1 and id = $2 \
             for update"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock a knowledge note"))?;
        record.map(NoteRecord::into_note).transpose()
    }

    async fn insert_note(&mut self, note: &Note) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "insert into knowledge_notes (workspace_id, id, text, links, file_ids, status, claim, \
             revision, created_at, created_by_user, closed_at, closed_by_user, \
             closed_by_connection, outcome) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
             on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(note.id.as_uuid())
        .bind(&note.text)
        .bind(encode(&note.links, "the note's links")?)
        .bind(encode(&note.file_ids, "the note's files")?)
        .bind(note.status.key())
        .bind(
            note.claim
                .as_ref()
                .map(|c| encode(c, "the note's claim"))
                .transpose()?,
        )
        .bind(int(note.revision, "the note revision")?)
        .bind(note.created_at)
        .bind(note.created_by.as_uuid())
        .bind(note.closed_at)
        .bind(note.closed_by_user.map(|u| u.as_uuid()))
        .bind(note.closed_by_connection.map(|c| c.as_uuid()))
        .bind(
            note.outcome
                .as_ref()
                .map(|o| encode(o, "the note's outcome"))
                .transpose()?,
        )
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store a knowledge note"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the note id is taken"));
        }
        Ok(())
    }

    async fn save_note(&mut self, note: &Note) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update knowledge_notes set status = $3, claim = $4, revision = $5, closed_at = $6, \
             closed_by_user = $7, closed_by_connection = $8, outcome = $9 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(note.id.as_uuid())
        .bind(note.status.key())
        .bind(
            note.claim
                .as_ref()
                .map(|c| encode(c, "the note's claim"))
                .transpose()?,
        )
        .bind(int(note.revision, "the note revision")?)
        .bind(note.closed_at)
        .bind(note.closed_by_user.map(|u| u.as_uuid()))
        .bind(note.closed_by_connection.map(|c| c.as_uuid()))
        .bind(
            note.outcome
                .as_ref()
                .map(|o| encode(o, "the note's outcome"))
                .transpose()?,
        )
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save a knowledge note"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such note"));
        }
        Ok(())
    }

    async fn proposals(
        &mut self,
        status: Option<ProposalStatus>,
    ) -> Result<Vec<Proposal>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<ProposalRecord> = sqlx::query_as(&format!(
            "select {PROPOSAL_COLUMNS} from knowledge_proposals where workspace_id = $1 \
             and ($2::text is null or status = $2) order by proposed_at desc, id desc"
        ))
        .bind(ws.as_uuid())
        .bind(status.map(|s| s.key()))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list knowledge proposals"))?;
        records
            .into_iter()
            .map(ProposalRecord::into_proposal)
            .collect()
    }

    async fn proposal(&mut self, id: KnowledgeProposalId) -> Result<Option<Proposal>, AppError> {
        let ws = self.workspace_id();
        let record: Option<ProposalRecord> = sqlx::query_as(&format!(
            "select {PROPOSAL_COLUMNS} from knowledge_proposals where workspace_id = $1 \
             and id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read a knowledge proposal"))?;
        record.map(ProposalRecord::into_proposal).transpose()
    }

    async fn lock_proposal(
        &mut self,
        id: KnowledgeProposalId,
    ) -> Result<Option<Proposal>, AppError> {
        let ws = self.workspace_id();
        let record: Option<ProposalRecord> = sqlx::query_as(&format!(
            "select {PROPOSAL_COLUMNS} from knowledge_proposals where workspace_id = $1 \
             and id = $2 for update"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock a knowledge proposal"))?;
        record.map(ProposalRecord::into_proposal).transpose()
    }

    async fn insert_proposal(&mut self, p: &Proposal) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let (connection, component) = proposer_columns(&p.proposed_by);
        let done = sqlx::query(
            "insert into knowledge_proposals (workspace_id, id, kind, card_id, title, body, \
             reason, status, base_revision, proposed_at, proposed_by_connection, \
             proposed_by_component, expires_at, decided_at, decided_by_user, applied_revision) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) \
             on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(p.id.as_uuid())
        .bind(p.kind.key())
        .bind(p.card_id.map(|c| c.as_uuid()))
        .bind(p.title.as_deref())
        .bind(&p.body)
        .bind(&p.reason)
        .bind(p.status.key())
        .bind(
            p.base_revision
                .map(|n| int(n, "the base revision"))
                .transpose()?,
        )
        .bind(p.proposed_at)
        .bind(connection)
        .bind(component)
        .bind(p.expires_at)
        .bind(p.decided_at)
        .bind(p.decided_by.map(|u| u.as_uuid()))
        .bind(
            p.applied_revision
                .map(|n| int(n, "the applied revision"))
                .transpose()?,
        )
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store a knowledge proposal"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the proposal id is taken, or the same proposal is pending",
            ));
        }
        Ok(())
    }

    async fn save_proposal(&mut self, p: &Proposal) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update knowledge_proposals set status = $3, decided_at = $4, decided_by_user = $5, \
             applied_revision = $6 where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(p.id.as_uuid())
        .bind(p.status.key())
        .bind(p.decided_at)
        .bind(p.decided_by.map(|u| u.as_uuid()))
        .bind(
            p.applied_revision
                .map(|n| int(n, "the applied revision"))
                .transpose()?,
        )
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save a knowledge proposal"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such proposal"));
        }
        Ok(())
    }

    async fn proposals_by(
        &mut self,
        connection: AgentConnectionId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from knowledge_proposals where workspace_id = $1 \
             and proposed_by_connection = $2 and proposed_at >= $3",
        )
        .bind(ws.as_uuid())
        .bind(connection.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count an agent's knowledge proposals"))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn expire_proposals(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update knowledge_proposals set status = 'expired', decided_at = $2 \
             where workspace_id = $1 and status = 'pending' and expires_at <= $2",
        )
        .bind(ws.as_uuid())
        .bind(now)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "expire knowledge proposals"))?;
        Ok(done.rows_affected())
    }
}
