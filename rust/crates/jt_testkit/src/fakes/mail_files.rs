//! The in-memory mail files, with the constraints migration `0028_mail_files` enforces: a row
//! keeps the rules of `jt_app::ports::mail_files` (`mail_file_row_valid`), names a capability, a
//! message and a person of the bundle's workspace only, and its id is unique. Locks are not
//! modelled: races are tested on PostgreSQL.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::mail_files::{
    MAX_MAIL_FILE_PAGE, MailFileDirection, MailFileRepo, MailFileRow, MailFileState,
    mail_file_row_valid,
};
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, unique};
use super::tenant::MemTenant;

/// The mail files' table, as the fake stores it.
#[derive(Clone, Debug, Default)]
pub struct MemMailFiles {
    pub rows: Vec<(WorkspaceId, MailFileRow)>,
}

impl MemTenant {
    fn mail_rows(&self) -> impl Iterator<Item = &MailFileRow> {
        let ws = self.ws;
        self.state()
            .mail_files
            .rows
            .iter()
            .filter(move |(w, _)| *w == ws)
            .map(|(_, r)| r)
    }

    fn mail_row(&self, id: FileId) -> Option<MailFileRow> {
        self.mail_rows().find(|r| r.id == id).cloned()
    }

    /// The workspace's people merged into `person`, transitively, and `person`.
    fn family(&self, person: PersonId) -> BTreeSet<PersonId> {
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

    /// Checks a row's references in the bundle's workspace, as the composite foreign keys do.
    fn check_mail_refs(&self, row: &MailFileRow) -> Result<(), AppError> {
        let s = self.state();
        let ws = self.ws;
        let refs_ok = row.capability_id.is_none_or(|c| {
            s.capabilities
                .iter()
                .any(|x| x.capability.id == c && x.capability.workspace_id == ws)
        }) && row.message_id.is_none_or(|m| {
            s.inbox
                .messages
                .iter()
                .any(|x| x.id == m && x.workspace_id == ws)
        }) && row.person_id.is_none_or(|p| {
            s.inbox
                .people
                .iter()
                .any(|x| x.id == p && x.workspace_id == ws)
        });
        if refs_ok {
            Ok(())
        } else {
            Err(AppError::internal(
                "mail_files references a row that does not exist",
            ))
        }
    }

    /// Applies `change` to each row of the workspace `pick` chooses, here and on commit.
    fn change_mail(
        &mut self,
        pick: impl Fn(&MailFileRow) -> bool + Send + Sync + 'static,
        change: impl Fn(&mut MailFileRow) + Send + Sync + 'static,
    ) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            for (w, r) in s.mail_files.rows.iter_mut() {
                if *w == ws && pick(r) {
                    change(r);
                }
            }
        });
    }

    /// Erases the rows `pick` chooses (names blanked, bytes-holding rows deleted at `at`), and
    /// answers the ids whose bytes go.
    fn erase_mail(
        &mut self,
        pick: impl Fn(&MailFileRow) -> bool + Send + Sync + 'static,
        at: OffsetDateTime,
    ) -> Vec<FileId> {
        let gone: Vec<FileId> = self
            .mail_rows()
            .filter(|r| pick(r) && r.state.holds_bytes())
            .map(|r| r.id)
            .collect();
        self.change_mail(pick, move |r| {
            r.filename = String::new();
            if r.state.holds_bytes() {
                r.state = MailFileState::Deleted;
                r.deleted_at = Some(at);
            }
        });
        gone
    }
}

#[async_trait]
impl MailFileRepo for MemTenant {
    async fn insert(&mut self, row: MailFileRow) -> Result<(), AppError> {
        self.call(|t| {
            if !mail_file_row_valid(&row) {
                return Err(AppError::internal("invalid mail file row"));
            }
            t.check_mail_refs(&row)?;
            unique(
                !t.state()
                    .mail_files
                    .rows
                    .iter()
                    .any(|(_, r)| r.id == row.id),
                "mail file id is already taken",
            )?;
            let ws = t.ws;
            t.tx.write(move |s: &mut MemState| s.mail_files.rows.push((ws, row.clone())));
            Ok(())
        })
    }

    async fn get(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError> {
        Ok(self.mail_row(id))
    }

    async fn lock(&mut self, id: FileId) -> Result<Option<MailFileRow>, AppError> {
        Ok(self.mail_row(id))
    }

    async fn link_event_to_message(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError> {
        let external = event_external_id.to_owned();
        let pick = move |r: &MailFileRow| {
            r.direction == MailFileDirection::Inbound
                && r.capability_id == Some(capability)
                && r.event_external_id.as_deref() == Some(external.as_str())
                && r.message_id.is_none()
        };
        let probe = MailFileRow {
            message_id: Some(message),
            person_id: Some(person),
            ..placeholder()
        };
        self.call(|t| t.check_mail_refs(&probe))?;
        let n = self.mail_rows().filter(|r| pick(r)).count();
        self.change_mail(pick, move |r| {
            r.message_id = Some(message);
            r.person_id = Some(person);
        });
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn attach(
        &mut self,
        ids: &[FileId],
        message: MessageId,
        person: PersonId,
    ) -> Result<u32, AppError> {
        let ids: BTreeSet<FileId> = ids.iter().copied().collect();
        let probe = MailFileRow {
            message_id: Some(message),
            person_id: Some(person),
            ..placeholder()
        };
        self.call(|t| t.check_mail_refs(&probe))?;
        let pick = move |r: &MailFileRow| ids.contains(&r.id) && r.state == MailFileState::Staged;
        let n = self.mail_rows().filter(|r| pick(r)).count();
        self.change_mail(pick, move |r| {
            r.state = MailFileState::Attached;
            r.message_id = Some(message);
            r.person_id = Some(person);
            r.expires_at = None;
        });
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn for_messages(&mut self, messages: &[MessageId]) -> Result<Vec<MailFileRow>, AppError> {
        let mut rows: Vec<MailFileRow> = self
            .mail_rows()
            .filter(|r| r.message_id.is_some_and(|m| messages.contains(&m)))
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows)
    }

    async fn due_for_purge(
        &mut self,
        inbound_before: OffsetDateTime,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<MailFileRow>, AppError> {
        let mut rows: Vec<MailFileRow> = self
            .mail_rows()
            .filter(|r| {
                (r.direction == MailFileDirection::Inbound
                    && r.state == MailFileState::Stored
                    && r.created_at <= inbound_before)
                    || (r.state == MailFileState::Staged && r.expires_at.is_some_and(|e| e <= now))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        rows.truncate(limit.min(MAX_MAIL_FILE_PAGE) as usize);
        Ok(rows)
    }

    async fn mark_deleted(&mut self, ids: &[FileId], at: OffsetDateTime) -> Result<u32, AppError> {
        let ids: BTreeSet<FileId> = ids.iter().copied().collect();
        let pick = move |r: &MailFileRow| ids.contains(&r.id) && r.state.holds_bytes();
        let n = self.mail_rows().filter(|r| pick(r)).count();
        self.change_mail(pick, move |r| {
            r.state = MailFileState::Deleted;
            r.deleted_at = Some(at);
        });
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn erase_person(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        let family = self.family(person);
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
        let pick = move |r: &MailFileRow| {
            r.person_id.is_some_and(|p| family.contains(&p))
                || r.message_id.is_some_and(|m| messages.contains(&m))
        };
        Ok(self.erase_mail(pick, at))
    }

    async fn erase_event(
        &mut self,
        capability: CapabilityId,
        event_external_id: &str,
        at: OffsetDateTime,
    ) -> Result<Vec<FileId>, AppError> {
        let external = event_external_id.to_owned();
        let pick = move |r: &MailFileRow| {
            r.direction == MailFileDirection::Inbound
                && r.capability_id == Some(capability)
                && r.event_external_id.as_deref() == Some(external.as_str())
        };
        Ok(self.erase_mail(pick, at))
    }

    async fn kept(&mut self, ids: &[FileId]) -> Result<Vec<FileId>, AppError> {
        Ok(self
            .mail_rows()
            .filter(|r| ids.contains(&r.id) && r.state.holds_bytes())
            .map(|r| r.id)
            .collect())
    }

    async fn inbound_bytes_since(&mut self, since: OffsetDateTime) -> Result<u64, AppError> {
        Ok(self
            .mail_rows()
            .filter(|r| {
                r.direction == MailFileDirection::Inbound
                    && r.sha256.is_some()
                    && r.created_at >= since
            })
            .map(|r| r.size_bytes)
            .sum())
    }
}

/// A row naming nothing, for checking a message's and a person's references alone.
fn placeholder() -> MailFileRow {
    MailFileRow {
        id: FileId(uuid::Uuid::nil()),
        direction: MailFileDirection::Outbound,
        state: MailFileState::Deleted,
        skip_reason: None,
        capability_id: None,
        event_external_id: None,
        message_id: None,
        person_id: None,
        filename: String::new(),
        declared_mime: String::new(),
        size_bytes: 0,
        sha256: None,
        created_at: OffsetDateTime::UNIX_EPOCH,
        expires_at: None,
        deleted_at: Some(OffsetDateTime::UNIX_EPOCH),
    }
}
