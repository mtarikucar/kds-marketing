//! The in-memory call repository: sessions, turns, the voice bridge's commands and event notes,
//! and the call policy, with the constraints the `0015_voice_calls` and `0016_voice_bridge`
//! migrations enforce (unique ids, `crm_id` and `bridge_call_id`, turn numbers per call, one note
//! per bridge event, commands in their queue order).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::calls::{
    CallCommandId, CallDirection, CallFilter, CallId, CallMode, CallPolicy, CallRepo, CallSession,
    CallState, Command, EndCause, MAX_CALL_PAGE, QueuedCommand, Turn,
};
use jt_capability::CapabilityId;
use jt_inbox::PersonId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use super::state::{MemBundle, same_workspace, unique};
use super::tenant::MemTenant;

/// The longest turn text the table keeps.
const MAX_TURN_TEXT: usize = 2000;

/// The workspace's calls, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemCalls {
    pub sessions: Vec<CallSession>,
    pub turns: Vec<(WorkspaceId, CallId, Turn)>,
    pub policies: Vec<(WorkspaceId, CallPolicy)>,
    /// In their queue order.
    pub commands: Vec<MemCommand>,
    /// `(workspace, bridge_call_id, bridge_seq)` of each event a bridge reported.
    pub bridge_events: Vec<(WorkspaceId, String, u32)>,
}

/// A command queued for the voice bridge, as the fake stores it.
#[derive(Clone, Debug)]
pub struct MemCommand {
    pub workspace_id: WorkspaceId,
    pub id: CallCommandId,
    pub call_id: CallId,
    pub command: Command,
    pub created_at: OffsetDateTime,
    pub taken_at: Option<OffsetDateTime>,
    pub acked_at: Option<OffsetDateTime>,
}

fn not_found() -> AppError {
    AppError::not_found("no such call")
}

#[async_trait]
impl CallRepo for MemTenant {
    async fn insert(&mut self, session: CallSession, _at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|this| {
            same_workspace(this.ws, session.workspace_id)?;
            let calls = &this.state().calls;
            let ws = this.ws;
            unique(
                !calls
                    .sessions
                    .iter()
                    .any(|s| s.workspace_id == ws && s.id == session.id),
                "the call id is already taken",
            )?;
            for (mine, what) in [
                (session.crm_id.as_deref(), "crm_id"),
                (session.bridge_call_id.as_deref(), "bridge_call_id"),
            ] {
                if let Some(value) = mine {
                    unique(
                        !calls.sessions.iter().any(|s| {
                            s.workspace_id == ws
                                && match what {
                                    "crm_id" => s.crm_id.as_deref() == Some(value),
                                    _ => s.bridge_call_id.as_deref() == Some(value),
                                }
                        }),
                        "the call's provider id is already taken",
                    )?;
                }
            }
            let session = session.clone();
            this.tx
                .write(move |s| s.calls.sessions.push(session.clone()));
            let hook = super::state::lock(&this.tx.after_call_insert).take();
            if let Some(hook) = hook {
                this.tx.write(move |s| hook(s));
            }
            Ok(())
        })
    }

    async fn get(&mut self, id: CallId) -> Result<Option<CallSession>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .calls
            .sessions
            .iter()
            .find(|s| s.workspace_id == ws && s.id == id)
            .cloned())
    }

    async fn lock(&mut self, id: CallId) -> Result<Option<CallSession>, AppError> {
        CallRepo::get(self, id).await
    }

    async fn lock_by_crm_id(&mut self, crm_id: &str) -> Result<Option<CallSession>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .calls
            .sessions
            .iter()
            .find(|s| s.workspace_id == ws && s.crm_id.as_deref() == Some(crm_id))
            .cloned())
    }

    async fn lock_by_pbx_id(&mut self, unique_id: &str) -> Result<Option<CallSession>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .calls
            .sessions
            .iter()
            .filter(|s| s.workspace_id == ws && s.pbx_unique_id.as_deref() == Some(unique_id))
            .max_by_key(|s| s.started_at)
            .cloned())
    }

    async fn lock_by_bridge_id(
        &mut self,
        bridge_call_id: &str,
    ) -> Result<Option<CallSession>, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .calls
            .sessions
            .iter()
            .find(|s| s.workspace_id == ws && s.bridge_call_id.as_deref() == Some(bridge_call_id))
            .cloned())
    }

    async fn update(&mut self, session: CallSession, _at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, session.workspace_id)?;
            let calls = &this.state().calls;
            if !calls
                .sessions
                .iter()
                .any(|s| s.workspace_id == ws && s.id == session.id)
            {
                return Err(not_found());
            }
            if let Some(crm) = &session.crm_id {
                unique(
                    !calls.sessions.iter().any(|s| {
                        s.workspace_id == ws && s.id != session.id && s.crm_id.as_ref() == Some(crm)
                    }),
                    "the call's provider id is already taken",
                )?;
            }
            let session = session.clone();
            this.tx.write(move |s| {
                if let Some(row) = s
                    .calls
                    .sessions
                    .iter_mut()
                    .find(|r| r.workspace_id == session.workspace_id && r.id == session.id)
                {
                    *row = session.clone();
                }
            });
            Ok(())
        })
    }

    async fn list(&mut self, filter: CallFilter) -> Result<Vec<CallSession>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<CallSession> = self
            .state()
            .calls
            .sessions
            .iter()
            .filter(|s| s.workspace_id == ws)
            .filter(|s| filter.person_id.is_none_or(|p| s.person_id == Some(p)))
            .filter(|s| filter.state.is_none_or(|st| s.state == st))
            .filter(|s| filter.direction.is_none_or(|d| s.direction == d))
            .filter(|s| filter.since.is_none_or(|t| s.started_at >= t))
            .filter(|s| filter.before.is_none_or(|b| (s.started_at, s.id) < b))
            .cloned()
            .collect();
        rows.sort_by_key(|s| std::cmp::Reverse((s.started_at, s.id)));
        rows.truncate(filter.limit.clamp(1, MAX_CALL_PAGE) as usize);
        Ok(rows)
    }

    async fn count_started(
        &mut self,
        capability: CapabilityId,
        from: OffsetDateTime,
        to: OffsetDateTime,
        except: Option<CallId>,
    ) -> Result<u32, AppError> {
        let ws = self.ws;
        let n = self
            .state()
            .calls
            .sessions
            .iter()
            .filter(|s| {
                s.workspace_id == ws
                    && s.capability_id == capability
                    && s.direction == CallDirection::Outbound
                    && s.started_at >= from
                    && s.started_at < to
                    && !matches!(s.end_cause, Some(EndCause::Refused(_)))
                    && Some(s.id) != except
            })
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn extension_busy(
        &mut self,
        rep_extension: &str,
        except: Option<CallId>,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        Ok(self.state().calls.sessions.iter().any(|s| {
            s.workspace_id == ws
                && s.state != CallState::Ended
                && Some(s.id) != except
                && matches!(&s.mode, CallMode::Human { rep_extension: e } if e == rep_extension)
        }))
    }

    async fn inbound_since(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        Ok(self.state().calls.sessions.iter().any(|s| {
            s.workspace_id == ws
                && s.person_id == Some(person)
                && s.direction == CallDirection::Inbound
                && s.started_at >= since
        }))
    }

    async fn live(&mut self) -> Result<Vec<CallSession>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<CallSession> = self
            .state()
            .calls
            .sessions
            .iter()
            .filter(|s| s.workspace_id == ws && s.state.is_live())
            .cloned()
            .collect();
        rows.sort_by_key(|s| (s.started_at, s.id));
        rows.truncate(MAX_CALL_PAGE as usize);
        Ok(rows)
    }

    async fn append_turns(&mut self, call: CallId, turns: Vec<Turn>) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let calls = &this.state().calls;
            if !calls
                .sessions
                .iter()
                .any(|s| s.workspace_id == ws && s.id == call)
            {
                return Err(not_found());
            }
            for turn in &turns {
                unique(
                    !calls
                        .turns
                        .iter()
                        .any(|(w, c, t)| *w == ws && *c == call && t.seq == turn.seq),
                    "the turn number is already taken",
                )?;
            }
            let stored: Vec<Turn> = turns
                .into_iter()
                .map(|mut t| {
                    t.text = t.text.chars().take(MAX_TURN_TEXT).collect();
                    t
                })
                .collect();
            this.tx.write(move |s| {
                s.calls
                    .turns
                    .extend(stored.iter().cloned().map(|t| (ws, call, t)));
            });
            Ok(())
        })
    }

    async fn mark_interrupted(
        &mut self,
        call: CallId,
        seq: u32,
        at_char: u32,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        let known = self
            .state()
            .calls
            .turns
            .iter()
            .any(|(w, c, t)| *w == ws && *c == call && t.seq == seq);
        if known {
            self.tx.write(move |s| {
                for (w, c, t) in s.calls.turns.iter_mut() {
                    if *w == ws && *c == call && t.seq == seq {
                        t.meta.interrupted_at_char = Some(at_char);
                    }
                }
            });
        }
        Ok(known)
    }

    async fn turns(
        &mut self,
        call: CallId,
        after_seq: Option<u32>,
        limit: u32,
    ) -> Result<Vec<Turn>, AppError> {
        let ws = self.ws;
        let mut out: Vec<Turn> = self
            .state()
            .calls
            .turns
            .iter()
            .filter(|(w, c, t)| *w == ws && *c == call && after_seq.is_none_or(|a| t.seq > a))
            .map(|(_, _, t)| t.clone())
            .collect();
        out.sort_by_key(|t| t.seq);
        out.truncate(limit.clamp(1, MAX_CALL_PAGE) as usize);
        Ok(out)
    }

    async fn enqueue_commands(
        &mut self,
        call: CallId,
        commands: Vec<(CallCommandId, Command)>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let calls = &this.state().calls;
            if !calls
                .sessions
                .iter()
                .any(|s| s.workspace_id == ws && s.id == call)
            {
                return Err(not_found());
            }
            for (id, _) in &commands {
                unique(
                    !calls
                        .commands
                        .iter()
                        .any(|c| c.workspace_id == ws && c.id == *id),
                    "the command id is already taken",
                )?;
            }
            let rows: Vec<MemCommand> = commands
                .into_iter()
                .map(|(id, command)| MemCommand {
                    workspace_id: ws,
                    id,
                    call_id: call,
                    command,
                    created_at: at,
                    taken_at: None,
                    acked_at: None,
                })
                .collect();
            this.tx
                .write(move |s| s.calls.commands.extend(rows.iter().cloned()));
            Ok(())
        })
    }

    async fn take_commands(
        &mut self,
        capability: CapabilityId,
        now: OffsetDateTime,
        stale_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<QueuedCommand>, AppError> {
        let ws = self.ws;
        let calls = &self.state().calls;
        let taken: Vec<QueuedCommand> = calls
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && c.acked_at.is_none())
            .filter(|c| c.taken_at.is_none_or(|t| t < stale_before))
            .filter_map(|c| {
                let session = calls
                    .sessions
                    .iter()
                    .find(|s| s.workspace_id == ws && s.id == c.call_id)?;
                (session.capability_id == capability).then(|| QueuedCommand {
                    id: c.id,
                    call_id: c.call_id,
                    bridge_call_id: session.bridge_call_id.clone(),
                    command: c.command.clone(),
                })
            })
            .take(limit.clamp(1, MAX_CALL_PAGE) as usize)
            .collect();
        let ids: Vec<CallCommandId> = taken.iter().map(|q| q.id).collect();
        self.tx.write(move |s| {
            for c in s.calls.commands.iter_mut() {
                if c.workspace_id == ws && ids.contains(&c.id) {
                    c.taken_at = Some(now);
                }
            }
        });
        Ok(taken)
    }

    async fn ack_command(
        &mut self,
        capability: CapabilityId,
        id: CallCommandId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        let calls = &self.state().calls;
        let open = calls.commands.iter().any(|c| {
            c.workspace_id == ws
                && c.id == id
                && c.acked_at.is_none()
                && calls.sessions.iter().any(|s| {
                    s.workspace_id == ws && s.id == c.call_id && s.capability_id == capability
                })
        });
        if open {
            self.tx.write(move |s| {
                for c in s.calls.commands.iter_mut() {
                    if c.workspace_id == ws && c.id == id {
                        c.acked_at = Some(at);
                    }
                }
            });
        }
        Ok(open)
    }

    async fn purge_commands(&mut self, before: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let n = self
            .state()
            .calls
            .commands
            .iter()
            .filter(|c| c.workspace_id == ws && c.created_at < before)
            .count();
        if n > 0 {
            self.tx.write(move |s| {
                s.calls
                    .commands
                    .retain(|c| c.workspace_id != ws || c.created_at >= before);
            });
        }
        Ok(n as u64)
    }

    async fn note_bridge_event(
        &mut self,
        _capability: CapabilityId,
        bridge_call_id: &str,
        bridge_seq: u32,
        _kind: &str,
        _at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        let seen = self
            .state()
            .calls
            .bridge_events
            .iter()
            .any(|(w, id, seq)| *w == ws && id == bridge_call_id && *seq == bridge_seq);
        if !seen {
            let id = bridge_call_id.to_owned();
            self.tx
                .write(move |s| s.calls.bridge_events.push((ws, id.clone(), bridge_seq)));
        }
        Ok(!seen)
    }

    async fn policy(&mut self) -> Result<CallPolicy, AppError> {
        let ws = self.ws;
        Ok(self
            .state()
            .calls
            .policies
            .iter()
            .find(|(w, _)| *w == ws)
            .map(|(_, p)| p.clone())
            .unwrap_or_default())
    }

    async fn set_policy(
        &mut self,
        policy: CallPolicy,
        _at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            s.calls.policies.retain(|(w, _)| *w != ws);
            s.calls.policies.push((ws, policy.clone()));
        });
        Ok(())
    }
}
