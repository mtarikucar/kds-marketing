//! The in-memory chat media, with the constraints migration `0055_message_media` enforces: a row
//! keeps the rules of `jt_app::ports::message_media` (`media_row_valid`), names a message and a
//! capability of the bundle's workspace only, holds one position of its message, and its id is
//! unique. Locks are not modelled: races are tested on PostgreSQL.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::message_media::{
    ErasedFiles, MAX_MEDIA_PAGE, MediaDirection, MediaReason, MediaSource, MediaState,
    MessageMediaRepo, MessageMediaRow, media_row_valid,
};
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::{MemBundle, MemState, unique};
use super::tenant::MemTenant;

impl MemTenant {
    fn media_rows(&self) -> impl Iterator<Item = &MessageMediaRow> {
        let ws = self.ws;
        self.state()
            .message_media
            .iter()
            .filter(move |(w, _)| *w == ws)
            .map(|(_, r)| r)
    }

    fn media_row(&self, id: Uuid) -> Option<MessageMediaRow> {
        self.media_rows().find(|r| r.id == id).cloned()
    }

    /// Checks a row's references in the bundle's workspace, as the composite foreign keys do.
    fn check_media_refs(&self, row: &MessageMediaRow) -> Result<(), AppError> {
        let s = self.state();
        let ws = self.ws;
        let ok = s
            .capabilities
            .iter()
            .any(|x| x.capability.id == row.capability_id && x.capability.workspace_id == ws)
            && s.inbox
                .messages
                .iter()
                .any(|x| x.id == row.message_id && x.workspace_id == ws);
        if ok {
            Ok(())
        } else {
            Err(AppError::internal(
                "message_media references a row that does not exist",
            ))
        }
    }

    /// The workspace's people merged into `person`, transitively, and `person`.
    fn media_family(&self, person: PersonId) -> BTreeSet<PersonId> {
        let mut family = BTreeSet::from([person]);
        loop {
            let more: Vec<PersonId> = self
                .state()
                .inbox
                .people
                .iter()
                .filter(|p| {
                    p.workspace_id == self.ws
                        && p.merged_into.is_some_and(|m| family.contains(&m))
                        && !family.contains(&p.id)
                })
                .map(|p| p.id)
                .collect();
            if more.is_empty() {
                return family;
            }
            family.extend(more);
        }
    }
}

#[async_trait]
impl MessageMediaRepo for MemTenant {
    async fn insert_if_new(&mut self, row: &MessageMediaRow) -> Result<bool, AppError> {
        let row = row.clone();
        self.call(|t| {
            if !media_row_valid(&row) {
                return Err(AppError::internal("invalid message media row"));
            }
            t.check_media_refs(&row)?;
            if t.media_rows()
                .any(|r| r.message_id == row.message_id && r.position == row.position)
            {
                return Ok(false);
            }
            unique(
                !t.state().message_media.iter().any(|(_, r)| r.id == row.id),
                "message media id is already taken",
            )?;
            let ws = t.ws;
            t.tx.write(move |s: &mut MemState| s.message_media.push((ws, row.clone())));
            Ok(true)
        })
    }

    async fn get(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError> {
        Ok(self.media_row(id))
    }

    async fn lock(&mut self, id: Uuid) -> Result<Option<MessageMediaRow>, AppError> {
        Ok(self.media_row(id))
    }

    async fn save(&mut self, row: &MessageMediaRow) -> Result<(), AppError> {
        let row = row.clone();
        self.call(|t| {
            if !media_row_valid(&row) {
                return Err(AppError::internal("invalid message media row"));
            }
            let Some(old) = t.media_row(row.id) else {
                return Err(AppError::not_found("no such message media"));
            };
            let ws = t.ws;
            t.tx.write(move |s: &mut MemState| {
                for (w, r) in s.message_media.iter_mut() {
                    if *w == ws && r.id == row.id {
                        // What a save leaves as it was.
                        *r = MessageMediaRow {
                            message_id: old.message_id,
                            position: old.position,
                            capability_id: old.capability_id,
                            direction: old.direction,
                            kind: old.kind,
                            source: old.source,
                            material_id: old.material_id,
                            created_at: old.created_at,
                            ..row.clone()
                        };
                    }
                }
            });
            Ok(())
        })
    }

    async fn for_messages(
        &mut self,
        messages: &[MessageId],
    ) -> Result<Vec<MessageMediaRow>, AppError> {
        let mut rows: Vec<MessageMediaRow> = self
            .media_rows()
            .filter(|r| messages.contains(&r.message_id))
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.message_id, r.position));
        Ok(rows)
    }

    async fn due(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<Uuid>, AppError> {
        let mut rows: Vec<&MessageMediaRow> = self
            .media_rows()
            .filter(|r| {
                r.state == MediaState::Pending && r.next_attempt_at.is_none_or(|at| at <= now)
            })
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows
            .into_iter()
            .take(limit.min(MAX_MEDIA_PAGE) as usize)
            .map(|r| r.id)
            .collect())
    }

    async fn due_for_purge(
        &mut self,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MessageMediaRow>, AppError> {
        let mut rows: Vec<MessageMediaRow> = self
            .media_rows()
            .filter(|r| {
                r.state == MediaState::Stored
                    && r.direction == MediaDirection::Inbound
                    && r.stored_at.is_some_and(|at| at <= before)
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.stored_at, r.id));
        rows.truncate(limit.min(MAX_MEDIA_PAGE) as usize);
        Ok(rows)
    }

    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError> {
        Ok(self
            .media_rows()
            .filter(|r| {
                r.direction == MediaDirection::Inbound && r.stored_at.is_some_and(|at| at >= since)
            })
            .filter_map(|r| r.size_bytes)
            .sum())
    }

    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<ErasedFiles, AppError> {
        let family = self.media_family(person);
        let conversations: BTreeSet<_> = self
            .state()
            .inbox
            .conversations
            .iter()
            .filter(|c| c.workspace_id == self.ws && family.contains(&c.person_id))
            .map(|c| c.id)
            .collect();
        let messages: BTreeSet<MessageId> = self
            .state()
            .inbox
            .messages
            .iter()
            .filter(|m| m.workspace_id == self.ws && conversations.contains(&m.conversation_id))
            .map(|m| m.id)
            .collect();
        let customer: Vec<FileId> = self
            .media_rows()
            .filter(|r| messages.contains(&r.message_id) && r.owns_bytes())
            .filter_map(|r| r.file_id)
            .collect();
        let mut uploads: Vec<FileId> = Vec::new();
        for r in self.media_rows().filter(|r| {
            messages.contains(&r.message_id)
                && r.state == MediaState::Stored
                && r.source == MediaSource::Upload
        }) {
            let Some(file) = r.file_id else { continue };
            let shared = self.media_rows().any(|o| {
                o.file_id == Some(file)
                    && o.state == MediaState::Stored
                    && !messages.contains(&o.message_id)
            });
            if !shared && !uploads.contains(&file) {
                uploads.push(file);
            }
        }
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            for (w, r) in s.message_media.iter_mut() {
                if *w != ws || !messages.contains(&r.message_id) {
                    continue;
                }
                r.filename = String::new();
                r.provider_media_id = None;
                r.next_attempt_at = None;
                if r.state != MediaState::Deleted {
                    r.state = MediaState::Deleted;
                    r.reason = Some(MediaReason::Erased);
                    r.deleted_at = Some(at);
                    r.file_id = None;
                    r.mime = None;
                    r.sha256 = None;
                    r.stored_at = None;
                }
            }
        });
        Ok(ErasedFiles { customer, uploads })
    }

    async fn kept(&mut self, ids: &[FileId]) -> Result<Vec<FileId>, AppError> {
        let mut found: Vec<FileId> = self
            .media_rows()
            .filter(|r| r.state == MediaState::Stored)
            .filter_map(|r| r.file_id)
            .filter(|f| ids.contains(f))
            .collect();
        found.sort();
        found.dedup();
        Ok(found)
    }
}

/// The rows of workspace `ws` in `state`, for tests.
pub fn media_of(state: &MemState, ws: WorkspaceId) -> Vec<MessageMediaRow> {
    state
        .message_media
        .iter()
        .filter(|(w, _)| *w == ws)
        .map(|(_, r)| r.clone())
        .collect()
}
