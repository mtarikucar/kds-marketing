//! Runtime probes and bounded Prometheus exposition. No error chains enter telemetry.
use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use jt_app::{
    error::AppError,
    ports::{UnitOfWork, ops::*},
    usecases::jobs::Job,
};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    fmt::Write as _,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub struct RuntimeOps {
    pub pool: PgPool,
    pub uow: Arc<dyn UnitOfWork>,
    pub signals: Arc<OpsSignals>,
    pub files: Arc<dyn jt_app::ports::files::FileStore>,
    pub files_dir: Option<PathBuf>,
    pub recovery_dir: Option<PathBuf>,
    pub started_at: OffsetDateTime,
    pub boot_complete: AtomicBool,
}
impl RuntimeOps {
    pub async fn ready(&self) -> bool {
        if !self.boot_complete.load(Ordering::Acquire) {
            return false;
        }
        let (database, files) = tokio::join!(
            tokio::time::timeout(
                Duration::from_secs(2),
                sqlx::query("SELECT 1").execute(&self.pool)
            ),
            self.files_ready()
        );
        matches!(database, Ok(Ok(_))) && files
    }
    async fn files_ready(&self) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_secs(2), self.files.probe()).await,
            Ok(Ok(()))
        )
    }
    pub fn booted(&self) {
        self.boot_complete.store(true, Ordering::Release);
    }
}
#[async_trait]
impl OpsSnapshot for RuntimeOps {
    async fn snapshot(&self) -> Result<OpsHealthOut, AppError> {
        let now = OffsetDateTime::now_utc();
        let mut out = OpsHealthOut::unknown(now);
        out.process_started_at = self.started_at;
        out.boot_complete = self.boot_complete.load(Ordering::Acquire);
        out.database_pool_size = self.pool.size();
        out.database_pool_idle = self.pool.num_idle();
        out.database = match tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("SELECT 1").execute(&self.pool),
        )
        .await
        {
            Ok(Ok(_)) => HealthState::Ok,
            _ => HealthState::Degraded,
        };
        let files = self.files_dir.clone();
        let recovery = self.recovery_dir.clone();
        let probes = tokio::task::spawn_blocking(move || {
            let disk = files.as_deref().and_then(disk_free);
            let backup = marker(
                recovery.as_deref(),
                "backup-status.json",
                "completed_at",
                now,
                24 * 60 * 60,
            );
            let wal = marker(
                recovery.as_deref(),
                "wal-status.json",
                "archived_at",
                now,
                15 * 60,
            );
            (disk, backup, wal)
        });
        let (files_ok, probes) = tokio::join!(
            self.files_ready(),
            tokio::time::timeout(Duration::from_secs(2), probes)
        );
        out.files = if files_ok {
            HealthState::Ok
        } else {
            HealthState::Degraded
        };
        if let Ok(Ok((disk, backup, wal))) = probes {
            if let Some((available, total)) = disk {
                out.disk_available_bytes = Some(available);
                out.disk = disk_state(available, total);
            }
            out.backup = RecoveryFreshness {
                last_backup_at: backup.0,
                last_wal_archive_at: wal.0,
                backup_state: backup.1,
                wal_state: wal.1,
            };
        }
        let s = self.signals.read();
        out.webhooks = s.webhooks;
        out.jobs = Job::ALL
            .iter()
            .map(|j| {
                s.jobs.get(j.name()).cloned().unwrap_or(JobHealth {
                    name: j.name().into(),
                    last_success_at: None,
                    failed_total: 0,
                })
            })
            .collect();
        if out.database == HealthState::Ok {
            let projected = tokio::time::timeout(Duration::from_secs(2), async {
                let mut r = self.uow.platform().await?;
                r.connector_health_counts().await
            })
            .await;
            match projected {
                Ok(Ok(rows)) => {
                    out.connectors = rows;
                    out.connectors_state = HealthState::Ok;
                }
                _ => out.connectors_state = HealthState::Degraded,
            }
        }
        Ok(out)
    }
}
// GNU coreutils is part of the deployment image. Fixed argv (no shell) avoids unsafe FFI;
// workspace forbids unsafe Rust and the lockfile has no safe statvfs wrapper.
fn disk_free(path: &Path) -> Option<(u64, u64)> {
    let out = std::process::Command::new("/usr/bin/df")
        .args(["-Pk", "--"])
        .arg(path)
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.len() > 8192 {
        return None;
    }
    let text = std::str::from_utf8(&out.stdout).ok()?;
    let values: Vec<_> = text.lines().nth(1)?.split_whitespace().collect();
    Some((
        values.get(3)?.parse::<u64>().ok()?.checked_mul(1024)?,
        values.get(1)?.parse::<u64>().ok()?.checked_mul(1024)?,
    ))
}
/// Minimal artifact: {"completed_at":"RFC3339"} or {"archived_at":"RFC3339"}.
/// Writers publish atomically only after verified success; absence is never freshness.
pub fn marker(
    dir: Option<&Path>,
    name: &str,
    field: &str,
    now: OffsetDateTime,
    max_age: i64,
) -> (Option<OffsetDateTime>, HealthState) {
    let read = || -> Option<OffsetDateTime> {
        let mut bytes = Vec::new();
        std::fs::File::open(dir?.join(name))
            .ok()?
            .take(4097)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 4096 {
            return None;
        }
        let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        OffsetDateTime::parse(json.get(field)?.as_str()?, &Rfc3339).ok()
    };
    match read() {
        None => (None, HealthState::Unknown),
        Some(at) if at > now || now - at > time::Duration::seconds(max_age) => {
            (Some(at), HealthState::Degraded)
        }
        Some(at) => (Some(at), HealthState::Ok),
    }
}
#[derive(Clone)]
struct ProcessState {
    readiness: Option<Arc<RuntimeOps>>,
    ops: Arc<dyn OpsSnapshot>,
    signals: Arc<OpsSignals>,
    token: Arc<str>,
}
pub fn router(
    ops: Arc<dyn OpsSnapshot>,
    signals: Arc<OpsSignals>,
    token: &str,
    readiness: Option<Arc<RuntimeOps>>,
) -> Router {
    Router::new()
        .route("/readyz", get(ready))
        .route("/metrics", get(metrics))
        .with_state(ProcessState {
            readiness,
            ops,
            signals,
            token: token.into(),
        })
}
async fn ready(State(s): State<ProcessState>) -> Response {
    let ok = match &s.readiness {
        Some(probe) => probe.ready().await,
        None => false,
    };
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"ok":ok})),
    )
        .into_response()
}
async fn metrics(State(s): State<ProcessState>, headers: HeaderMap) -> Response {
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    // Compare fixed-size hashes so differing input lengths do not short-circuit the secret check.
    use sha2::{Digest, Sha256};
    let a = Sha256::digest(supplied.as_bytes());
    let b = Sha256::digest(s.token.as_bytes());
    if s.token.is_empty() || !bool::from(a.ct_eq(&b)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match s.ops.snapshot().await {
        Ok(out) => {
            let body = prometheus(&out, &s.signals);
            if body.len() > 256 * 1024 {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            (
                [
                    (header::CONTENT_TYPE, "text/plain; version=0.0.4"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                body,
            )
                .into_response()
        }
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
pub fn prometheus(out: &OpsHealthOut, signals: &OpsSignals) -> String {
    let signals = signals.read();
    let mut text = String::from("# Counters reset on process start; earlier history is unknown.\n");
    for (name, value) in [
        (
            "process_start_time_seconds",
            out.process_started_at.unix_timestamp() as f64,
        ),
        ("history_known", 0.0),
        (
            "database_reachable",
            f64::from(out.database == HealthState::Ok),
        ),
        (
            "connectors_observed",
            f64::from(out.connectors_state == HealthState::Ok),
        ),
        ("database_pool_size", f64::from(out.database_pool_size)),
        ("database_pool_idle", out.database_pool_idle as f64),
        (
            "disk_available_bytes",
            out.disk_available_bytes.unwrap_or(0) as f64,
        ),
        (
            "disk_observed",
            f64::from(out.disk_available_bytes.is_some()),
        ),
        (
            "backup_healthy",
            f64::from(out.backup.backup_state == HealthState::Ok),
        ),
        (
            "wal_healthy",
            f64::from(out.backup.wal_state == HealthState::Ok),
        ),
    ] {
        let _ = writeln!(text, "jeeta_{name} {value}");
    }
    for (outcome, value) in [
        ("accepted", out.webhooks.accepted),
        ("unrouted", out.webhooks.unrouted),
        ("unresolved", out.webhooks.unresolved),
    ] {
        let _ = writeln!(
            text,
            "jeeta_webhooks_total{{outcome=\"{outcome}\"}} {value}"
        );
    }
    for job in Job::ALL {
        let _ = writeln!(
            text,
            "jeeta_job_successes_total{{kind=\"{}\"}} {}",
            job.name(),
            signals.job_successes.get(job.name()).copied().unwrap_or(0)
        );
        let row = out.jobs.iter().find(|j| j.name == job.name());
        let _ = writeln!(
            text,
            "jeeta_job_failures_total{{kind=\"{}\"}} {}",
            job.name(),
            row.map_or(0, |j| j.failed_total)
        );
        if let Some(at) = row.and_then(|j| j.last_success_at) {
            let _ = writeln!(
                text,
                "jeeta_job_last_success_seconds{{kind=\"{}\"}} {}",
                job.name(),
                at.unix_timestamp()
            );
        }
    }
    let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
    for c in &out.connectors {
        let kind = if jt_connector::provider_for_kind(&c.kind_key).is_some() {
            c.kind_key.as_str()
        } else {
            "other"
        };
        let n = counts.entry(kind).or_default();
        *n = n.saturating_add(c.reconnect_required);
    }
    for (kind, n) in counts {
        let _ = writeln!(
            text,
            "jeeta_connector_reconnect_required{{kind=\"{kind}\"}} {n}"
        );
    }
    for (route, h) in signals.http {
        for (name, value) in [
            ("requests_total", h.total as f64),
            ("errors_total", h.errors as f64),
            ("duration_seconds_sum", h.seconds),
        ] {
            let _ = writeln!(text, "jeeta_http_{name}{{route=\"{route}\"}} {value}");
        }
    }
    text
}

use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
};
use std::time::Instant;
/// One line per request: method, route template, status and duration. Never the raw path or
/// query, so no token in a URL reaches the log.
pub async fn access_log(
    axum::extract::State(signals): axum::extract::State<Arc<jt_app::ports::ops::OpsSignals>>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let route = loggable_route(
        req.extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    )
    .to_owned();
    let started = Instant::now();
    let resp = next.run(req).await;
    signals.http(
        &route,
        resp.status().as_u16(),
        started.elapsed().as_secs_f64(),
    );
    tracing::info!(
        target: "jeeta::access",
        %method,
        route,
        status = resp.status().as_u16(),
        ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "request"
    );
    resp
}

/// What the access log shows as a request's route: its template (`/api/team/{membership_id}`),
/// never the path; `-` when no route matched (panel pages and files, `/invite/<token>` among
/// them); `<redacted>` for the operator console's login.
pub fn loggable_route(template: Option<&str>) -> &str {
    match template {
        None => "-",
        Some("/api/platform/login") => "<redacted>",
        Some(template) => template,
    }
}

/// A hard cap independent of user-supplied target/span directives: rmcp info includes session IDs.
pub fn install_tracing(log_filter: &str, json: bool) {
    let _ = process_started_at();
    use std::io::IsTerminal;
    use tracing_subscriber::{EnvFilter, prelude::*};
    let filter =
        EnvFilter::try_new(log_filter).unwrap_or_else(|_| EnvFilter::new("info,rmcp=warn"));
    let cap = tracing_subscriber::filter::filter_fn(|metadata| {
        !(metadata.target() == "rmcp" || metadata.target().starts_with("rmcp::"))
            || *metadata.level() <= tracing::Level::WARN
    });
    let registry = tracing_subscriber::registry().with(filter).with(cap);
    let layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    if json {
        registry.with(layer.json().with_ansi(false)).init();
    } else {
        registry
            .with(layer.compact().with_ansi(std::io::stderr().is_terminal()))
            .init();
    }
}

/// Capacity is degraded strictly below ten percent; a zero-size filesystem is unusable.
pub fn disk_state(available: u64, total: u64) -> HealthState {
    if total == 0 || u128::from(available) * 10 < u128::from(total) {
        HealthState::Degraded
    } else {
        HealthState::Ok
    }
}
static PROCESS_STARTED: std::sync::OnceLock<OffsetDateTime> = std::sync::OnceLock::new();
pub fn process_started_at() -> OffsetDateTime {
    *PROCESS_STARTED.get_or_init(OffsetDateTime::now_utc)
}
