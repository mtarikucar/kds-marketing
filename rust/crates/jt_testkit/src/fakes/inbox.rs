//! Inbox fakes mirror PostgreSQL constraints and replay buffered writes only on commit.
//! As with the other fakes, concurrent uniqueness/locking contracts are tested on PostgreSQL.
use super::state::{MemBundle, MemState, exists, same_workspace, unique};
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::ports::connectors::MailboxCursor;
use jt_app::{error::AppError, ports::inbox::*};
use jt_capability::CapabilityId;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// Upgrade exception shared by claim and traversal; every other consumption remains final.
pub(super) fn deferred_leadgen(
    consumer: &str,
    event: &InboundEvent,
    outcome: Option<&ConsumptionOutcome>,
) -> bool {
    consumer == "inbox@2"
        && event.provider == Provider::Meta
        && event.kind == EventKind::LeadGen
        && outcome.is_some_and(|o| o.outcome == "deferred")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredConsumption {
    pub workspace_id: WorkspaceId,
    pub consumer: String,
    pub event_id: InboundEventId,
    pub outcome: Option<ConsumptionOutcome>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct StoredRequestKey {
    pub workspace_id: WorkspaceId,
    pub key: String,
    pub response: Value,
    pub at: OffsetDateTime,
}
#[derive(Clone, Debug, Default)]
pub struct MemInbox {
    pub consents: Vec<(WorkspaceId, Consent)>,
    pub suppressions: Vec<(WorkspaceId, Suppression)>,
    pub quotes: Vec<QuoteRow>,
    pub appointments: Vec<AppointmentRow>,
    pub commissions: Vec<CommissionRow>,
    pub commission_defaults: Vec<(WorkspaceId, u16)>,
    pub commission_user_rates: Vec<(WorkspaceId, UserId, u16)>,
    pub erasure_logs: Vec<ErasureLog>,
    pub erased_identities: Vec<(WorkspaceId, IdentityChannel, String)>,
    pub mail_cursors: Vec<(WorkspaceId, CapabilityId, MailboxCursor)>,
    pub attribution: Vec<JourneyAttribution>,
    pub journey_reducer_revisions: std::collections::BTreeMap<JourneyId, i64>,
    pub conversation_send_states: std::collections::BTreeMap<ConversationId, ConversationSendState>,
    pub message_senders: std::collections::BTreeMap<MessageId, IdentityId>,
    pub people: Vec<Person>,
    pub identities: Vec<Identity>,
    pub conversations: Vec<Conversation>,
    pub messages: Vec<Message>,
    pub journeys: Vec<Journey>,
    pub events: Vec<JourneyEvent>,
    pub tasks: Vec<Task>,
    pub notes: Vec<Note>,
    pub merges: Vec<MergeRow>,
    pub lost_reasons: Vec<LostReasonRow>,
    pub consumption: Vec<StoredConsumption>,
    pub request_keys: Vec<StoredRequestKey>,
    pub outbox: Vec<OutboxRow>,
}

pub(super) fn initialize_defaults(state: &mut MemInbox, ws: WorkspaceId) {
    for (key, label) in LOST_REASON_DEFAULTS {
        if !state
            .lost_reasons
            .iter()
            .any(|r| r.workspace_id == ws && r.key == *key)
        {
            state.lost_reasons.push(LostReasonRow {
                workspace_id: ws,
                key: (*key).into(),
                label: (*label).into(),
                active: true,
                seeded: true,
            });
        }
    }
}
fn found(ok: bool) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::not_found("no such inbox reference"))
    }
}
pub(super) fn person(s: &MemState, ws: WorkspaceId, id: PersonId) -> Result<(), AppError> {
    found(
        s.inbox
            .people
            .iter()
            .any(|r| r.workspace_id == ws && r.id == id),
    )
}
pub(super) fn journey(s: &MemState, ws: WorkspaceId, id: JourneyId) -> Result<(), AppError> {
    found(
        s.inbox
            .journeys
            .iter()
            .any(|r| r.workspace_id == ws && r.id == id),
    )
}
fn conversation(s: &MemState, ws: WorkspaceId, id: ConversationId) -> Result<(), AppError> {
    found(
        s.inbox
            .conversations
            .iter()
            .any(|r| r.workspace_id == ws && r.id == id),
    )
}
fn capability(s: &MemState, ws: WorkspaceId, id: CapabilityId) -> Result<(), AppError> {
    found(
        s.capabilities
            .iter()
            .any(|r| r.capability.workspace_id == ws && r.capability.id == id),
    )
}
fn user(s: &MemState, id: Option<UserId>) -> Result<(), AppError> {
    if let Some(id) = id {
        exists(s.user(id).is_some(), "inbox.user_id")?;
    }
    Ok(())
}

pub(super) fn touch_person(s: &mut MemState, ws: WorkspaceId, id: PersonId, at: OffsetDateTime) {
    if let Some(row) = s
        .inbox
        .people
        .iter_mut()
        .find(|r| r.workspace_id == ws && r.id == id)
    {
        row.updated_at = at.max(row.updated_at + Duration::microseconds(1));
    }
}
pub(super) fn touch_journey(s: &mut MemState, ws: WorkspaceId, id: JourneyId, at: OffsetDateTime) {
    if let Some(row) = s
        .inbox
        .journeys
        .iter_mut()
        .find(|r| r.workspace_id == ws && r.id == id)
    {
        row.updated_at = at.max(row.updated_at + Duration::microseconds(1));
        let person_id = row.person_id;
        touch_person(s, ws, person_id, at);
    }
}
pub(super) fn touch_conversation(
    s: &mut MemState,
    ws: WorkspaceId,
    id: ConversationId,
    at: OffsetDateTime,
) {
    if let Some(row) = s
        .inbox
        .conversations
        .iter_mut()
        .find(|r| r.workspace_id == ws && r.id == id)
    {
        row.updated_at = at.max(row.updated_at + Duration::microseconds(1));
        let person_id = row.person_id;
        touch_person(s, ws, person_id, at);
    }
}

#[async_trait]
impl PersonRepo for MemTenant {
    async fn set_write_time(&mut self, at: OffsetDateTime) -> Result<(), AppError> {
        self.tx.inbox_write_at = Some(at);
        Ok(())
    }
    async fn lock_workspace(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    async fn insert(&mut self, row: Person) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            exists(t.state().workspace(t.ws).is_some(), "people.workspace_id")?;
            if let Some(id) = row.first_touch.capability_id {
                capability(t.state(), t.ws, id)?;
            }
            if let Some(id) = row.merged_into {
                person(t.state(), t.ws, id)?;
            }
            unique(
                !t.state().inbox.people.iter().any(|r| r.id == row.id),
                "person id is taken",
            )?;
            t.tx.write(move |s| s.inbox.people.push(row.clone()));
            Ok(())
        })
    }
    async fn get(&mut self, id: PersonId) -> Result<Option<Person>, AppError> {
        Ok(self
            .state()
            .inbox
            .people
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn lock(&mut self, id: PersonId) -> Result<Option<Person>, AppError> {
        PersonRepo::get(self, id).await
    }
    async fn find_by_identity(
        &mut self,
        channel: IdentityChannel,
        normalized: &str,
    ) -> Result<Option<Person>, AppError> {
        Ok(self
            .state()
            .inbox
            .identities
            .iter()
            .find(|r| {
                r.workspace_id == self.ws
                    && r.active
                    && r.channel == channel
                    && r.value_normalized == normalized
            })
            .and_then(|i| {
                self.state().inbox.people.iter().find(|p| {
                    p.workspace_id == self.ws
                        && p.id == i.person_id
                        && p.merged_into.is_none()
                        && p.erased_at.is_none()
                })
            })
            .cloned())
    }
    async fn search(
        &mut self,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Person>, AppError> {
        let query = query.to_lowercase();
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .people
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.merged_into.is_none()
                    && r.erased_at.is_none()
                    && (r.display_name.to_lowercase().contains(&query)
                        || r.company.to_lowercase().contains(&query))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows
            .into_iter()
            .skip(offset as usize)
            .take(limit.clamp(1, MAX_INBOX_PAGE) as usize)
            .collect())
    }
    async fn mark_merged(
        &mut self,
        id: PersonId,
        target: Option<PersonId>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if target == Some(id) {
                return Err(AppError::validation(
                    "cannot merge a person into itself",
                    serde_json::json!({}),
                ));
            }
            if let Some(to) = target {
                person(t.state(), ws, to)?;
            }
            person(t.state(), ws, id)?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .people
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.merged_into = target;
                    r.updated_at = at.max(r.updated_at + Duration::microseconds(1));
                }
            });
            Ok(())
        })
    }
    async fn set_erased(&mut self, id: PersonId, at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            person(t.state(), ws, id)?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .people
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.erased_at = Some(at);
                    r.updated_at = at.max(r.updated_at + Duration::microseconds(1));
                }
            });
            Ok(())
        })
    }
}
#[async_trait]
impl IdentityRepo for MemTenant {
    async fn insert(&mut self, row: Identity) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            person(t.state(), t.ws, row.person_id)?;
            unique(
                !t.state().inbox.identities.iter().any(|r| {
                    r.id == row.id
                        || (r.workspace_id == t.ws
                            && r.active
                            && row.active
                            && r.channel == row.channel
                            && r.value_normalized == row.value_normalized)
                }),
                "identity key is taken",
            )?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.identities.push(row.clone());
                touch_person(s, row.workspace_id, row.person_id, at);
            });
            Ok(())
        })
    }
    async fn list(&mut self, id: PersonId) -> Result<Vec<Identity>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .identities
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.person_id == id && r.active)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.first_seen_at, r.id));
        Ok(rows)
    }
    async fn deactivate_for(&mut self, id: PersonId) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            person(t.state(), ws, id)?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                for r in s
                    .inbox
                    .identities
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && r.person_id == id)
                {
                    r.active = false;
                }
                touch_person(s, ws, id, at);
            });
            Ok(())
        })
    }
    async fn move_to(&mut self, from: PersonId, to: PersonId) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            person(t.state(), ws, from)?;
            person(t.state(), ws, to)?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                for r in s
                    .inbox
                    .identities
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && r.person_id == from && r.active)
                {
                    r.person_id = to;
                }
                touch_person(s, ws, from, at);
                touch_person(s, ws, to, at);
            });
            Ok(())
        })
    }
}
#[async_trait]
impl ConversationRepo for MemTenant {
    async fn insert_for_send(&mut self, row: Conversation) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            if row.last_inbound_at.is_some()
                || row.executor != Executor::Agent
                || row.state != ConvState::Open
                || row.executor_generation != 0
                || row.last_outbound_at.is_some()
            {
                return Err(AppError::validation(
                    "invalid outbound conversation",
                    serde_json::json!({}),
                ));
            }
            person(t.state(), t.ws, row.person_id)?;
            capability(t.state(), t.ws, row.capability_id)?;
            unique(
                !t.state().inbox.conversations.iter().any(|c| {
                    c.id == row.id
                        || (c.workspace_id == t.ws
                            && c.person_id == row.person_id
                            && c.capability_id == row.capability_id)
                }),
                "conversation already exists",
            )?;
            t.tx.write(move |s| {
                s.inbox.conversation_send_states.entry(row.id).or_default();
                s.inbox.conversations.push(row.clone());
            });
            Ok(())
        })
    }

    async fn send_state(&mut self, id: ConversationId) -> Result<ConversationSendState, AppError> {
        conversation(self.state(), self.ws, id)?;
        Ok(self
            .state()
            .inbox
            .conversation_send_states
            .get(&id)
            .cloned()
            .unwrap_or_default())
    }
    async fn record_outbound(
        &mut self,
        id: ConversationId,
        expected_activity_revision: i64,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            conversation(t.state(), ws, id)?;
            let write_at = t.inbox_write_at();
            t.tx.write(move |s| {
                let revision = s
                    .inbox
                    .conversation_send_states
                    .get(&id)
                    .map_or(0, |m| m.activity_revision);
                if let Some(c) = s
                    .inbox
                    .conversations
                    .iter_mut()
                    .find(|c| c.workspace_id == ws && c.id == id)
                {
                    if revision == expected_activity_revision {
                        c.state = ConvState::Theirs;
                    }
                    c.last_outbound_at = Some(c.last_outbound_at.map_or(at, |old| old.max(at)));
                }
                touch_conversation(s, ws, id, write_at);
            });
            Ok(())
        })
    }

    async fn page(
        &mut self,
        queue: ConversationQueue,
        after: Option<(OffsetDateTime, ConversationId)>,
        limit: u32,
    ) -> Result<Vec<Conversation>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .conversations
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && after.is_none_or(|key| (r.created_at, r.id) > key)
                    && match queue {
                        ConversationQueue::All => true,
                        ConversationQueue::Ours => r.state == ConvState::Ours,
                        ConversationQueue::Unassigned => {
                            r.executor == Executor::Human { user_id: None }
                                && r.state != ConvState::Closed
                        }
                        ConversationQueue::Snoozed => matches!(r.state, ConvState::Snoozed { .. }),
                    }
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        rows.truncate(limit.clamp(1, MAX_INBOX_PAGE) as usize);
        Ok(rows)
    }
    async fn lock_for_person(&mut self, person: PersonId) -> Result<Vec<Conversation>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .conversations
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.person_id == person)
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(rows)
    }
    async fn get(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError> {
        Ok(self
            .state()
            .inbox
            .conversations
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn lock(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError> {
        ConversationRepo::get(self, id).await
    }
    async fn find(
        &mut self,
        p: PersonId,
        c: CapabilityId,
    ) -> Result<Option<Conversation>, AppError> {
        Ok(self
            .state()
            .inbox
            .conversations
            .iter()
            .find(|r| r.workspace_id == self.ws && r.person_id == p && r.capability_id == c)
            .cloned())
    }
    async fn upsert_on_inbound(&mut self, mut row: Conversation) -> Result<Conversation, AppError> {
        self.call(|t| {
            let ws = t.ws;
            let write_at = t.inbox_write_at();
            same_workspace(ws, row.workspace_id)?;
            let at = row.last_inbound_at.ok_or_else(|| {
                AppError::validation("inbound time is required", serde_json::json!({}))
            })?;
            person(t.state(), ws, row.person_id)?;
            capability(t.state(), ws, row.capability_id)?;
            if let Executor::Human { user_id } = row.executor {
                user(t.state(), user_id)?;
            }
            let prior = t.state().inbox.conversations.iter().find(|r| {
                r.workspace_id == ws
                    && r.person_id == row.person_id
                    && r.capability_id == row.capability_id
            });
            let existed = prior.is_some();
            let clear_sender = prior.is_none_or(|c| c.last_inbound_at.is_none_or(|old| at >= old));
            if let Some(old) = t.state().inbox.conversations.iter().find(|r| {
                r.workspace_id == ws
                    && r.person_id == row.person_id
                    && r.capability_id == row.capability_id
            }) {
                row = old.clone();
                let at = row.last_inbound_at.map_or(at, |old| old.max(at));
                row.reopen_on_inbound(at);
            } else {
                unique(
                    !t.state().inbox.conversations.iter().any(|r| r.id == row.id),
                    "conversation id is taken",
                )?;
                row.reopen_on_inbound(at);
                row.created_at = write_at;
                row.updated_at = write_at;
            }
            row.updated_at = write_at.max(row.updated_at + Duration::microseconds(1));
            let out = row.clone();
            t.tx.write(move |s| {
                if let Some(old) = s
                    .inbox
                    .conversations
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == row.id)
                {
                    *old = row.clone();
                } else {
                    s.inbox.conversations.push(row.clone());
                }
                let metadata = s.inbox.conversation_send_states.entry(row.id).or_default();
                if existed {
                    metadata.activity_revision += 1;
                }
                if clear_sender {
                    metadata.last_inbound_identity_id = None;
                }
                touch_person(s, ws, row.person_id, write_at);
            });
            Ok(out)
        })
    }
    async fn update_state(
        &mut self,
        id: ConversationId,
        state: ConvState,
        outbound_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            conversation(t.state(), ws, id)?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .conversations
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.state = state.clone();
                    if outbound_at.is_some() {
                        r.last_outbound_at = outbound_at;
                    }
                }
                s.inbox
                    .conversation_send_states
                    .entry(id)
                    .or_default()
                    .activity_revision += 1;
                touch_conversation(s, ws, id, at);
            });
            Ok(())
        })
    }
    async fn update_executor(
        &mut self,
        id: ConversationId,
        executor: Executor,
    ) -> Result<u32, AppError> {
        self.call(|t| {
            let ws = t.ws;
            let row = t
                .state()
                .inbox
                .conversations
                .iter()
                .find(|r| r.workspace_id == ws && r.id == id)
                .ok_or_else(|| AppError::not_found("no such conversation"))?;
            let generation = row
                .executor_generation
                .checked_add(1)
                .ok_or_else(|| AppError::internal("executor generation exhausted"))?;
            if let Executor::Human { user_id } = executor {
                user(t.state(), user_id)?;
            }
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .conversations
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.executor = executor;
                    r.executor_generation = generation;
                }
                touch_conversation(s, ws, id, at);
            });
            Ok(generation)
        })
    }
    async fn list(
        &mut self,
        person: Option<PersonId>,
        limit: u32,
    ) -> Result<Vec<Conversation>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .conversations
            .iter()
            .filter(|r| r.workspace_id == self.ws && person.is_none_or(|p| r.person_id == p))
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.id);
        rows.truncate(limit.clamp(1, MAX_INBOX_PAGE) as usize);
        Ok(rows)
    }
}
#[async_trait]
impl MessageRepo for MemTenant {
    async fn find_by_external_id(
        &mut self,
        capability: CapabilityId,
        external_id: &str,
    ) -> Result<Option<Message>, AppError> {
        let s = self.state();
        Ok(s.inbox
            .messages
            .iter()
            .filter(|m| {
                m.workspace_id == self.ws
                    && m.external_id.as_deref() == Some(external_id)
                    && s.inbox.conversations.iter().any(|c| {
                        c.workspace_id == self.ws
                            && c.id == m.conversation_id
                            && c.capability_id == capability
                    })
            })
            .min_by_key(|m| (m.at, m.id))
            .cloned())
    }
    async fn echo_candidates(
        &mut self,
        conversation: ConversationId,
        body: &str,
        received_at: OffsetDateTime,
    ) -> Result<Vec<Message>, AppError> {
        let s = self.state();
        let mut rows: Vec<_> = s
            .inbox
            .messages
            .iter()
            .filter(|m| {
                m.workspace_id == self.ws
                    && m.conversation_id == conversation
                    && m.direction == Direction::Outbound
                    && m.external_id.is_none()
                    && m.body == body
                    && s.inbox.outbox.iter().any(|o| {
                        o.workspace_id == self.ws
                            && o.conversation_id == m.conversation_id
                            && o.message_id == m.id
                            && o.fence_snapshot
                                .as_ref()
                                .and_then(|f| f.get("send_at"))
                                .and_then(Value::as_str)
                                .filter(|s| s.strip_prefix('-').unwrap_or(s).len() <= 38)
                                .and_then(|s| s.parse::<i128>().ok())
                                .is_some_and(|at| at <= received_at.unix_timestamp_nanos())
                            && (o.state == "sending"
                                || (o.state == "sent"
                                    && o.updated_at >= received_at - Duration::minutes(5)))
                    })
            })
            .cloned()
            .collect();
        rows.sort_by_key(|m| (m.at, m.id));
        rows.truncate(2);
        Ok(rows)
    }

    async fn recent(&mut self, id: ConversationId, limit: u32) -> Result<Vec<Message>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .messages
            .iter()
            .filter(|m| m.workspace_id == self.ws && m.conversation_id == id)
            .cloned()
            .collect();
        rows.sort_by_key(|m| (m.at, m.id));
        let skip = rows.len().saturating_sub(limit.clamp(1, 500) as usize);
        Ok(rows.into_iter().skip(skip).collect())
    }

    async fn record_inbound_sender(
        &mut self,
        message: MessageId,
        sender: IdentityId,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            let m = t
                .state()
                .inbox
                .messages
                .iter()
                .find(|m| {
                    m.workspace_id == ws && m.id == message && m.direction == Direction::Inbound
                })
                .ok_or_else(|| AppError::not_found("no matching inbound sender"))?;
            let c = t
                .state()
                .inbox
                .conversations
                .iter()
                .find(|c| c.workspace_id == ws && c.id == m.conversation_id)
                .ok_or_else(|| AppError::not_found("no such conversation"))?;
            let i = t
                .state()
                .inbox
                .identities
                .iter()
                .find(|i| {
                    i.workspace_id == ws && i.id == sender && i.person_id == c.person_id && i.active
                })
                .ok_or_else(|| AppError::not_found("no matching inbound sender"))?;
            if channel_for_kind(&c.kind_key).map(|ch| ch.identity_channel()) != Some(i.channel) {
                return Err(AppError::not_found("no matching inbound sender"));
            }
            if t.state()
                .inbox
                .message_senders
                .get(&message)
                .is_some_and(|id| *id != sender)
            {
                return Err(AppError::conflict("inbound sender is immutable"));
            }
            let cid = c.id;
            let inbound_at = c.last_inbound_at;
            t.tx.write(move |s| {
                s.inbox.message_senders.insert(message, sender);
                let latest = s
                    .inbox
                    .messages
                    .iter()
                    .filter(|m| {
                        m.workspace_id == ws
                            && m.conversation_id == cid
                            && m.direction == Direction::Inbound
                            && Some(m.at) == inbound_at
                    })
                    .max_by_key(|m| m.id);
                let sender = latest.and_then(|m| s.inbox.message_senders.get(&m.id).copied());
                s.inbox
                    .conversation_send_states
                    .entry(cid)
                    .or_default()
                    .last_inbound_identity_id = sender;
            });
            Ok(())
        })
    }

    async fn get(&mut self, id: MessageId) -> Result<Option<Message>, AppError> {
        Ok(self
            .state()
            .inbox
            .messages
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn page(
        &mut self,
        conversation: ConversationId,
        after: Option<(OffsetDateTime, MessageId)>,
        limit: u32,
    ) -> Result<Vec<Message>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .messages
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.conversation_id == conversation
                    && after.is_none_or(|key| (r.at, r.id) > key)
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        rows.truncate(limit.clamp(1, MAX_INBOX_PAGE) as usize);
        Ok(rows)
    }
    async fn insert_if_new(&mut self, row: Message) -> Result<Option<MessageId>, AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, row.workspace_id)?;
            conversation(t.state(), ws, row.conversation_id)?;
            if row.external_id.is_some()
                && t.state().inbox.messages.iter().any(|r| {
                    r.workspace_id == ws
                        && r.conversation_id == row.conversation_id
                        && r.external_id == row.external_id
                })
            {
                return Ok(None);
            }
            unique(
                !t.state().inbox.messages.iter().any(|r| r.id == row.id),
                "message id is taken",
            )?;
            let id = row.id;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.messages.push(row.clone());
                touch_conversation(s, row.workspace_id, row.conversation_id, at);
            });
            Ok(Some(id))
        })
    }
    async fn list(&mut self, id: ConversationId, limit: u32) -> Result<Vec<Message>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .messages
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.conversation_id == id)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        rows.truncate(limit.clamp(1, MAX_INBOX_PAGE) as usize);
        Ok(rows)
    }
    async fn set_status(
        &mut self,
        id: MessageId,
        status: MsgStatus,
        external_id: Option<String>,
        cost_minor: Option<i64>,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            let old = t
                .state()
                .inbox
                .messages
                .iter()
                .find(|r| r.workspace_id == ws && r.id == id)
                .ok_or_else(|| AppError::not_found("no such message"))?;
            if external_id.is_some() {
                unique(
                    !t.state().inbox.messages.iter().any(|r| {
                        r.workspace_id == ws
                            && r.conversation_id == old.conversation_id
                            && r.id != id
                            && r.external_id == external_id
                    }),
                    "message external id is taken",
                )?;
            }
            let conversation_id = old.conversation_id;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .messages
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.status = status.clone();
                    if external_id.is_some() {
                        r.external_id = external_id.clone();
                    }
                    if cost_minor.is_some() {
                        r.cost_minor = cost_minor;
                    }
                }
                touch_conversation(s, ws, conversation_id, at);
            });
            Ok(())
        })
    }
}
#[async_trait]
impl JourneyRepo for MemTenant {
    async fn open_owned_by(&mut self, user: jt_tenancy::UserId) -> Result<Vec<Journey>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .journeys
            .iter()
            .filter(|j| j.workspace_id == self.ws && j.owner == Some(user) && j.closed_at.is_none())
            .cloned()
            .collect();
        rows.sort_by_key(|j| j.id);
        Ok(rows)
    }

    async fn reducer_revision(&mut self, id: JourneyId) -> Result<i64, AppError> {
        journey(self.state(), self.ws, id)?;
        Ok(*self
            .state()
            .inbox
            .journey_reducer_revisions
            .get(&id)
            .unwrap_or(&0))
    }

    async fn append_historical_reply(&mut self, event: JourneyEvent) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, event.workspace_id)?;
            if event.source != EventSource::System
                || !matches!(
                    event.kind,
                    JourneyEventKind::Replied | JourneyEventKind::QuoteSent
                )
            {
                return Err(AppError::validation(
                    "only system outbound receipts may be historical",
                    serde_json::json!({}),
                ));
            }
            let j = t
                .state()
                .inbox
                .journeys
                .iter()
                .find(|j| j.workspace_id == ws && j.id == event.journey_id)
                .ok_or_else(|| AppError::not_found("no such journey"))?;
            unique(
                !t.state().inbox.events.iter().any(|e| {
                    e.id == event.id
                        || (e.workspace_id == ws && e.idempotency_key == event.idempotency_key)
                }),
                "journey event key is taken",
            )?;
            let person = j.person_id;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.events.push(event.clone());
                touch_person(s, ws, person, at);
            });
            Ok(())
        })
    }

    async fn event_by_key(&mut self, key: &str) -> Result<Option<JourneyEvent>, AppError> {
        Ok(self
            .state()
            .inbox
            .events
            .iter()
            .find(|r| r.workspace_id == self.ws && r.idempotency_key == key)
            .cloned())
    }
    async fn assign_owner(&mut self, id: JourneyId, owner: Option<UserId>) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            journey(t.state(), ws, id)?;
            user(t.state(), owner)?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .journeys
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.owner = owner;
                }
                touch_journey(s, ws, id, at);
            });
            Ok(())
        })
    }
    async fn get(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError> {
        Ok(self
            .state()
            .inbox
            .journeys
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn lock(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError> {
        JourneyRepo::get(self, id).await
    }
    async fn open_for(&mut self, id: PersonId) -> Result<Option<Journey>, AppError> {
        Ok(self
            .state()
            .inbox
            .journeys
            .iter()
            .find(|r| r.workspace_id == self.ws && r.person_id == id && r.closed_at.is_none())
            .cloned())
    }
    async fn latest_for(&mut self, id: PersonId) -> Result<Option<Journey>, AppError> {
        Ok(self
            .state()
            .inbox
            .journeys
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.person_id == id)
            .max_by_key(|r| (r.opened_at, r.id))
            .cloned())
    }
    async fn insert_initial(&mut self, initial: InitialJourney) -> Result<(), AppError> {
        let row = initial.journey().clone();
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, row.workspace_id)?;
            person(t.state(), ws, row.person_id)?;
            user(t.state(), row.owner)?;
            unique(
                !t.state().inbox.journeys.iter().any(|r| {
                    r.id == row.id
                        || (r.workspace_id == ws
                            && r.person_id == row.person_id
                            && r.closed_at.is_none())
                }),
                "open journey already exists",
            )?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.journeys.push(row.clone());
                touch_person(s, row.workspace_id, row.person_id, at);
            });
            Ok(())
        })
    }
    async fn apply_transition(
        &mut self,
        id: JourneyId,
        transition: Transition,
        event: JourneyEvent,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, event.workspace_id)?;
            if event.journey_id != id {
                return Err(AppError::validation(
                    "event names another journey",
                    serde_json::json!({}),
                ));
            }
            let row = t
                .state()
                .inbox
                .journeys
                .iter()
                .find(|r| r.workspace_id == ws && r.id == id)
                .ok_or_else(|| AppError::not_found("no such journey"))?;
            if row.status != transition.from() {
                return Err(AppError::conflict("journey changed before transition"));
            }
            unique(
                !t.state().inbox.events.iter().any(|r| {
                    r.id == event.id
                        || (r.workspace_id == ws && r.idempotency_key == event.idempotency_key)
                }),
                "journey event key is taken",
            )?;
            let patch = transition.patch().clone();
            if patch.closed_at.is_none() {
                unique(
                    !t.state().inbox.journeys.iter().any(|r| {
                        r.workspace_id == ws
                            && r.person_id == row.person_id
                            && r.id != id
                            && r.closed_at.is_none()
                    }),
                    "open journey already exists",
                )?;
            }
            let person_id = row.person_id;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .journeys
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.status = patch.status;
                    r.unreachable_attempts = patch.unreachable_attempts;
                    r.closed_at = patch.closed_at;
                    r.lost_reason = patch.lost_reason.clone();
                    r.updated_at = patch
                        .updated_at
                        .max(r.updated_at + Duration::microseconds(1));
                }
                if patch.closed_at.is_some() {
                    for row in s.inbox.outbox.iter_mut().filter(|o| {
                        o.workspace_id == ws && matches!(o.state.as_str(), "sending" | "unknown")
                    }) {
                        if let Some(fence) = row.fence_snapshot.as_mut()
                            && fence.get("journey_id") == Some(&serde_json::json!(id))
                        {
                            fence["journey_closed"] = serde_json::json!(true);
                        }
                    }
                }
                *s.inbox.journey_reducer_revisions.entry(id).or_default() += 1;
                s.inbox.events.push(event.clone());
                touch_person(s, ws, person_id, at);
            });
            Ok(())
        })
    }
    async fn events(&mut self, id: JourneyId, limit: u32) -> Result<Vec<JourneyEvent>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .events
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.journey_id == id)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        let skip = rows.len().saturating_sub(limit.clamp(1, 500) as usize);
        Ok(rows.into_iter().skip(skip).collect())
    }
}
#[async_trait]
impl TaskRepo for MemTenant {
    async fn get(&mut self, id: TaskId) -> Result<Option<Task>, AppError> {
        Ok(self
            .state()
            .inbox
            .tasks
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn query(
        &mut self,
        queue: TaskQueue,
        assignee: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<Task>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .tasks
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.status == TaskStatus::Open
                    && assignee.is_none_or(|id| r.assignee == Some(id))
                    && match queue {
                        TaskQueue::Due24h => {
                            r.due_at >= now && r.due_at <= now + Duration::hours(24)
                        }
                        TaskQueue::Overdue => r.due_at < now,
                        TaskQueue::All => true,
                    }
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.due_at, r.id));
        Ok(rows)
    }

    async fn insert(&mut self, row: Task) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.journey_id)?;
            user(t.state(), row.assignee)?;
            unique(
                !t.state().inbox.tasks.iter().any(|r| r.id == row.id),
                "task id is taken",
            )?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.tasks.push(row.clone());
                touch_journey(s, row.workspace_id, row.journey_id, at);
            });
            Ok(())
        })
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Task>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .tasks
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.journey_id == id)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.due_at, r.id));
        Ok(rows)
    }
    async fn set_status(&mut self, id: TaskId, status: TaskStatus) -> Result<(), AppError> {
        self.call(|t| {
            if t.tx.inbox_task_status_fails() {
                return Err(AppError::internal("injected task effect failure"));
            }
            let ws = t.ws;
            let journey_id = t
                .state()
                .inbox
                .tasks
                .iter()
                .find(|r| r.workspace_id == ws && r.id == id)
                .ok_or_else(|| AppError::not_found("no such task"))?
                .journey_id;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .tasks
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.status = status;
                }
                touch_journey(s, ws, journey_id, at);
            });
            Ok(())
        })
    }
}
#[async_trait]
impl NoteRepo for MemTenant {
    async fn insert(&mut self, row: Note) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.journey_id)?;
            unique(
                !t.state().inbox.notes.iter().any(|r| r.id == row.id),
                "note id is taken",
            )?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.notes.push(row.clone());
                touch_journey(s, row.workspace_id, row.journey_id, at);
            });
            Ok(())
        })
    }
    async fn list(&mut self, id: JourneyId) -> Result<Vec<Note>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .notes
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.journey_id == id)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        Ok(rows)
    }
}
#[async_trait]
impl LostReasonRepo for MemTenant {
    async fn initialize(&mut self) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            exists(
                t.state().workspace(ws).is_some(),
                "lost_reasons.workspace_id",
            )?;
            t.tx.write(move |s| initialize_defaults(&mut s.inbox, ws));
            Ok(())
        })
    }
    async fn list(&mut self) -> Result<Vec<LostReasonRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .lost_reasons
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(rows)
    }
    async fn set(&mut self, row: LostReasonRow) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            exists(
                t.state().workspace(t.ws).is_some(),
                "lost_reasons.workspace_id",
            )?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .lost_reasons
                    .iter_mut()
                    .find(|r| r.workspace_id == row.workspace_id && r.key == row.key)
                {
                    r.label = row.label.clone();
                    r.active = row.active;
                } else {
                    s.inbox.lost_reasons.push(row.clone());
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl ConsumptionRepo for MemTenant {
    async fn try_claim(&mut self, consumer: &str, id: InboundEventId) -> Result<bool, AppError> {
        self.call(|t| {
            let ws = t.ws;
            found(
                t.state()
                    .inbound_events
                    .iter()
                    .any(|r| r.event.workspace_id == ws && r.event.id == id),
            )?;
            if let Some(existing) = t
                .state()
                .inbox
                .consumption
                .iter()
                .find(|r| r.workspace_id == ws && r.consumer == consumer && r.event_id == id)
            {
                let event = &t
                    .state()
                    .inbound_events
                    .iter()
                    .find(|r| r.event.workspace_id == ws && r.event.id == id)
                    .expect("checked event")
                    .event;
                if !deferred_leadgen(consumer, event, existing.outcome.as_ref()) {
                    return Ok(false);
                }
                let consumer = consumer.to_owned();
                t.tx.write(move |s| {
                    let row = s
                        .inbox
                        .consumption
                        .iter_mut()
                        .find(|r| {
                            r.workspace_id == ws && r.consumer == consumer && r.event_id == id
                        })
                        .expect("checked claim");
                    row.outcome = None;
                });
                return Ok(true);
            }
            let row = StoredConsumption {
                workspace_id: ws,
                consumer: consumer.into(),
                event_id: id,
                outcome: None,
            };
            t.tx.write(move |s| s.inbox.consumption.push(row.clone()));
            Ok(true)
        })
    }
    async fn record(
        &mut self,
        consumer: &str,
        id: InboundEventId,
        outcome: ConsumptionOutcome,
    ) -> Result<(), AppError> {
        self.call(|t| {
            if t.tx.inbox_consumption_fails() {
                return Err(AppError::internal("injected consumption failure"));
            }
            let ws = t.ws;
            found(t.state().inbox.consumption.iter().any(|r| {
                r.workspace_id == ws
                    && r.consumer == consumer
                    && r.event_id == id
                    && r.outcome.is_none()
            }))?;
            let consumer = consumer.to_owned();
            t.tx.write(move |s| {
                if let Some(r) =
                    s.inbox.consumption.iter_mut().find(|r| {
                        r.workspace_id == ws && r.consumer == consumer && r.event_id == id
                    })
                {
                    r.outcome = Some(outcome.clone());
                }
            });
            Ok(())
        })
    }
}
#[async_trait]
impl RequestKeyRepo for MemTenant {
    async fn complete(
        &mut self,
        key: &str,
        expected: Value,
        response: Value,
    ) -> Result<bool, AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .request_keys
                .iter()
                .any(|r| r.workspace_id == ws && r.key == key && r.response == expected)
            {
                return Ok(false);
            }
            let key = key.to_owned();
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .request_keys
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.key == key && r.response == expected)
                {
                    r.response = response.clone();
                }
            });
            Ok(true)
        })
    }

    async fn get(&mut self, key: &str, now: OffsetDateTime) -> Result<Option<Value>, AppError> {
        Ok(self
            .state()
            .inbox
            .request_keys
            .iter()
            .find(|r| r.workspace_id == self.ws && r.key == key && r.at > now - Duration::hours(24))
            .map(|r| r.response.clone()))
    }
    async fn store(
        &mut self,
        key: &str,
        response: Value,
        now: OffsetDateTime,
    ) -> Result<bool, AppError> {
        self.call(|t| {
            let ws = t.ws;
            exists(
                t.state().workspace(ws).is_some(),
                "request_keys.workspace_id",
            )?;
            if t.state()
                .inbox
                .request_keys
                .iter()
                .any(|r| r.workspace_id == ws && r.key == key && r.at > now - Duration::hours(24))
            {
                return Ok(false);
            }
            let row = StoredRequestKey {
                workspace_id: ws,
                key: key.into(),
                response,
                at: now,
            };
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .request_keys
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.key == row.key)
                {
                    *r = row.clone();
                } else {
                    s.inbox.request_keys.push(row.clone());
                }
            });
            Ok(true)
        })
    }
}
fn check_outbox(row: &OutboxRow) -> Result<(), AppError> {
    if !["queued", "sending", "sent", "failed", "unknown", "refused"].contains(&row.state.as_str())
        || row.attempts > i32::MAX as u32
    {
        return Err(AppError::internal("invalid outbox state or attempts"));
    }
    Ok(())
}
#[async_trait]
impl OutboxRepo for MemTenant {
    async fn insert(&mut self, row: OutboxRow) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, row.workspace_id)?;
            conversation(t.state(), ws, row.conversation_id)?;
            found(
                t.state()
                    .inbox
                    .messages
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == row.message_id),
            )?;
            capability(t.state(), ws, row.capability_id)?;
            check_outbox(&row)?;
            unique(
                !t.state().inbox.outbox.iter().any(|r| r.id == row.id),
                "outbox id is taken",
            )?;
            t.tx.write(move |s| s.inbox.outbox.push(row.clone()));
            Ok(())
        })
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .outbox
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn lock(&mut self, id: Uuid) -> Result<Option<OutboxRow>, AppError> {
        OutboxRepo::get(self, id).await
    }
    async fn list_pending(
        &mut self,
        state: &str,
        before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<OutboxRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .outbox
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.state == state && r.updated_at < before)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.updated_at, r.id));
        rows.truncate(limit.clamp(1, MAX_INBOX_PAGE) as usize);
        Ok(rows)
    }
    async fn update(&mut self, row: OutboxRow) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            same_workspace(ws, row.workspace_id)?;
            found(
                t.state()
                    .inbox
                    .outbox
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == row.id),
            )?;
            check_outbox(&row)?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .outbox
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == row.id)
                {
                    r.state = row.state.clone();
                    r.attempts = row.attempts;
                    r.last_error = row.last_error.clone();
                    r.fence_snapshot = row.fence_snapshot.clone();
                    r.updated_at = row.updated_at;
                }
            });
            Ok(())
        })
    }
    async fn failure_reasons(
        &mut self,
        messages: &[MessageId],
    ) -> Result<Vec<(MessageId, String)>, AppError> {
        Ok(self
            .state()
            .inbox
            .outbox
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && messages.contains(&r.message_id)
                    && matches!(r.state.as_str(), "failed" | "unknown")
            })
            .filter_map(|r| r.last_error.clone().map(|e| (r.message_id, e)))
            .collect())
    }
}
