//! The scheduled jobs (spec §4.2 rule 2: deterministic jobs only; they keep connections alive and
//! records tidy, and never decide content): renewing expiring tokens, probing connections not
//! probed lately, polling NetGSM for delivery reports and for messages its webhook missed, and
//! purging what is past its retention.
//!
//! Each job is a function `run_<job>(deps, now) -> JobReport`, pure of scheduling: the binary's
//! scheduler calls it on a fixed interval, under the job's lock ([`Job::lock_name`],
//! [`crate::ports::JobLock`]) so that only one instance of the server runs it at a time. A job
//! never fails as a whole: each workspace, capability or line is a step of its own, and a step
//! that fails is logged and counted in [`JobReport::failed`] while the others go on. Every run
//! ends with one `info` line naming the job and its counts; no log line, ledger entry or report
//! ever holds a credential (a provider's reasons are redacted when its errors are built).
//!
//! **Which workspaces.** The jobs that reach a provider (`refresh_tokens`, `probe_all`, the two
//! NetGSM polls) run for `active` workspaces only: a workspace waiting for payment cannot connect
//! accounts, and the system does not act at the providers for a suspended one (its NetGSM webhook
//! is closed too). The purges run for every workspace.
//!
//! **Who.** What a job writes to the ledger is written by `Actor::System` with the component
//! `scheduler:<job name>`.

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_capability::{Capability, CapabilityId, Reach, StoredStatus};
use jt_connector::{ConnectorError, ProbeResult, Provider, provider_for_kind, status_after_probe};
use jt_ledger::Actor;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::Deps;
use super::capabilities::{append, locked, version_in_force};
use super::connector::{
    RECONNECT_REQUIRED, object, open_credential, probe_locked, reconnect_required, seal_credential,
};
use super::webhook::{self, Delivery};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::connectors::{Connector, DeliveryReports};
use crate::ports::{CapabilityFilter, MAX_PENDING_JOBS, PROBE_RUN_RETENTION, TenantRepos};

/// A token is renewed once it expires within this time (or has expired).
pub const REFRESH_WITHIN: Duration = Duration::days(7);

/// A connection is probed again once its last probe is at least this old (or it has none).
pub const PROBE_AFTER: Duration = Duration::hours(1);

/// The most probes `probe_all` runs at once. A probe holds its capability's row lock, and so a
/// database connection, while it waits for the provider, so this also bounds the connections
/// the job holds.
pub const PROBE_CONCURRENCY: usize = 4;

/// The window each NetGSM inbox poll asks for, ending now. Polled hourly, so consecutive windows
/// overlap by an hour; what both find is stored once.
pub const INBOX_WINDOW: Duration = Duration::hours(2);

/// The capability kind of a NetGSM SMS line, whose credentials the polls use.
const SMS_LINE: &str = "sms_line";

/// What one run of a job did. What each count means depends on the job (see each `run_*`); in
/// every job `failed` counts the steps that could not be done, each logged with its reason.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JobReport {
    /// What the run worked on.
    pub touched: u64,
    /// What it changed.
    pub changed: u64,
    /// What it left alone on purpose (changed meanwhile, or already there).
    pub skipped: u64,
    /// What it could not do.
    pub failed: u64,
}

/// The scheduled jobs, in the order they are listed everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Job {
    RefreshTokens,
    ProbeAll,
    NetgsmDlrPoll,
    NetgsmInboxPoll,
    PurgeRawBodies,
    PurgeOAuthPending,
    PurgeProbeRuns,
}

impl Job {
    /// Every job.
    pub const ALL: [Job; 7] = [
        Job::RefreshTokens,
        Job::ProbeAll,
        Job::NetgsmDlrPoll,
        Job::NetgsmInboxPoll,
        Job::PurgeRawBodies,
        Job::PurgeOAuthPending,
        Job::PurgeProbeRuns,
    ];

    /// The job's name, e.g. `"probe_all"`: in its lock's name, its log lines and its ledger
    /// entries' actor.
    pub fn name(&self) -> &'static str {
        match self {
            Job::RefreshTokens => "refresh_tokens",
            Job::ProbeAll => "probe_all",
            Job::NetgsmDlrPoll => "netgsm_dlr_poll",
            Job::NetgsmInboxPoll => "netgsm_inbox_poll",
            Job::PurgeRawBodies => "purge_raw_bodies",
            Job::PurgeOAuthPending => "purge_oauth_pending",
            Job::PurgeProbeRuns => "purge_probe_runs",
        }
    }

    /// The name of the lock a run holds ([`crate::ports::JobLock`]): `jeeta.jobs.<name>`.
    pub fn lock_name(&self) -> String {
        format!("jeeta.jobs.{}", self.name())
    }

    /// Runs the job once at `now`.
    pub async fn run(&self, deps: &Deps, now: OffsetDateTime) -> JobReport {
        match self {
            Job::RefreshTokens => run_refresh_tokens(deps, now).await,
            Job::ProbeAll => run_probe_all(deps, now).await,
            Job::NetgsmDlrPoll => run_netgsm_dlr_poll(deps, now).await,
            Job::NetgsmInboxPoll => run_netgsm_inbox_poll(deps, now).await,
            Job::PurgeRawBodies => run_purge_raw_bodies(deps, now).await,
            Job::PurgeOAuthPending => run_purge_oauth_pending(deps, now).await,
            Job::PurgeProbeRuns => run_purge_probe_runs(deps, now).await,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------------------------

/// Renews the tokens that are due, in every active workspace: each live connector capability
/// (not retired, sealed credentials, a provider adapter here) whose token expires within
/// [`REFRESH_WITHIN`] of `now` by its public facts (`connector_public.access.expires_at`; no
/// sealed credential is opened to choose), and every `x` capability whatever its expiry (X
/// rotates its refresh token at each use). A capability waiting for its owner to reconnect
/// (`connector_public.reconnect_required`) is left alone: the provider already refused its
/// token, and asking again would only repeat the refusal.
///
/// **Compare and swap.** The sealed credential is read in a transaction of its own, the provider
/// is asked with no transaction open, and the answer is written in a second transaction that
/// locks the capability and goes on only while it still holds the very sealed bytes read first
/// and is not retired. Otherwise someone changed it meanwhile (the owner reconnected, entered
/// new credentials, retired it), the answer is about a credential that is gone, and nothing is
/// written: `skipped`.
///
/// What the provider answers:
/// - a fresh credential: sealed in place of the old one, and `connector_public.access` (its
///   expiry and scopes) rewritten from it; `changed`. A renewal is routine: no ledger entry, and
///   the status is the probes' to decide;
/// - nothing to renew: nothing written;
/// - `Auth` (the provider no longer accepts the login): the capability turns `unreachable`
///   ([`jt_connector::status_after_probe`] with that error), `reconnect_required` is set, and
///   `connector.refresh_failed` is written (`{kind_key, error_kind}`); `changed` and `failed`;
/// - any other error (busy, unreachable, refused for another reason): logged, nothing written;
///   `failed`.
///
/// `touched` counts the capabilities whose token was put to the provider.
pub async fn run_refresh_tokens(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::RefreshTokens;
    let mut report = JobReport::default();
    for (ws, capabilities) in connected_capabilities(deps, job, &mut report).await {
        let ctx = system_ctx(job, ws, now);
        for capability in capabilities.iter().filter(|c| due_for_refresh(c, now)) {
            let Some(connector) = adapter_of(deps, capability) else {
                continue;
            };
            report.touched += 1;
            match refresh_one(deps, &ctx, capability, connector.as_ref()).await {
                Ok(Refreshed::Unchanged) => {}
                Ok(Refreshed::Rotated) => report.changed += 1,
                Ok(Refreshed::Superseded) => report.skipped += 1,
                Ok(Refreshed::Refused(e)) => {
                    report.changed += 1;
                    report.failed += 1;
                    tracing::warn!(
                        job = job.name(),
                        workspace_id = %ws,
                        capability_id = %capability.id,
                        kind_key = %capability.kind_key,
                        error_kind = e.kind(),
                        reason = e.reason().unwrap_or(""),
                        "the provider refused the login: the capability must be reconnected"
                    );
                }
                Ok(Refreshed::Failed(e)) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(capability.id), &Failure::Provider(e));
                }
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(capability.id), &Failure::App(e));
                }
            }
        }
    }
    finish(job, report)
}

/// Whether `capability`'s token is due for renewal at `now` (see [`run_refresh_tokens`]).
fn due_for_refresh(capability: &Capability, now: OffsetDateTime) -> bool {
    if reconnect_required(capability) {
        return false;
    }
    if provider_for_kind(&capability.kind_key) == Some(Provider::X) {
        return true;
    }
    public_time(&capability.connector_public["access"]["expires_at"])
        .is_some_and(|at| at - now <= REFRESH_WITHIN)
}

/// What became of one capability's renewal.
enum Refreshed {
    /// The provider had nothing to renew.
    Unchanged,
    /// A fresh credential was sealed.
    Rotated,
    /// The capability changed meanwhile; nothing was written.
    Superseded,
    /// The provider refused the login (`Auth`): marked unreachable, to be reconnected.
    Refused(ConnectorError),
    /// The provider failed otherwise; nothing was written.
    Failed(ConnectorError),
}

/// Renews `capability`'s token with `connector` (see [`run_refresh_tokens`]).
async fn refresh_one(
    deps: &Deps,
    ctx: &Ctx,
    capability: &Capability,
    connector: &dyn Connector,
) -> Result<Refreshed, AppError> {
    let (ws, id) = (ctx.workspace_id, capability.id);
    // Read in a transaction of its own, ended before the provider is asked.
    let read = {
        let mut repos = deps.uow.tenant(ws).await?;
        repos.capabilities().read_sealed(id).await?
    };
    let Some(read) = read else {
        return Ok(Refreshed::Superseded);
    };
    let credential = open_credential(deps, ws, &read)?;
    let answer = connector.refresh(&credential).await;
    drop(credential);

    match answer {
        Ok(None) => Ok(Refreshed::Unchanged),
        Ok(Some(fresh)) => {
            let sealed = seal_credential(deps, ctx, &fresh)?;
            let access = fresh.redact_for_public();
            drop(fresh);
            let mut repos = deps.uow.tenant(ws).await?;
            let Some(mut current) = still_holding(repos.as_mut(), id, &read).await? else {
                return Ok(Refreshed::Superseded);
            };
            let mut public = object(&current.connector_public);
            public.insert("access".to_owned(), access);
            current.connector_public = Value::Object(public);
            current.updated_at = ctx.now;
            repos.capabilities().update(current).await?;
            repos
                .capabilities()
                .set_sealed(id, Some(sealed), ctx.now)
                .await?;
            repos.commit().await?;
            Ok(Refreshed::Rotated)
        }
        Err(e @ ConnectorError::Auth { .. }) => {
            let mut repos = deps.uow.tenant(ws).await?;
            let Some(mut current) = still_holding(repos.as_mut(), id, &read).await? else {
                return Ok(Refreshed::Superseded);
            };
            current.status =
                status_after_probe(current.status, &ProbeResult::failure(0, e.clone()));
            let mut public = object(&current.connector_public);
            public.insert(RECONNECT_REQUIRED.to_owned(), json!(true));
            current.connector_public = Value::Object(public);
            current.updated_at = ctx.now;
            let kind_key = current.kind_key.clone();
            repos.capabilities().update(current).await?;
            let in_force = version_in_force(repos.as_mut()).await?;
            append(
                repos.as_mut(),
                ctx,
                "connector.refresh_failed",
                "capability",
                id,
                in_force,
                json!({ "kind_key": kind_key, "error_kind": e.kind() }),
            )
            .await?;
            repos.commit().await?;
            Ok(Refreshed::Refused(e))
        }
        Err(e) => Ok(Refreshed::Failed(e)),
    }
}

/// Capability `id`, locked, when it still holds exactly the sealed credential `read` and is not
/// retired; `None` when either changed since `read` was read.
async fn still_holding(
    repos: &mut dyn TenantRepos,
    id: CapabilityId,
    read: &[u8],
) -> Result<Option<Capability>, AppError> {
    let capability = locked(repos, id).await?;
    let sealed = repos.capabilities().read_sealed(id).await?;
    let same = capability.status != StoredStatus::Retired && sealed.as_deref() == Some(read);
    Ok(same.then_some(capability))
}

// ---------------------------------------------------------------------------------------------
// probe_all
// ---------------------------------------------------------------------------------------------

/// Probes, in every active workspace, each live connector capability (not retired, sealed
/// credentials, a provider adapter here; a declared capability without credentials is never
/// probed) whose last probe (`connector_public.health.at`) is [`PROBE_AFTER`] old or older, or
/// that was never probed. At most [`PROBE_CONCURRENCY`] probes run at once. A capability waiting
/// to be reconnected is probed too (unlike [`run_refresh_tokens`], which leaves it alone): a
/// NetGSM line refused for its IP allowlist (`auth`) recovers once the owner fixes the allowlist,
/// and a failing probe that leaves the status as it was writes no ledger entry.
///
/// Each probe is the one `connector.probe` runs (the capability locked while the provider is
/// asked, the run logged, the status following the result, `health` and `reconnect_required`
/// updated, a success verifying the account it binds, `connector.probe` written only when the
/// status changed), by the scheduler instead of a person or an agent.
///
/// `touched` counts the capabilities due, `changed` those whose status the probe moved, `skipped`
/// those that changed meanwhile (retired, or their credentials removed), `failed` those that
/// could not be probed (their credentials could not be opened, a database error, a panic).
pub async fn run_probe_all(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::ProbeAll;
    let mut report = JobReport::default();
    let semaphore = Arc::new(Semaphore::new(PROBE_CONCURRENCY));
    let mut probes = JoinSet::new();
    for (ws, capabilities) in connected_capabilities(deps, job, &mut report).await {
        for capability in capabilities
            .into_iter()
            .filter(|c| due_for_probe(c, now) && adapter_of(deps, c).is_some())
        {
            report.touched += 1;
            // Waits while four probes are out; the semaphore is never closed.
            let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
                break;
            };
            let deps = deps.clone();
            let ctx = system_ctx(job, ws, now);
            probes.spawn(async move {
                let _permit = permit;
                let probed = probe_locked(&deps, &ctx, capability.id, false).await;
                (ws, capability.id, capability.status, probed)
            });
        }
    }
    while let Some(joined) = probes.join_next().await {
        match joined {
            Ok((_, _, previous, Ok(out))) => {
                if out.status != previous {
                    report.changed += 1;
                }
            }
            Ok((_, _, _, Err(e)))
                if matches!(e.code, ErrorCode::Conflict | ErrorCode::NotFound) =>
            {
                report.skipped += 1;
            }
            Ok((ws, id, _, Err(e))) => {
                report.failed += 1;
                step_failed(job, ws, Some(id), &Failure::App(e));
            }
            Err(e) => {
                report.failed += 1;
                tracing::error!(job = job.name(), error = %e, "a probe panicked");
            }
        }
    }
    finish(job, report)
}

/// Whether `capability` is due for a probe at `now` (see [`run_probe_all`]).
fn due_for_probe(capability: &Capability, now: OffsetDateTime) -> bool {
    public_time(&capability.connector_public["health"]["at"])
        .is_none_or(|at| now - at >= PROBE_AFTER)
}

// ---------------------------------------------------------------------------------------------
// NetGSM polls
// ---------------------------------------------------------------------------------------------

/// Asks NetGSM how the messages sent earlier fared, in every active workspace: the job ids of
/// the workspace's messages whose delivery is not final yet ([`crate::ports::OutboundJobRepo`],
/// at most [`MAX_PENDING_JOBS`]) are put to its delivery reports with the credentials of each of
/// its verified SMS lines, and every status heard is recorded. A workspace with nothing waiting
/// asks nothing. (Until the next milestone stores sent messages, nothing ever waits: the
/// Postgres repository is a stub.)
///
/// `touched` counts the jobs asked about, `changed` the statuses recorded, `skipped` the jobs
/// waiting in a workspace with no verified line to ask with, `failed` the lines whose report
/// could not be had (and the workspaces that could not be read or written).
pub async fn run_netgsm_dlr_poll(deps: &Deps, _now: OffsetDateTime) -> JobReport {
    let job = Job::NetgsmDlrPoll;
    let mut report = JobReport::default();
    let Some(reports) = deps.connectors.delivery_reports(Provider::Netgsm) else {
        return finish(job, report);
    };
    // The workspace's jobs first: nothing waiting (always so until M2 stores sent messages)
    // costs one read and no provider call.
    for ws in workspaces(deps, job, true, &mut report).await {
        let pending = match pending_jobs(deps, ws).await {
            Ok(pending) => pending,
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        if pending.is_empty() {
            continue;
        }
        let lines = match live_connector_capabilities(deps, ws).await {
            Ok(capabilities) => verified_lines(&capabilities),
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        if lines.is_empty() {
            report.skipped += pending.len() as u64;
            continue;
        }
        report.touched += pending.len() as u64;
        let mut statuses = Vec::new();
        for line in lines {
            match report_for(deps, reports.as_ref(), ws, line, &pending).await {
                Ok(heard) => statuses.extend(heard),
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(line), &e);
                }
            }
        }
        if statuses.is_empty() {
            continue;
        }
        let heard = statuses.len() as u64;
        match record_statuses(deps, ws, statuses).await {
            Ok(()) => report.changed += heard,
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
            }
        }
    }
    finish(job, report)
}

/// The job ids awaiting a delivery report in `ws`.
async fn pending_jobs(deps: &Deps, ws: WorkspaceId) -> Result<Vec<String>, AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    repos
        .outbound_jobs()
        .pending_job_ids(ws, MAX_PENDING_JOBS)
        .await
}

/// The delivery reports of `jobs`, asked with line `line`'s credentials.
async fn report_for(
    deps: &Deps,
    reports: &dyn DeliveryReports,
    ws: WorkspaceId,
    line: CapabilityId,
    jobs: &[String],
) -> Result<Vec<crate::ports::connectors::DeliveryStatus>, Failure> {
    let Some(credential) = read_credential(deps, ws, line).await? else {
        return Ok(Vec::new());
    };
    let heard = reports.report(&credential, jobs).await;
    drop(credential);
    heard.map_err(Failure::Provider)
}

/// Records `statuses` in `ws`.
async fn record_statuses(
    deps: &Deps,
    ws: WorkspaceId,
    statuses: Vec<crate::ports::connectors::DeliveryStatus>,
) -> Result<(), AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    repos.outbound_jobs().record_status(ws, statuses).await?;
    repos.commit().await
}

/// Reads NetGSM's inbox backup, in every active workspace, for each verified SMS line (with
/// sealed credentials): the messages that arrived in the [`INBOX_WINDOW`] ending at `now`, both
/// ends always given. Each is stored as an inbound event of NetGSM attached to that line,
/// received at `now`, under the id NetGSM's webhook gives the same message
/// (`netgsm-mo:<gorevid>`), so a message the webhook (or an earlier poll) already stored is not
/// stored again. The provider is asked with no transaction open.
///
/// `touched` counts the lines polled, `changed` the events newly stored, `skipped` those already
/// there, `failed` the lines whose poll or storing failed.
pub async fn run_netgsm_inbox_poll(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::NetgsmInboxPoll;
    let mut report = JobReport::default();
    let Some(reports) = deps.connectors.delivery_reports(Provider::Netgsm) else {
        return finish(job, report);
    };
    for (ws, capabilities) in connected_capabilities(deps, job, &mut report).await {
        for line in verified_lines(&capabilities) {
            report.touched += 1;
            match poll_inbox(deps, reports.as_ref(), ws, line, now).await {
                Ok(deliveries) => {
                    for delivery in deliveries {
                        match delivery {
                            Delivery::Stored(_) => report.changed += 1,
                            Delivery::Duplicate | Delivery::Unrouted => report.skipped += 1,
                        }
                    }
                }
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(line), &e);
                }
            }
        }
    }
    finish(job, report)
}

/// Polls line `line`'s inbox for the window ending at `now` and stores what it finds.
async fn poll_inbox(
    deps: &Deps,
    reports: &dyn DeliveryReports,
    ws: WorkspaceId,
    line: CapabilityId,
    now: OffsetDateTime,
) -> Result<Vec<Delivery>, Failure> {
    let Some(credential) = read_credential(deps, ws, line).await? else {
        return Ok(Vec::new());
    };
    let drafts = reports.inbox(&credential, now - INBOX_WINDOW, now).await;
    drop(credential);
    let drafts = drafts.map_err(Failure::Provider)?;
    let mut repos = deps.uow.tenant(ws).await?;
    let out = webhook::store_polled(
        deps,
        repos.as_mut(),
        ws,
        Provider::Netgsm,
        Some(line),
        drafts,
        now,
    )
    .await?;
    repos.commit().await?;
    Ok(out)
}

/// The verified SMS lines among `capabilities` (all live, with credentials), in their order.
fn verified_lines(capabilities: &[Capability]) -> Vec<CapabilityId> {
    capabilities
        .iter()
        .filter(|c| c.kind_key == SMS_LINE && c.status == StoredStatus::Verified)
        .map(|c| c.id)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Purges
// ---------------------------------------------------------------------------------------------

/// Removes the raw body of every inbound event received more than
/// [`webhook::RAW_RETENTION`] (30 days) before `now`, in every workspace
/// ([`webhook::purge_raw`]); the events stay. `touched` and `changed` count the bodies removed;
/// a failure stops the purge where it was (`failed`), the next run goes on from there.
pub async fn run_purge_raw_bodies(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::PurgeRawBodies;
    let mut report = JobReport::default();
    match webhook::purge_raw(deps, webhook::raw_cutoff(now)).await {
        Ok(removed) => {
            report.touched = removed;
            report.changed = removed;
        }
        Err(e) => {
            report.failed += 1;
            tracing::warn!(
                job = job.name(),
                code = e.code.as_str(),
                error = %e,
                "the purge stopped"
            );
        }
    }
    finish(job, report)
}

/// Deletes, in every workspace, the pending OAuth flows that expired before `now`
/// (`OAuthPendingRepo::purge_expired`). `touched` and `changed` count the flows deleted,
/// `failed` the workspaces that could not be purged.
pub async fn run_purge_oauth_pending(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::PurgeOAuthPending;
    let mut report = JobReport::default();
    for ws in workspaces(deps, job, false, &mut report).await {
        let purged = async {
            let mut repos = deps.uow.tenant(ws).await?;
            let n = repos.oauth_pending().purge_expired(now).await?;
            if n > 0 {
                repos.commit().await?;
            }
            Ok::<u64, AppError>(n)
        };
        count_purged(job, ws, purged.await, &mut report);
    }
    finish(job, report)
}

/// Deletes, in every workspace, the probe runs made more than [`PROBE_RUN_RETENTION`] (30 days)
/// before `now` (`ProbeRunRepo::purge_before`). `touched` and `changed` count the runs deleted,
/// `failed` the workspaces that could not be purged.
pub async fn run_purge_probe_runs(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::PurgeProbeRuns;
    let mut report = JobReport::default();
    let cutoff = now - PROBE_RUN_RETENTION;
    for ws in workspaces(deps, job, false, &mut report).await {
        let purged = async {
            let mut repos = deps.uow.tenant(ws).await?;
            let n = repos.probe_runs().purge_before(cutoff).await?;
            if n > 0 {
                repos.commit().await?;
            }
            Ok::<u64, AppError>(n)
        };
        count_purged(job, ws, purged.await, &mut report);
    }
    finish(job, report)
}

/// Counts one workspace's purge into `report`.
fn count_purged(job: Job, ws: WorkspaceId, purged: Result<u64, AppError>, report: &mut JobReport) {
    match purged {
        Ok(n) => {
            report.touched += n;
            report.changed += n;
        }
        Err(e) => {
            report.failed += 1;
            step_failed(job, ws, None, &Failure::App(e));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/// Why a step failed: the application (the database, a sealed blob) or the provider.
enum Failure {
    App(AppError),
    Provider(ConnectorError),
}

impl From<AppError> for Failure {
    fn from(e: AppError) -> Failure {
        Failure::App(e)
    }
}

/// Logs a failed step: its workspace, its capability when it had one, and why, never more (a
/// provider's reason is redacted when its error is built; an application error carries no
/// secret).
fn step_failed(job: Job, ws: WorkspaceId, capability: Option<CapabilityId>, failure: &Failure) {
    let capability = capability.map(|id| id.to_string());
    match failure {
        Failure::App(e) => tracing::warn!(
            job = job.name(),
            workspace_id = %ws,
            capability_id = capability.as_deref().unwrap_or("-"),
            code = e.code.as_str(),
            error = %e,
            "a job step failed"
        ),
        Failure::Provider(e) => tracing::warn!(
            job = job.name(),
            workspace_id = %ws,
            capability_id = capability.as_deref().unwrap_or("-"),
            error_kind = e.kind(),
            reason = e.reason().unwrap_or(""),
            "a job step failed at the provider"
        ),
    }
}

/// The run's summary line, and its report.
fn finish(job: Job, report: JobReport) -> JobReport {
    tracing::info!(
        job = job.name(),
        touched = report.touched,
        changed = report.changed,
        skipped = report.skipped,
        failed = report.failed,
        "job finished"
    );
    report
}

/// The ids of the workspaces a job runs for: the active ones, or every one; none (and one
/// failure counted) when they cannot be listed.
async fn workspaces(
    deps: &Deps,
    job: Job,
    active_only: bool,
    report: &mut JobReport,
) -> Vec<WorkspaceId> {
    let listed = async {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_list().await
    };
    match listed.await {
        Ok(all) => all
            .into_iter()
            .filter(|w| !active_only || w.status == WorkspaceStatus::Active)
            .map(|w| w.id)
            .collect(),
        Err(e) => {
            report.failed += 1;
            tracing::warn!(
                job = job.name(),
                code = e.code.as_str(),
                error = %e,
                "the workspaces could not be listed"
            );
            Vec::new()
        }
    }
}

/// Each active workspace with its live connector capabilities (reached through a connector, not
/// retired, with sealed credentials), oldest first; a workspace that cannot be read is counted as
/// a failure and left out.
async fn connected_capabilities(
    deps: &Deps,
    job: Job,
    report: &mut JobReport,
) -> Vec<(WorkspaceId, Vec<Capability>)> {
    let mut out = Vec::new();
    for ws in workspaces(deps, job, true, report).await {
        match live_connector_capabilities(deps, ws).await {
            Ok(capabilities) => out.push((ws, capabilities)),
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
            }
        }
    }
    out
}

/// Workspace `ws`'s live connector capabilities (reached through a connector, not retired, with
/// sealed credentials), oldest first.
async fn live_connector_capabilities(
    deps: &Deps,
    ws: WorkspaceId,
) -> Result<Vec<Capability>, AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    let all = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?;
    Ok(all
        .into_iter()
        .filter(|c| {
            c.reach == Reach::Connector && c.status != StoredStatus::Retired && c.has_sealed_config
        })
        .collect())
}

/// The adapter that serves `capability`'s kind, when there is one here.
fn adapter_of(deps: &Deps, capability: &Capability) -> Option<Arc<dyn Connector>> {
    provider_for_kind(&capability.kind_key).and_then(|p| deps.connectors.connector(p))
}

/// Capability `id`'s credential, read in a transaction of its own (ended before anything else
/// happens) and opened; `None` when it has none any more.
async fn read_credential(
    deps: &Deps,
    ws: WorkspaceId,
    id: CapabilityId,
) -> Result<Option<jt_connector::Credential>, AppError> {
    let sealed = {
        let mut repos = deps.uow.tenant(ws).await?;
        repos.capabilities().read_sealed(id).await?
    };
    sealed
        .map(|sealed| open_credential(deps, ws, &sealed))
        .transpose()
}

/// The context a job's step in workspace `ws` acts in: the system, as `scheduler:<job>`, with no
/// permission of its own (the jobs call internal steps, not the permission-checked use cases),
/// at `now`.
fn system_ctx(job: Job, ws: WorkspaceId, now: OffsetDateTime) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: format!("scheduler:{}", job.name()),
        },
        permissions: BTreeSet::new(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// The RFC 3339 time a public field holds, if it holds one.
fn public_time(value: &Value) -> Option<OffsetDateTime> {
    value
        .as_str()
        .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
}
