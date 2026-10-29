//! What one caller turn took, as the voice bridge measured it (design addendum
//! `2026-10-29-voice-sidecar-free-path-design.md` §7), and the percentiles of a call's turns. Every
//! field is an offset in milliseconds from the caller's end of speech (the last voiced 20 ms
//! frame), on the bridge's monotonic clock, except `barge_in_stop_ms`, a duration from the caller's
//! onset (the first voiced frame of the interruption) to the agent's voice stopping, and
//! `reply_seq`, the number of the agent's `say` that `say_ms` timed. Numbers only: a trace never
//! carries a word or a number dialled.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The first sound the caller hears after speaking (perceived latency): alert above this p95.
pub const PERCEIVED_P95_ALERT_MS: u32 = 1_000;
/// The first sound of the agent's real reply (content latency): alert above this p95.
pub const CONTENT_P95_ALERT_MS: u32 = 3_000;
/// The caller's onset to the agent's voice stopping when the caller cuts in: alert above this p95.
pub const BARGE_IN_P95_ALERT_MS: u32 = 300;
/// The most traces one call keeps.
pub const MAX_TRACES: usize = 200;

/// What decided that the caller's turn had ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointBy {
    /// The turn model judged it complete after a short pause.
    SmartTurn,
    /// The silence ran past the fallback.
    Fallback,
}

/// The timings of one caller turn (offsets from the end of speech, bar `barge_in_stop_ms` and the
/// `reply_seq` key).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TurnTrace {
    /// The end of the turn was decided.
    pub endpoint_ms: u32,
    pub endpoint_by: Option<EndpointBy>,
    /// The final transcript was ready.
    pub stt_final_ms: u32,
    /// The core answered the utterance's report.
    pub delivered_ms: Option<u32>,
    /// The reply's first sentence (`say` or `play`) reached the bridge.
    pub say_ms: Option<u32>,
    /// The reply's first synthesised audio was ready.
    pub tts_first_ms: Option<u32>,
    /// The reply's first frame was written to the line.
    pub first_audio_ms: Option<u32>,
    /// The first frame of a phrase the bridge played on its own (acknowledgement, filler).
    pub ack_ms: Option<u32>,
    /// When the caller cut the reply: a duration from the caller's onset (not from the end of
    /// speech) to the agent's voice stopping.
    pub barge_in_stop_ms: Option<u32>,
    /// The caller cut the reply with words that were only acknowledgement ("hı hı", "evet").
    pub backchannel_cut: bool,
    /// The `seq` of the agent `say` whose arrival `say_ms` timed: the key that pairs this turn with
    /// the core's own latency for that sentence ([`AgentReply`]). `None` when no `say` arrived.
    pub reply_seq: Option<u32>,
}

impl TurnTrace {
    /// The first sound the caller heard after speaking: a local phrase or the reply.
    pub fn perceived_ms(&self) -> Option<u32> {
        match (self.ack_ms, self.first_audio_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// From the core taking the caller's words to the reply reaching the bridge: the agent's think
    /// time plus both hops.
    pub fn core_round_ms(&self) -> Option<u32> {
        self.say_ms?.checked_sub(self.delivered_ms?)
    }
}

/// What the core measured for one agent `say`: its turn `seq` (the number a bridge trace carries
/// as `reply_seq`) and the wait the sentence ended, in milliseconds from the moment the agent owed
/// one (the caller's final words, a key press, a fallback line) to the `say`. One per `say` that
/// ended a wait, so the list can be longer or shorter than the call's traces: the match is by `seq`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReply {
    pub seq: u32,
    pub latency_ms: u32,
}

/// How many values, and their nearest-rank median and 95th percentile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Percentiles {
    pub n: u32,
    pub p50: Option<u32>,
    pub p95: Option<u32>,
}

/// The nearest-rank percentiles of `values`: the value at rank `ceil(q * n)`, worked out in
/// integers so that no rounding of a float product can move a rank by one.
pub fn percentiles(values: impl IntoIterator<Item = u32>) -> Percentiles {
    let mut v: Vec<u32> = values.into_iter().collect();
    v.sort_unstable();
    let rank = |percent: usize| -> Option<u32> {
        if v.is_empty() {
            return None;
        }
        let k = (percent * v.len()).div_ceil(100);
        v.get(k.clamp(1, v.len()) - 1).copied()
    };
    Percentiles {
        n: u32::try_from(v.len()).unwrap_or(u32::MAX),
        p50: rank(50),
        p95: rank(95),
    }
}

/// A call's latency: each measure's percentiles over its turns, and the alerts the thresholds
/// raise (`perceived_p95_over_1s`, `content_p95_over_3s`, `barge_in_p95_over_300ms`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencySummary {
    pub turns: u32,
    pub perceived: Percentiles,
    pub content: Percentiles,
    pub endpoint: Percentiles,
    pub stt_final: Percentiles,
    pub core_round: Percentiles,
    /// The agent's reply time as the core measured it (`CallMetrics::agent_latency_ms`).
    pub agent: Percentiles,
    pub barge_in_stop: Percentiles,
    /// What the bridge-to-core hops added, per turn: `core_round_ms` less the core's latency for the
    /// reply the trace names, saturating at 0 (the two windows differ by the tail of the utterance
    /// POST). Only the turns whose reply has both a `reply_seq` and a recorded latency count. A
    /// reply that followed a fallback line has its latency counted from the fallback, so it
    /// overstates the hop. Reported, never an alert (the acceptance gate is p95 ≤ 100 ms).
    pub transport: Percentiles,
    pub backchannel_cuts: u32,
    pub alerts: Vec<String>,
}

/// The summary of `traces`, the core's own `agent_latency_ms`, and its `agent_replies` (the same
/// latencies keyed by the `say`'s `seq`, which is how a trace finds its own).
pub fn summarize(
    traces: &[TurnTrace],
    agent_latency_ms: &[u32],
    agent_replies: &[AgentReply],
) -> LatencySummary {
    let mut latency_of = BTreeMap::new();
    for r in agent_replies {
        latency_of.entry(r.seq).or_insert(r.latency_ms);
    }
    let s = LatencySummary {
        turns: u32::try_from(traces.len()).unwrap_or(u32::MAX),
        perceived: percentiles(traces.iter().filter_map(TurnTrace::perceived_ms)),
        content: percentiles(traces.iter().filter_map(|t| t.first_audio_ms)),
        endpoint: percentiles(traces.iter().map(|t| t.endpoint_ms)),
        stt_final: percentiles(traces.iter().map(|t| t.stt_final_ms)),
        core_round: percentiles(traces.iter().filter_map(TurnTrace::core_round_ms)),
        agent: percentiles(agent_latency_ms.iter().copied()),
        barge_in_stop: percentiles(traces.iter().filter_map(|t| t.barge_in_stop_ms)),
        transport: percentiles(traces.iter().filter_map(|t| {
            let latency = latency_of.get(&t.reply_seq?)?;
            Some(t.core_round_ms()?.saturating_sub(*latency))
        })),
        backchannel_cuts: u32::try_from(traces.iter().filter(|t| t.backchannel_cut).count())
            .unwrap_or(u32::MAX),
        alerts: Vec::new(),
    };
    let over = |p: Percentiles, limit: u32| p.p95.is_some_and(|v| v > limit);
    let mut alerts = Vec::new();
    if over(s.perceived, PERCEIVED_P95_ALERT_MS) {
        alerts.push("perceived_p95_over_1s".to_owned());
    }
    if over(s.content, CONTENT_P95_ALERT_MS) {
        alerts.push("content_p95_over_3s".to_owned());
    }
    if over(s.barge_in_stop, BARGE_IN_P95_ALERT_MS) {
        alerts.push("barge_in_p95_over_300ms".to_owned());
    }
    LatencySummary { alerts, ..s }
}
