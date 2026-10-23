//! Pure send-fence decisions, evaluated again immediately before provider I/O.

use serde::{Deserialize, Serialize};

use crate::{ConvState, JourneyStatus};

/// Fresh application snapshot for one queued send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenceCtx {
    /// Open journey status, or the latest terminal status when none is open.
    /// None means the person has no journey; callers must not hide a latest Lost here.
    pub journey_status: Option<JourneyStatus>,
    /// Whether the person's data was erased.
    pub person_erased: bool,
    /// Whether the person is a merged alias.
    pub person_merged: bool,
    /// Current conversation state. State alone does not prevent an explicit reply.
    pub conversation_state: ConvState,
    /// Generation captured when the send was queued.
    pub expected_generation: u32,
    /// Generation from the current conversation.
    pub current_generation: u32,
    /// Whether the agent currently holds execution.
    pub executor_is_agent: bool,
    /// Whether the capability is currently live.
    pub capability_live: bool,
}

/// Stable refusal reasons for a send that must not reach the provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum FenceRefusal {
    /// The person's latest journey is lost.
    #[error("journey_lost")]
    JourneyLost,
    /// Personal data has been erased.
    #[error("person_erased")]
    PersonErased,
    /// The person was merged into a different record.
    #[error("person_merged")]
    PersonMerged,
    /// A handover invalidated the queued generation.
    #[error("executor_changed")]
    ExecutorChanged,
    /// An agent attempted to send while a human holds the conversation.
    #[error("human_holds_conversation")]
    HumanHoldsConversation,
    /// The capability is no longer live.
    #[error("capability_down")]
    CapabilityDown,
}

/// Check the domain send fence. Human sends ignore holder identity, but obey all other fences.
/// Reply-window, suppression and consent checks belong to their application use cases.
pub fn may_send(ctx: &FenceCtx, by_agent: bool) -> Result<(), FenceRefusal> {
    if ctx.journey_status == Some(JourneyStatus::Lost) {
        return Err(FenceRefusal::JourneyLost);
    }
    if ctx.person_erased {
        return Err(FenceRefusal::PersonErased);
    }
    if ctx.person_merged {
        return Err(FenceRefusal::PersonMerged);
    }
    if ctx.expected_generation != ctx.current_generation {
        return Err(FenceRefusal::ExecutorChanged);
    }
    if by_agent && !ctx.executor_is_agent {
        return Err(FenceRefusal::HumanHoldsConversation);
    }
    if !ctx.capability_live {
        return Err(FenceRefusal::CapabilityDown);
    }
    Ok(())
}
