//! The tenant bundle's connector repos: inbound events, pending OAuth flows and probe runs,
//! answering as `jt_pg` does over migration 0005, with the checks in the order Postgres makes
//! them: the repo's own pre-checks (workspace, capability), then check constraints, then the
//! unique keys (`on conflict do nothing`), then the foreign keys. Outbound jobs retain their
//! tenant/capability scope and only poll queued or sent rows within the last 72 hours.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::compliance::{OutboundJobRow, OutboundJobState};
use jt_app::ports::connectors::{DeliveryState, DeliveryStatus};
use jt_app::ports::{
    EventOrder, EventQuery, InboundEventRepo, MAX_EVENT_PAGE, MAX_PENDING_JOBS, MAX_PROBE_PAGE,
    OAuthPendingId, OAuthPendingRepo, OAuthPendingRow, OutboundJobRepo, ProbeRun, ProbeRunId,
    ProbeRunRepo,
};
use jt_capability::CapabilityId;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::capability::ensure_capability;
use super::state::{
    MemBundle, StoredInboundEvent, StoredOutboundJob, exists, same_workspace, unique,
};
use super::tenant::MemTenant;

/// The `error_kind` values the check constraint of `probe_runs` accepts (migration 0005): the
/// `jt_connector::ConnectorError::kind` keys.
const ERROR_KINDS: [&str; 5] = ["auth", "permission", "throttle", "transient", "permanent"];

#[async_trait]
impl InboundEventRepo for MemTenant {
    async fn call_events(
        &mut self,
        unique_id: &str,
        until: OffsetDateTime,
    ) -> Result<Vec<InboundEvent>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbound_events
            .iter()
            .map(|s| &s.event)
            .filter(|e| {
                e.workspace_id == self.ws
                    && e.provider == Provider::Netgsm
                    && e.kind == EventKind::CallEvent
                    && e.payload["unique_id"].as_str() == Some(unique_id)
                    && e.received_at <= until
            })
            .cloned()
            .collect();
        rows.sort_by_key(|e| (e.received_at, e.id));
        Ok(rows)
    }

    async fn list_for_consumer(
        &mut self,
        consumer: &str,
        cursor: Option<(OffsetDateTime, InboundEventId)>,
        limit: u32,
    ) -> Result<Vec<InboundEvent>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbound_events
            .iter()
            .map(|s| &s.event)
            .filter(|e| {
                e.workspace_id == self.ws && cursor.is_none_or(|c| (e.received_at, e.id) > c)
            })
            .filter(|e| {
                !self.state().inbox.consumption.iter().any(|c| {
                    c.workspace_id == self.ws && c.consumer == consumer && c.event_id == e.id
                })
            })
            .cloned()
            .collect();
        rows.sort_by_key(|e| (e.received_at, e.id));
        rows.truncate(limit.clamp(1, MAX_EVENT_PAGE) as usize);
        Ok(rows)
    }

    async fn insert_if_new(
        &mut self,
        event: InboundEvent,
        raw: Option<Vec<u8>>,
    ) -> Result<Option<InboundEventId>, AppError> {
        self.call(|this| {
            same_workspace(this.ws, event.workspace_id)?;
            let (ws, state) = (this.ws, this.state());
            if let Some(capability) = event.capability_id {
                ensure_capability(state, ws, capability)?;
            }
            let replay = state.inbound_events.iter().any(|s| {
                s.event.workspace_id == ws
                    && s.event.provider == event.provider
                    && s.event.external_id == event.external_id
            });
            if replay {
                return Ok(None);
            }
            unique(
                !state.inbound_events.iter().any(|s| s.event.id == event.id),
                "the inbound event id is already taken",
            )?;
            exists(state.workspace(ws).is_some(), "inbound_events.workspace_id")?;
            let id = event.id;
            let stored = StoredInboundEvent { event, raw };
            this.tx
                .write(move |s| s.inbound_events.push(stored.clone()));
            Ok(Some(id))
        })
    }

    async fn list_pending(&mut self, limit: u32) -> Result<Vec<InboundEvent>, AppError> {
        let ws = self.ws;
        let mut events: Vec<InboundEvent> = self
            .state()
            .inbound_events
            .iter()
            .filter(|s| s.event.workspace_id == ws && s.event.processed_at.is_none())
            .map(|s| s.event.clone())
            .collect();
        events.sort_by_key(|e| (e.received_at, e.id));
        events.truncate(limit.clamp(1, MAX_EVENT_PAGE) as usize);
        Ok(events)
    }

    async fn mark_processed(
        &mut self,
        id: InboundEventId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let event = this
                .state()
                .inbound_events
                .iter()
                .find(|s| s.event.workspace_id == ws && s.event.id == id)
                .ok_or_else(|| AppError::not_found("no such inbound event"))?;
            if event.event.processed_at.is_some() {
                return Ok(false);
            }
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .inbound_events
                    .iter_mut()
                    .find(|s| s.event.workspace_id == ws && s.event.id == id)
                {
                    stored.event.processed_at.get_or_insert(at);
                }
            });
            Ok(true)
        })
    }

    async fn purge_raw_before(&mut self, cutoff: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let purgeable = move |s: &StoredInboundEvent| {
            s.event.workspace_id == ws && s.event.received_at < cutoff && s.raw.is_some()
        };
        let n = self
            .state()
            .inbound_events
            .iter()
            .filter(|s| purgeable(s))
            .count();
        self.tx.write(move |s| {
            for stored in s.inbound_events.iter_mut().filter(|s| purgeable(s)) {
                stored.raw = None;
            }
        });
        Ok(n as u64)
    }

    async fn list(&mut self, query: EventQuery) -> Result<Vec<InboundEvent>, AppError> {
        let ws = self.ws;
        let key = |e: &InboundEvent| (e.received_at, e.id);
        let mut events: Vec<InboundEvent> = self
            .state()
            .inbound_events
            .iter()
            .map(|s| &s.event)
            .filter(|e| {
                e.workspace_id == ws
                    && (!query.pending_only || e.processed_at.is_none())
                    && query.provider.is_none_or(|p| e.provider == p)
                    && query.kind.as_ref().is_none_or(|k| e.kind.key() == k.key())
                    && match query.order {
                        EventOrder::OldestFirst { after } => after.is_none_or(|c| key(e) > c),
                        EventOrder::NewestFirst { before } => before.is_none_or(|c| key(e) < c),
                    }
            })
            .cloned()
            .collect();
        events.sort_by_key(key);
        if matches!(query.order, EventOrder::NewestFirst { .. }) {
            events.reverse();
        }
        events.truncate(query.limit.clamp(1, MAX_EVENT_PAGE) as usize);
        Ok(events)
    }

    async fn count_pending(&mut self, cap: u32) -> Result<u32, AppError> {
        let ws = self.ws;
        let n = self
            .state()
            .inbound_events
            .iter()
            .filter(|s| s.event.workspace_id == ws && s.event.processed_at.is_none())
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX).min(cap))
    }
}

#[async_trait]
impl OAuthPendingRepo for MemTenant {
    async fn insert(&mut self, row: OAuthPendingRow) -> Result<(), AppError> {
        self.call(|this| {
            same_workspace(this.ws, row.workspace_id)?;
            let state = this.state();
            if let Some(capability) = row.capability_id {
                ensure_capability(state, this.ws, capability)?;
            }
            unique(
                !state
                    .oauth_pending
                    .iter()
                    .any(|p| p.id == row.id || p.state_hash == row.state_hash),
                "the pending oauth flow id or its state is already taken",
            )?;
            exists(
                state.workspace(row.workspace_id).is_some(),
                "oauth_pending.workspace_id",
            )?;
            exists(
                state.user(row.started_by).is_some(),
                "oauth_pending.started_by",
            )?;
            this.tx.write(move |s| s.oauth_pending.push(row.clone()));
            Ok(())
        })
    }

    async fn find_by_state_hash(
        &mut self,
        state_hash: &str,
    ) -> Result<Option<OAuthPendingRow>, AppError> {
        Ok(self
            .state()
            .oauth_pending
            .iter()
            .find(|p| p.workspace_id == self.ws && p.state_hash == state_hash)
            .cloned())
    }

    async fn lock(&mut self, id: OAuthPendingId) -> Result<Option<OAuthPendingRow>, AppError> {
        Ok(self
            .state()
            .oauth_pending
            .iter()
            .find(|p| p.workspace_id == self.ws && p.id == id)
            .cloned())
    }

    async fn set_assets(
        &mut self,
        id: OAuthPendingId,
        sealed: Vec<u8>,
        public: Value,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if !this
                .state()
                .oauth_pending
                .iter()
                .any(|p| p.workspace_id == ws && p.id == id)
            {
                return Err(AppError::not_found("no such pending oauth flow"));
            }
            this.tx.write(move |s| {
                if let Some(p) = s
                    .oauth_pending
                    .iter_mut()
                    .find(|p| p.workspace_id == ws && p.id == id)
                {
                    p.assets_sealed = Some(sealed.clone());
                    p.assets_public = public.clone();
                }
            });
            Ok(())
        })
    }

    async fn delete(&mut self, id: OAuthPendingId) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if !this
                .state()
                .oauth_pending
                .iter()
                .any(|p| p.workspace_id == ws && p.id == id)
            {
                return Err(AppError::not_found("no such pending oauth flow"));
            }
            this.tx.write(move |s| {
                s.oauth_pending
                    .retain(|p| !(p.workspace_id == ws && p.id == id));
            });
            Ok(())
        })
    }

    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let expired = move |p: &OAuthPendingRow| p.workspace_id == ws && p.expires_at < now;
        let n = self
            .state()
            .oauth_pending
            .iter()
            .filter(|p| expired(p))
            .count();
        self.tx
            .write(move |s| s.oauth_pending.retain(|p| !expired(p)));
        Ok(n as u64)
    }
}

/// The run as Postgres stores it: a latency beyond `i32::MAX` milliseconds is `i32::MAX`.
fn as_stored(mut run: ProbeRun) -> ProbeRun {
    run.latency_ms = run.latency_ms.min(i32::MAX as u32);
    run
}

#[async_trait]
impl ProbeRunRepo for MemTenant {
    async fn append(&mut self, run: ProbeRun) -> Result<ProbeRunId, AppError> {
        self.call(|this| {
            same_workspace(this.ws, run.workspace_id)?;
            let state = this.state();
            ensure_capability(state, this.ws, run.capability_id)?;
            if let Some(kind) = &run.error_kind
                && !ERROR_KINDS.contains(&kind.as_str())
            {
                return Err(AppError::internal(
                    "probe_runs.error_kind breaks its check constraint",
                ));
            }
            unique(
                !state.probe_runs.iter().any(|r| r.id == run.id),
                "the probe run id is already taken",
            )?;
            let id = run.id;
            let run = as_stored(run);
            this.tx.write(move |s| s.probe_runs.push(run.clone()));
            Ok(id)
        })
    }

    async fn latest(&mut self, capability_id: CapabilityId) -> Result<Option<ProbeRun>, AppError> {
        Ok(ProbeRunRepo::list(self, capability_id, 1).await?.pop())
    }

    async fn list(
        &mut self,
        capability_id: CapabilityId,
        limit: u32,
    ) -> Result<Vec<ProbeRun>, AppError> {
        let ws = self.ws;
        let mut runs: Vec<ProbeRun> = self
            .state()
            .probe_runs
            .iter()
            .filter(|r| r.workspace_id == ws && r.capability_id == capability_id)
            .cloned()
            .collect();
        runs.sort_by_key(|r| std::cmp::Reverse((r.at, r.id)));
        runs.truncate(limit.clamp(1, MAX_PROBE_PAGE) as usize);
        Ok(runs)
    }

    /// Without a database clock, only the cutoff applies (see the port).
    async fn purge_before(&mut self, cutoff: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let old = move |r: &ProbeRun| r.workspace_id == ws && r.at < cutoff;
        let n = self.state().probe_runs.iter().filter(|r| old(r)).count();
        self.tx.write(move |s| s.probe_runs.retain(|r| !old(r)));
        Ok(n as u64)
    }
}

#[async_trait]
impl OutboundJobRepo for MemTenant {
    async fn insert(&mut self, row: OutboundJobRow) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            ensure_capability(t.state(), t.ws, row.capability_id)?;
            if let Some(message) = row.message_id
                && !t
                    .state()
                    .inbox
                    .messages
                    .iter()
                    .any(|r| r.workspace_id == t.ws && r.id == message)
            {
                return Err(AppError::not_found("no such message"));
            }
            unique(
                !t.state().outbound_jobs.iter().any(|j| {
                    j.row.id == row.id
                        || (j.workspace_id == row.workspace_id
                            && j.capability_id == row.capability_id
                            && row.provider_job_id.is_some()
                            && j.row.provider_job_id == row.provider_job_id)
                }),
                "outbound job id or provider job id is taken",
            )?;
            let stored = StoredOutboundJob {
                workspace_id: row.workspace_id,
                capability_id: row.capability_id,
                job_id: row.provider_job_id.clone().unwrap_or_default(),
                status: row.last_status.clone(),
                row,
            };
            t.tx.write(move |s| s.outbound_jobs.push(stored.clone()));
            Ok(())
        })
    }
    async fn get(
        &mut self,
        capability: CapabilityId,
        id: Uuid,
    ) -> Result<Option<OutboundJobRow>, AppError> {
        Ok(self
            .state()
            .outbound_jobs
            .iter()
            .find(|j| j.workspace_id == self.ws && j.capability_id == capability && j.row.id == id)
            .map(|j| j.row.clone()))
    }
    async fn pending_job_ids(
        &mut self,
        ws: WorkspaceId,
        capability_id: CapabilityId,
        limit: u32,
    ) -> Result<Vec<String>, AppError> {
        self.call(|t| {
            same_workspace(t.ws, ws)?;
            let now = t.tx.inbox_write_at.unwrap_or_else(OffsetDateTime::now_utc);
            let mut rows: Vec<_> = t
                .state()
                .outbound_jobs
                .iter()
                .filter(|j| {
                    j.workspace_id == ws
                        && j.capability_id == capability_id
                        && matches!(
                            j.row.state,
                            OutboundJobState::Queued | OutboundJobState::Sent
                        )
                        && j.row.provider_job_id.is_some()
                        && j.row.created_at > now - Duration::hours(72)
                        && j.row.created_at <= now
                })
                .collect();
            rows.sort_by_key(|j| (j.row.created_at, j.row.id));
            Ok(rows
                .into_iter()
                .take(limit.clamp(1, MAX_PENDING_JOBS) as usize)
                .map(|j| j.job_id.clone())
                .collect())
        })
    }
    async fn record_status(
        &mut self,
        ws: WorkspaceId,
        capability_id: CapabilityId,
        statuses: Vec<DeliveryStatus>,
    ) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, ws)?;
            let now = t.tx.inbox_write_at.unwrap_or_else(OffsetDateTime::now_utc);
            t.tx.write(move |s| {
                for status in &statuses {
                    for job in s.outbound_jobs.iter_mut().filter(|j| {
                        j.workspace_id == ws
                            && j.capability_id == capability_id
                            && j.row.provider_job_id.as_deref() == Some(status.job_id.as_str())
                    }) {
                        job.status = Some(status.clone());
                        job.row.last_status = Some(status.clone());
                        job.row.state = match status.status {
                            DeliveryState::Delivered => OutboundJobState::Delivered,
                            DeliveryState::Failed => OutboundJobState::Failed,
                            DeliveryState::Pending | DeliveryState::Unknown(_) => job.row.state,
                        };
                        job.row.updated_at = now;
                    }
                }
            });
            Ok(())
        })
    }
}
