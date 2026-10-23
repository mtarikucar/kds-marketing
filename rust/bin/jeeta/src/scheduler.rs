//! The scheduler of `jeeta serve`: runs each job of `jt_app::usecases::jobs` on a fixed interval
//! (spec §4.2 rule 2: deterministic jobs only).
//!
//! Every tick of a job asks for the job's lock (`Deps::job_lock`, a Postgres advisory lock named
//! [`Job::lock_name`]) and skips the run when another runner holds it: two runs of the same job
//! never overlap, on one instance or across instances sharing the database. The lock does not
//! make instances take turns, though: each instance ticks on its own schedule, so with several
//! instances a job runs (one at a time) as often as each of them ticks it; run the jobs on one
//! instance only ([`JOBS_ENABLED`](crate::config::JOBS_ENABLED) `false` on the others). A job's
//! first tick comes after a random delay of up to [`Intervals::first_run_jitter`], so instances
//! started together do not all ask at the same moment, and later ticks follow its interval (a run
//! longer than the interval delays the next tick instead of piling ticks up).
//!
//! Each run is a task of its own: a run that panics is logged, its lock given back, and the next
//! tick runs the job again. Each job's loop is a task of its own too, watched by a supervisor
//! that starts it again, one interval later, should it ever stop by panicking.
//!
//! **Stopping.** [`Scheduler::stop`] (on SIGINT or SIGTERM) lets no new run start; a run already
//! going finishes, gives its lock back, and its loop ends. [`Scheduler::shutdown`] stops and
//! waits for those runs for at most a grace period ([`SHUTDOWN_GRACE`] in the server), then aborts
//! what is left. A run is not cut short lightly: a token renewal between the provider's answer
//! and the commit of the new credential is the one step that cannot simply be repeated (X has
//! already retired the old refresh token by then).
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
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::{Instant, MissedTickBehavior};

use crate::config::{self, Config};

/// How long the server waits, once it stops, for the runs in flight to finish before it aborts
/// them.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

/// How often each job runs, and how long a job may wait for its first run. The default is the
/// production schedule; tests shorten it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intervals {
    pub refresh_tokens: Duration,
    pub refresh_tenant_hosts: Duration,
    pub probe_all: Duration,
    pub netgsm_dlr_poll: Duration,
    pub netgsm_inbox_poll: Duration,
    pub mail_inbox_poll: Duration,
    pub iys_sync: Duration,
    pub purge_raw_bodies: Duration,
    pub purge_oauth_pending: Duration,
    pub purge_probe_runs: Duration,
    pub outbox_recover: Duration,
    pub inbox_consume: Duration,
    pub response_sla: Duration,
    pub snooze_wake: Duration,
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
            refresh_tenant_hosts: MINUTE,
            probe_all: 15 * MINUTE,
            netgsm_dlr_poll: MINUTE,
            netgsm_inbox_poll: HOUR,
            mail_inbox_poll: 2 * MINUTE,
            iys_sync: HOUR,
            purge_raw_bodies: DAY,
            purge_oauth_pending: HOUR,
            purge_probe_runs: DAY,
            outbox_recover: MINUTE,
            inbox_consume: Duration::from_secs(10),
            response_sla: MINUTE,
            snooze_wake: MINUTE,
            first_run_jitter: Duration::from_secs(30),
        }
    }
}

impl Intervals {
    /// How often `job` runs.
    pub fn of(&self, job: Job) -> Duration {
        match job {
            Job::RefreshTokens => self.refresh_tokens,
            Job::RefreshTenantHosts => self.refresh_tenant_hosts,
            Job::ProbeAll => self.probe_all,
            Job::NetgsmDlrPoll => self.netgsm_dlr_poll,
            Job::NetgsmInboxPoll => self.netgsm_inbox_poll,
            Job::MailInboxPoll => self.mail_inbox_poll,
            Job::IysSync => self.iys_sync,
            Job::PurgeRawBodies => self.purge_raw_bodies,
            Job::PurgeOAuthPending => self.purge_oauth_pending,
            Job::PurgeProbeRuns => self.purge_probe_runs,
            Job::OutboxRecover => self.outbox_recover,
            Job::InboxConsume => self.inbox_consume,
            Job::ResponseSla => self.response_sla,
            Job::SnoozeWake => self.snooze_wake,
        }
    }
}

/// The running jobs: one supervised loop per job. Dropping it aborts every loop and every run in
/// flight at once; [`Scheduler::shutdown`] lets the runs finish first.
pub struct Scheduler {
    tasks: JoinSet<()>,
    stop: watch::Sender<bool>,
}

impl Scheduler {
    /// A scheduler running nothing.
    fn idle() -> Scheduler {
        Scheduler {
            tasks: JoinSet::new(),
            stop: watch::channel(false).0,
        }
    }

    /// How many job loops run (none when the jobs are disabled).
    pub fn job_count(&self) -> usize {
        self.tasks.len()
    }

    /// Lets no new run start: each loop ends once the run it is in (if any) has finished and
    /// given its lock back. Returns at once; stopping twice is stopping once.
    pub fn stop(&self) {
        self.stop.send_replace(true);
    }

    /// A handle that [`Scheduler::stop`]s these jobs, for whoever sees the shutdown signal.
    pub fn stopper(&self) -> impl FnOnce() + Send + 'static {
        let stop = self.stop.clone();
        move || {
            stop.send_replace(true);
        }
    }

    /// Stops the jobs ([`Scheduler::stop`]) and waits for the runs in flight to finish, for at
    /// most `grace`; whatever still runs then is aborted (its lock given back by its dropped
    /// guard).
    pub async fn shutdown(mut self, grace: Duration) {
        self.stop();
        let finished = tokio::time::timeout(grace, async {
            while self.tasks.join_next().await.is_some() {}
        })
        .await;
        if finished.is_err() {
            tracing::warn!(
                grace_secs = grace.as_secs(),
                "scheduled jobs still running after the grace period; aborting them"
            );
            self.tasks.shutdown().await;
        }
    }
}

/// Starts every job on the production schedule when `config.jobs_enabled`, and logs that it did;
/// otherwise starts nothing and logs that the jobs are off.
pub fn start(config: &Config, deps: Arc<Deps>) -> Scheduler {
    if !config.jobs_enabled {
        tracing::info!(
            "scheduled jobs are disabled ({}=false): no token renewal, probe, poll or purge runs \
             in this instance",
            config::JOBS_ENABLED
        );
        return Scheduler::idle();
    }
    let jobs = spawn(deps, Intervals::default());
    tracing::info!(jobs = jobs.job_count(), "scheduled jobs started");
    jobs
}

/// Starts every job of [`Job::ALL`] on `intervals`, each under its own lock; one task per job.
pub fn spawn(deps: Arc<Deps>, intervals: Intervals) -> Scheduler {
    let mut scheduler = Scheduler::idle();
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
        scheduler.add(Arc::clone(&deps), schedule, run);
    }
    scheduler
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

impl Scheduler {
    /// Starts one job's supervised loop.
    fn add(&mut self, deps: Arc<Deps>, schedule: Schedule, run: Run) {
        let stop = self.stop.subscribe();
        self.tasks.spawn(supervise(deps, schedule, run, stop));
    }
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
/// stops by panicking. Ends when the loop ends (stopped).
async fn supervise(deps: Arc<Deps>, schedule: Schedule, run: Run, stop: watch::Receiver<bool>) {
    let mut first = schedule.first;
    loop {
        let task = tokio::spawn(job_loop(
            Arc::clone(&deps),
            schedule.clone(),
            first,
            Arc::clone(&run),
            stop.clone(),
        ));
        let _abort = AbortOnDrop(task.abort_handle());
        match task.await {
            Err(e) if e.is_panic() => {
                tracing::error!(
                    job = schedule.name,
                    "the job's loop panicked; it starts again after one interval"
                );
                first = schedule.every;
            }
            // Stopped, or cancelled on purpose.
            _ => return,
        }
    }
}

/// The job's ticks: the first after `first`, then one per interval (at least a millisecond: a
/// zero interval would never let the loop wait), until `stop` turns `true`. A run under way is
/// never interrupted by the stop: the loop ends after it.
async fn job_loop(
    deps: Arc<Deps>,
    schedule: Schedule,
    first: Duration,
    run: Run,
    mut stop: watch::Receiver<bool>,
) {
    let every = schedule.every.max(Duration::from_millis(1));
    let mut ticks = tokio::time::interval_at(Instant::now() + first, every);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        if *stop.borrow_and_update() {
            return;
        }
        tokio::select! {
            biased;
            changed = stop.changed() => {
                // A dropped sender (the scheduler is gone) stops the loop as well.
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
            _ = ticks.tick() => tick(&deps, &schedule, &run).await,
        }
    }
}

/// One tick: the job's lock, one run as a task of its own, the lock given back.
async fn tick(deps: &Arc<Deps>, schedule: &Schedule, run: &Run) {
    let guard = match deps.job_lock.try_acquire(&schedule.lock).await {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            tracing::debug!(
                job = schedule.name,
                "skipped: another runner holds this job's lock"
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
    let abort = AbortOnDrop(task.abort_handle());
    match task.await {
        // The job logged its own summary.
        Ok(_) => {}
        Err(e) if e.is_panic() => tracing::error!(
            job = schedule.name,
            "the run panicked; the next tick runs the job again"
        ),
        Err(_) => {}
    }
    drop(abort);
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use jt_app::error::AppError;
    use jt_app::ports::{JobGuard, JobLock};
    use jt_testkit::fakes::{FakeJobLock, InMemoryUow, deps};

    use super::*;

    const LOCK: &str = "jeeta.jobs.test_job";

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
    fn fake_deps(lock: Arc<dyn JobLock>) -> Arc<Deps> {
        let mut deps = deps(Arc::new(InMemoryUow::new()));
        deps.job_lock = lock;
        Arc::new(deps)
    }

    /// Every job every `every`, starting at once.
    fn every(every: Duration) -> Intervals {
        Intervals {
            refresh_tokens: every,
            refresh_tenant_hosts: every,
            probe_all: every,
            netgsm_dlr_poll: every,
            netgsm_inbox_poll: every,
            mail_inbox_poll: every,
            iys_sync: every,
            purge_raw_bodies: every,
            purge_oauth_pending: every,
            purge_probe_runs: every,
            outbox_recover: every,
            inbox_consume: every,
            response_sla: every,
            snooze_wake: every,
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

    /// A scheduler of one job running `run` every `every`, at once, under [`LOCK`].
    fn one(deps: Arc<Deps>, every: Duration, run: Run) -> Scheduler {
        let mut scheduler = Scheduler::idle();
        scheduler.add(
            deps,
            Schedule {
                name: "test_job",
                lock: LOCK.to_owned(),
                every,
                first: Duration::ZERO,
            },
            run,
        );
        scheduler
    }

    /// A run that counts its starts, takes `takes`, then counts its ends.
    fn counted(takes: Duration) -> (Run, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let (started, ended) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (s, e) = (Arc::clone(&started), Arc::clone(&ended));
        let run: Run = Arc::new(move |_, _| {
            let (s, e) = (Arc::clone(&s), Arc::clone(&e));
            Box::pin(async move {
                s.fetch_add(1, Ordering::SeqCst);
                if !takes.is_zero() {
                    tokio::time::sleep(takes).await;
                }
                e.fetch_add(1, Ordering::SeqCst);
                JobReport::default()
            })
        });
        (run, started, ended)
    }

    #[tokio::test]
    async fn disabled_flag_spawns_nothing() {
        let lock = FakeJobLock::new();
        let jobs = start(
            &config(&[(config::JOBS_ENABLED, "false")]),
            fake_deps(Arc::new(lock.clone())),
        );
        assert_eq!(jobs.job_count(), 0);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(lock.granted().is_empty(), "nothing ran");
        jobs.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn enabled_starts_one_task_per_job() {
        let lock = FakeJobLock::new();
        let jobs = start(&config(&[]), fake_deps(Arc::new(lock)));
        assert_eq!(jobs.job_count(), Job::ALL.len());
        // Stopped before any first run (each waits its jitter), it ends at once.
        tokio::time::timeout(Duration::from_secs(2), jobs.shutdown(SHUTDOWN_GRACE))
            .await
            .expect("idle loops stop at once");
    }

    #[test]
    fn the_production_schedule() {
        let i = Intervals::default();
        assert_eq!(i.of(Job::RefreshTokens), HOUR);
        assert_eq!(i.of(Job::RefreshTenantHosts), MINUTE);
        assert_eq!(i.of(Job::ProbeAll), Duration::from_secs(15 * 60));
        assert_eq!(i.of(Job::NetgsmDlrPoll), MINUTE);
        assert_eq!(i.of(Job::NetgsmInboxPoll), HOUR);
        assert_eq!(i.of(Job::MailInboxPoll), 2 * MINUTE);
        assert_eq!(i.of(Job::IysSync), HOUR);
        assert_eq!(i.of(Job::PurgeRawBodies), DAY);
        assert_eq!(i.of(Job::PurgeOAuthPending), HOUR);
        assert_eq!(i.of(Job::PurgeProbeRuns), DAY);
        assert_eq!(i.of(Job::OutboxRecover), MINUTE);
        assert_eq!(i.of(Job::InboxConsume), Duration::from_secs(10));
        assert_eq!(i.of(Job::ResponseSla), MINUTE);
        assert_eq!(i.of(Job::SnoozeWake), MINUTE);
        assert_eq!(Job::ResponseSla.lock_name(), "jeeta.jobs.response_sla");
        assert_eq!(Job::SnoozeWake.lock_name(), "jeeta.jobs.snooze_wake");
        assert_eq!(Job::InboxConsume.lock_name(), "jeeta.jobs.inbox_consume");
        assert_eq!(i.first_run_jitter, Duration::from_secs(30));
        assert_eq!(SHUTDOWN_GRACE, Duration::from_secs(30));
        // The jitter stays within its bound, and none is none.
        for job in Job::ALL {
            assert!(jitter(job.name(), i.first_run_jitter) <= i.first_run_jitter);
            assert_eq!(jitter(job.name(), Duration::ZERO), Duration::ZERO);
        }
    }

    #[tokio::test]
    async fn every_job_runs_under_its_own_lock_and_gives_it_back() {
        let lock = FakeJobLock::new();
        let jobs = spawn(
            fake_deps(Arc::new(lock.clone())),
            every(Duration::from_millis(20)),
        );
        let names: BTreeSet<String> = Job::ALL.iter().map(Job::lock_name).collect();
        assert!(
            eventually(|| lock.granted().into_iter().collect::<BTreeSet<_>>() == names).await,
            "granted: {:?}",
            lock.granted()
        );
        jobs.shutdown(SHUTDOWN_GRACE).await;
        // Every lock taken was given back.
        assert!(names.iter().all(|n| !lock.is_held(n)));
        assert_eq!(lock.granted().len(), lock.released().len());
    }

    #[tokio::test]
    async fn a_tick_skips_while_another_runner_holds_the_lock() {
        let lock = FakeJobLock::new();
        let (run, started, _) = counted(Duration::ZERO);
        // Another runner holds the lock: ticks come and go, the job never runs.
        lock.hold(LOCK);
        let jobs = one(
            fake_deps(Arc::new(lock.clone())),
            Duration::from_millis(10),
            run,
        );
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(started.load(Ordering::SeqCst), 0);
        assert!(lock.granted().is_empty());
        // Once it lets go, the next tick runs the job.
        lock.free(LOCK);
        assert!(eventually(|| started.load(Ordering::SeqCst) >= 2).await);
        jobs.shutdown(SHUTDOWN_GRACE).await;
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
        let jobs = one(
            fake_deps(Arc::new(lock.clone())),
            Duration::from_millis(10),
            run,
        );
        assert!(eventually(|| runs.load(Ordering::SeqCst) >= 3).await);
        jobs.shutdown(SHUTDOWN_GRACE).await;
        // Each run took the lock and gave it back, the panicking one included.
        assert!(!lock.is_held(LOCK));
        assert_eq!(lock.granted().len(), lock.released().len());
        assert!(lock.granted().len() >= 3);
    }

    /// A job lock whose first request panics (a bug in the loop itself), granting afterwards.
    struct PanicsOnce {
        inner: FakeJobLock,
        panicked: AtomicBool,
    }

    // The port's async method, written out as the port's macro expands it.
    impl JobLock for PanicsOnce {
        fn try_acquire<'a, 'b, 'f>(
            &'a self,
            name: &'b str,
        ) -> Pin<Box<dyn Future<Output = Result<Option<Box<dyn JobGuard>>, AppError>> + Send + 'f>>
        where
            'a: 'f,
            'b: 'f,
            Self: 'f,
        {
            Box::pin(async move {
                if !self.panicked.swap(true, Ordering::SeqCst) {
                    panic!("the loop fails");
                }
                self.inner.try_acquire(name).await
            })
        }
    }

    #[tokio::test]
    async fn a_panicking_loop_is_started_again_after_one_interval() {
        let lock = Arc::new(PanicsOnce {
            inner: FakeJobLock::new(),
            panicked: AtomicBool::new(false),
        });
        let (run, started, _) = counted(Duration::ZERO);
        let jobs = one(fake_deps(lock.clone()), Duration::from_millis(20), run);
        assert!(eventually(|| started.load(Ordering::SeqCst) >= 2).await);
        assert!(lock.panicked.load(Ordering::SeqCst));
        jobs.shutdown(SHUTDOWN_GRACE).await;
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_running_job_within_grace() {
        let lock = FakeJobLock::new();
        let (run, started, ended) = counted(Duration::from_millis(300));
        let jobs = one(
            fake_deps(Arc::new(lock.clone())),
            Duration::from_millis(10),
            run,
        );
        assert!(eventually(|| started.load(Ordering::SeqCst) == 1).await);
        let asked = std::time::Instant::now();
        jobs.shutdown(Duration::from_secs(5)).await;
        // The run under way finished (not cut short), no other started, and the lock is back.
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert!(asked.elapsed() < Duration::from_secs(5));
        assert!(!lock.is_held(LOCK));
        assert_eq!(lock.released(), [LOCK]);
    }

    #[tokio::test]
    async fn shutdown_aborts_a_run_that_outlives_the_grace() {
        let lock = FakeJobLock::new();
        let (run, started, ended) = counted(Duration::from_secs(30));
        let jobs = one(
            fake_deps(Arc::new(lock.clone())),
            Duration::from_millis(10),
            run,
        );
        assert!(eventually(|| started.load(Ordering::SeqCst) == 1).await);
        let asked = std::time::Instant::now();
        jobs.shutdown(Duration::from_millis(100)).await;
        assert!(asked.elapsed() < Duration::from_secs(5));
        assert_eq!(ended.load(Ordering::SeqCst), 0, "the run was aborted");
        // Its dropped guard gave the lock back.
        assert!(eventually(|| !lock.is_held(LOCK)).await);
    }
}
