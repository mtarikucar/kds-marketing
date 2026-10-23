//! The scheduled jobs (spec §4.2 rule 2: deterministic jobs only; they keep connections alive and
//! records tidy, and never decide content): renewing expiring tokens, probing connections not
//! probed lately, polling NetGSM for delivery reports and for messages its webhook missed, and
//! purging what is past its retention.
//!
//! Each job is a function `run_<job>(deps, now) -> JobReport`, pure of scheduling: the binary's
//! scheduler calls it on a fixed interval, under the job's lock ([`Job::lock_name`],
//! [`crate::ports::JobLock`]) so that two runs of the same job never overlap. A job never fails
//! as a whole: each workspace, capability or line is a step of its own, and a step that fails is
//! logged and counted in [`JobReport::failed`] while the others go on. Every run ends with one
//! summary line naming the job and its counts (`info`, or `debug` when the run found nothing to
//! do); no log line, ledger entry or report ever holds a credential (a provider's reasons are
//! redacted when its errors are built).
//!
//! **Which workspaces.** `probe_all` and the NetGSM delivery-report poll run for `active`
//! workspaces only: they act at the provider on the tenant's behalf, which a workspace waiting
//! for payment or a suspended one does not get. The NetGSM inbox poll runs for `active` and
//! `pending_payment` workspaces, as the webhooks take in for them (NetGSM's hook and Meta's
//! routing both accept `active` and `pending_payment` and refuse `suspended`): it backs up the
//! inbound messages its webhook missed, so a payment hold does not lose them. `refresh_tokens`
//! runs for `active` and `pending_payment` workspaces too: renewing only keeps an existing grant
//! alive, and a payment hold must not turn into reconnecting every account. A suspended
//! workspace is left alone. The NetGSM polls go only to the workspaces holding a verified SMS
//! line, found with one platform-wide read before any of their transactions opens. The purges
//! run for every workspace.
//!
//! **Who.** What a job writes to the ledger is written by `Actor::System` with the component
//! `scheduler:<job name>`.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use jt_capability::{Capability, CapabilityId, Reach, StoredStatus};
use jt_connector::{
    ConnectorError, Credential, ProbeResult, Provider, provider_for_kind, status_after_probe,
};
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
use crate::ports::connectors::{Connector, DeliveryReports, DeliveryStatus};
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

/// The workspaces the jobs that act at a provider run for.
const ACTIVE: &[WorkspaceStatus] = &[WorkspaceStatus::Active];

/// The workspaces `refresh_tokens` runs for: a payment hold keeps its grants alive.
const RENEWING: &[WorkspaceStatus] = &[WorkspaceStatus::Active, WorkspaceStatus::PendingPayment];

/// The workspaces the NetGSM inbox poll runs for: those whose webhooks take in events
/// (`webhook::takes_routed_events`), so a payment hold keeps its inbound messages.
const RECEIVING: &[WorkspaceStatus] = &[WorkspaceStatus::Active, WorkspaceStatus::PendingPayment];

/// Every workspace (the purges).
const EVERY: &[WorkspaceStatus] = &[
    WorkspaceStatus::Active,
    WorkspaceStatus::PendingPayment,
    WorkspaceStatus::Suspended,
];

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
    MailInboxPoll,
    IysSync,
    PurgeRawBodies,
    PurgeOAuthPending,
    PurgeProbeRuns,
    OutboxRecover,
    InboxConsume,
    ResponseSla,
    SnoozeWake,
}

impl Job {
    /// Every job.
    pub const ALL: [Job; 13] = [
        Job::RefreshTokens,
        Job::ProbeAll,
        Job::NetgsmDlrPoll,
        Job::NetgsmInboxPoll,
        Job::MailInboxPoll,
        Job::IysSync,
        Job::PurgeRawBodies,
        Job::PurgeOAuthPending,
        Job::PurgeProbeRuns,
        Job::OutboxRecover,
        Job::InboxConsume,
        Job::ResponseSla,
        Job::SnoozeWake,
    ];

    /// The job's name, e.g. `"probe_all"`: in its lock's name, its log lines and its ledger
    /// entries' actor.
    pub fn name(&self) -> &'static str {
        match self {
            Job::RefreshTokens => "refresh_tokens",
            Job::ProbeAll => "probe_all",
            Job::NetgsmDlrPoll => "netgsm_dlr_poll",
            Job::NetgsmInboxPoll => "netgsm_inbox_poll",
            Job::MailInboxPoll => "mail_inbox_poll",
            Job::IysSync => "iys_sync",
            Job::PurgeRawBodies => "purge_raw_bodies",
            Job::PurgeOAuthPending => "purge_oauth_pending",
            Job::PurgeProbeRuns => "purge_probe_runs",
            Job::OutboxRecover => "outbox_recover",
            Job::InboxConsume => "inbox_consume",
            Job::ResponseSla => "response_sla",
            Job::SnoozeWake => "snooze_wake",
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
            Job::MailInboxPoll => run_mail_inbox_poll(deps, now).await,
            Job::IysSync => run_iys_sync(deps, now).await,
            Job::PurgeRawBodies => run_purge_raw_bodies(deps, now).await,
            Job::PurgeOAuthPending => run_purge_oauth_pending(deps, now).await,
            Job::PurgeProbeRuns => run_purge_probe_runs(deps, now).await,
            Job::OutboxRecover => run_outbox_recover(deps, now).await,
            Job::InboxConsume => run_inbox_consume(deps, now).await,
            Job::ResponseSla => run_response_sla(deps, now).await,
            Job::SnoozeWake => run_snooze_wake(deps, now).await,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------------------------

/// Renews the tokens that are due, in every `active` or `pending_payment` workspace: each live
/// connector capability (not retired, sealed credentials, a provider adapter here) whose token
/// expires within [`REFRESH_WITHIN`] of `now` by its public facts
/// (`connector_public.access.expires_at`; no sealed credential is opened to choose), and every
/// `x` capability whatever its expiry (X rotates its refresh token at each use).
///
/// A capability waiting for its owner to reconnect (`connector_public.reconnect_required`) is
/// left alone, unless it is X's: an X access token lives two hours, so a probe made after it
/// lapsed (the server was down, the platform's client secret was wrong for a while) flags the
/// capability although its refresh token still holds; renewing is what brings it back.
///
/// **Compare and swap.** The sealed credential is read in a transaction of its own, the provider
/// is asked with no transaction open, and the answer is written in a second transaction that
/// locks the capability and goes on only while it still holds the very sealed bytes read first
/// and is not retired. Otherwise someone changed it meanwhile (the owner reconnected, entered
/// new credentials, retired it), the answer is about a credential that is gone, and nothing is
/// written: `skipped`.
///
/// What the provider answers:
/// - a fresh credential: sealed in place of the old one, `connector_public.access` (its expiry
///   and scopes) rewritten from it and `reconnect_required` cleared (a fresh credential is
///   sealed); `changed`. A capability that was flagged or `unreachable` is then probed at once,
///   as `connector.probe` does, so its status follows the new credential. A renewal is routine:
///   no ledger entry of its own. Should the write fail (the database, not a lost
///   compare-and-swap), it is tried once more, the provider may already have retired the old
///   credential; failing again, it is logged as an error and counted in `failed`;
/// - nothing to renew: nothing written;
/// - `Auth` (the provider no longer accepts the login): the capability turns `unreachable`
///   ([`jt_connector::status_after_probe`] with that error) and `reconnect_required` is set;
///   `connector.refresh_failed` (`{kind_key, error_kind}`) is written only when the flag flips,
///   so an X capability refused hour after hour is ledgered once; `failed`, and `changed` when
///   anything was written;
/// - any other error (busy, unreachable, refused for another reason): logged, nothing written;
///   `failed`.
///
/// `touched` counts the capabilities whose token was put to the provider.
pub async fn run_refresh_tokens(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::RefreshTokens;
    let mut report = JobReport::default();
    for (ws, capabilities) in connected_capabilities(deps, job, RENEWING, &mut report).await {
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
                Ok(Refreshed::Unsaved) => report.failed += 1,
                Ok(Refreshed::Refused {
                    error,
                    wrote,
                    flipped,
                }) => {
                    report.failed += 1;
                    if wrote {
                        report.changed += 1;
                    }
                    tracing::warn!(
                        job = job.name(),
                        workspace_id = %ws,
                        capability_id = %capability.id,
                        kind_key = %capability.kind_key,
                        error_kind = error.kind(),
                        reason = error.reason().unwrap_or(""),
                        first = flipped,
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
    // X: every run, flagged or not (its refresh token outlives a lapsed access token).
    if provider_for_kind(&capability.kind_key) == Some(Provider::X) {
        return true;
    }
    if reconnect_required(capability) {
        return false;
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
    /// The provider gave a fresh credential that could not be saved, twice (logged as an error).
    Unsaved,
    /// The provider refused the login (`Auth`): marked unreachable, to be reconnected. `wrote`
    /// when the status or the flag changed, `flipped` when the flag did (and the ledger entry was
    /// written).
    Refused {
        error: ConnectorError,
        wrote: bool,
        flipped: bool,
    },
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
        Ok(Some(fresh)) => save_fresh(deps, ctx, id, &read, fresh).await,
        Err(error @ ConnectorError::Auth { .. }) => refused(deps, ctx, id, &read, error).await,
        Err(e) => Ok(Refreshed::Failed(e)),
    }
}

/// Seals `fresh` in place of `read` (see [`run_refresh_tokens`]): the write tried twice, then the
/// capability probed when it was down.
async fn save_fresh(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    read: &[u8],
    fresh: Credential,
) -> Result<Refreshed, AppError> {
    let sealed = seal_credential(deps, ctx, &fresh)?;
    let access = fresh.redact_for_public();
    drop(fresh);
    let mut saved = write_fresh(deps, ctx, id, read, &sealed, &access).await;
    if let Err(e) = &saved {
        tracing::warn!(
            job = Job::RefreshTokens.name(),
            workspace_id = %ctx.workspace_id,
            capability_id = %id,
            code = e.code.as_str(),
            error = %e,
            "a renewed credential could not be saved; trying once more"
        );
        saved = write_fresh(deps, ctx, id, read, &sealed, &access).await;
    }
    match saved {
        Ok(None) => Ok(Refreshed::Superseded),
        Ok(Some(was_down)) => {
            if was_down && let Err(e) = probe_locked(deps, ctx, id, false).await {
                // The renewal holds; the next probe tells the status.
                step_failed(
                    Job::RefreshTokens,
                    ctx.workspace_id,
                    Some(id),
                    &Failure::App(e),
                );
            }
            Ok(Refreshed::Rotated)
        }
        Err(e) => {
            tracing::error!(
                job = Job::RefreshTokens.name(),
                workspace_id = %ctx.workspace_id,
                capability_id = %id,
                code = e.code.as_str(),
                error = %e,
                "a renewed credential could not be saved: the provider may already have retired \
                 the old one, so the capability may have to be reconnected"
            );
            Ok(Refreshed::Unsaved)
        }
    }
}

/// One attempt at sealing a renewed credential: `None` when the capability changed since `read`
/// (nothing written), else whether it was down (flagged or `unreachable`) before.
async fn write_fresh(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    read: &[u8],
    sealed: &[u8],
    access: &Value,
) -> Result<Option<bool>, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(mut current) = still_holding(repos.as_mut(), id, read).await? else {
        return Ok(None);
    };
    let was_down = reconnect_required(&current) || current.status == StoredStatus::Unreachable;
    let mut public = object(&current.connector_public);
    // The renewal is the same app's token: the app that issued it stays recorded.
    let mut access = access.clone();
    if let Some(app) = current.connector_public["access"].get("app").cloned()
        && let Value::Object(fields) = &mut access
    {
        fields.insert("app".to_owned(), app);
    }
    public.insert("access".to_owned(), access);
    public.insert(RECONNECT_REQUIRED.to_owned(), json!(false));
    current.connector_public = Value::Object(public);
    current.updated_at = ctx.now;
    repos.capabilities().update(current).await?;
    repos
        .capabilities()
        .set_sealed(id, Some(sealed.to_vec()), ctx.now)
        .await?;
    repos.commit().await?;
    Ok(Some(was_down))
}

/// Records the provider's refusal of `read`'s login (see [`run_refresh_tokens`]).
async fn refused(
    deps: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    read: &[u8],
    error: ConnectorError,
) -> Result<Refreshed, AppError> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(mut current) = still_holding(repos.as_mut(), id, read).await? else {
        return Ok(Refreshed::Superseded);
    };
    let flipped = !reconnect_required(&current);
    let status = status_after_probe(current.status, &ProbeResult::failure(0, error.clone()));
    if !flipped && status == current.status {
        // Already waiting for its owner: nothing new to write or to ledger.
        return Ok(Refreshed::Refused {
            error,
            wrote: false,
            flipped,
        });
    }
    current.status = status;
    let mut public = object(&current.connector_public);
    public.insert(RECONNECT_REQUIRED.to_owned(), json!(true));
    current.connector_public = Value::Object(public);
    current.updated_at = ctx.now;
    let kind_key = current.kind_key.clone();
    repos.capabilities().update(current).await?;
    if flipped {
        let in_force = version_in_force(repos.as_mut()).await?;
        append(
            repos.as_mut(),
            ctx,
            "connector.refresh_failed",
            "capability",
            id,
            in_force,
            json!({ "kind_key": kind_key, "error_kind": error.kind() }),
        )
        .await?;
    }
    repos.commit().await?;
    Ok(Refreshed::Refused {
        error,
        wrote: true,
        flipped,
    })
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
/// to be reconnected is probed too: a NetGSM line refused for its IP allowlist (`auth`) recovers
/// once the owner fixes the allowlist, and a failing probe that leaves the status as it was
/// writes no ledger entry.
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
    let mut which = HashMap::new();
    for (ws, capabilities) in connected_capabilities(deps, job, ACTIVE, &mut report).await {
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
            let (id, previous) = (capability.id, capability.status);
            let task = probes.spawn(async move {
                let _permit = permit;
                (previous, probe_locked(&deps, &ctx, id, false).await)
            });
            which.insert(task.id(), (ws, id));
        }
    }
    while let Some(joined) = probes.join_next_with_id().await {
        match joined {
            Ok((_, (previous, Ok(out)))) => {
                if out.status != previous {
                    report.changed += 1;
                }
            }
            Ok((_, (_, Err(e)))) if matches!(e.code, ErrorCode::Conflict | ErrorCode::NotFound) => {
                report.skipped += 1;
            }
            Ok((task, (_, Err(e)))) => {
                report.failed += 1;
                if let Some((ws, id)) = which.get(&task) {
                    step_failed(job, *ws, Some(*id), &Failure::App(e));
                }
            }
            Err(e) => {
                report.failed += 1;
                let (ws, id) = which.get(&e.id()).copied().unzip();
                tracing::error!(
                    job = job.name(),
                    workspace_id = ws.map(|w| w.to_string()).as_deref().unwrap_or("-"),
                    capability_id = id.map(|c| c.to_string()).as_deref().unwrap_or("-"),
                    error = %e,
                    "a probe panicked"
                );
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

/// Asks each verified SMS capability in active workspaces about its own pending jobs only.
/// Both the pending read and status write are scoped by workspace and capability, even when
/// different accounts use the same provider job id. Provider I/O holds no transaction.
/// The Postgres repository remains a stub until M2b adds outbound job storage.
///
/// `touched` counts jobs asked about, `changed` statuses recorded, and `failed` the capabilities
/// whose pending jobs, reports or statuses could not be read or written.
pub async fn run_netgsm_dlr_poll(deps: &Deps, _now: OffsetDateTime) -> JobReport {
    let job = Job::NetgsmDlrPoll;
    let mut report = JobReport::default();
    let Some(reports) = deps.connectors.delivery_reports(Provider::Netgsm) else {
        return finish(job, report);
    };
    for ws in netgsm_workspaces(deps, job, ACTIVE, &mut report).await {
        let lines = match live_connector_capabilities(deps, ws).await {
            Ok(capabilities) => verified_lines(&capabilities),
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        for line in lines {
            let pending = match pending_jobs(deps, ws, line).await {
                Ok(pending) => pending,
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(line), &Failure::App(e));
                    continue;
                }
            };
            if pending.is_empty() {
                continue;
            }
            report.touched += pending.len() as u64;
            let statuses = match report_for(deps, reports.as_ref(), ws, line, &pending).await {
                Ok(heard) => heard,
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(line), &e);
                    continue;
                }
            };
            if statuses.is_empty() {
                continue;
            }
            let heard = statuses.len() as u64;
            match record_statuses(deps, ws, line, statuses).await {
                Ok(()) => report.changed += heard,
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(line), &Failure::App(e));
                }
            }
        }
    }
    finish(job, report)
}

/// The job ids awaiting a delivery report for `capability_id` in `ws`.
async fn pending_jobs(
    deps: &Deps,
    ws: WorkspaceId,
    capability_id: CapabilityId,
) -> Result<Vec<String>, AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    repos
        .outbound_jobs()
        .pending_job_ids(ws, capability_id, MAX_PENDING_JOBS)
        .await
}

/// The delivery reports of `jobs`, asked with line `line`'s credentials.
async fn report_for(
    deps: &Deps,
    reports: &dyn DeliveryReports,
    ws: WorkspaceId,
    line: CapabilityId,
    jobs: &[String],
) -> Result<Vec<DeliveryStatus>, Failure> {
    let Some(credential) = read_credential(deps, ws, line).await? else {
        return Ok(Vec::new());
    };
    let heard = reports.report(&credential, jobs).await;
    drop(credential);
    heard.map_err(Failure::Provider)
}

/// Records `statuses` for `capability_id` in `ws`.
async fn record_statuses(
    deps: &Deps,
    ws: WorkspaceId,
    capability_id: CapabilityId,
    statuses: Vec<DeliveryStatus>,
) -> Result<(), AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    repos
        .outbound_jobs()
        .record_status(ws, capability_id, statuses)
        .await?;
    repos.commit().await
}

/// Reads NetGSM's inbox backup, in every active or pending-payment workspace (those whose
/// webhooks take in events, [`webhook::takes_routed_events`]) holding a verified SMS line (found as for [`run_netgsm_dlr_poll`]),
/// for each such line (with sealed credentials): the messages that
/// arrived in the [`INBOX_WINDOW`] ending at `now`, both ends always given. Each is stored as an
/// inbound event of NetGSM attached to that line, received at `now`, under the id NetGSM's
/// webhook gives the same message (`netgsm-mo:<gorevid>`), so a message the webhook (or an
/// earlier poll) already stored is not stored again. The provider is asked with no transaction
/// open.
///
/// `touched` counts the lines polled, `changed` the events newly stored, `skipped` those already
/// there, `failed` the lines whose poll or storing failed.
pub async fn run_netgsm_inbox_poll(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::NetgsmInboxPoll;
    let mut report = JobReport::default();
    let Some(reports) = deps.connectors.delivery_reports(Provider::Netgsm) else {
        return finish(job, report);
    };
    for ws in netgsm_workspaces(deps, job, RECEIVING, &mut report).await {
        let lines = match live_connector_capabilities(deps, ws).await {
            Ok(capabilities) => verified_lines(&capabilities),
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        for line in lines {
            report.touched += 1;
            match poll_inbox(deps, reports.as_ref(), ws, line, now).await {
                Ok(deliveries) => {
                    for delivery in deliveries {
                        match delivery {
                            Delivery::Stored(_) => report.changed += 1,
                            Delivery::Duplicate | Delivery::Unrouted | Delivery::Inactive => {
                                report.skipped += 1
                            }
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

/// The workspaces in one of `statuses` holding a verified SMS line with sealed credentials, read
/// in one platform-wide transaction; none (and one failure counted) when they cannot be read.
async fn netgsm_workspaces(
    deps: &Deps,
    job: Job,
    statuses: &[WorkspaceStatus],
    report: &mut JobReport,
) -> Vec<WorkspaceId> {
    let listed = async {
        let mut platform = deps.uow.platform().await?;
        let taken: BTreeSet<WorkspaceId> = platform
            .workspaces_list()
            .await?
            .into_iter()
            .filter(|w| statuses.contains(&w.status))
            .map(|w| w.id)
            .collect();
        let with_line = platform.workspaces_with_verified(&[SMS_LINE]).await?;
        Ok::<_, AppError>(
            with_line
                .into_iter()
                .filter(|ws| taken.contains(ws))
                .collect(),
        )
    };
    match listed.await {
        Ok(workspaces) => workspaces,
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

/// Removes, in every workspace, the raw body of every inbound event received more than
/// [`webhook::RAW_RETENTION`] (30 days) before `now` ([`webhook::purge_raw_in`]); the events
/// stay. `touched` and `changed` count the bodies removed, `failed` the workspaces that could not
/// be purged (the others are purged all the same).
pub async fn run_purge_raw_bodies(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::PurgeRawBodies;
    let mut report = JobReport::default();
    let cutoff = webhook::raw_cutoff(now);
    for ws in workspaces(deps, job, EVERY, &mut report).await {
        let purged = webhook::purge_raw_in(deps, ws, cutoff).await;
        count_purged(job, ws, purged, &mut report);
    }
    finish(job, report)
}

/// Deletes, in every workspace, the pending OAuth flows that expired before `now`
/// (`OAuthPendingRepo::purge_expired`). `touched` and `changed` count the flows deleted,
/// `failed` the workspaces that could not be purged.
pub async fn run_purge_oauth_pending(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::PurgeOAuthPending;
    let mut report = JobReport::default();
    for ws in workspaces(deps, job, EVERY, &mut report).await {
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
    for ws in workspaces(deps, job, EVERY, &mut report).await {
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

/// The run's summary line (`debug` when the run found nothing to do, so a poll every minute
/// with nothing waiting does not fill the log), and its report.
fn finish(job: Job, report: JobReport) -> JobReport {
    if report == JobReport::default() {
        tracing::debug!(job = job.name(), "job finished: nothing to do");
    } else {
        tracing::info!(
            job = job.name(),
            touched = report.touched,
            changed = report.changed,
            skipped = report.skipped,
            failed = report.failed,
            "job finished"
        );
    }
    report
}

/// The ids of the workspaces whose status is one of `statuses`; none (and one failure counted)
/// when they cannot be listed.
async fn workspaces(
    deps: &Deps,
    job: Job,
    statuses: &[WorkspaceStatus],
    report: &mut JobReport,
) -> Vec<WorkspaceId> {
    let listed = async {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_list().await
    };
    match listed.await {
        Ok(all) => all
            .into_iter()
            .filter(|w| statuses.contains(&w.status))
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

/// Each workspace whose status is one of `statuses` with its live connector capabilities
/// ([`live_connector_capabilities`]); a workspace that cannot be read is counted as a failure
/// and left out.
async fn connected_capabilities(
    deps: &Deps,
    job: Job,
    statuses: &[WorkspaceStatus],
    report: &mut JobReport,
) -> Vec<(WorkspaceId, Vec<Capability>)> {
    let mut out = Vec::new();
    for ws in workspaces(deps, job, statuses, report).await {
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
) -> Result<Option<Credential>, AppError> {
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

/// Reconcile interrupted sends in every workspace; resume old queued intents only in active
/// workspaces, with fresh fences in the shared send step. Each candidate is claimed under lock.
pub async fn run_outbox_recover(deps: &Deps, now: OffsetDateTime) -> JobReport {
    use super::inbox::replies;
    let job = Job::OutboxRecover;
    let mut report = JobReport::default();
    for ws in workspaces(deps, job, EVERY, &mut report).await {
        let ctx = system_ctx(job, ws, now);
        let candidates = async {
            let mut r = deps.uow.tenant(ws).await?;
            let sending = r
                .outbox()
                .list_pending("sending", now - Duration::minutes(2), 500)
                .await?;
            let queued = if r.workspace().get().await?.status == WorkspaceStatus::Active {
                r.outbox()
                    .list_pending("queued", now - Duration::minutes(5), 500)
                    .await?
            } else {
                Vec::new()
            };
            Ok::<_, AppError>((sending, queued))
        }
        .await;
        let (sending, queued) = match candidates {
            Ok(v) => v,
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        for row in sending {
            report.touched += 1;
            match replies::recover_sending(deps, &ctx, row.id).await {
                Ok(true) => report.changed += 1,
                Ok(false) => report.skipped += 1,
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, None, &Failure::App(e));
                }
            }
        }
        for row in queued {
            report.touched += 1;
            match replies::send_step(deps, &ctx, row.id).await {
                Ok(out) if out.state != "queued" => report.changed += 1,
                Ok(_) => report.skipped += 1,
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, None, &Failure::App(e));
                }
            }
        }
    }
    finish(job, report)
}

/// Turn persisted inbound events into inbox facts for receiving workspaces, without a strategy gate.
pub async fn run_inbox_consume(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let mut report = JobReport::default();
    for ws in workspaces(deps, Job::InboxConsume, RECEIVING, &mut report).await {
        let result = super::inbox::consumer::consume_workspace(deps, ws, now).await;
        report.touched += result.touched;
        report.changed += result.changed;
        report.skipped += result.skipped;
        report.failed += result.failed;
    }
    finish(Job::InboxConsume, report)
}

/// Hand overdue agent conversations to their journey owner or the unassigned queue.
pub async fn run_response_sla(deps: &Deps, now: OffsetDateTime) -> JobReport {
    run_inbox_timer(deps, now, Job::ResponseSla).await
}
/// Wake elapsed snoozes; persisted state makes subsequent runs no-ops.
pub async fn run_snooze_wake(deps: &Deps, now: OffsetDateTime) -> JobReport {
    run_inbox_timer(deps, now, Job::SnoozeWake).await
}
async fn run_inbox_timer(deps: &Deps, now: OffsetDateTime, job: Job) -> JobReport {
    use jt_inbox::{ConvState, Executor};
    let mut report = JobReport::default();
    for ws in workspaces(deps, job, ACTIVE, &mut report).await {
        let ctx = system_ctx(job, ws, now);
        let result = async {
            let mut r = deps.uow.tenant(ws).await?;
            r.people().lock_workspace().await?;
            r.people().set_write_time(now).await?;
            let policy = r.workspace_policy().get().await?.inbox;
            let mut changed = 0;
            for c in super::inbox::context::all_conversations(r.as_mut()).await? {
                if job == Job::SnoozeWake {
                    if !matches!(c.state,ConvState::Snoozed{until} if until<=now) {
                        continue;
                    }
                    r.conversations()
                        .update_state(c.id, ConvState::Ours, None)
                        .await?;
                } else {
                    if c.state != ConvState::Ours || c.executor != Executor::Agent {
                        continue;
                    }
                    let channel = match c.kind_key.as_str() {
                        "sms_line" => "sms",
                        "whatsapp_cloud" => "whatsapp",
                        other => other,
                    };
                    let Some(seconds) = policy.max_response_s.get(channel) else {
                        continue;
                    };
                    if now - c.last_inbound_at.unwrap_or(c.created_at)
                        <= Duration::seconds(i64::from(*seconds))
                    {
                        continue;
                    }
                    let owner = r
                        .journeys()
                        .open_for(c.person_id)
                        .await?
                        .and_then(|j| j.owner);
                    r.conversations()
                        .update_executor(c.id, Executor::Human { user_id: owner })
                        .await?;
                }
                super::inbox::record(
                    r.as_mut(),
                    &ctx,
                    &format!("inbox.{}", job.name()),
                    "conversation",
                    c.id,
                    json!({}),
                )
                .await?;
                changed += 1;
            }
            r.commit().await?;
            Ok::<_, AppError>(changed)
        }
        .await;
        match result {
            Ok(n) => {
                report.changed += n;
                report.touched += n;
            }
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
            }
        }
    }
    finish(job, report)
}

/// Poll each receiving workspace's verified mailboxes. Network I/O owns no transaction;
/// cursor and drafts commit together only if the account, credential and cursor still match.
pub async fn run_mail_inbox_poll(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let job = Job::MailInboxPoll;
    let mut report = JobReport::default();
    let Some(poller) = deps.connectors.mailbox_poller(Provider::Mail) else {
        return finish(job, report);
    };
    for ws in workspaces(deps, job, RECEIVING, &mut report).await {
        let capabilities = match live_connector_capabilities(deps, ws).await {
            Ok(caps) => caps,
            Err(e) => {
                report.failed += 1;
                step_failed(job, ws, None, &Failure::App(e));
                continue;
            }
        };
        for cap in capabilities
            .into_iter()
            .filter(|c| c.kind_key == "mailbox" && c.status == StoredStatus::Verified)
        {
            report.touched += 1;
            let outcome = async {
                let (sealed, cursor) = {
                    let mut r = deps.uow.tenant(ws).await?;
                    (
                        r.capabilities().read_sealed(cap.id).await?,
                        r.mail_cursors().get(cap.id).await?,
                    )
                };
                let Some(sealed) = sealed else {
                    return Ok::<_, Failure>(vec![]);
                };
                let credential = open_credential(deps, ws, &sealed)?;
                let (drafts, next) = poller
                    .poll(
                        ws,
                        &credential,
                        &super::connector::adapter_public(&cap),
                        &cursor,
                    )
                    .await
                    .map_err(Failure::Provider)?;
                drop(credential);
                let mut r = deps.uow.tenant(ws).await?;
                let current = r.capabilities().lock(cap.id).await?;
                if !RECEIVING.contains(&r.workspace().get().await?.status)
                    || !current.is_some_and(|c| {
                        c.status == StoredStatus::Verified
                            && c.external_id == cap.external_id
                            && c.updated_at == cap.updated_at
                    })
                    || r.capabilities().read_sealed(cap.id).await?.as_ref() != Some(&sealed)
                    || r.mail_cursors().get(cap.id).await? != cursor
                {
                    return Ok(vec![]);
                }
                let stored = webhook::store_polled(
                    deps,
                    r.as_mut(),
                    ws,
                    Provider::Mail,
                    Some(cap.id),
                    drafts,
                    now,
                )
                .await?;
                r.mail_cursors().store(cap.id, next).await?;
                r.commit().await?;
                Ok(stored)
            }
            .await;
            match outcome {
                Ok(stored) => {
                    for delivery in stored {
                        if matches!(delivery, Delivery::Stored(_)) {
                            report.changed += 1;
                        } else {
                            report.skipped += 1;
                        }
                    }
                }
                Err(e) => {
                    report.failed += 1;
                    step_failed(job, ws, Some(cap.id), &e);
                }
            }
        }
        let consumed = super::inbox::consumer::consume_workspace(deps, ws, now).await;
        report.failed += consumed.failed;
    }
    finish(job, report)
}

/// Hourly retry, serialized by the scheduler's iys_sync advisory lock. A lost acknowledgement
/// may repeat a submission. Sync metadata never changes the underlying local consent decision.
pub async fn run_iys_sync(deps: &Deps, now: OffsetDateTime) -> JobReport {
    use jt_inbox::{Channel, ConsentKind, SyncState, Task, TaskId, TaskStatus};
    let job = Job::IysSync;
    let mut report = JobReport::default();
    for ws in workspaces(deps, job, ACTIVE, &mut report).await {
        let result = async {
            let (credential, rows) = {
                let mut r = deps.uow.tenant(ws).await?;
                let rows = r.consents().pending_sync(1000).await?;
                if rows.is_empty() {
                    return Ok::<_, AppError>(());
                }
                let mut credentials = Vec::new();
                for cap in r.capabilities().list(CapabilityFilter::default()).await? {
                    if cap.status == StoredStatus::Retired
                        || cap.reach != jt_capability::Reach::Connector
                        || cap.kind_key != "sms_line"
                    {
                        continue;
                    }
                    let Some(sealed) = r.capabilities().read_iys_sealed(cap.id).await? else {
                        continue;
                    };
                    let Some(sms) = r.capabilities().read_sealed(cap.id).await? else {
                        continue;
                    };
                    let Credential::NetgsmSms {
                        usercode: line_user,
                        ..
                    } = open_credential(deps, ws, &sms)?
                    else {
                        continue;
                    };
                    let Credential::NetgsmIys {
                        usercode, password, ..
                    } = open_credential(deps, ws, &sealed)?
                    else {
                        continue;
                    };
                    let Some(brand) = cap.connector_public["iys"]["brand_code"]
                        .as_str()
                        .filter(|b| !b.trim().is_empty())
                    else {
                        continue;
                    };
                    if usercode == line_user {
                        credentials.push(Credential::NetgsmIys {
                            usercode,
                            password,
                            brand_code: brand.into(),
                        });
                    }
                }
                // No usable slot (or ambiguous brands) must leave consent pending and ask the owner.
                if credentials.len() != 1 {
                    request_iys_provisioning(deps, r.as_mut(), ws, &rows, now).await?;
                    r.commit().await?;
                    return Ok(());
                }
                (credentials.remove(0), rows)
            };
            let Some(sync) = deps.connectors.consent(Provider::Netgsm) else {
                return Ok(());
            };
            for chunk in rows.chunks(500) {
                let mut wire = Vec::new();
                let mut valid = std::collections::BTreeSet::new();
                {
                    let mut r = deps.uow.tenant(ws).await?;
                    for row in chunk {
                        let channel = match row.channel {
                            Channel::Sms => "MESAJ",
                            Channel::Phone => "ARAMA",
                            Channel::Email => "EPOSTA",
                            _ => continue,
                        };
                        let Some(person) =
                            consent_recipient_person(r.as_mut(), row.person_id).await?
                        else {
                            continue;
                        };
                        if person.erased_at.is_some() {
                            continue;
                        }
                        let identities = r.identities().list(person.id).await?;
                        let candidates: Vec<_> = identities
                            .iter()
                            .filter(|i| i.active && i.channel == row.channel.identity_channel())
                            .collect();
                        if candidates.len() != 1 {
                            continue;
                        }
                        wire.push(crate::ports::connectors::ConsentRow {
                            recipient: candidates[0].value_normalized.clone(),
                            channel: channel.into(),
                            granted: row.kind != ConsentKind::Withdrawn,
                            source: "HS_WEB".into(),
                            at: row.at,
                        });
                        valid.insert(row.id);
                    }
                }
                // A full page uses at most two provider requests, not one request per decision.
                // No tenant transaction or row lock crosses the provider call.
                let result = if wire.is_empty() {
                    Ok(crate::ports::connectors::SendReceipt {
                        provider_id: String::new(),
                        cost_minor: None,
                    })
                } else {
                    sync.add(&credential, &wire).await
                };
                for row in chunk {
                    report.touched += 1;
                    if valid.contains(&row.id)
                        && matches!(result, Err(ConnectorError::Throttle { .. }))
                    {
                        report.skipped += 1;
                        continue;
                    }
                    // Unresolvable recipients also consume the bounded validation retry budget.
                    let ok = valid.contains(&row.id) && result.is_ok();
                    let mut r = deps.uow.tenant(ws).await?;
                    r.people().lock_workspace().await?;
                    let current = r
                        .consents()
                        .list(row.person_id)
                        .await?
                        .into_iter()
                        .find(|c| c.id == row.id);
                    if !current.is_some_and(|c| {
                        c.sync_state == row.sync_state && c.attempts == row.attempts
                    }) {
                        report.skipped += 1;
                        continue;
                    }
                    let attempts = row.attempts + 1;
                    let state = if ok {
                        SyncState::Sent
                    } else if attempts >= 5 {
                        SyncState::FailedFinal
                    } else {
                        SyncState::Failed
                    };
                    r.consents().set_sync(row.id, state, attempts).await?;
                    if state == SyncState::FailedFinal {
                        let person = consent_recipient_person(r.as_mut(), row.person_id)
                            .await?
                            .ok_or_else(|| AppError::not_found("consent person missing"))?;
                        let journey =
                            r.journeys().latest_for(person.id).await?.ok_or_else(|| {
                                AppError::conflict("consent requires a human follow-up journey")
                            })?;
                        let assignee = r
                            .memberships()
                            .list()
                            .await?
                            .into_iter()
                            .find(|m| {
                                m.status == jt_tenancy::MembershipStatus::Active
                                    && matches!(m.role_key.as_str(), "owner" | "manager")
                            })
                            .and_then(|m| m.user_id);
                        r.tasks()
                            .insert(Task {
                                id: TaskId::from(deps.ids.uuid()),
                                workspace_id: ws,
                                journey_id: journey.id,
                                title: format!(
                                    "Review failed IYS consent synchronization {}",
                                    row.id
                                ),
                                due_at: now,
                                assignee,
                                status: TaskStatus::Open,
                            })
                            .await?;
                    }
                    super::inbox::record(
                        r.as_mut(),
                        &system_ctx(job, ws, now),
                        "inbox.consent.synced",
                        "consent",
                        row.id,
                        json!({"person_id":row.person_id,"state":state,"attempts":attempts}),
                    )
                    .await?;
                    r.commit().await?;
                    if ok {
                        report.changed += 1;
                    } else {
                        report.failed += 1;
                    }
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            report.failed += 1;
            step_failed(job, ws, None, &Failure::App(e));
        }
    }
    finish(job, report)
}

/// One open owner task per workspace, shared by the pending backlog; hourly retries do not spam.
async fn request_iys_provisioning(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    ws: WorkspaceId,
    rows: &[jt_inbox::Consent],
    now: OffsetDateTime,
) -> Result<(), AppError> {
    use jt_inbox::{Task, TaskId, TaskStatus};
    const TITLE: &str = "Provision IYS on the SMS line (select one brand)";
    r.people().lock_workspace().await?;
    if r.tasks()
        .query(crate::ports::inbox::TaskQueue::All, None, now)
        .await?
        .iter()
        .any(|t| t.title == TITLE)
    {
        return Ok(());
    }
    let owner = r
        .memberships()
        .list()
        .await?
        .into_iter()
        .find(|m| m.status == jt_tenancy::MembershipStatus::Active && m.role_key == "owner")
        .and_then(|m| m.user_id)
        .ok_or_else(|| AppError::conflict("IYS provisioning requires an active owner"))?;
    for row in rows {
        let Some(person) = consent_recipient_person(r, row.person_id).await? else {
            continue;
        };
        let Some(journey) = r.journeys().latest_for(person.id).await? else {
            continue;
        };
        r.tasks()
            .insert(Task {
                id: TaskId::from(deps.ids.uuid()),
                workspace_id: ws,
                journey_id: journey.id,
                title: TITLE.into(),
                due_at: now,
                assignee: Some(owner),
                status: TaskStatus::Open,
            })
            .await?;
        break;
    }
    Ok(())
}

async fn consent_recipient_person(
    r: &mut dyn TenantRepos,
    mut id: jt_inbox::PersonId,
) -> Result<Option<jt_inbox::Person>, AppError> {
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(id) {
            return Err(AppError::conflict("cyclic person merge"));
        }
        let Some(person) = r.people().get(id).await? else {
            return Ok(None);
        };
        if let Some(target) = person.merged_into {
            id = target;
        } else {
            return Ok(Some(person));
        }
    }
}
