//! `run`: the workspace's line (design addendum §2, §4). It registers every heartbeat, keeps one
//! command long-poll outstanding and hands each command to its call's task (a dial starts one),
//! forwards Asterisk's events to the calls, and posts what the calls report, in order and as soon
//! as it happens, each event once by its `(bridge_call_id, bridge_seq)`. When the core stays
//! unreachable for five seconds the live calls are told (they play the fault sentence and hang up).
//!
//! No call ends unheard (review of D, M1): what Asterisk still carries from an earlier run is hung
//! up and reported failed at the start; a command for a call this line does not carry is reported
//! (a hangup of it has nothing left to do); on stop each call is told the line stops (a live one
//! plays its closing), and the run waits for every call's task, then for the reports to be posted.
//! Nothing waits on a call (L6): each call's task is capped ([`crate::call::run_call_capped`]), a
//! command or the core's loss is handed to it without waiting (a call that takes no more commands
//! is reported failed), and a call the core asked to hang up leaves the line free for the next dial
//! while it closes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use jt_calls::wire::{
    BridgeCommand, CommandsQuery, EventIn, EventsInput, RegisterInput, SpeechToText, TextToSpeech,
};
use jt_calls::{BridgeEvent, CallCommandId, CallPlan, Command, DialScript};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::ari::{self, Ari, AriEvent};
use crate::call::{
    CLOSE_GRACE, CallDeps, CallSetup, LineWaits, Report, ToCall, run_call_capped, task_cap,
};
use crate::config::Config;
use crate::jeeta::JeetaClient;
use crate::netgsm;
use crate::trace::TraceFile;

/// A call on the line: its task's inbox, and whether the core asked it to hang up (it then closes
/// on its own, and the line takes the next dial meanwhile).
struct CallEntry {
    tx: mpsc::Sender<ToCall>,
    closing: bool,
}

/// The calls on the line, by the bridge's id of the call (also its Asterisk channel id).
type Registry = Arc<Mutex<HashMap<String, CallEntry>>>;

/// How long the core may refuse every report before the live calls are told it is lost.
const CORE_LOST_AFTER: Duration = Duration::from_secs(5);
/// The command long-poll's wait: the core's longest.
const POLL_WAIT_S: u32 = 25;
/// How many command ids are remembered, so that a command handed out again (its
/// acknowledgement lost) runs once.
const SEEN_COMMANDS: usize = 1_000;
/// How long a stop waits for the calls: a closing played within [`CLOSE_GRACE`], the hangup's
/// confirmation, and a margin for ARI's retries.
const STOP_WAIT: Duration = Duration::from_secs(CLOSE_GRACE.as_secs() + 15);
/// How long a stop then waits for the last reports to be posted.
const POST_WAIT: Duration = Duration::from_secs(5);

/// What the bridge reports of itself.
pub fn register_input(config: &Config) -> RegisterInput {
    RegisterInput {
        extension: config.extension.clone(),
        codecs: vec!["PCMA".into(), "PCMU".into()],
        max_calls: 1,
        stt: SpeechToText {
            engine: "seda".into(),
            model: "seda-v0.1".into(),
        },
        tts: TextToSpeech {
            engine: "ema".into(),
            voice: "ema-lightning-1.1.2".into(),
        },
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

/// The command ids already taken, the oldest forgotten first.
#[derive(Default)]
struct Seen {
    order: VecDeque<CallCommandId>,
    set: HashSet<CallCommandId>,
}

impl Seen {
    /// `true` the first time `id` is seen.
    fn insert(&mut self, id: CallCommandId) -> bool {
        if !self.set.insert(id) {
            return false;
        }
        self.order.push_back(id);
        if self.order.len() > SEEN_COMMANDS
            && let Some(old) = self.order.pop_front()
        {
            self.set.remove(&old);
        }
        true
    }
}

/// Runs the line until `stop` turns true.
pub async fn run(config: Config, mut stop: watch::Receiver<bool>) {
    let jeeta = match JeetaClient::new(&config.jeeta_base_url, &config.bridge_key) {
        Ok(j) => Arc::new(j),
        Err(e) => {
            warn!(error = %e, "the core's client could not be built");
            return;
        }
    };
    let ari = match Ari::new(&config.ari_url, &config.ari_user, &config.ari_password) {
        Ok(a) => Arc::new(a),
        Err(e) => {
            warn!(error = %e, "the ARI client could not be built");
            return;
        }
    };
    let calls: Registry = Arc::default();
    // Unbounded (B5 re-review, B6 as built): a call hands its reports on without waiting, so a
    // slow core never holds a call's loop up, and none is dropped (a lost utterance would lose its
    // turn's reply, and `bridge_seq` would leave the core no gap to see). One call's events bound
    // it.
    let (reports_tx, reports_rx) = mpsc::unbounded_channel::<Report>();
    let poster = tokio::spawn(post_reports(jeeta.clone(), reports_rx, calls.clone()));
    sweep(&ari, &reports_tx).await;
    let deps = Arc::new(CallDeps {
        ari: ari.clone(),
        listen: config.listen.clone(),
        speak: config.speak.clone(),
        cache_dir: config.cache_dir.clone(),
        timing: config.timing,
        traces: Some(TraceFile::new(config.trace_file.clone())),
        waits: LineWaits::default(),
    });
    let beat = tokio::spawn(heartbeat(jeeta.clone(), register_input(&config)));
    let events = tokio::spawn(forward_ari(ari.clone(), calls.clone()));
    let mut seen = Seen::default();
    let mut tasks = JoinSet::new();
    info!("the line is up");
    loop {
        // The calls' tasks that ended are reaped as the line goes.
        while tasks.try_join_next().is_some() {}
        let query = CommandsQuery {
            wait_s: Some(POLL_WAIT_S),
            extension: Some(config.extension.clone()),
        };
        tokio::select! {
            _ = stop.changed() => break,
            out = jeeta.commands(&query) => match out {
                Ok(out) => {
                    for c in out.commands {
                        dispatch(c, &deps, &calls, &reports_tx, &mut seen, &mut tasks);
                    }
                }
                Err(e) => {
                    warn!(error = %e, "the command poll failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
    info!("stopping");
    // Every call is told, then waited for, while Asterisk's events still reach it and its reports
    // are still posted; a hangup in flight is never cut.
    let live: Vec<mpsc::Sender<ToCall>> = calls
        .lock()
        .map(|m| m.values().map(|e| e.tx.clone()).collect())
        .unwrap_or_default();
    for tx in live {
        let _ = tx.try_send(ToCall::Stop);
    }
    let joined = tokio::time::timeout(STOP_WAIT, async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    if joined.is_err() {
        let count = tasks.len();
        warn!(count, "calls still running when the stop's wait ended");
    }
    beat.abort();
    events.abort();
    drop(reports_tx);
    let _ = tokio::time::timeout(POST_WAIT, poster).await;
}

/// Hangs up what Asterisk still carries from an earlier run (a crash, a restart): each call's own
/// channel is reported failed, once (its `-m` media channel is the same call's).
async fn sweep(ari: &Ari, reports: &mpsc::UnboundedSender<Report>) {
    let Ok(left) = ari.channel_ids().await else {
        return;
    };
    let count = left.len();
    for channel in left {
        let _ = ari.hangup(&channel).await;
        if !channel.ends_with("-m") {
            let failure_line = "transient: bridge: the line restarted during the call".to_owned();
            let _ = reports.send(Report::now(&channel, BridgeEvent::Error { failure_line }));
        }
    }
    if count > 0 {
        warn!(count, "hung up the channels left from before");
    }
}

/// Registers the line every heartbeat the core asks for, and every 2 s while it refuses.
async fn heartbeat(jeeta: Arc<JeetaClient>, body: RegisterInput) {
    let mut registered = false;
    loop {
        let pause = match jeeta.register(&body).await {
            Ok(out) => {
                if !registered {
                    info!(status = ?out.status, "registered with the core");
                }
                registered = true;
                Duration::from_secs(u64::from(out.heartbeat_s.max(1)))
            }
            Err(e) => {
                warn!(error = %e, "registration failed");
                registered = false;
                Duration::from_secs(2)
            }
        };
        tokio::time::sleep(pause).await;
    }
}

/// Hands command `c` to its call (a dial starts one), once, and acknowledges it however it went.
/// A command of a call this line does not carry is reported, so a session the core still thinks
/// live ends (a hangup of one has nothing left to do), and acknowledged all the same: an
/// unacknowledged command would be handed out again every ten seconds for a week. Never waits on
/// a call (L6): one whose inbox is full takes no more commands, and is reported failed.
fn dispatch(
    c: BridgeCommand,
    deps: &Arc<CallDeps>,
    calls: &Registry,
    reports: &mpsc::UnboundedSender<Report>,
    seen: &mut Seen,
    tasks: &mut JoinSet<()>,
) {
    let call = c
        .bridge_call_id
        .clone()
        .unwrap_or_else(|| c.call_id.to_string());
    if seen.insert(c.id) {
        match c.command() {
            Ok(Command::Dial {
                to_e164,
                plan,
                script,
            }) => start_call(&call, &to_e164, plan, script, deps, calls, reports, tasks),
            Ok(command) => {
                let hangup = matches!(command, Command::Hangup);
                // A hangup frees the line for the next dial while the call closes.
                let tx = calls.lock().ok().and_then(|mut m| {
                    let entry = m.get_mut(&call)?;
                    entry.closing |= hangup;
                    Some(entry.tx.clone())
                });
                let failure = match tx.map(|tx| tx.try_send(ToCall::Command(command))) {
                    Some(Ok(())) => None,
                    Some(Err(TrySendError::Full(_))) => {
                        warn!(call, "a call takes no more commands");
                        Some("transient: bridge: the call stopped taking commands")
                    }
                    Some(Err(TrySendError::Closed(_))) | None if hangup => None,
                    Some(Err(TrySendError::Closed(_))) | None => {
                        warn!(call, "a command for a call this line does not carry");
                        Some("transient: bridge: the call is not on this line")
                    }
                };
                if let Some(line) = failure {
                    let failure_line = line.to_owned();
                    let _ = reports.send(Report::now(&call, BridgeEvent::Error { failure_line }));
                }
            }
            Err(_) => warn!(command = %c.id, kind = %c.kind, "a command this build cannot read"),
        }
    }
    let _ = reports.send(Report::now(&call, BridgeEvent::CommandDone { id: c.id }));
}

/// Starts the task of a dialled call (in `tasks`, which a stop waits for), or reports why the
/// line refuses it.
#[expect(
    clippy::too_many_arguments,
    reason = "the line's state, handed down from run"
)]
fn start_call(
    call: &str,
    to_e164: &str,
    plan: CallPlan,
    script: DialScript,
    deps: &Arc<CallDeps>,
    calls: &Registry,
    reports: &mpsc::UnboundedSender<Report>,
    tasks: &mut JoinSet<()>,
) {
    let refuse = |failure_line: &str| {
        Report::now(
            call,
            BridgeEvent::Error {
                failure_line: failure_line.to_owned(),
            },
        )
    };
    let Some(dial) = netgsm::dial_string(to_e164) else {
        // Geographic, mobile, 0800 and 0850 numbers only (B4 review I6).
        warn!(call, "a number the line may not call was refused");
        let _ = reports.send(refuse(
            "permanent: bridge: this line calls Turkish geographic, mobile, 0800 and 0850 numbers only",
        ));
        return;
    };
    // One call at a time; a call closing on the core's hangup leaves the line free.
    if calls
        .lock()
        .map(|m| m.values().any(|e| !e.closing))
        .unwrap_or(true)
    {
        let _ = reports.send(refuse("transient: bridge: the line is busy"));
        return;
    }
    let (tx, rx) = mpsc::channel(64);
    if let Ok(mut m) = calls.lock() {
        m.insert(call.to_owned(), CallEntry { tx, closing: false });
    }
    let setup = CallSetup {
        bridge_call_id: call.to_owned(),
        dial,
        // The core closes a call at its plan's longest duration; the bridge closes it a minute
        // after that only if the core did not (lost, or the session stuck; B6 review).
        max_duration: Duration::from_secs(
            u64::from(plan.max_duration_s) + u64::from(jt_calls::CLOSING_GRACE_S),
        ),
        // A plan from before C1 may bring no closing: the approved default then.
        closing: Some(plan.closing.clone())
            .filter(|c| !c.trim().is_empty())
            .unwrap_or_else(|| jt_calls::CLOSING.to_owned()),
        script,
        plan_lines: plan.playable().map(str::to_owned).collect(),
    };
    let (deps, calls, reports, call) = (
        deps.clone(),
        calls.clone(),
        reports.clone(),
        call.to_owned(),
    );
    let cap = task_cap(deps.waits, setup.max_duration);
    tasks.spawn(async move {
        run_call_capped(deps, setup, rx, reports, cap).await;
        if let Ok(mut m) = calls.lock() {
            m.remove(&call);
        }
    });
}

/// The first `bridge_seq` of a call: 1 for a call dialled by this process; for any other (a
/// command of a call from before a restart) a number no earlier process used.
fn first_seq(dialled_here: bool) -> u32 {
    if dialled_here {
        return 1;
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    1_000_000 + u32::try_from(secs % 1_000_000).unwrap_or(0) * 1_000
}

/// Since when every report to the core has failed, counted from the start of the first attempt
/// that failed (against a wedged core each attempt costs its whole timeout, review of D, M3), and
/// whether the live calls were told it is lost.
#[derive(Debug, Default)]
struct Outage {
    since: Option<Instant>,
    told: bool,
}

impl Outage {
    /// The attempt begun at `tried` failed at `now`: whether the live calls are to be told now
    /// (once an outage lasted [`CORE_LOST_AFTER`], once per outage).
    fn failed(&mut self, tried: Instant, now: Instant) -> bool {
        let since = *self.since.get_or_insert(tried);
        if self.told || now.duration_since(since) < CORE_LOST_AFTER {
            return false;
        }
        self.told = true;
        true
    }

    /// A report went through: the outage is over.
    fn over(&mut self) {
        *self = Outage::default();
    }
}

/// Posts the calls' reports one by one, in order, each numbered within its call and stamped when it
/// happened; retries while the
/// core is away, and tells the live calls once it stayed away [`CORE_LOST_AFTER`].
async fn post_reports(
    jeeta: Arc<JeetaClient>,
    mut rx: mpsc::UnboundedReceiver<Report>,
    calls: Registry,
) {
    let mut seqs: HashMap<String, u32> = HashMap::new();
    let mut outage = Outage::default();
    while let Some(report) = rx.recv().await {
        let dialled = calls
            .lock()
            .map(|m| m.contains_key(&report.bridge_call_id))
            .unwrap_or(false);
        let seq = seqs
            .entry(report.bridge_call_id.clone())
            .or_insert_with(|| first_seq(dialled).saturating_sub(1));
        *seq += 1;
        let body = EventsInput {
            events: vec![EventIn {
                bridge_call_id: report.bridge_call_id.clone(),
                bridge_seq: *seq,
                at: report.at,
                event: report.event,
            }],
        };
        let taken = report.taken;
        loop {
            let tried = Instant::now();
            match jeeta.events(&body).await {
                Ok(_) => {
                    // A core that comes back and goes again sends `CoreLost` again; the talker
                    // takes the first only (B4 review I2), so the fault sentence never restarts.
                    outage.over();
                    if let Some(t) = taken {
                        let _ = t.send(());
                    }
                    break;
                }
                Err(e) if !e.retryable() => {
                    warn!(error = %e, "the core refused an event; it is dropped");
                    break;
                }
                Err(e) => {
                    if outage.failed(tried, Instant::now()) {
                        warn!(error = %e, "the core is unreachable");
                        let live: Vec<mpsc::Sender<ToCall>> = calls
                            .lock()
                            .map(|m| m.values().map(|e| e.tx.clone()).collect())
                            .unwrap_or_default();
                        for tx in live {
                            // Never waits (L6): a call too busy to take it is capped all the same.
                            let _ = tx.try_send(ToCall::CoreLost);
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }
}

/// Forwards Asterisk's events to the calls they concern, reconnecting every 2 s; an inbound call
/// is refused (duty mode is V2).
async fn forward_ari(ari: Arc<Ari>, calls: Registry) {
    loop {
        match ari.events().await {
            Ok(mut events) => {
                info!("connected to Asterisk's events");
                while let Some(Ok(message)) = events.next().await {
                    let Message::Text(t) = message else { continue };
                    let event = ari::parse_event(&t);
                    let channel = match &event {
                        AriEvent::Ringing { channel }
                        | AriEvent::Answered { channel, .. }
                        | AriEvent::Dtmf { channel, .. }
                        | AriEvent::Gone { channel, .. } => channel.clone(),
                        AriEvent::Other => continue,
                    };
                    if let AriEvent::Answered { inbound: true, .. } = event {
                        info!("an inbound call reached the bridge; refused until duty mode exists");
                        let _ = ari.refuse(&channel).await;
                        continue;
                    }
                    let tx = calls
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&channel).map(|e| e.tx.clone()));
                    if let Some(tx) = tx {
                        let _ = tx.send(ToCall::Ari(event)).await;
                    }
                }
                warn!("Asterisk's events closed");
            }
            Err(e) => warn!(error = %e, "Asterisk's events are unreachable"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wedged_core_is_lost_five_seconds_after_the_first_attempt_began() {
        // Each attempt against a wedged core costs its whole timeout (about 3 s): counted from the
        // first failure, the calls would hear of it a timeout late (M3).
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut outage = Outage::default();
        assert!(!outage.failed(t0, t0 + s(3)));
        assert!(outage.failed(
            t0 + Duration::from_millis(3_200),
            t0 + Duration::from_millis(6_200)
        ));
        // Once per outage.
        assert!(!outage.failed(t0 + s(7), t0 + s(10)));
        outage.over();
        assert!(!outage.failed(t0 + s(20), t0 + s(23)));
        assert!(outage.failed(t0 + s(23), t0 + s(26)));
    }
}
