//! The scheduler of `jeeta serve`: runs each job of `jt_app::usecases::jobs` on a fixed interval
//! (spec §4.2 rule 2: deterministic jobs only).
//!
//! Every tick of a job asks for the job's lock (`Deps::job_lock`, a Postgres advisory lock named
//! [`Job::lock_name`]) and skips the run when another instance holds it, so several servers on
//! one database never run a job twice at once; otherwise it runs the job once and gives the lock
//! back. A job's first tick comes after a random delay of up to [`Intervals::first_run_jitter`],
//! so instances started together do not all ask at the same moment, and later ticks follow its
//! interval (a run longer than the interval delays the next tick instead of piling ticks up).
//!
//! Each run is a task of its own: a run that panics is logged, its lock given back, and the next
//! tick runs the job again. Each job's loop is a task of its own too, watched by a supervisor
//! that starts it again, one interval later, should it ever stop by panicking. Dropping (or
//! shutting down) the returned [`JoinSet`] stops every loop and every run in flight.
//!
//! [`JOBS_ENABLED`](crate::config::JOBS_ENABLED) set to `false` starts nothing ([`start`]).

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use jt_app::usecases::Deps;
use jt_app::usecases::jobs::{Job, JobReport};
use time::OffsetDateTime;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::{Instant, MissedTickBehavior};

use crate::config::{self, Config};

/// How often each job runs, and how long a job may wait for its first run. The default is the
/// production schedule; tests shorten it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intervals {
    pub refresh_tokens: Duration,
    pub probe_all: Duration,
    pub netgsm_dlr_poll: Duration,
    pub netgsm_inbox_poll: Duration,
    pub purge_raw_bodies: Duration,
    pub purge_oauth_pending: Duration,
    pub purge_probe_runs: Duration,
    /// The longest random delay before each job's first run.
    pub first_run_jitter: Duration,
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(60 * 60);
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

impl Default for Intervals {
    /// Token renewal hourly, probes every 15 minutes, the delivery-report poll every minute, the
    /// inbox poll hourly, the raw-body and probe-run purges daily, the OAuth-flow purge hourly;
    /// first runs within 30 seconds of the start.
    fn default() -> Self {
        Intervals {
            refresh_tokens: HOUR,
            probe_all: 15 * MINUTE,
            netgsm_dlr_poll: MINUTE,
            netgsm_inbox_poll: HOUR,
            purge_raw_bodies: DAY,
            purge_oauth_pending: HOUR,
            purge_probe_runs: DAY,
            first_run_jitter: Duration::from_secs(30),
        }
    }
}

impl Intervals {
    /// How often `job` runs.
    pub fn of(&self, job: Job) -> Duration {
        match job {
            Job::RefreshTokens => self.refresh_tokens,
            Job::ProbeAll => self.probe_all,
            Job::NetgsmDlrPoll => self.netgsm_dlr_poll,
            Job::NetgsmInboxPoll => self.netgsm_inbox_poll,
            Job::PurgeRawBodies => self.purge_raw_bodies,
            Job::PurgeOAuthPending => self.purge_oauth_pending,
            Job::PurgeProbeRuns => self.purge_probe_runs,
        }
    }
}

/// Starts every job on the production schedule when `config.jobs_enabled`, and logs that it did;
/// otherwise starts nothing and logs that the jobs are off.
pub fn start(config: &Config, deps: Arc<Deps>) -> JoinSet<()> {
    if !config.jobs_enabled {
        tracing::info!(
            "scheduled jobs are disabled ({}=false): no token renewal, probe, poll or purge runs \
             in this instance",
            config::JOBS_ENABLED
        );
        return JoinSet::new();
    }
    let jobs = spawn(deps, Intervals::default());
    tracing::info!(jobs = jobs.len(), "scheduled jobs started");
    jobs
}

/// Starts every job of [`Job::ALL`] on `intervals`, each under its own lock; one task per job.
pub fn spawn(deps: Arc<Deps>, intervals: Intervals) -> JoinSet<()> {
    let mut set = JoinSet::new();
    for job in Job::ALL {
        let schedule = Schedule {
            name: job.name(),
            lock: job.lock_name(),
            every: intervals.of(job),
            first: jitter(job.name(), intervals.first_run_jitter),
        };
        let run: Run = Arc::new(move |deps: Arc<Deps>, now| {
            Box::pin(async move { job.run(&deps, now).await })
        });
        set.spawn(supervise(Arc::clone(&deps), schedule, run));
    }
    set
}

/// One run of a job, at the time given, with the shared ports.
type Run = Arc<
    dyn Fn(Arc<Deps>, OffsetDateTime) -> Pin<Box<dyn Future<Output = JobReport> + Send>>
        + Send
        + Sync,
>;

/// When and under which lock a job runs.
#[derive(Clone, Debug)]
struct Schedule {
    name: &'static str,
    lock: String,
    every: Duration,
    /// The delay before the first run.
    first: Duration,
}

/// A random delay of at most `max`, different per job and per process.
fn jitter(job: &str, max: Duration) -> Duration {
    let max_ms = u64::try_from(max.as_millis()).unwrap_or(u64::MAX);
    if max_ms == 0 {
        return Duration::ZERO;
    }
    // A fresh `RandomState` is randomly keyed: enough randomness to spread first runs.
    let random = RandomState::new().hash_one(job);
    Duration::from_millis(random % max_ms.saturating_add(1))
}

/// Aborts a task when dropped, so that stopping a loop also stops what it started.
struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Runs the job's loop as a task of its own, and starts it again one interval later if it ever
/// stops by panicking.
async fn supervise(deps: Arc<Deps>, schedule: Schedule, run: Run) {
    let mut first = schedule.first;
    loop {
        let task = tokio::spawn(job_loop(
            Arc::clone(&deps),
            schedule.clone(),
            first,
            Arc::clone(&run),
        ));
        let _stop = AbortOnDrop(task.abort_handle());
        match task.await {
            Err(e) if e.is_panic() => {
                tracing::error!(
                    job = schedule.name,
                    "the job's loop panicked; it starts again after one interval"
                );
                first = schedule.every;
            }
            // The loop never ends on its own; cancelled, it was stopped on purpose.
            _ => return,
        }
    }
}

/// The job's ticks: the first after `first`, then one per interval (at least a millisecond: a
/// zero interval would never let the loop wait).
async fn job_loop(deps: Arc<Deps>, schedule: Schedule, first: Duration, run: Run) {
    let every = schedule.every.max(Duration::from_millis(1));
    let mut ticks = tokio::time::interval_at(Instant::now() + first, every);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        tick(&deps, &schedule, &run).await;
    }
}

/// One tick: the job's lock, one run as a task of its own, the lock given back.
async fn tick(deps: &Arc<Deps>, schedule: &Schedule, run: &Run) {
    let guard = match deps.job_lock.try_acquire(&schedule.lock).await {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            tracing::debug!(
                job = schedule.name,
                "skipped: another instance is running this job"
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                job = schedule.name,
                error = %e,
                "skipped: the job's lock could not be asked for"
            );
            return;
        }
    };
    let task = tokio::spawn(run(Arc::clone(deps), deps.clock.now()));
    let stop = AbortOnDrop(task.abort_handle());
    match task.await {
        // The job logged its own summary.
        Ok(_) => {}
        Err(e) if e.is_panic() => tracing::error!(
            job = schedule.name,
            "the run panicked; the next tick runs the job again"
        ),
        Err(_) => {}
    }
    drop(stop);
    if let Err(e) = guard.release().await {
        tracing::warn!(
            job = schedule.name,
            error = %e,
            "the job's lock could not be given back cleanly; its session is closed instead"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use jt_testkit::fakes::{FakeJobLock, InMemoryUow, deps};

    use super::*;

    fn config(extra: &[(&str, &str)]) -> Config {
        let mut vars: HashMap<String, String> = [
            (config::DATABASE_URL, "postgres://localhost/unused"),
            (config::SECRET_KEY, &"ab".repeat(32)[..]),
        ]
        .iter()
        .chain(extra)
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        vars.retain(|_, v| !v.is_empty());
        Config::from_map(&vars).unwrap()
    }

    /// Fake ports over an empty in-memory database, with `lock` as the job lock.
    fn fake_deps(lock: &FakeJobLock) -> Arc<Deps> {
        let mut deps = deps(Arc::new(InMemoryUow::new()));
        deps.job_lock = Arc::new(lock.clone());
        Arc::new(deps)
    }

    /// Every job every `every`, starting at once.
    fn every(every: Duration) -> Intervals {
        Intervals {
            refresh_tokens: every,
            probe_all: every,
            netgsm_dlr_poll: every,
            netgsm_inbox_poll: every,
            purge_raw_bodies: every,
            purge_oauth_pending: every,
            purge_probe_runs: every,
            first_run_jitter: Duration::ZERO,
        }
    }

    /// Waits up to two seconds for `done`.
    async fn eventually(done: impl Fn() -> bool) -> bool {
        for _ in 0..200 {
            if done() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        done()
    }

    /// One schedule of `run`, every `every`, starting at once, under the lock `lock`.
    fn one(deps: Arc<Deps>, lock: &str, every: Duration, run: Run) -> JoinSet<()> {
        let mut set = JoinSet::new();
        set.spawn(supervise(
            deps,
            Schedule {
                name: "test_job",
                lock: lock.to_owned(),
                every,
                first: Duration::ZERO,
            },
            run,
        ));
        set
    }

    #[tokio::test]
    async fn disabled_flag_spawns_nothing() {
        let lock = FakeJobLock::new();
        let set = start(
            &config(&[(config::JOBS_ENABLED, "false")]),
            fake_deps(&lock),
        );
        assert!(set.is_empty());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(lock.granted().is_empty(), "nothing ran");
    }

    #[tokio::test]
    async fn enabled_starts_one_task_per_job() {
        let lock = FakeJobLock::new();
        let mut set = start(&config(&[]), fake_deps(&lock));
        assert_eq!(set.len(), Job::ALL.len());
        set.shutdown().await;
        assert!(set.is_empty());
    }

    #[test]
    fn the_production_schedule() {
        let i = Intervals::default();
        assert_eq!(i.of(Job::RefreshTokens), HOUR);
        assert_eq!(i.of(Job::ProbeAll), Duration::from_secs(15 * 60));
        assert_eq!(i.of(Job::NetgsmDlrPoll), MINUTE);
        assert_eq!(i.of(Job::NetgsmInboxPoll), HOUR);
        assert_eq!(i.of(Job::PurgeRawBodies), DAY);
        assert_eq!(i.of(Job::PurgeOAuthPending), HOUR);
        assert_eq!(i.of(Job::PurgeProbeRuns), DAY);
        assert_eq!(i.first_run_jitter, Duration::from_secs(30));
        // The jitter stays within its bound, and none is none.
        for job in Job::ALL {
            assert!(jitter(job.name(), i.first_run_jitter) <= i.first_run_jitter);
            assert_eq!(jitter(job.name(), Duration::ZERO), Duration::ZERO);
        }
    }

    #[tokio::test]
    async fn every_job_runs_under_its_own_lock_and_gives_it_back() {
        let lock = FakeJobLock::new();
        let mut set = spawn(fake_deps(&lock), every(Duration::from_millis(20)));
        let names: BTreeSet<String> = Job::ALL.iter().map(Job::lock_name).collect();
        assert!(
            eventually(|| lock.granted().into_iter().collect::<BTreeSet<_>>() == names).await,
            "granted: {:?}",
            lock.granted()
        );
        set.shutdown().await;
        // Every lock taken was given back.
        assert!(eventually(|| names.iter().all(|n| !lock.is_held(n))).await);
    }

    #[tokio::test]
    async fn a_tick_skips_while_another_runner_holds_the_lock() {
        let lock = FakeJobLock::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&runs);
        let run: Run = Arc::new(move |_, _| {
            let counted = Arc::clone(&counted);
            Box::pin(async move {
                counted.fetch_add(1, Ordering::SeqCst);
                JobReport::default()
            })
        });
        // Another instance holds the lock: ticks come and go, the job never runs.
        lock.hold("jeeta.jobs.test_job");
        let mut set = one(
            fake_deps(&lock),
            "jeeta.jobs.test_job",
            Duration::from_millis(10),
            run,
        );
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        assert!(lock.granted().is_empty());
        // Once it lets go, the next tick runs the job.
        lock.free("jeeta.jobs.test_job");
        assert!(eventually(|| runs.load(Ordering::SeqCst) >= 2).await);
        set.shutdown().await;
    }

    #[tokio::test]
    async fn a_panicking_run_is_caught_its_lock_given_back_and_the_job_runs_again() {
        let lock = FakeJobLock::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&runs);
        let run: Run = Arc::new(move |_, _| {
            let counted = Arc::clone(&counted);
            Box::pin(async move {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("the first run fails");
                }
                JobReport::default()
            })
        });
        let mut set = one(
            fake_deps(&lock),
            "jeeta.jobs.test_job",
            Duration::from_millis(10),
            run,
        );
        assert!(eventually(|| runs.load(Ordering::SeqCst) >= 3).await);
        set.shutdown().await;
        // Each run took the lock and gave it back, the panicking one included.
        assert!(eventually(|| !lock.is_held("jeeta.jobs.test_job")).await);
        assert_eq!(lock.granted().len(), lock.released().len());
        assert!(lock.granted().len() >= 3);
    }
}
