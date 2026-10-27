//! The in-memory call repository: sessions, turns and the call policy, with the constraints the
//! `0015_voice_calls` migration enforces (unique ids, `crm_id` and `bridge_call_id`, and turn
//! numbers per call).

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::calls::{
    CallDirection, CallFilter, CallId, CallMode, CallPolicy, CallRepo, CallSession, CallState,
    EndCause, MAX_CALL_PAGE, Turn,
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
