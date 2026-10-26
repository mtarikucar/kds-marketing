//! Operational metadata and process-local counters. No tenant bodies or credentials.
use crate::error::AppError;
use async_trait::async_trait;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Ok,
    Degraded,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobHealth {
    pub name: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_success_at: Option<OffsetDateTime>,
    pub failed_total: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectorHealthCount {
    pub workspace_id: WorkspaceId,
    pub kind_key: String,
    pub reconnect_required: u64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_before: Option<OffsetDateTime>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WebhookCounters {
    pub accepted: u64,
    pub unrouted: u64,
    pub unresolved: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecoveryFreshness {
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_backup_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_wal_archive_at: Option<OffsetDateTime>,
    pub backup_state: HealthState,
    pub wal_state: HealthState,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OpsHealthOut {
    #[serde(with = "time::serde::rfc3339")]
    pub observed_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub process_started_at: OffsetDateTime,
    /// Counters reset at process_started_at; no pre-start history is available.
    pub history: String,
    pub boot_complete: bool,
    pub database: HealthState,
    pub files: HealthState,
    pub disk: HealthState,
    pub disk_available_bytes: Option<u64>,
    pub database_pool_size: u32,
    pub database_pool_idle: usize,
    pub jobs: Vec<JobHealth>,
    pub connectors: Vec<ConnectorHealthCount>,
    pub connectors_state: HealthState,
    pub webhooks: WebhookCounters,
    pub backup: RecoveryFreshness,
}
impl OpsHealthOut {
    pub fn unknown(at: OffsetDateTime) -> Self {
        Self {
            observed_at: at,
            process_started_at: at,
            history: "unknown_before_process_start".into(),
            boot_complete: false,
            database: HealthState::Unknown,
            files: HealthState::Unknown,
            disk: HealthState::Unknown,
            disk_available_bytes: None,
            database_pool_size: 0,
            database_pool_idle: 0,
            jobs: vec![],
            connectors: vec![],
            connectors_state: HealthState::Unknown,
            webhooks: WebhookCounters::default(),
            backup: RecoveryFreshness {
                last_backup_at: None,
                last_wal_archive_at: None,
                backup_state: HealthState::Unknown,
                wal_state: HealthState::Unknown,
            },
        }
    }
    pub fn ready(&self) -> bool {
        self.boot_complete && self.database == HealthState::Ok && self.files == HealthState::Ok
    }
}
#[async_trait]
pub trait OpsSnapshot: Send + Sync {
    async fn snapshot(&self) -> Result<OpsHealthOut, AppError>;
}
/// Fail-closed default for contexts with no runtime probes (including stdio).
pub struct UnknownOps;
#[async_trait]
impl OpsSnapshot for UnknownOps {
    async fn snapshot(&self) -> Result<OpsHealthOut, AppError> {
        Ok(OpsHealthOut::unknown(OffsetDateTime::UNIX_EPOCH))
    }
}
#[derive(Clone, Copy)]
pub enum WebhookOutcome {
    Accepted,
    Unrouted,
    Unresolved,
}
#[derive(Clone, Debug, Default)]
pub struct HttpCounts {
    pub total: u64,
    pub errors: u64,
    pub seconds: f64,
}
/// Callers supply catalog templates and known job names; unknown values collapse to `other`.
#[derive(Default)]
pub struct OpsSignals {
    inner: Mutex<SignalState>,
}
#[derive(Clone, Default)]
pub struct SignalState {
    pub webhooks: WebhookCounters,
    pub jobs: BTreeMap<String, JobHealth>,
    pub http: BTreeMap<String, HttpCounts>,
    pub job_successes: BTreeMap<String, u64>,
}
impl OpsSignals {
    pub fn read(&self) -> SignalState {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn webhook(&self, outcome: WebhookOutcome) {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let n = match outcome {
            WebhookOutcome::Accepted => &mut s.webhooks.accepted,
            WebhookOutcome::Unrouted => &mut s.webhooks.unrouted,
            WebhookOutcome::Unresolved => &mut s.webhooks.unresolved,
        };
        *n = n.saturating_add(1);
    }
    pub fn job(&self, name: &str, at: OffsetDateTime, failed: u64) {
        if !crate::usecases::jobs::Job::ALL
            .iter()
            .any(|j| j.name() == name)
        {
            return;
        }
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let j = s.jobs.entry(name.into()).or_insert(JobHealth {
            name: name.into(),
            last_success_at: None,
            failed_total: 0,
        });
        if failed == 0 {
            j.last_success_at = Some(at);
        }
        j.failed_total = j.failed_total.saturating_add(failed);
        if failed == 0 {
            let n = s.job_successes.entry(name.into()).or_default();
            *n = n.saturating_add(1);
        }
    }
    pub fn http(&self, route: &str, status: u16, seconds: f64) {
        let route = if crate::catalog::CATALOG
            .iter()
            .any(|r| r.panel_route.is_some_and(|(_, p)| p == route))
            || matches!(
                route,
                "/healthz" | "/readyz" | "/metrics" | "/mcp" | "/hooks/meta" | "/hooks/netgsm"
            ) {
            route
        } else {
            "other"
        };
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let h = s.http.entry(route.into()).or_default();
        h.total = h.total.saturating_add(1);
        h.errors = h.errors.saturating_add(u64::from(status >= 400));
        if seconds.is_finite() && seconds >= 0.0 {
            h.seconds += seconds;
        }
    }
}
