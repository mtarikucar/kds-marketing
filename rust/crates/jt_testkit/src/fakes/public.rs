//! Public items, their subjects and the polled surfaces' cursors (migration 0019) in memory,
//! mirroring PostgreSQL's keys, references, checks and orders: an external id of 1 to 512
//! characters, a subject's title, links and facts within bounds, and an item's conversation and
//! subject on its own capability (the composite foreign keys), each broken one `INTERNAL` as the
//! database's check or key violation is. Writes are buffered and replayed by key on commit, like
//! every inbox fake.

use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::*};
use jt_capability::CapabilityId;
use jt_inbox::public::{
    MAX_EXTERNAL_ID_CHARS, MAX_SUBJECT_IMAGE_URL_CHARS, MAX_SUBJECT_TITLE_CHARS,
    MAX_SUBJECT_URL_CHARS,
};
use jt_inbox::*;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, same_workspace, unique};
use super::tenant::MemTenant;

/// One capability's poll cursor.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCursor {
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub cursor: Value,
    pub updated_at: OffsetDateTime,
}

fn found(ok: bool, what: &str) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::not_found(format!("no such {what}")))
    }
}
/// A check or key the database enforces, broken: `INTERNAL`, as `jt_pg` answers it.
fn checked(ok: bool, what: &str) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "public inbox row breaks {what}"
        )))
    }
}
fn chars_within(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.chars().count())
}
fn capability(s: &MemState, ws: WorkspaceId, id: CapabilityId) -> Result<(), AppError> {
    found(
        s.capabilities
            .iter()
            .any(|r| r.capability.workspace_id == ws && r.capability.id == id),
        "capability",
    )
}
fn message(s: &MemState, ws: WorkspaceId, id: MessageId) -> Result<(), AppError> {
    found(
        s.inbox
            .messages
            .iter()
            .any(|r| r.workspace_id == ws && r.id == id),
        "message",
    )
}
/// The workspace's message and subject references of `item`, as `jt_pg` checks them, and its
/// subject on its capability (the composite foreign key).
fn references(s: &MemState, ws: WorkspaceId, item: &PublicItem) -> Result<(), AppError> {
    message(s, ws, item.message_id)?;
    if let Some(subject) = item.subject_id {
        let stored = s
            .inbox
            .public_subjects
            .iter()
            .find(|r| r.workspace_id == ws && r.id == subject);
        found(stored.is_some(), "public subject")?;
        checked(
            stored.is_some_and(|r| r.capability_id == item.capability_id),
            "the subject's capability key",
        )?;
    }
    if let Some(private) = item.private_reply_message_id {
        message(s, ws, private)?;
    }
    Ok(())
}
/// The answer states the deadline and reconciliation indexes of 0019 hold.
fn open_or_pending(item: &PublicItem) -> bool {
    matches!(
        item.answer,
        AnswerState::Awaiting | AnswerState::Rejected { .. } | AnswerState::Pending { .. }
    )
}
/// A known subject refreshed by a new write of it: its id, its first sighting and a publication
/// link the write does not name are kept.
fn refreshed(known: &PublicSubject, new: &PublicSubject) -> PublicSubject {
    PublicSubject {
        kind: new.kind,
        title: new.title.clone(),
        url: new.url.clone(),
        image_url: new.image_url.clone(),
        facts: new.facts.clone(),
        publication_id: new.publication_id.or(known.publication_id),
        updated_at: new.updated_at,
        ..known.clone()
    }
}
fn page(limit: u32) -> usize {
    limit.clamp(1, MAX_INBOX_PAGE) as usize
}

impl MemTenant {
    fn public_items_of(&self, keep: impl Fn(&PublicItem) -> bool) -> Vec<PublicItem> {
        self.state()
            .inbox
            .public_items
            .iter()
            .filter(|r| r.workspace_id == self.ws && keep(r))
            .cloned()
            .collect()
    }
}

#[async_trait]
impl PublicItemRepo for MemTenant {
    async fn insert(&mut self, item: PublicItem) -> Result<bool, AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, item.workspace_id)?;
            let s = t.state();
            capability(s, ws, item.capability_id)?;
            let conversation = s
                .inbox
                .conversations
                .iter()
                .find(|r| r.workspace_id == ws && r.id == item.conversation_id);
            found(conversation.is_some(), "conversation")?;
            references(s, ws, &item)?;
            checked(
                chars_within(&item.external_id, 1, MAX_EXTERNAL_ID_CHARS),
                "the external id's length",
            )?;
            checked(
                conversation.is_some_and(|r| r.capability_id == item.capability_id),
                "the conversation's capability key",
            )?;
            let replay = move |s: &MemState, item: &PublicItem| {
                s.inbox.public_items.iter().any(|r| {
                    r.workspace_id == ws
                        && r.capability_id == item.capability_id
                        && r.external_id == item.external_id
                })
            };
            if replay(s, &item) {
                return Ok(false);
            }
            unique(
                !s.inbox.public_items.iter().any(|r| r.id == item.id),
                "public item id is taken",
            )?;
            t.tx.write(move |s| {
                if !replay(s, &item) {
                    s.inbox.public_items.push(item.clone());
                }
            });
            Ok(true)
        })
    }
    async fn get(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError> {
        Ok(self.public_items_of(|r| r.id == id).pop())
    }
    async fn lock(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError> {
        PublicItemRepo::get(self, id).await
    }
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicItem>, AppError> {
        Ok(self
            .public_items_of(|r| r.capability_id == capability && r.external_id == external_id)
            .pop())
    }
    async fn item_for_message(
        &mut self,
        message: MessageId,
    ) -> Result<Option<PublicItem>, AppError> {
        let mut rows = self.public_items_of(|r| r.message_id == message);
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows.into_iter().next())
    }
    async fn update(&mut self, item: PublicItem) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, item.workspace_id)?;
            found(
                t.state()
                    .inbox
                    .public_items
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == item.id),
                "public item",
            )?;
            references(t.state(), ws, &item)?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .public_items
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == item.id)
                {
                    r.message_id = item.message_id;
                    r.subject_id = item.subject_id;
                    r.deadline = item.deadline;
                    r.private_reply_until = item.private_reply_until;
                    r.answer = item.answer.clone();
                    r.moderation = item.moderation;
                    r.private_reply_message_id = item.private_reply_message_id;
                    r.agent_answers = item.agent_answers;
                    r.checked_at = item.checked_at;
                    r.updated_at = item.updated_at;
                }
            });
            Ok(())
        })
    }
    async fn for_conversation(
        &mut self,
        conversation: ConversationId,
    ) -> Result<Vec<PublicItem>, AppError> {
        let mut rows = self.public_items_of(|r| r.conversation_id == conversation);
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows)
    }
    async fn thread(
        &mut self,
        capability: CapabilityId,
        root_external_id: &str,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        let mut rows = self.public_items_of(|r| {
            r.capability_id == capability && r.root_external_id == root_external_id
        });
        rows.sort_by_key(|r| (r.created_at, r.id));
        rows.truncate(page(limit));
        Ok(rows)
    }
    async fn due_before(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        let mut rows = self.public_items_of(|r| {
            r.deadline.is_some_and(|deadline| deadline < before) && open_or_pending(r)
        });
        rows.sort_by_key(|r| (r.deadline, r.id));
        rows.truncate(page(limit));
        Ok(rows)
    }
    async fn to_reconcile(
        &mut self,
        capability: CapabilityId,
        limit: u32,
    ) -> Result<Vec<PublicItem>, AppError> {
        let mut rows =
            self.public_items_of(|r| r.capability_id == capability && open_or_pending(r));
        // `checked_at nulls first, id`.
        rows.sort_by_key(|r| (r.checked_at.is_some(), r.checked_at, r.id));
        rows.truncate(page(limit));
        Ok(rows)
    }
    async fn mark_checked(
        &mut self,
        ids: &[PublicItemId],
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let (ws, ids) = (self.ws, ids.to_vec());
        self.tx.write(move |s| {
            for r in s
                .inbox
                .public_items
                .iter_mut()
                .filter(|r| r.workspace_id == ws && ids.contains(&r.id))
            {
                r.checked_at = Some(at);
            }
        });
        Ok(())
    }
}

#[async_trait]
impl PublicSubjectRepo for MemTenant {
    async fn upsert(&mut self, subject: PublicSubject) -> Result<PublicSubject, AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, subject.workspace_id)?;
            let s = t.state();
            capability(s, ws, subject.capability_id)?;
            if let Some(publication) = subject.publication_id {
                found(
                    s.studio
                        .publications
                        .iter()
                        .any(|p| p.chain.workspace_id == ws && p.id.as_uuid() == publication),
                    "studio publication",
                )?;
            }
            checked(
                chars_within(&subject.external_id, 1, MAX_EXTERNAL_ID_CHARS),
                "the external id's length",
            )?;
            checked(
                subject.title.chars().count() <= MAX_SUBJECT_TITLE_CHARS,
                "the title's length",
            )?;
            checked(
                subject
                    .url
                    .as_deref()
                    .is_none_or(|u| u.chars().count() <= MAX_SUBJECT_URL_CHARS),
                "the url's length",
            )?;
            checked(
                subject
                    .image_url
                    .as_deref()
                    .is_none_or(|u| u.chars().count() <= MAX_SUBJECT_IMAGE_URL_CHARS),
                "the image url's length",
            )?;
            checked(subject.facts.is_object(), "facts being an object")?;
            let same = move |r: &PublicSubject, subject: &PublicSubject| {
                r.workspace_id == ws
                    && r.capability_id == subject.capability_id
                    && r.external_id == subject.external_id
            };
            let stored = match s.inbox.public_subjects.iter().find(|r| same(r, &subject)) {
                Some(r) => refreshed(r, &subject),
                None => subject.clone(),
            };
            t.tx.write(move |s| {
                match s
                    .inbox
                    .public_subjects
                    .iter_mut()
                    .find(|r| same(r, &subject))
                {
                    Some(r) => *r = refreshed(r, &subject),
                    None => s.inbox.public_subjects.push(subject.clone()),
                }
            });
            Ok(stored)
        })
    }
    async fn get(&mut self, id: PublicSubjectId) -> Result<Option<PublicSubject>, AppError> {
        Ok(self
            .state()
            .inbox
            .public_subjects
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn find_by_external(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<PublicSubject>, AppError> {
        Ok(self
            .state()
            .inbox
            .public_subjects
            .iter()
            .find(|r| {
                r.workspace_id == self.ws
                    && r.capability_id == capability
                    && r.external_id == external_id
            })
            .cloned())
    }
}

#[async_trait]
impl PublicCursorRepo for MemTenant {
    async fn get(&mut self, capability: CapabilityId) -> Result<Option<Value>, AppError> {
        Ok(self
            .state()
            .inbox
            .public_cursors
            .iter()
            .find(|r| r.workspace_id == self.ws && r.capability_id == capability)
            .map(|r| r.cursor.clone()))
    }
    async fn store(
        &mut self,
        capability_id: CapabilityId,
        cursor: Value,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !cursor.is_object() {
                return Err(AppError::internal("a public cursor is a JSON object"));
            }
            capability(t.state(), ws, capability_id)?;
            t.tx.write(move |s| {
                let row = StoredCursor {
                    workspace_id: ws,
                    capability_id,
                    cursor: cursor.clone(),
                    updated_at: at,
                };
                match s
                    .inbox
                    .public_cursors
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.capability_id == capability_id)
                {
                    Some(r) => *r = row,
                    None => s.inbox.public_cursors.push(row),
                }
            });
            Ok(())
        })
    }
}
