//! The bridge's loop (spec §6): it registers, polls for commands, runs them on the phones and
//! posts what they did. Three tasks share it, plus one worker per phone:
//!
//! - **Register** on start, then every `heartbeat_s` the server answers, with the phones the
//!   registry lists: only the configured `serials`, if any; each serial once; at most
//!   [`MAX_PHONES`]; never a retired one. A phone the server refuses is logged with its serial and
//!   the reason (when the refusal is new). A retired one ([`PHONE_RETIRED`]) is not listed again
//!   until the bridge restarts. A failed register is tried again after a growing pause, at most a
//!   heartbeat.
//! - **Poll** while a phone is registered: at once after a poll that brought work, and at least
//!   [`Timing::idle_poll_floor`] after asking for one that brought none. A failed poll (no answer,
//!   an error status, or a body that is not a poll) is logged and followed by a growing pause: it
//!   is never read as an idle poll.
//! - **Run** the commands of different phones at the same time, and those of one phone one after
//!   the other in the order they came: one worker per phone. Each command runs in a task of its
//!   own, so a driver that panics fails that command as `bridge_error`, and the phone's worker
//!   goes on. A worker found stopped all the same is logged, started again, and the command that
//!   found it stopped is failed as `bridge_error`. A command id runs once: the last
//!   [`RECENT_IDS`] ids are remembered, so a command handed out again (spec §3: not acknowledged
//!   within 10 s) is skipped. A command this build cannot read is failed by its id as
//!   `unsupported_by_bridge`, the decoder's message as the failure's detail.
//! - **Post** the results in batches of what is ready ([`MAX_RESULTS`] at most, and
//!   [`MAX_RESULTS_BODY_BYTES`] serialized). A post that got no answer, a server error, or a 408
//!   or 429 is sent again after a growing pause (results are applied once per command, so that
//!   is safe). A refused batch (422) is refused for good and is never sent again as it is: it is
//!   split in halves until the result the server refuses stands alone, and that result is
//!   dropped. Before it is batched, a result is checked against the protocol's limits: one that
//!   breaks them is replaced by a `bridge_error` failure, so the server is not sent what it must
//!   refuse.
//!
//! # Logging
//!
//! Command ids, kinds and statuses, failure reasons, phone serials, counts, and request errors
//! without URLs. Never the key, a command's arguments, an observation, shell output, a file, a
//! failure's detail or a signed address.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jt_device_protocol::{
    CommandsOut, CommandsQuery, DeviceCommand, FailReason, HEARTBEAT_S, LeasedCommand,
    MAX_COMMANDS, MAX_PHONES, MAX_RESULTS, MAX_RESULTS_BODY_BYTES, MAX_WAIT_S, Outcome,
    PHONE_RETIRED, PROTOCOL_VERSION, PhoneReport, RegisterIn, ResultIn, ResultsIn,
};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::client::{ClientError, JeetaClient};
use crate::config::Config;
use crate::driver::{AttachedPhone, PhoneDriver, PhoneRegistry};

/// How many command ids the bridge remembers to run each once.
pub const RECENT_IDS: usize = 1000;
/// The longest heartbeat the bridge follows, in the server's seconds.
const MAX_HEARTBEAT_S: u32 = 300;
/// What a results body adds around its results: `{"results":[` and `]}`.
const RESULTS_ENVELOPE_BYTES: usize = 14;
/// The most characters of a refusal's reason the log keeps.
const MAX_LOGGED_REASON_CHARS: usize = 200;

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
    /// How long a driver may take over one command before it is failed as `timeout` (and its
    /// future dropped: a driver is cancel-safe).
    pub command_timeout: Duration,
    /// The same for `push_file` and `pull_file`, which move a whole file.
    pub transfer_timeout: Duration,
    /// How long listing the phones, and reading one, may take before a register goes without it.
    pub report_timeout: Duration,
    /// How long the results still to post may take at shutdown.
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
            command_timeout: Duration::from_secs(120),
            transfer_timeout: Duration::from_secs(30 * 60),
            report_timeout: Duration::from_secs(10),
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

/// Runs the bridge for `config` with the phones `registry` lists, until `shutdown` completes.
///
/// It only fails to start (the HTTP client cannot be built); after that every failure is logged
/// and tried again. At shutdown, the results already made get `timing.shutdown_grace` to be
/// posted; a command still running is cut off, and the server hands it out again later.
pub async fn run(
    config: &Config,
    registry: Arc<dyn PhoneRegistry>,
    timing: Timing,
    shutdown: impl Future<Output = ()>,
) -> Result<(), ClientError> {
    let client = JeetaClient::new(config)?;
    let (table_tx, table_rx) = watch::channel(PhoneTable::default());
    let (results_tx, results_rx) = mpsc::unbounded_channel();
    let listing = Listing {
        bridge_id: config.bridge_id.clone(),
        serials: config.serials.clone(),
    };
    let heartbeat = tokio::spawn(heartbeat(
        client.clone(),
        registry,
        listing,
        table_tx,
        timing.clone(),
    ));
    let poll = tokio::spawn(poll(client.clone(), table_rx, results_tx, timing.clone()));
    let post = tokio::spawn(post(client, results_rx, timing.clone()));

    shutdown.await;
    heartbeat.abort();
    poll.abort();
    // Once both are gone, so are the workers and every sender of results: the poster ends when
    // it has posted what is left.
    let _ = heartbeat.await;
    let _ = poll.await;
    let posting = post.abort_handle();
    if tokio::time::timeout(timing.shutdown_grace, post)
        .await
        .is_err()
    {
        warn!("results not yet posted at shutdown are dropped");
        posting.abort();
    }
    info!("the bridge stopped");
    Ok(())
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

/// A refusal's reason, fit for one log line.
fn loggable(reason: &str) -> String {
    reason
        .chars()
        .take(MAX_LOGGED_REASON_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Register

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
    let mut backoff = Backoff::new(&timing);
    let mut every = timing.server_second * HEARTBEAT_S;
    loop {
        let listed = listed_phones(registry.as_ref(), &listing, &retired, &timing).await;
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
                for refused in out.refused {
                    if refused.reason == PHONE_RETIRED {
                        if retired.insert(refused.serial.clone()) {
                            warn!(
                                serial = %refused.serial,
                                reason = PHONE_RETIRED,
                                "the server refused a retired phone; it is not listed again until the bridge restarts"
                            );
                        }
                    } else {
                        if refusals.get(&refused.serial) != Some(&refused.reason) {
                            warn!(
                                serial = %refused.serial,
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
/// wants and that are not retired, each serial once, at most [`MAX_PHONES`]. A phone that cannot
/// be read now is left out of this register.
async fn listed_phones(
    registry: &dyn PhoneRegistry,
    listing: &Listing,
    retired: &HashSet<String>,
    timing: &Timing,
) -> Vec<(AttachedPhone, PhoneReport)> {
    let attached = match tokio::time::timeout(timing.report_timeout, registry.attached()).await {
        Ok(Ok(attached)) => attached,
        Ok(Err(error)) => {
            warn!(
                reason = error.reason.key(),
                "listing the attached phones failed"
            );
            Vec::new()
        }
        Err(_) => {
            warn!(
                reason = FailReason::Timeout.key(),
                "listing the attached phones failed"
            );
            Vec::new()
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
    let mut reports: Vec<Option<PhoneReport>> = vec![None; wanted.len()];
    while let Some(read) = reads.join_next().await {
        let (index, read) = match read {
            Ok(read) => read,
            Err(failed) => {
                if let Some(index) = tasks.get(&failed.id()) {
                    error!(
                        serial = %wanted[*index].serial,
                        "a phone's driver failed while reporting; it is left out of this register"
                    );
                }
                continue;
            }
        };
        let serial = &wanted[index].serial;
        match read {
            Ok(Ok(mut report)) => {
                report.serial.clone_from(serial);
                reports[index] = Some(report);
            }
            Ok(Err(error)) => warn!(
                serial = %serial,
                reason = error.reason.key(),
                "a phone could not be read; it is left out of this register"
            ),
            Err(_) => warn!(
                serial = %serial,
                reason = FailReason::Timeout.key(),
                "a phone could not be read; it is left out of this register"
            ),
        }
    }
    wanted
        .into_iter()
        .zip(reports)
        .filter_map(|(phone, report)| report.map(|report| (phone, report)))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Poll and run

async fn poll(
    client: JeetaClient,
    mut table: watch::Receiver<PhoneTable>,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
) {
    let mut recent = RecentIds::new(RECENT_IDS);
    let mut workers = Workers::new(
        table.clone(),
        client.clone(),
        results.clone(),
        timing.clone(),
    );
    let mut backoff = Backoff::new(&timing);
    loop {
        // Commands are queued for registered phones only.
        let max_wait_s = match table.wait_for(|t| !t.phones.is_empty()).await {
            Ok(table) => table.max_wait_s,
            Err(_) => return,
        };
        let query = CommandsQuery {
            wait_s: timing.poll_wait_s.min(max_wait_s),
            limit: MAX_COMMANDS,
        };
        let asked = Instant::now();
        let read = match client.commands(&query).await {
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
            tokio::time::sleep(backoff.next()).await;
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
            if spent < timing.idle_poll_floor {
                tokio::time::sleep(timing.idle_poll_floor - spent).await;
            }
        }
    }
}

/// The phones' workers, one each, started on a phone's first command.
struct Workers {
    queues: HashMap<String, mpsc::UnboundedSender<LeasedCommand>>,
    /// Dropped with the poll task, which ends every worker.
    tasks: JoinSet<()>,
    table: watch::Receiver<PhoneTable>,
    client: JeetaClient,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
}

impl Workers {
    fn new(
        table: watch::Receiver<PhoneTable>,
        client: JeetaClient,
        results: mpsc::UnboundedSender<ResultIn>,
        timing: Timing,
    ) -> Workers {
        Workers {
            queues: HashMap::new(),
            tasks: JoinSet::new(),
            table,
            client,
            results,
            timing,
        }
    }

    /// Hands `leased` to its phone's worker, starting one for a phone that has none.
    ///
    /// A worker should not stop (a driver's panic is caught per command), but one found stopped
    /// is logged and started again, and `leased` is failed as `bridge_error` rather than run: the
    /// commands queued before it were lost with the worker, and running it without them could
    /// act on the wrong screen.
    fn dispatch(&mut self, leased: LeasedCommand) {
        let serial = leased.serial.clone();
        let Some(queue) = self.queues.get(&serial) else {
            let queue = self.start(&serial);
            let _ = queue.send(leased);
            self.queues.insert(serial, queue);
            return;
        };
        let Err(mpsc::error::SendError(leased)) = queue.send(leased) else {
            return;
        };
        error!(
            serial = %serial,
            command_id = %leased.id,
            "a phone's worker had stopped; the command is failed and the worker started again"
        );
        let _ = self.results.send(ResultIn {
            command_id: leased.id,
            outcome: Outcome::failed(
                FailReason::BridgeError,
                "the bridge's worker for this phone had stopped; it was started again",
            ),
            duration_ms: 0,
        });
        let queue = self.start(&serial);
        self.queues.insert(serial, queue);
    }

    fn start(&mut self, serial: &str) -> mpsc::UnboundedSender<LeasedCommand> {
        let (queue, commands) = mpsc::unbounded_channel();
        self.tasks.spawn(work(
            serial.to_owned(),
            commands,
            self.table.clone(),
            self.client.clone(),
            self.results.clone(),
            self.timing.clone(),
        ));
        queue
    }
}

/// A task aborted when this is dropped.
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One phone's worker: its commands, one after the other.
async fn work(
    serial: String,
    mut commands: mpsc::UnboundedReceiver<LeasedCommand>,
    table: watch::Receiver<PhoneTable>,
    client: JeetaClient,
    results: mpsc::UnboundedSender<ResultIn>,
    timing: Timing,
) {
    while let Some(leased) = commands.recv().await {
        let started = Instant::now();
        let outcome = carry_out(&serial, &leased, &table, &client, &timing).await;
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
    }
}

/// Runs one command on its phone's driver, within the command timeout.
async fn carry_out(
    serial: &str,
    leased: &LeasedCommand,
    table: &watch::Receiver<PhoneTable>,
    client: &JeetaClient,
    timing: &Timing,
) -> Outcome {
    // The server validated it before queuing; a driver relies on the bounds.
    if let Err(error) = leased.command.validate() {
        return Outcome::failed(
            FailReason::BridgeError,
            &format!("the command breaks a limit ({error})"),
        );
    }
    let driver = table.borrow().phones.get(serial).cloned();
    let Some(driver) = driver else {
        return Outcome::failed(
            FailReason::DeviceOffline,
            "the phone is not registered by this bridge now",
        );
    };
    let files = client.files(leased.download_url.clone());
    let command = leased.command.clone();
    // A task of its own, so that a driver's panic fails this command, not the phone's worker.
    // The guard aborts it when the wait ends early (the timeout, or shutdown dropping the
    // worker), which drops the driver's future: that is how a command is cancelled.
    let mut running = AbortOnDrop(tokio::spawn(async move {
        driver.execute(&command, &files).await
    }));
    let bound = match leased.command {
        DeviceCommand::PushFile { .. } | DeviceCommand::PullFile { .. } => timing.transfer_timeout,
        _ => timing.command_timeout,
    };
    match tokio::time::timeout(bound, &mut running.0).await {
        Ok(Ok(Ok(result))) => Outcome::Done { result },
        Ok(Ok(Err(error))) => Outcome::failed(error.reason, &error.detail),
        Ok(Err(_)) => {
            // The panic's message is the driver's and may quote the command: not logged.
            error!(
                serial = %serial,
                command_id = %leased.id,
                kind = leased.command.kind(),
                "the phone's driver failed while carrying out a command"
            );
            Outcome::failed(
                FailReason::BridgeError,
                "the phone's driver failed while carrying out the command",
            )
        }
        Err(_) => Outcome::failed(
            FailReason::Timeout,
            &format!(
                "the phone did not finish the command within {} s",
                bound.as_secs()
            ),
        ),
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

async fn post(client: JeetaClient, mut results: mpsc::UnboundedReceiver<ResultIn>, timing: Timing) {
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
        post_batch(&client, batch, &timing).await;
    }
}

/// Posts `batch` until the server takes it, splitting it when the server refuses it.
async fn post_batch(client: &JeetaClient, batch: Vec<ResultIn>, timing: &Timing) {
    let mut pending = vec![batch];
    while let Some(results) = pending.pop() {
        let body = ResultsIn { results };
        let mut backoff = Backoff::new(timing);
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
                    let mut first = body.results;
                    if first.len() > 1 {
                        // Never the same body again: its halves, the first one first.
                        let second = first.split_off(first.len() / 2);
                        debug!(
                            results = first.len() + second.len(),
                            "the server refused a batch of results; it is split to find the one it refuses"
                        );
                        pending.push(second);
                        pending.push(first);
                    } else {
                        for result in first {
                            warn!(
                                command_id = %result.command_id,
                                field = error.field().unwrap_or("unknown"),
                                "the server refused a result for good; it is dropped"
                            );
                        }
                    }
                    break;
                }
                Err(error) if error.is_transient() => {
                    warn!(
                        %error,
                        results = body.results.len(),
                        "posting results failed; they are posted again after a pause"
                    );
                    tokio::time::sleep(backoff.next()).await;
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
    use std::io::Write;
    use std::sync::Mutex;

    use jt_device_protocol::CommandResult;
    use serde_json::json;

    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0000 + n)
    }

    fn leased(n: u128, serial: &str) -> LeasedCommand {
        serde_json::from_value(json!({
            "id": id(n), "capability_id": id(100), "serial": serial,
            "command": { "kind": "tap", "x": 1, "y": 1 }, "expires_at": "2026-10-28T12:30:45Z",
        }))
        .unwrap()
    }

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_command_for_a_stopped_worker_is_failed_and_the_worker_started_again() {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let _logs = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish(),
        );
        let config = Config::parse(
            "base_url = \"http://127.0.0.1:9\"\nkey = \"jk_unit\"\n",
            |_| None,
        )
        .unwrap();
        let (_table, phones) = watch::channel(PhoneTable::default());
        let (results_tx, mut results) = mpsc::unbounded_channel();
        let client = JeetaClient::new(&config).unwrap();
        let mut workers = Workers::new(phones, client, results_tx, Timing::default());
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
        let logged = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
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

    fn done(n: u128) -> ResultIn {
        ResultIn {
            command_id: id(n),
            outcome: Outcome::Done {
                result: CommandResult::Done {},
            },
            duration_ms: 1,
        }
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
        let pauses: Vec<u64> = (0..4).map(|_| backoff.next().as_millis() as u64).collect();
        assert_eq!(pauses, [10, 20, 35, 35]);
        backoff.reset();
        assert_eq!(backoff.next(), Duration::from_millis(10));
    }
}
