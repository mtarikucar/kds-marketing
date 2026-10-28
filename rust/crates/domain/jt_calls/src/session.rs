//! A call session, its turn log entries and its state machine (spec §5, §10): [`reduce`] applies
//! what the voice bridge (or the PBX's call events) reported, [`say`] what the agent asked to be
//! said, [`transfer`] a hand-over to a rep, and [`end`] the scripted ending ([`close`] when the
//! line cannot be waited for). Each returns the [`Step`]: the commands for the bridge and the
//! turns to append. No text is composed here: a command carries the plan's, the policy's or the
//! agent's own sentence.

use jt_capability::CapabilityId;
use jt_inbox::{JourneyId, PersonId};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::plan::{CallPlan, MAX_LINE_CHARS};
use crate::policy::CallPolicy;
use crate::{CallCommandId, CallId};

/// The longest failure line a session keeps (the `kind: provider: reason` line).
const MAX_FAILURE_CHARS: usize = 300;

/// Who called whom.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallDirection {
    Inbound,
    Outbound,
}

/// Why a call is placed (spec §8.4): a commercial call needs İYS consent on the phone channel; a
/// service call an existing relationship; a callback a recent inbound call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallPurpose {
    Service,
    Commercial,
    Callback,
}

/// Who talks to the counterpart: the connected agent through the voice bridge, or a human rep
/// whose PBX extension rings first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CallMode {
    Agent,
    Human { rep_extension: String },
}

impl CallMode {
    pub fn key(&self) -> &'static str {
        match self {
            CallMode::Agent => "agent",
            CallMode::Human { .. } => "human",
        }
    }
}

/// Where a session stands. `Planned` waits for a human approval; `Ending` has its closing queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallState {
    Planned,
    Dialing,
    Ringing,
    Live,
    Holding,
    Ending,
    Ended,
}

impl CallState {
    pub const ALL: [CallState; 7] = [
        CallState::Planned,
        CallState::Dialing,
        CallState::Ringing,
        CallState::Live,
        CallState::Holding,
        CallState::Ending,
        CallState::Ended,
    ];

    /// The stored and wire name, e.g. `"live"`.
    pub fn key(self) -> &'static str {
        match self {
            CallState::Planned => "planned",
            CallState::Dialing => "dialing",
            CallState::Ringing => "ringing",
            CallState::Live => "live",
            CallState::Holding => "holding",
            CallState::Ending => "ending",
            CallState::Ended => "ended",
        }
    }

    /// The state named `key`.
    pub fn from_key(key: &str) -> Option<CallState> {
        CallState::ALL.into_iter().find(|s| s.key() == key)
    }

    /// A line is (or is being) used: dialing through ending.
    pub fn is_live(self) -> bool {
        !matches!(self, CallState::Planned | CallState::Ended)
    }
}

/// Why a call was not placed (spec §8), each a stable key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    WorkspaceInactive,
    StrategyRequired,
    BridgeOffline,
    BridgeBusy,
    PersonErased,
    PersonMerged,
    NoPhoneIdentity,
    Suppressed,
    JourneyLost,
    ConsentMissing,
    NoRelationship,
    NoRecentInbound,
    OutsideWorkHours,
    DailyOpsCap,
    BudgetExhausted,
    DisclosureMissing,
}

impl RefusalReason {
    pub const ALL: [RefusalReason; 16] = [
        RefusalReason::WorkspaceInactive,
        RefusalReason::StrategyRequired,
        RefusalReason::BridgeOffline,
        RefusalReason::BridgeBusy,
        RefusalReason::PersonErased,
        RefusalReason::PersonMerged,
        RefusalReason::NoPhoneIdentity,
        RefusalReason::Suppressed,
        RefusalReason::JourneyLost,
        RefusalReason::ConsentMissing,
        RefusalReason::NoRelationship,
        RefusalReason::NoRecentInbound,
        RefusalReason::OutsideWorkHours,
        RefusalReason::DailyOpsCap,
        RefusalReason::BudgetExhausted,
        RefusalReason::DisclosureMissing,
    ];

    /// The stable key, e.g. `"consent_missing"` (what `details.reason` carries).
    pub fn key(self) -> &'static str {
        match self {
            RefusalReason::WorkspaceInactive => "workspace_inactive",
            RefusalReason::StrategyRequired => "strategy_required",
            RefusalReason::BridgeOffline => "bridge_offline",
            RefusalReason::BridgeBusy => "bridge_busy",
            RefusalReason::PersonErased => "person_erased",
            RefusalReason::PersonMerged => "person_merged",
            RefusalReason::NoPhoneIdentity => "no_phone_identity",
            RefusalReason::Suppressed => "suppressed",
            RefusalReason::JourneyLost => "journey_lost",
            RefusalReason::ConsentMissing => "consent_missing",
            RefusalReason::NoRelationship => "no_relationship",
            RefusalReason::NoRecentInbound => "no_recent_inbound",
            RefusalReason::OutsideWorkHours => "outside_work_hours",
            RefusalReason::DailyOpsCap => "daily_ops_cap",
            RefusalReason::BudgetExhausted => "budget_exhausted",
            RefusalReason::DisclosureMissing => "disclosure_missing",
        }
    }

    pub fn from_key(key: &str) -> Option<RefusalReason> {
        RefusalReason::ALL.into_iter().find(|r| r.key() == key)
    }
}

/// Why a session ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cause", content = "detail", rename_all = "snake_case")]
pub enum EndCause {
    CallerHangup,
    AgentEnded,
    /// The agent stayed silent through every fallback line: closed by script.
    AgentTimeout,
    MaxDuration,
    NoAnswer,
    Busy,
    /// The failure line (`kind: provider: reason`).
    Failed(String),
    Transferred,
    BridgeOffline,
    Refused(RefusalReason),
    /// The caller stayed silent after the agent spoke: closed by script.
    CallerSilent,
}

impl EndCause {
    /// The stored name, e.g. `"agent_timeout"`.
    pub fn key(&self) -> &'static str {
        match self {
            EndCause::CallerHangup => "caller_hangup",
            EndCause::AgentEnded => "agent_ended",
            EndCause::AgentTimeout => "agent_timeout",
            EndCause::MaxDuration => "max_duration",
            EndCause::NoAnswer => "no_answer",
            EndCause::Busy => "busy",
            EndCause::Failed(_) => "failed",
            EndCause::Transferred => "transferred",
            EndCause::BridgeOffline => "bridge_offline",
            EndCause::Refused(_) => "refused",
            EndCause::CallerSilent => "caller_silent",
        }
    }

    /// The failure line or the refusal's key, for the two causes that carry one.
    pub fn detail(&self) -> Option<String> {
        match self {
            EndCause::Failed(line) => Some(line.clone()),
            EndCause::Refused(reason) => Some(reason.key().to_owned()),
            _ => None,
        }
    }

    /// The cause stored as `key` and `detail`.
    pub fn from_parts(key: &str, detail: Option<&str>) -> Option<EndCause> {
        Some(match key {
            "caller_hangup" => EndCause::CallerHangup,
            "agent_ended" => EndCause::AgentEnded,
            "agent_timeout" => EndCause::AgentTimeout,
            "max_duration" => EndCause::MaxDuration,
            "no_answer" => EndCause::NoAnswer,
            "busy" => EndCause::Busy,
            "failed" => EndCause::Failed(detail.unwrap_or_default().to_owned()),
            "transferred" => EndCause::Transferred,
            "bridge_offline" => EndCause::BridgeOffline,
            "refused" => EndCause::Refused(RefusalReason::from_key(detail?)?),
            "caller_silent" => EndCause::CallerSilent,
            _ => return None,
        })
    }

    /// Every cause a session can end with, one of each (the refusal and failure with a sample).
    pub fn samples() -> Vec<EndCause> {
        vec![
            EndCause::CallerHangup,
            EndCause::AgentEnded,
            EndCause::AgentTimeout,
            EndCause::MaxDuration,
            EndCause::NoAnswer,
            EndCause::Busy,
            EndCause::Failed("permanent: netgsm: refused".into()),
            EndCause::Transferred,
            EndCause::BridgeOffline,
            EndCause::Refused(RefusalReason::ConsentMissing),
            EndCause::CallerSilent,
        ]
    }
}

/// How the caller (agent or rep) says a finished call went (`calls.end`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallOutcome {
    Connected,
    NoAnswer,
    Voicemail,
    RefusedByCustomer,
    Appointment,
    CallbackRequested,
    Other,
}

impl CallOutcome {
    pub fn key(self) -> &'static str {
        match self {
            CallOutcome::Connected => "connected",
            CallOutcome::NoAnswer => "no_answer",
            CallOutcome::Voicemail => "voicemail",
            CallOutcome::RefusedByCustomer => "refused_by_customer",
            CallOutcome::Appointment => "appointment",
            CallOutcome::CallbackRequested => "callback_requested",
            CallOutcome::Other => "other",
        }
    }

    pub fn from_key(key: &str) -> Option<CallOutcome> {
        [
            CallOutcome::Connected,
            CallOutcome::NoAnswer,
            CallOutcome::Voicemail,
            CallOutcome::RefusedByCustomer,
            CallOutcome::Appointment,
            CallOutcome::CallbackRequested,
            CallOutcome::Other,
        ]
        .into_iter()
        .find(|o| o.key() == key)
    }

    /// Whether the person was reached, when the outcome says (`Other` does not).
    pub fn reached(self) -> Option<bool> {
        match self {
            CallOutcome::NoAnswer | CallOutcome::Voicemail => Some(false),
            CallOutcome::Connected
            | CallOutcome::RefusedByCustomer
            | CallOutcome::Appointment
            | CallOutcome::CallbackRequested => Some(true),
            CallOutcome::Other => None,
        }
    }
}

/// Whether, and where, the call is recorded. `Pending`: the announcement is to be played first,
/// and recording starts only once it was heard to its end; `Recording`: it started (the file once
/// known; for a rep's call the PBX records, and its call record names the file).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RecordingState {
    #[default]
    Off,
    Pending,
    Recording {
        #[serde(default)]
        file_ref: Option<String>,
    },
}

impl RecordingState {
    pub fn key(&self) -> &'static str {
        match self {
            RecordingState::Off => "off",
            RecordingState::Pending => "pending",
            RecordingState::Recording { .. } => "recording",
        }
    }
}

/// Per-call measurements (spec §12): turn count, the agent's reply latencies (caller's final
/// utterance to the agent's `say`), the bridge's STT and TTS times, and how often the script
/// covered for the agent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CallMetrics {
    pub turns: u32,
    pub agent_latency_ms: Vec<u32>,
    pub stt_ms: Vec<u32>,
    pub tts_ms: Vec<u32>,
    pub holding_played: u8,
    pub fallback_played: u8,
}

/// What the timers read (see [`crate::next_timer`]): since when the agent owes a reply (the
/// caller's last final utterance, the last fallback line, or the end of an agent's sentence that
/// expected no reply), how many holding phrases this wait already played, since when the caller
/// is waited for (the agent's last sentence finished), and whether the caller's silence was
/// already reported. Also the next turn number, the turn of the recording announcement, the turn
/// of the agent's sentence after which the agent speaks again, and since when the closing plays.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TurnClock {
    #[serde(with = "time::serde::rfc3339::option")]
    pub owed_since: Option<OffsetDateTime>,
    pub holding_in_turn: u8,
    #[serde(with = "time::serde::rfc3339::option")]
    pub awaiting_caller_since: Option<OffsetDateTime>,
    pub silence_noted: bool,
    pub next_seq: u32,
    pub announcement_seq: Option<u32>,
    /// The agent's sentence (`say` with `expect_reply: false`) once played, the agent owes the
    /// next one.
    pub agent_continues_after: Option<u32>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub closing_since: Option<OffsetDateTime>,
}

/// One call, inbound or outbound, agent-driven or a rep's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallSession {
    pub id: CallId,
    pub workspace_id: WorkspaceId,
    /// The `netgsm_pbx` (rep calls) or `voice_bridge` (agent calls) capability the call uses.
    pub capability_id: CapabilityId,
    pub direction: CallDirection,
    pub purpose: CallPurpose,
    pub person_id: Option<PersonId>,
    pub journey_id: Option<JourneyId>,
    pub mode: CallMode,
    pub state: CallState,
    /// The agent's script; a rep's call has none.
    pub plan: Option<CallPlan>,
    /// The counterpart's number; masked in every output ([`crate::mask_e164`]).
    pub counterpart_e164: String,
    pub bridge_call_id: Option<String>,
    pub pbx_unique_id: Option<String>,
    /// The PBX's correlation id of a rep's call (NetGSM's `crm_id`).
    pub crm_id: Option<String>,
    pub agent_connection_id: Option<AgentConnectionId>,
    pub placed_by: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub answered_at: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub ended_at: Option<OffsetDateTime>,
    pub end_cause: Option<EndCause>,
    pub outcome: Option<CallOutcome>,
    pub summary: Option<String>,
    pub duration_s: Option<u32>,
    pub cost_minor: Option<i64>,
    pub recording: RecordingState,
    pub metrics: CallMetrics,
    pub clock: TurnClock,
}

/// Who said a sentence that was played: the agent, or the script (plan or policy).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    Agent,
    Script,
}

/// What a turn of the log is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnKind {
    /// The counterpart's final utterance (the bridge's transcript).
    Utterance,
    /// A sentence played to the counterpart.
    Say {
        by: Speaker,
    },
    Holding,
    Fallback,
    Dtmf,
    /// Something that happened on the line: `answered`, `hangup`, `silence`, `caller_silence`.
    Event {
        name: String,
    },
}

impl TurnKind {
    pub fn key(&self) -> &'static str {
        match self {
            TurnKind::Utterance => "utterance",
            TurnKind::Say { .. } => "say",
            TurnKind::Holding => "holding",
            TurnKind::Fallback => "fallback",
            TurnKind::Dtmf => "dtmf",
            TurnKind::Event { .. } => "event",
        }
    }
}

/// What a turn measured.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TurnMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// The agent's reply time: the caller's final utterance (or the last fallback) to `say`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_at_char: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_ms: Option<u32>,
}

/// One entry of a call's turn log; `seq` orders it within the call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub seq: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub kind: TurnKind,
    pub text: String,
    #[serde(default)]
    pub meta: TurnMeta,
}

/// What the voice bridge (or, for a rep's call, the PBX's call events) reports about a call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeEvent {
    Inbound {
        from_e164: String,
        to_e164: String,
    },
    Ringing,
    Answered,
    Utterance {
        text: String,
        is_final: bool,
        #[serde(default)]
        confidence: Option<f32>,
        #[serde(default)]
        stt_ms: Option<u32>,
    },
    Dtmf {
        digit: String,
    },
    /// A queued sentence finished playing, or was cut by the caller at a character.
    Said {
        seq: u32,
        #[serde(default)]
        interrupted_at_char: Option<u32>,
        #[serde(default)]
        tts_ms: Option<u32>,
    },
    Silence {
        ms: u32,
    },
    Recording {
        file_ref: String,
    },
    /// The line closed; `cause` is the bridge's or PBX's word for why (`busy`, `no_answer`, ...).
    Hangup {
        cause: String,
    },
    Error {
        failure_line: String,
    },
    CommandDone {
        id: CallCommandId,
    },
}

/// A sentence of the plan or the policy played without the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayKind {
    Opening,
    Holding,
    Fallback,
    Closing,
    Announcement,
}

/// What the voice bridge is asked to do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Answer {
        greeting_text: String,
        then_record: bool,
    },
    Dial {
        to_e164: String,
        plan: CallPlan,
    },
    Say {
        seq: u32,
        text: String,
        allow_barge_in: bool,
    },
    Play {
        seq: u32,
        clip: PlayKind,
        index: u8,
        text: String,
    },
    Record {
        start: bool,
    },
    Transfer {
        to: String,
    },
    Hangup,
}

impl Command {
    /// The sentence the command has played, if it plays one.
    pub fn text(&self) -> Option<&str> {
        match self {
            Command::Answer { greeting_text, .. } => Some(greeting_text),
            Command::Say { text, .. } | Command::Play { text, .. } => Some(text),
            _ => None,
        }
    }
}

/// The outcome of applying one event or action: the commands for the bridge, the turns to
/// append, and a played sentence the caller cut (its turn and the character), if any.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Step {
    pub commands: Vec<Command>,
    pub turns: Vec<Turn>,
    pub interrupted: Option<(u32, u32)>,
}

/// Why an agent's action is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CallError {
    #[error("the call is not live")]
    NotLive,
    #[error("the sentence is empty")]
    EmptyText,
    #[error("the sentence is longer than 600 characters")]
    TextTooLong,
    #[error("only an agent-driven call takes sentences")]
    NotAgentCall,
}

impl CallSession {
    /// The next turn number, consumed.
    pub(crate) fn seq(&mut self) -> u32 {
        let seq = self.clock.next_seq;
        self.clock.next_seq += 1;
        seq
    }

    pub(crate) fn turn(
        &mut self,
        at: OffsetDateTime,
        kind: TurnKind,
        text: impl Into<String>,
        meta: TurnMeta,
    ) -> Turn {
        Turn {
            seq: self.seq(),
            at,
            kind,
            text: text.into(),
            meta,
        }
    }

    /// Marks the session ended now with `cause` (keeping a cause already set by a scripted
    /// ending), and its duration from the answer.
    pub(crate) fn finish(&mut self, cause: EndCause, now: OffsetDateTime) {
        self.state = CallState::Ended;
        self.ended_at.get_or_insert(now);
        self.end_cause.get_or_insert(cause);
        if let (Some(answered), Some(ended)) = (self.answered_at, self.ended_at) {
            let secs = (ended - answered).whole_seconds().max(0);
            self.duration_s = Some(u32::try_from(secs).unwrap_or(u32::MAX));
        }
        self.clock.owed_since = None;
        self.clock.awaiting_caller_since = None;
    }

    fn is_agent(&self) -> bool {
        self.mode == CallMode::Agent
    }
}

fn ms(d: time::Duration) -> u32 {
    u32::try_from(d.whole_milliseconds().max(0)).unwrap_or(u32::MAX)
}

/// The end cause of a hangup the counterpart's side reported with `cause`, before or after the
/// call was answered.
fn hangup_cause(cause: &str, answered: bool) -> EndCause {
    let cause = cause.trim().to_ascii_lowercase();
    if answered {
        return EndCause::CallerHangup;
    }
    match cause.as_str() {
        "busy" | "user_busy" => EndCause::Busy,
        "failed" | "error" | "congestion" | "unavailable" => {
            EndCause::Failed(format!("transient: bridge: {cause}"))
        }
        _ => EndCause::NoAnswer,
    }
}

/// Applies `event`, reported at `now`, to `session` (see the module docs). An ended session takes
/// nothing more; a partial utterance is not logged.
pub fn reduce(
    session: &mut CallSession,
    event: &BridgeEvent,
    now: OffsetDateTime,
    policy: &CallPolicy,
) -> Step {
    let mut step = Step::default();
    if session.state == CallState::Ended {
        return step;
    }
    match event {
        BridgeEvent::Inbound { .. } | BridgeEvent::Ringing => {
            if matches!(session.state, CallState::Planned | CallState::Dialing) {
                session.state = CallState::Ringing;
            }
        }
        BridgeEvent::Answered => {
            if session.answered_at.is_some() {
                return step;
            }
            session.answered_at = Some(now);
            session.state = CallState::Live;
            step.turns.push(session.turn(
                now,
                TurnKind::Event {
                    name: "answered".into(),
                },
                "",
                TurnMeta::default(),
            ));
            if !session.is_agent() {
                return step;
            }
            if session.recording == RecordingState::Pending && policy.may_record() {
                let text = policy.recording_announcement.clone();
                let turn = session.turn(
                    now,
                    TurnKind::Say {
                        by: Speaker::Script,
                    },
                    text.clone(),
                    TurnMeta::default(),
                );
                session.clock.announcement_seq = Some(turn.seq);
                step.commands.push(Command::Play {
                    seq: turn.seq,
                    clip: PlayKind::Announcement,
                    index: 0,
                    text,
                });
                step.turns.push(turn);
            }
            if let Some(opening) = session.plan.as_ref().map(|p| p.opening.clone()) {
                let turn = session.turn(
                    now,
                    TurnKind::Say {
                        by: Speaker::Script,
                    },
                    opening.clone(),
                    TurnMeta::default(),
                );
                step.commands.push(Command::Play {
                    seq: turn.seq,
                    clip: PlayKind::Opening,
                    index: 0,
                    text: opening,
                });
                step.turns.push(turn);
                session.clock.awaiting_caller_since = Some(now);
            }
        }
        BridgeEvent::Utterance {
            text,
            is_final,
            confidence,
            stt_ms,
        } => {
            if !is_final || text.trim().is_empty() {
                return step;
            }
            if let Some(stt) = stt_ms {
                session.metrics.stt_ms.push(*stt);
            }
            session.metrics.turns += 1;
            step.turns.push(session.turn(
                now,
                TurnKind::Utterance,
                text.clone(),
                TurnMeta {
                    confidence: *confidence,
                    stt_ms: *stt_ms,
                    ..TurnMeta::default()
                },
            ));
            session.clock.owed_since = Some(now);
            session.clock.holding_in_turn = 0;
            session.clock.awaiting_caller_since = None;
            session.clock.silence_noted = false;
            session.clock.agent_continues_after = None;
            if session.state == CallState::Holding {
                session.state = CallState::Live;
            }
        }
        BridgeEvent::Dtmf { digit } => {
            step.turns
                .push(session.turn(now, TurnKind::Dtmf, digit.clone(), TurnMeta::default()));
            session.clock.owed_since = Some(now);
            session.clock.holding_in_turn = 0;
            session.clock.awaiting_caller_since = None;
            session.clock.agent_continues_after = None;
        }
        BridgeEvent::Said {
            seq,
            interrupted_at_char,
            tts_ms,
        } => {
            if let Some(tts) = tts_ms {
                session.metrics.tts_ms.push(*tts);
            }
            if let Some(at) = interrupted_at_char {
                step.interrupted = Some((*seq, *at));
            }
            if session.clock.announcement_seq == Some(*seq)
                && session.recording == RecordingState::Pending
                && interrupted_at_char.is_none()
            {
                // The announcement was heard to its end: recording starts only now.
                step.commands.push(Command::Record { start: true });
                session.recording = RecordingState::Recording { file_ref: None };
            }
            if session.clock.agent_continues_after == Some(*seq) {
                // The agent said it would go on: its next sentence is owed from here.
                session.clock.agent_continues_after = None;
                session.clock.owed_since = Some(now);
                session.clock.holding_in_turn = 0;
            } else if session.clock.owed_since.is_none() {
                session.clock.awaiting_caller_since = Some(now);
                session.clock.silence_noted = false;
            }
        }
        BridgeEvent::Silence { .. } => {
            step.turns.push(session.turn(
                now,
                TurnKind::Event {
                    name: "silence".into(),
                },
                "",
                TurnMeta::default(),
            ));
        }
        BridgeEvent::Recording { file_ref } => {
            session.recording = RecordingState::Recording {
                file_ref: Some(file_ref.clone()),
            };
        }
        BridgeEvent::Hangup { cause } => {
            let cause = hangup_cause(cause, session.answered_at.is_some());
            step.turns.push(session.turn(
                now,
                TurnKind::Event {
                    name: "hangup".into(),
                },
                "",
                TurnMeta::default(),
            ));
            session.finish(cause, now);
        }
        BridgeEvent::Error { failure_line } => {
            let line: String = failure_line
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(MAX_FAILURE_CHARS)
                .collect();
            step.commands.push(Command::Hangup);
            session.finish(EndCause::Failed(line), now);
        }
        BridgeEvent::CommandDone { .. } => {}
    }
    step
}

/// The agent's sentence `text`, played now: refused unless the call is agent-driven and live (or
/// holding), and the sentence 1 to 600 characters. The turn records the agent's reply latency.
/// With `expect_reply` the caller is waited for once it has been played; without, the agent owes
/// its next sentence from then on (the holding and fallback timers count again).
pub fn say(
    session: &mut CallSession,
    text: &str,
    allow_barge_in: bool,
    expect_reply: bool,
    now: OffsetDateTime,
) -> Result<Step, CallError> {
    if !session.is_agent() {
        return Err(CallError::NotAgentCall);
    }
    if !matches!(session.state, CallState::Live | CallState::Holding) {
        return Err(CallError::NotLive);
    }
    if text.trim().is_empty() {
        return Err(CallError::EmptyText);
    }
    if text.chars().count() > MAX_LINE_CHARS {
        return Err(CallError::TextTooLong);
    }
    let latency = session.clock.owed_since.map(|owed| ms(now - owed));
    if let Some(latency) = latency {
        session.metrics.agent_latency_ms.push(latency);
    }
    let turn = session.turn(
        now,
        TurnKind::Say { by: Speaker::Agent },
        text,
        TurnMeta {
            latency_ms: latency,
            ..TurnMeta::default()
        },
    );
    session.clock.owed_since = None;
    session.clock.holding_in_turn = 0;
    session.clock.awaiting_caller_since = None;
    session.clock.agent_continues_after = (!expect_reply).then_some(turn.seq);
    session.state = CallState::Live;
    Ok(Step {
        commands: vec![Command::Say {
            seq: turn.seq,
            text: text.to_owned(),
            allow_barge_in,
        }],
        turns: vec![turn],
        interrupted: None,
    })
}

/// Hands the caller over to PBX extension `to`: refused unless the call is agent-driven and live
/// (or holding). The bridge is asked to transfer the line, and the agent's part ends at once
/// (`transferred`), with no closing: the line goes on without the agent.
pub fn transfer(
    session: &mut CallSession,
    to: &str,
    now: OffsetDateTime,
) -> Result<Step, CallError> {
    if !session.is_agent() {
        return Err(CallError::NotAgentCall);
    }
    if !matches!(session.state, CallState::Live | CallState::Holding) {
        return Err(CallError::NotLive);
    }
    let turn = session.turn(
        now,
        TurnKind::Event {
            name: "transferred".into(),
        },
        "",
        TurnMeta::default(),
    );
    session.finish(EndCause::Transferred, now);
    Ok(Step {
        commands: vec![Command::Transfer { to: to.to_owned() }],
        turns: vec![turn],
        interrupted: None,
    })
}

/// Ends the session at `now` without waiting for the line: the bridge stopped reporting, or never
/// reported the end of a closing, or the caller recorded the call's outcome while its closing
/// plays. A cause a scripted ending already set is kept; nothing is sent to the bridge. An ended
/// session is left as it is.
pub fn close(session: &mut CallSession, cause: EndCause, now: OffsetDateTime) {
    if session.state != CallState::Ended {
        session.finish(cause, now);
    }
}

/// Ends the call with `cause`: an answered agent-driven call hears its plan's closing and is hung
/// up (the session is `Ending` until the bridge reports the hangup); any other live call is hung
/// up at once and ended; a planned one is ended without a command. An ended session is left as
/// it is.
pub fn end(session: &mut CallSession, cause: EndCause, now: OffsetDateTime) -> Step {
    let mut step = Step::default();
    match session.state {
        CallState::Ended | CallState::Ending => return step,
        CallState::Planned => {
            session.finish(cause, now);
            return step;
        }
        _ => {}
    }
    let closing = session
        .plan
        .as_ref()
        .filter(|_| session.is_agent() && session.answered_at.is_some())
        .map(|p| p.closing.clone());
    match closing {
        Some(text) => {
            let turn = session.turn(
                now,
                TurnKind::Say {
                    by: Speaker::Script,
                },
                text.clone(),
                TurnMeta::default(),
            );
            step.commands.push(Command::Play {
                seq: turn.seq,
                clip: PlayKind::Closing,
                index: 0,
                text,
            });
            step.turns.push(turn);
            step.commands.push(Command::Hangup);
            session.state = CallState::Ending;
            session.end_cause = Some(cause);
            session.clock.owed_since = None;
            session.clock.awaiting_caller_since = None;
            session.clock.closing_since = Some(now);
        }
        None => {
            if session.is_agent() {
                step.commands.push(Command::Hangup);
            }
            session.finish(cause, now);
        }
    }
    step
}
