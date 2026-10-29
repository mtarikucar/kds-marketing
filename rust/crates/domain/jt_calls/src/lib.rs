//! Phone calls of a workspace (spec `2026-10-27-agent-voice-calls-design.md` §5): a call session
//! and its state machine, the plan the caller authored before dialing, the workspace's call
//! policy, the fence every placed call passes, and the timers that keep a slow or silent agent
//! from leaving a caller hanging. Pure rules: no provider, database or clock I/O; every function
//! takes the time it needs.
//!
//! The server never composes a sentence: every text a [`Command`] carries is the plan's, the
//! policy's, or one the agent passed to [`say`].

mod fence;
mod ids;
mod mask;
mod opening;
mod phrases;
mod plan;
mod policy;
mod session;
mod timers;
mod trace;
pub mod wire;

pub use fence::{FenceInput, RelationshipEvidence, fence_call};
pub use ids::{CallCommandId, CallId};
pub use mask::mask_e164;
pub use opening::{
    CLOSING, TRANSCRIPT_NOTICE, disclosure, genitive, inbound_greeting, outbound_opening,
};
pub use phrases::{BridgePhrases, PhraseSet};
pub use plan::{
    CallPlan, MAX_CALL_DURATION_S, MAX_FALLBACK_LINES, MAX_HOLDING_LINES, MAX_LINE_CHARS, PlanError,
};
pub use policy::{CallPolicy, MAX_SUMMARY_CHARS, PolicyError};
pub use session::{
    BridgeEvent, CallDirection, CallError, CallMetrics, CallMode, CallOutcome, CallPurpose,
    CallSession, CallState, Command, EndCause, PlayKind, RecordingState, RefusalReason, Speaker,
    Step, Turn, TurnClock, TurnKind, TurnMeta, close, end, reduce, say, transfer,
};
pub use timers::{CLOSING_GRACE_S, MAX_RING_S, TimerAction, apply_timer, next_timer};
pub use trace::{
    AgentReply, BARGE_IN_P95_ALERT_MS, CONTENT_P95_ALERT_MS, EndpointBy, LatencySummary,
    MAX_TRACES, PERCEIVED_P95_ALERT_MS, Percentiles, TurnTrace, percentiles, summarize,
};
