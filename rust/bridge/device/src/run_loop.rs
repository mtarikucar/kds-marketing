//! The bridge's loop (spec §6): it registers, polls for commands, runs them on the phones and
//! posts what they did. Three tasks share it, plus one worker per phone:
//!
//! - **Register** on start, then every `heartbeat_s` the server answers, with the phones the
//!   registry lists: only the configured `serials`, if any; each serial once; at most
//!   [`MAX_PHONES`]; never a retired one. A listing that fails, panics or takes too long is
//!   replaced by the last good one, and a phone whose report fails by its last good report for
//!   up to [`STALE_REPORT_HEARTBEATS`] registers, so a slow `adb` does not take phones offline. A
//!   phone the server refuses is logged with its serial and the reason (when the refusal is new);
//!   a retired one ([`PHONE_RETIRED`]) is not listed again until the bridge restarts. A failed
//!   register is tried again after a growing pause, at most a heartbeat.
//! - **Poll** while a phone is registered: at once after a poll that brought work, and at least
//!   [`Timing::idle_poll_floor`] after asking for one that brought none. A failed poll (no answer,
//!   an error status, or a body that is not a poll) is logged and followed by a growing pause: it
//!   is never read as an idle poll.
//! - **Run** the commands of different phones at the same time, and those of one phone one after
//!   the other in the order they came: one worker per phone. A command id runs once: the last
//!   [`RECENT_IDS`] ids are remembered, so a command handed out again (spec §3: not acknowledged
//!   within 10 s) is skipped. A command this build cannot read is failed by its id as
//!   `unsupported_by_bridge`, the decoder's message as the failure's detail. One that waited in
//!   its phone's queue longer than [`Timing::stale_after`] is failed as `timeout` without being
//!   run.
//! - **Cut off** a command that outlasts its timeout, or that runs when the bridge stops: its
//!   task is aborted, which drops the driver's future, and the phone's next step waits until it
//!   is gone; then the worker awaits [`PhoneDriver::recover`]. Each command runs in a task of its
//!   own, so a driver that panics fails that command as `bridge_error` (and its phone recovers)
//!   while the phone's worker goes on.
//! - **Post** the results in batches of what is ready ([`MAX_RESULTS`] at most, and
//!   [`MAX_RESULTS_BODY_BYTES`] serialized). A post that got no answer, a server error, or a 408
//!   or 429 is sent again after a growing pause (results are applied once per command, so that
//!   is safe), at most [`Timing::post_attempts`] times in a row: then the batch is split as a
//!   refused one is. A refused batch (422 or 413) is refused for good and is never sent again as
//!   it is: it is split in halves until the result the server refuses stands alone, and that
//!   result is dropped. Before it is batched, a result is checked against the protocol's limits:
//!   one that breaks them is replaced by a `bridge_error` failure, so the server is not sent what
//!   it must refuse.
//! - **Stop** when the shutdown future completes, or when one of the three tasks ends on its own
//!   (logged at `error`; [`run`] then answers [`RunError::TaskEnded`]). Polling stops, a running
//!   command is cut off and failed as `bridge_error`, commands still queued stay unanswered (the
//!   server hands them out again later), and the results made get [`Timing::shutdown_grace`],
//!   shared with the cutting off, to be posted.
//!
//! # Logging
//!
//! Command ids, kinds and statuses, failure reasons, phone serials, counts, and request errors
//! without URLs. Never the key, a command's arguments, an observation, shell output, a file, a
//! failure's detail, a panic's message or a signed address.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jt_device_protocol::{
    CommandsOut, CommandsQuery, DeviceCommand, FailReason, HEARTBEAT_S, LeasedCommand,
    MAX_COMMANDS, MAX_PHONES, MAX_RESULTS, MAX_RESULTS_BODY_BYTES, MAX_WAIT_S, Outcome,
    PHONE_RETIRED, PROTOCOL_VERSION, PhoneReport, RegisterIn, ResultIn, ResultsIn,
};
use jt_devices::DEFAULT_EXPIRES_IN;
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::client::{ClientError, JeetaClient};
use crate::config::Config;
use crate::driver::{AttachedPhone, PhoneDriver, PhoneRegistry};

/// How many command ids the bridge remembers to run each once.
pub const RECENT_IDS: usize = 1000;
/// How many transient failures in a row a batch of results gets before it is split as a refused
/// one is (and a lone result dropped). With the default pauses, 1 s doubling to 60 s, ten tries
/// take about four minutes: within the five of a command's default expiry.
pub const MAX_POST_ATTEMPTS: u32 = 10;
/// For how many registers in a row a phone's last good report stands in for one that failed.
pub const STALE_REPORT_HEARTBEATS: u32 = 3;
/// How long a cut-off command's task may take to stop before that is logged. The phone's next
/// step waits for it all the same: two commands never run on one phone at once.
pub const STOP_WAIT: Duration = Duration::from_secs(5);
/// How long [`PhoneDriver::recover`] may take.
pub const RECOVER_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest heartbeat the bridge follows, in the server's seconds.
const MAX_HEARTBEAT_S: u32 = 300;
/// What a results body adds around its results: `{"results":[` and `]}`.
const RESULTS_ENVELOPE_BYTES: usize = 14;
/// The most characters of a refusal's reason, or a serial, the log keeps.
const MAX_LOGGED_CHARS: usize = 200;

/// How long the loop waits, for what. [`Timing::default`] is the protocol's own; tests shorten it.
#[derive(Clone, Debug)]
pub struct Timing {
    /// One of the server's seconds: the bridge registers every `heartbeat_s` of these. One real
    /// second outside tests.
    pub server_second: Duration,
    /// How long a poll asks the server to wait when nothing is queued, in seconds (the server's
    /// `max_wait_s` caps it).
    pub poll_wait_s: u32,
    /// The least time from asking for one poll to asking for the next when the first brought
    /// nothing new: a server that answers at once (a `max_wait_s` of 0, say) is not polled in a
    /// busy loop. A long poll that waited longer adds nothing.
    pub idle_poll_floor: Duration,
    /// The pause after a first failure; it doubles with each failure after it, up to
    /// `backoff_max`, and a success brings it back.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// How many transient failures in a row a batch of results gets ([`MAX_POST_ATTEMPTS`]).
    pub post_attempts: u32,
    /// How long a driver may take over one command before it is cut off and failed as `timeout`.
    pub command_timeout: Duration,
    /// The same for `push_file` and `pull_file`, which move a whole file.
    pub transfer_timeout: Duration,
    /// How long listing the phones, and reading one, may take before the last good listing or
    /// report stands in.
    pub report_timeout: Duration,
    /// How long a command may wait in its phone's queue, from when it arrived (this computer's
    /// monotonic clock), before it is failed as `timeout` without being run: a command's default
    /// expiry.
    pub stale_after: Duration,
    /// How long cutting off the running commands and posting the results left may take at
    /// shutdown.
    pub shutdown_grace: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            server_second: Duration::from_secs(1),
            poll_wait_s: MAX_WAIT_S,
            idle_poll_floor: Duration::from_secs(1),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            post_attempts: MAX_POST_ATTEMPTS,
            command_timeout: Duration::from_secs(120),
            transfer_timeout: Duration::from_secs(30 * 60),
            report_timeout: Duration::from_secs(10),
            stale_after: DEFAULT_EXPIRES_IN.unsigned_abs(),
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

/// Why [`run`] ended other than by its shutdown future.
#[derive(Debug)]
pub enum RunError {
    /// The HTTP client could not be built.
    Start(ClientError),
    /// One of the bridge's tasks (`register`, `poll` or `post`) ended while the bridge ran.
    TaskEnded(&'static str),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Start(error) => write!(f, "the bridge could not start: {error}"),
            RunError::TaskEnded(task) => write!(f, "the bridge's {task} task ended while it ran"),
        }
    }
}

impl std::error::Error for RunError {}

/// Runs the bridge for `config` with the phones `registry` lists, until `shutdown` completes, or
/// until one of its tasks ends on its own ([`RunError::TaskEnded`]). Every other failure is
/// logged and tried again. See the module's notes for what stopping does.
pub async fn run(
    config: &Config,
    registry: Arc<dyn PhoneRegistry>,
    timing: Timing,
    shutdown: impl Future<Output = ()>,
) -> Result<(), RunError> {
    let client = JeetaClient::new(config).map_err(RunError::Start)?;
    let (stop_tx, stop) = watch::channel(false);
    let (table_tx, table_rx) = watch::channel(PhoneTable::default());
    let (results_tx, results_rx) = mpsc::unbounded_channel();
    let listing = Listing {
        bridge_id: config.bridge_id().to_owned(),
        serials: config.serials().map(<[String]>::to_vec),
    };
    let mut heartbeat = tokio::spawn(heartbeat(
        client.clone(),
        registry,
        listing,
        table_tx,
        timing.clone(),
    ));
    let mut poll = tokio::spawn(poll(
        client.clone(),
        table_rx,
        results_tx,
        timing.clone(),
        stop.clone(),
    ));
    let mut post = tokio::spawn(post(client, results_rx, timing.clone(), stop));

    let ended = first_end(
        shutdown,
        [
            ("register", &mut heartbeat),
            ("poll", &mut poll),
            ("post", &mut post),
        ],
    )
    .await;
    if let Some(task) = ended {
        error!(
            task,
            "a task of the bridge ended while it ran; the bridge stops"
        );
    }
    let _ = stop_tx.send(true);
    heartbeat.abort();
    // The poll task stops, and its workers cut off what runs and end: then no sender of results
    // is left, and the poster ends once it has posted what they made.
    let deadline = tokio::time::Instant::now() + timing.shutdown_grace;
    if ended != Some("poll") {
        settle(
            &mut poll,
            deadline,
            "commands still being cut off at shutdown",
        )
        .await;
    }
    if ended != Some("post") {
        settle(&mut post, deadline, "results not yet posted at shutdown").await;
    }
    info!("the bridge stopped");
    match ended {
        None => Ok(()),
        Some(task) => Err(RunError::TaskEnded(task)),
    }
}

/// Waits for `shutdown`, or for one of `tasks` to end first, and answers that one's name.
async fn first_end(
    shutdown: impl Future<Output = ()>,
    tasks: [(&'static str, &mut JoinHandle<()>); 3],
) -> Option<&'static str> {
    let [(a, first), (b, second), (c, third)] = tasks;
    tokio::select! {
        () = shutdown => None,
        _ = first => Some(a),
        _ = second => Some(b),
        _ = third => Some(c),
    }
}

/// Waits for `task` until `deadline`, then aborts it and logs that `what` were dropped.
async fn settle(task: &mut JoinHandle<()>, deadline: tokio::time::Instant, what: &'static str) {
    if tokio::time::timeout_at(deadline, &mut *task).await.is_err() {
        warn!(what, "the shutdown grace ran out; these are dropped");
        task.abort();
    }
}

/// Waits until the bridge stops (a sender that is gone counts as stopping).
async fn stopping(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopping| *stopping).await;
}

/// Sleeps `pause`, and answers whether the bridge began to stop meanwhile (it wakes then).
async fn pause(stop: &mut watch::Receiver<bool>, pause: Duration) -> bool {
    tokio::select! {
        biased;
        () = stopping(stop) => true,
        () = tokio::time::sleep(pause) => false,
    }
}

/// The registered phones, as the last successful register left them.
#[derive(Default)]
struct PhoneTable {
    phones: HashMap<String, Arc<dyn PhoneDriver>>,
    /// The server's `max_wait_s`.
    max_wait_s: u32,
}

/// What a register lists.
struct Listing {
    bridge_id: String,
    serials: Option<Vec<String>>,
}

/// A pause that doubles with each failure.
struct Backoff {
    min: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    fn new(timing: &Timing) -> Backoff {
        Backoff {
            min: timing.backoff_min,
            max: timing.backoff_max.max(timing.backoff_min),
            next: timing.backoff_min,
        }
    }

    /// The pause after this failure.
    fn next(&mut self) -> Duration {
        let pause = self.next;
        self.next = self.next.saturating_mul(2).min(self.max);
        pause
    }

    fn reset(&mut self) {
        self.next = self.min;
    }
}

/// The last ids seen, at most `cap` of them, oldest forgotten first.
struct RecentIds {
    cap: usize,
    known: HashSet<Uuid>,
    order: VecDeque<Uuid>,
}

impl RecentIds {
    fn new(cap: usize) -> RecentIds {
        RecentIds {
            cap,
            known: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    /// Whether `id` is new; it is remembered from now on.
    fn insert(&mut self, id: Uuid) -> bool {
        if !self.known.insert(id) {
            return false;
        }
        self.order.push_back(id);
        if self.order.len() > self.cap
            && let Some(oldest) = self.order.pop_front()
        {
            self.known.remove(&oldest);
        }
        true
    }
}

/// Text from the server (a refusal's reason, a serial), fit for one log line.
fn loggable(text: &str) -> String {
    text.chars()
        .take(MAX_LOGGED_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// A task aborted when this is dropped.
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

// ---------------------------------------------------------------------------------------------
// Register

/// What earlier registers saw, to stand in for a listing or a report that failed.
#[derive(Default)]
struct LastGood {
    /// The registry's last good listing.
    attached: Vec<AttachedPhone>,
    /// Each listed phone's last good report, and how many registers in a row it has stood in.
    reports: HashMap<String, (PhoneReport, u32)>,
}

async fn heartbeat(
    client: JeetaClient,
    registry: Arc<dyn PhoneRegistry>,
    listing: Listing,
    table: watch::Sender<PhoneTable>,
    timing: Timing,
) {
    let mut retired: HashSet<String> = HashSet::new();
    let mut refusals: HashMap<String, String> = HashMap::new();
    let mut registered: Vec<String> = Vec::new();
    let mut last = LastGood::default();
    let mut backoff = Backoff::new(&timing);
    let mut every = timing.server_second * HEARTBEAT_S;
    loop {
        let listed = listed_phones(&registry, &listing, &retired, &mut last, &timing).await;
        let sent: HashSet<String> = listed.iter().map(|(p, _)| p.serial.clone()).collect();
        let body = RegisterIn {
            bridge_id: listing.bridge_id.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            protocol: PROTOCOL_VERSION,
            phones: listed.iter().map(|(_, report)| report.clone()).collect(),
        };
        let pause = match client.register(&body).await {
            Ok(out) => {
                backoff.reset();
                every = timing.server_second * out.heartbeat_s.clamp(1, MAX_HEARTBEAT_S);
                let mut now_refused = HashMap::new();
                // Only the phones this bridge listed: anything else is not its to act on.
                for refused in out.refused.into_iter().filter(|r| sent.contains(&r.serial)) {
                    let serial = loggable(&refused.serial);
                    if refused.reason == PHONE_RETIRED {
                        if retired.insert(refused.serial) {
                            warn!(
                                serial = %serial,
                                reason = PHONE_RETIRED,
                                "the server refused a retired phone; it is not listed again until the bridge restarts"
                            );
                        }
                    } else {
                        if refusals.get(&refused.serial) != Some(&refused.reason) {
                            warn!(
                                serial = %serial,
                                reason = %loggable(&refused.reason),
                                "the server refused a phone"
                            );
                        }
                        now_refused.insert(refused.serial, refused.reason);
                    }
                }
                refusals = now_refused;
                let drivers: HashMap<String, Arc<dyn PhoneDriver>> = listed
                    .into_iter()
                    .map(|(phone, _)| (phone.serial, phone.driver))
                    .collect();
                let phones: HashMap<String, Arc<dyn PhoneDriver>> = out
                    .phones
                    .into_iter()
                    .filter_map(|p| drivers.get(&p.serial).map(|d| (p.serial, d.clone())))
                    .collect();
                let mut serials: Vec<String> = phones.keys().cloned().collect();
                serials.sort();
                if serials != registered {
                    info!(phones = serials.len(), serials = ?serials, "registered phones");
                    registered = serials;
                }
                debug!(phones = phones.len(), "registered");
                table.send_replace(PhoneTable {
                    phones,
                    max_wait_s: out.max_wait_s,
                });
                every
            }
            Err(error) => {
                warn!(%error, "registering with Jeeta failed");
                backoff.next().min(every)
            }
        };
        tokio::time::sleep(pause).await;
    }
}

/// The phones to register, each with what it reported: the attached phones the configuration
/// wants and that are not retired, each serial once, at most [`MAX_PHONES`]. The registry and
/// each driver run in tasks of their own, within `report_timeout`; one that fails stands in by
/// what `last` remembers (see the module's notes).
async fn listed_phones(
    registry: &Arc<dyn PhoneRegistry>,
    listing: &Listing,
    retired: &HashSet<String>,
    last: &mut LastGood,
    timing: &Timing,
) -> Vec<(AttachedPhone, PhoneReport)> {
    let attached = {
        let registry = registry.clone();
        let mut listing_task = AbortOnDrop(tokio::spawn(async move { registry.attached().await }));
        match tokio::time::timeout(timing.report_timeout, &mut listing_task.0).await {
            Ok(Ok(Ok(attached))) => {
                last.attached.clone_from(&attached);
                attached
            }
            Ok(Ok(Err(error))) => {
                warn!(
                    reason = error.reason.key(),
                    phones = last.attached.len(),
                    "listing the attached phones failed; the last list stands in"
                );
                last.attached.clone()
            }
            Ok(Err(_)) => {
                error!(
                    phones = last.attached.len(),
                    "the phone registry failed while listing the phones; the last list stands in"
                );
                last.attached.clone()
            }
            Err(_) => {
                warn!(
                    reason = FailReason::Timeout.key(),
                    phones = last.attached.len(),
                    "listing the attached phones failed; the last list stands in"
                );
                last.attached.clone()
            }
        }
    };
    let mut once = HashSet::new();
    let mut wanted: Vec<AttachedPhone> = attached
        .into_iter()
        .filter(|phone| {
            listing
                .serials
                .as_ref()
                .is_none_or(|serials| serials.contains(&phone.serial))
                && !retired.contains(&phone.serial)
                && once.insert(phone.serial.clone())
        })
        .collect();
    if wanted.len() > MAX_PHONES {
        warn!(
            attached = wanted.len(),
            listed = MAX_PHONES,
            "more phones than one register carries; the rest are left out"
        );
        wanted.truncate(MAX_PHONES);
    }
    // Read every phone at once: a slow one must not hold up the others' heartbeat.
    let mut reads = JoinSet::new();
    let mut tasks = HashMap::new();
    for (index, phone) in wanted.iter().enumerate() {
        let driver = phone.driver.clone();
        let bound = timing.report_timeout;
        let task =
            reads.spawn(async move { (index, tokio::time::timeout(bound, driver.report()).await) });
        tasks.insert(task.id(), index);
    }
    let mut read: Vec<Result<PhoneReport, &'static str>> = vec![Err("panicked"); wanted.len()];
    while let Some(done) = reads.join_next().await {
        match done {
            Ok((index, Ok(Ok(report)))) => read[index] = Ok(report),
            Ok((index, Ok(Err(error)))) => read[index] = Err(error.reason.key()),
            Ok((index, Err(_))) => read[index] = Err(FailReason::Timeout.key()),
            Err(failed) => {
                if let Some(index) = tasks.get(&failed.id()) {
                    error!(
                        serial = %wanted[*index].serial,
                        "a phone's driver failed while reporting"
                    );
                }
            }
        }
    }
    last.reports
        .retain(|serial, _| wanted.iter().any(|phone| phone.serial == *serial));
    let mut listed = Vec::new();
    for (phone, read) in wanted.into_iter().zip(read) {
        let report = match read {
            Ok(mut report) => {
                report.serial.clone_from(&phone.serial);
                report.platform = phone.driver.platform();
                last.reports
                    .insert(phone.serial.clone(), (report.clone(), 0));
                report
            }
            Err(reason) => match last.reports.get_mut(&phone.serial) {
                Some((report, stood_in)) if *stood_in < STALE_REPORT_HEARTBEATS => {
                    *stood_in += 1;
                    warn!(
                        serial = %phone.serial,
                        reason,
                        stood_in = *stood_in,
                        "a phone could not be read; its last report stands in"
                    );
                    report.clone()
                }
                _ => {
                    last.reports.remove(&phone.serial);
                    warn!(
                        serial = %phone.serial,
                        reason,
                        "a phone could not be read; it is left out of this register"
                    );
                    continue;
                }
            },
        };
        listed.push((phone, report));
    }
    listed
}

// ---------------------------------------------------------------------------------------------
// Poll and run

async fn poll(
    client: JeetaClient,
    mut table: watch::Receiver<PhoneTable>,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
    mut stop: watch::Receiver<bool>,
) {
    let mut recent = RecentIds::new(RECENT_IDS);
    let mut workers = Workers::new(
        table.clone(),
        client.clone(),
        results.clone(),
        timing.clone(),
        stop.clone(),
    );
    let mut backoff = Backoff::new(&timing);
    loop {
        // Commands are queued for registered phones only.
        let max_wait_s = tokio::select! {
            biased;
            () = stopping(&mut stop) => break,
            ready = table.wait_for(|t| !t.phones.is_empty()) => match ready {
                Ok(phones) => phones.max_wait_s,
                Err(_) => break,
            },
        };
        let query = CommandsQuery {
            wait_s: timing.poll_wait_s.min(max_wait_s),
            limit: MAX_COMMANDS,
        };
        let asked = Instant::now();
        let answer = tokio::select! {
            biased;
            () = stopping(&mut stop) => break,
            answer = client.commands(&query) => answer,
        };
        let read = match answer {
            Ok(body) => CommandsOut::decode_lenient(body).map_err(|error| {
                warn!(
                    field = error.field(),
                    "a poll's answer is not a poll; polling again after a pause"
                );
            }),
            Err(error) => {
                warn!(%error, "polling for commands failed; polling again after a pause");
                Err(())
            }
        };
        let Ok(read) = read else {
            if pause(&mut stop, backoff.next()).await {
                break;
            }
            continue;
        };
        backoff.reset();
        if read.dropped > 0 {
            warn!(
                dropped = read.dropped,
                "a poll carried commands without a readable id; they are left out"
            );
        }
        let mut worked = false;
        for (command_id, message) in read.unreadable {
            if !recent.insert(command_id) {
                continue;
            }
            worked = true;
            warn!(
                command_id = %command_id,
                status = "failed",
                reason = FailReason::UnsupportedByBridge.key(),
                "a command this bridge cannot read"
            );
            let _ = results.send(ResultIn {
                command_id,
                outcome: Outcome::failed(FailReason::UnsupportedByBridge, &message),
                duration_ms: 0,
            });
        }
        for leased in read.commands {
            if !recent.insert(leased.id) {
                debug!(
                    command_id = %leased.id,
                    "a command handed out again is skipped: it ran or is running"
                );
                continue;
            }
            debug!(
                command_id = %leased.id,
                kind = leased.command.kind(),
                serial = %leased.serial,
                "command received"
            );
            worked = true;
            workers.dispatch(leased);
        }
        if !worked {
            let spent = asked.elapsed();
            if spent < timing.idle_poll_floor
                && pause(&mut stop, timing.idle_poll_floor - spent).await
            {
                break;
            }
        }
    }
    workers.finish().await;
}

/// A command in its phone's queue, and when it arrived.
struct Queued {
    leased: LeasedCommand,
    arrived: Instant,
}

/// The phones' workers, one each, started on a phone's first command.
struct Workers {
    queues: HashMap<String, mpsc::UnboundedSender<Queued>>,
    tasks: JoinSet<()>,
    table: watch::Receiver<PhoneTable>,
    client: JeetaClient,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
    stop: watch::Receiver<bool>,
}

impl Workers {
    fn new(
        table: watch::Receiver<PhoneTable>,
        client: JeetaClient,
        results: mpsc::UnboundedSender<ResultIn>,
        timing: Timing,
        stop: watch::Receiver<bool>,
    ) -> Workers {
        Workers {
            queues: HashMap::new(),
            tasks: JoinSet::new(),
            table,
            client,
            results,
            timing,
            stop,
        }
    }

    /// Hands `leased` to its phone's worker, starting one for a phone that has none.
    ///
    /// A worker should not stop while the bridge runs (a driver's panic is caught per command),
    /// but one found stopped is logged and started again, and `leased` is failed as
    /// `bridge_error` rather than run: the commands queued before it were lost with the worker,
    /// and running it without them could act on the wrong screen. Those lost commands are never
    /// answered: the server lets them expire.
    fn dispatch(&mut self, leased: LeasedCommand) {
        let serial = leased.serial.clone();
        let queued = Queued {
            leased,
            arrived: Instant::now(),
        };
        let Some(queue) = self.queues.get(&serial) else {
            let queue = self.start(&serial);
            let _ = queue.send(queued);
            self.queues.insert(serial, queue);
            return;
        };
        let Err(mpsc::error::SendError(queued)) = queue.send(queued) else {
            return;
        };
        error!(
            serial = %serial,
            command_id = %queued.leased.id,
            "a phone's worker had stopped; the command is failed and the worker started again"
        );
        let _ = self.results.send(ResultIn {
            command_id: queued.leased.id,
            outcome: Outcome::failed(
                FailReason::BridgeError,
                "the bridge's worker for this phone had stopped; it was started again",
            ),
            duration_ms: 0,
        });
        let queue = self.start(&serial);
        self.queues.insert(serial, queue);
    }

    fn start(&mut self, serial: &str) -> mpsc::UnboundedSender<Queued> {
        let (queue, commands) = mpsc::unbounded_channel();
        self.tasks.spawn(work(
            serial.to_owned(),
            commands,
            self.table.clone(),
            self.client.clone(),
            self.results.clone(),
            self.timing.clone(),
            self.stop.clone(),
        ));
        queue
    }

    /// Waits for every worker to end: at shutdown each cuts off what it runs and ends.
    async fn finish(mut self) {
        self.queues.clear();
        while self.tasks.join_next().await.is_some() {}
    }
}

/// Whether a worker goes on to its next command or ends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Then {
    Next,
    Stop,
}

/// One phone's worker: its commands, one after the other.
async fn work(
    serial: String,
    mut commands: mpsc::UnboundedReceiver<Queued>,
    table: watch::Receiver<PhoneTable>,
    client: JeetaClient,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        let queued = tokio::select! {
            biased;
            () = stopping(&mut stop) => return,
            next = commands.recv() => match next {
                Some(queued) => queued,
                None => return,
            },
        };
        let leased = &queued.leased;
        let started = Instant::now();
        let (outcome, then) =
            carry_out(&serial, &queued, &table, &client, &timing, &mut stop).await;
        let duration_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        match &outcome {
            Outcome::Done { .. } => info!(
                command_id = %leased.id,
                kind = leased.command.kind(),
                serial = %serial,
                status = "done",
                duration_ms,
                "command finished"
            ),
            Outcome::Failed { reason, .. } => info!(
                command_id = %leased.id,
                kind = leased.command.kind(),
                serial = %serial,
                status = "failed",
                reason = reason.key(),
                duration_ms,
                "command finished"
            ),
        }
        let _ = results.send(ResultIn {
            command_id: leased.id,
            outcome,
            duration_ms,
        });
        if then == Then::Stop {
            return;
        }
    }
}

/// Runs one command on its phone's driver, within its timeout, unless the bridge stops first.
async fn carry_out(
    serial: &str,
    queued: &Queued,
    table: &watch::Receiver<PhoneTable>,
    client: &JeetaClient,
    timing: &Timing,
    stop: &mut watch::Receiver<bool>,
) -> (Outcome, Then) {
    let leased = &queued.leased;
    let waited = queued.arrived.elapsed();
    if waited > timing.stale_after {
        let detail = format!(
            "the command waited {} s in the phone's queue, past its expiry; it was not run",
            waited.as_secs()
        );
        return (Outcome::failed(FailReason::Timeout, &detail), Then::Next);
    }
    // The server validated it before queuing; a driver relies on the bounds.
    if let Err(error) = leased.command.validate() {
        let detail = format!("the command breaks a limit ({error})");
        return (
            Outcome::failed(FailReason::BridgeError, &detail),
            Then::Next,
        );
    }
    let driver = table.borrow().phones.get(serial).cloned();
    let Some(driver) = driver else {
        let detail = "the phone is not registered by this bridge now";
        return (
            Outcome::failed(FailReason::DeviceOffline, detail),
            Then::Next,
        );
    };
    let bound = match leased.command {
        DeviceCommand::PushFile { .. } | DeviceCommand::PullFile { .. } => timing.transfer_timeout,
        _ => timing.command_timeout,
    };
    let files = client.files(leased.download_url.clone());
    let command = leased.command.clone();
    // A task of its own: a driver's panic fails this command, not the phone's worker.
    let mut running = {
        let driver = driver.clone();
        AbortOnDrop(tokio::spawn(async move {
            driver.execute(&command, &files).await
        }))
    };
    let ended = tokio::select! {
        biased;
        () = stopping(stop) => None,
        ended = tokio::time::timeout(bound, &mut running.0) => Some(ended),
    };
    match ended {
        Some(Ok(Ok(Ok(result)))) => (Outcome::Done { result }, Then::Next),
        Some(Ok(Ok(Err(error)))) => (Outcome::failed(error.reason, &error.detail), Then::Next),
        Some(Ok(Err(_))) => {
            // The panic's message is the driver's and may quote the command: not logged.
            error!(
                serial = %serial,
                command_id = %leased.id,
                kind = leased.command.kind(),
                "the phone's driver failed while carrying out a command"
            );
            recover(serial, &driver).await;
            let detail = "the phone's driver failed while carrying out the command";
            (Outcome::failed(FailReason::BridgeError, detail), Then::Next)
        }
        Some(Err(_)) => {
            cut_off(serial, leased.id, running).await;
            recover(serial, &driver).await;
            let detail = format!(
                "the phone did not finish the command within {} s",
                bound.as_secs()
            );
            (Outcome::failed(FailReason::Timeout, &detail), Then::Next)
        }
        None => {
            cut_off(serial, leased.id, running).await;
            recover(serial, &driver).await;
            let detail = "the bridge stopped while the command ran";
            (Outcome::failed(FailReason::BridgeError, detail), Then::Stop)
        }
    }
}

/// Aborts a command's task and waits until it is gone, so the phone's next step never runs
/// beside it: [`STOP_WAIT`], then on without a bound once that is logged.
async fn cut_off<T>(serial: &str, command_id: Uuid, mut running: AbortOnDrop<T>) {
    running.0.abort();
    if tokio::time::timeout(STOP_WAIT, &mut running.0)
        .await
        .is_err()
    {
        error!(
            serial = %serial,
            command_id = %command_id,
            "a cut-off command has not stopped yet; the phone waits for it"
        );
        let _ = (&mut running.0).await;
    }
}

/// Awaits the driver's [`PhoneDriver::recover`], in a task of its own, within
/// [`RECOVER_TIMEOUT`].
async fn recover(serial: &str, driver: &Arc<dyn PhoneDriver>) {
    let driver = driver.clone();
    let mut recovering = AbortOnDrop(tokio::spawn(async move { driver.recover().await }));
    match tokio::time::timeout(RECOVER_TIMEOUT, &mut recovering.0).await {
        Ok(Ok(())) => debug!(serial = %serial, "the phone's driver recovered"),
        Ok(Err(_)) => error!(serial = %serial, "the phone's driver failed while recovering"),
        Err(_) => warn!(serial = %serial, "the phone's driver did not recover in time"),
    }
}

// ---------------------------------------------------------------------------------------------
// Post

/// A result ready to be batched, and its size serialized.
struct Ready {
    result: ResultIn,
    bytes: usize,
}

fn serialized_len(result: &ResultIn) -> usize {
    serde_json::to_vec(result).map_or(usize::MAX, |bytes| bytes.len())
}

/// `result` as it is sent: as it is when the server can take it, else a `bridge_error` failure
/// for its command that says why.
fn sendable(result: ResultIn) -> Ready {
    let (command_id, duration_ms) = (result.command_id, result.duration_ms);
    let mut alone = ResultsIn {
        results: vec![result],
    };
    let detail = match alone.validate() {
        Err(error) => {
            warn!(
                command_id = %command_id,
                field = error.field(),
                "a result breaks a protocol limit; its command is failed instead"
            );
            Some(format!(
                "the result breaks a protocol limit ({})",
                error.field()
            ))
        }
        Ok(()) => None,
    };
    let result = alone.results.pop().expect("one result");
    let bytes = serialized_len(&result);
    let detail = detail.or_else(|| {
        (bytes.saturating_add(RESULTS_ENVELOPE_BYTES) > MAX_RESULTS_BODY_BYTES).then(|| {
            warn!(
                command_id = %command_id,
                bytes,
                "a result is larger than one request carries; its command is failed instead"
            );
            format!(
                "the result is {bytes} bytes, more than the {MAX_RESULTS_BODY_BYTES} one request to Jeeta carries"
            )
        })
    });
    match detail {
        None => Ready { result, bytes },
        Some(detail) => {
            let result = ResultIn {
                command_id,
                outcome: Outcome::failed(FailReason::BridgeError, &detail),
                duration_ms,
            };
            let bytes = serialized_len(&result);
            Ready { result, bytes }
        }
    }
}

/// The next batch from the front of `queue`: at most [`MAX_RESULTS`], within
/// [`MAX_RESULTS_BODY_BYTES`] serialized, and a command once.
fn take_batch(queue: &mut VecDeque<Ready>) -> Vec<ResultIn> {
    let mut batch: Vec<ResultIn> = Vec::new();
    let mut commands = HashSet::new();
    let mut bytes = RESULTS_ENVELOPE_BYTES;
    while let Some(next) = queue.front() {
        // A comma before every result but the first.
        let more = next.bytes.saturating_add(usize::from(!batch.is_empty()));
        let full = batch.len() == MAX_RESULTS
            || bytes.saturating_add(more) > MAX_RESULTS_BODY_BYTES
            || commands.contains(&next.result.command_id);
        if full && !batch.is_empty() {
            break;
        }
        bytes = bytes.saturating_add(more);
        let next = queue.pop_front().expect("a result at the front");
        commands.insert(next.result.command_id);
        batch.push(next.result);
    }
    batch
}

async fn post(
    client: JeetaClient,
    mut results: mpsc::UnboundedReceiver<ResultIn>,
    timing: Timing,
    mut stop: watch::Receiver<bool>,
) {
    let mut queue: VecDeque<Ready> = VecDeque::new();
    loop {
        if queue.is_empty() {
            let Some(result) = results.recv().await else {
                return;
            };
            queue.push_back(sendable(result));
        }
        // Whatever else is ready goes in the same batch.
        while let Ok(result) = results.try_recv() {
            queue.push_back(sendable(result));
        }
        let batch = take_batch(&mut queue);
        post_batch(&client, batch, &timing, &mut stop).await;
    }
}

/// `batch` in halves on `pending`, the first one on top; or, when it holds one result, that
/// result, to be dropped.
fn split(mut batch: Vec<ResultIn>, pending: &mut Vec<Vec<ResultIn>>) -> Option<ResultIn> {
    if batch.len() > 1 {
        let second = batch.split_off(batch.len() / 2);
        pending.push(second);
        pending.push(batch);
        None
    } else {
        batch.pop()
    }
}

/// Posts `batch` until the server takes it, splitting it when the server refuses it or keeps
/// failing it.
async fn post_batch(
    client: &JeetaClient,
    batch: Vec<ResultIn>,
    timing: &Timing,
    stop: &mut watch::Receiver<bool>,
) {
    let mut pending = vec![batch];
    while let Some(results) = pending.pop() {
        let body = ResultsIn { results };
        let mut backoff = Backoff::new(timing);
        let mut failures = 0u32;
        loop {
            match client.results(&body).await {
                Ok(out) => {
                    debug!(
                        applied = out.applied,
                        duplicates = out.duplicates,
                        unknown = out.unknown,
                        "results posted"
                    );
                    if out.unknown > 0 {
                        warn!(
                            unknown = out.unknown,
                            "the server knew no command for some of the results posted"
                        );
                    }
                    break;
                }
                Err(error) if error.is_refused() => {
                    // Never the same body again: its halves, until the refused result is alone.
                    let results = body.results.len();
                    if let Some(lone) = split(body.results, &mut pending) {
                        warn!(
                            command_id = %lone.command_id,
                            field = error.field().unwrap_or("unknown"),
                            "the server refused a result for good; it is dropped"
                        );
                    } else {
                        debug!(
                            results,
                            "the server refused a batch of results; it is split to find the one it refuses"
                        );
                    }
                    break;
                }
                Err(error) if error.is_transient() => {
                    failures += 1;
                    if failures >= timing.post_attempts.max(1) {
                        let results = body.results.len();
                        if let Some(lone) = split(body.results, &mut pending) {
                            warn!(
                                command_id = %lone.command_id,
                                failures,
                                "the server kept failing a result; it is dropped"
                            );
                        } else {
                            warn!(
                                results,
                                failures, "the server kept failing a batch of results; it is split"
                            );
                        }
                        break;
                    }
                    warn!(
                        %error,
                        results = body.results.len(),
                        "posting results failed; they are posted again after a pause"
                    );
                    // Stopping, the next try comes after the shortest pause.
                    if *stop.borrow() {
                        tokio::time::sleep(timing.backoff_min).await;
                    } else {
                        pause(stop, backoff.next()).await;
                    }
                }
                Err(error) => {
                    error!(
                        %error,
                        results = body.results.len(),
                        "the server refused the results; they are dropped"
                    );
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use jt_device_protocol::CommandResult;
    use serde_json::json;

    use super::*;
    use crate::test_logs::Logs;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0000 + n)
    }

    fn done(n: u128) -> ResultIn {
        ResultIn {
            command_id: id(n),
            outcome: Outcome::Done {
                result: CommandResult::Done {},
            },
            duration_ms: 1,
        }
    }

    fn leased(n: u128, serial: &str) -> LeasedCommand {
        serde_json::from_value(json!({
            "id": id(n), "capability_id": id(100), "serial": serial,
            "command": { "kind": "tap", "x": 1, "y": 1 }, "expires_at": "2026-10-28T12:30:45Z",
        }))
        .unwrap()
    }

    #[test]
    fn recent_ids_forget_the_oldest_past_the_cap() {
        let mut recent = RecentIds::new(3);
        for n in 0..3 {
            assert!(recent.insert(id(n)));
        }
        assert!(!recent.insert(id(1)));
        assert!(recent.insert(id(3)));
        // The oldest is forgotten, the others are not.
        assert!(recent.insert(id(0)));
        assert!(!recent.insert(id(2)));
        assert_eq!(recent.order.len(), 3);
        assert_eq!(recent.known.len(), 3);
    }

    #[test]
    fn a_batch_is_bounded_by_count_size_and_command() {
        // By count.
        let mut queue: VecDeque<Ready> = (0..250).map(|n| sendable(done(n))).collect();
        assert_eq!(take_batch(&mut queue).len(), MAX_RESULTS);
        assert_eq!(queue.len(), 150);
        // By size: a control character is six bytes of JSON, so these results are a little under
        // 800 KB each, and two fit in a body but three do not.
        let big = |n| ResultIn {
            command_id: id(n),
            outcome: Outcome::Done {
                result: CommandResult::shell(0, &[0x01; 65_536], &[0x01; 65_536]),
            },
            duration_ms: 1,
        };
        let mut queue: VecDeque<Ready> = (0..3).map(|n| sendable(big(n))).collect();
        assert!(queue[0].bytes > 700_000, "{}", queue[0].bytes);
        let first = take_batch(&mut queue);
        assert_eq!(first.len(), 2);
        let size = serde_json::to_vec(&ResultsIn { results: first })
            .unwrap()
            .len();
        assert!(size <= MAX_RESULTS_BODY_BYTES, "{size}");
        assert_eq!(queue.len(), 1);
        // A command once: its second result waits for the next batch.
        let mut queue: VecDeque<Ready> = [done(1), done(2), done(1)]
            .into_iter()
            .map(sendable)
            .collect();
        assert_eq!(take_batch(&mut queue).len(), 2);
        assert_eq!(take_batch(&mut queue).len(), 1);
    }

    #[test]
    fn a_result_the_server_must_refuse_is_sent_as_a_failure() {
        let mut seen = jt_device_protocol::Observation {
            screen: jt_device_protocol::Screen {
                w: 1080,
                h: 2400,
                rotation: 0,
            },
            foreground_app: Some("x".repeat(5000)),
            elements: Vec::new(),
            truncated: false,
            screenshot_file_id: None,
        };
        seen.cap_elements();
        let ready = sendable(ResultIn {
            command_id: id(1),
            outcome: Outcome::Done {
                result: CommandResult::Observation(seen),
            },
            duration_ms: 7,
        });
        assert_eq!(ready.result.command_id, id(1));
        assert_eq!(ready.result.duration_ms, 7);
        match &ready.result.outcome {
            Outcome::Failed { reason, detail } => {
                assert_eq!(*reason, FailReason::BridgeError);
                assert!(detail.contains("observation"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
        let alone = ResultsIn {
            results: vec![ready.result],
        };
        assert_eq!(alone.validate(), Ok(()));
    }

    #[test]
    fn backoff_doubles_to_its_cap_and_resets() {
        let timing = Timing {
            backoff_min: Duration::from_millis(10),
            backoff_max: Duration::from_millis(35),
            ..Timing::default()
        };
        let mut backoff = Backoff::new(&timing);
        let pauses: Vec<u128> = (0..4).map(|_| backoff.next().as_millis()).collect();
        assert_eq!(pauses, [10, 20, 35, 35]);
        backoff.reset();
        assert_eq!(backoff.next(), Duration::from_millis(10));
    }

    #[tokio::test]
    async fn the_first_task_to_end_is_named() {
        let mut ends = tokio::spawn(async {});
        let mut runs = tokio::spawn(std::future::pending::<()>());
        let mut also = tokio::spawn(std::future::pending::<()>());
        let ended = first_end(
            std::future::pending(),
            [("a", &mut runs), ("b", &mut ends), ("c", &mut also)],
        )
        .await;
        assert_eq!(ended, Some("b"));
        // The shutdown future wins when it completes first.
        let ended = first_end(
            std::future::ready(()),
            [
                ("a", &mut runs),
                ("c", &mut also),
                ("d", &mut also_pending()),
            ],
        )
        .await;
        assert_eq!(ended, None);
        runs.abort();
        also.abort();
    }

    fn also_pending() -> JoinHandle<()> {
        tokio::spawn(std::future::pending::<()>())
    }

    #[tokio::test]
    async fn a_command_for_a_stopped_worker_is_failed_and_the_worker_started_again() {
        let logs = Logs::capture();
        let config = Config::parse(
            "base_url = \"http://127.0.0.1:9\"\nkey = \"jk_unit\"\n",
            |_| None,
        )
        .unwrap();
        let (_table, phones) = watch::channel(PhoneTable::default());
        let (_stop, stop) = watch::channel(false);
        let (results_tx, mut results) = mpsc::unbounded_channel();
        let client = JeetaClient::new(&config).unwrap();
        let mut workers = Workers::new(phones, client, results_tx, Timing::default(), stop);
        // A worker that stopped: the other end of its queue is gone.
        let (stopped, gone) = mpsc::unbounded_channel();
        drop(gone);
        workers.queues.insert("S1".into(), stopped);

        workers.dispatch(leased(1, "S1"));
        let failed = results.recv().await.unwrap();
        assert_eq!(failed.command_id, id(1));
        assert!(
            matches!(
                failed.outcome,
                Outcome::Failed {
                    reason: FailReason::BridgeError,
                    ..
                }
            ),
            "{:?}",
            failed.outcome
        );
        let logged = logs.text();
        let line = logged
            .lines()
            .find(|l| l.contains("ERROR"))
            .unwrap_or_else(|| panic!("{logged}"));
        assert!(
            line.contains("S1") && line.contains(&id(1).to_string()),
            "{line}"
        );

        // Started again: the next command reaches a worker (no phone is registered, so it fails
        // as offline, from the worker).
        assert!(!workers.queues["S1"].is_closed());
        workers.dispatch(leased(2, "S1"));
        let next = results.recv().await.unwrap();
        assert_eq!(next.command_id, id(2));
        assert!(
            matches!(
                next.outcome,
                Outcome::Failed {
                    reason: FailReason::DeviceOffline,
                    ..
                }
            ),
            "{:?}",
            next.outcome
        );
    }
}
