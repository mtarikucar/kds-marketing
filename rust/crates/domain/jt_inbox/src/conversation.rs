//! Conversation state and generation-fenced executor handovers.

use jt_capability::CapabilityId;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{ConversationId, PersonId};

/// Who owes the next response, or whether the conversation is snoozed or closed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvState {
    /// Newly opened, before either side has spoken; the storage default.
    #[default]
    Open,
    /// The workspace owes the next response.
    Ours,
    /// The person owes the next response.
    Theirs,
    /// Temporarily deferred until a given time.
    Snoozed {
        /// When the conversation should return to the workspace queue.
        #[serde(with = "time::serde::rfc3339")]
        until: OffsetDateTime,
    },
    /// Closed until a later contact reopens it.
    Closed,
}

/// Who executes replies; this is independent of a journey's commission owner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Executor {
    /// Agent execution, the default for a new conversation.
    #[default]
    Agent,
    /// Human execution; an absent user means the unassigned human queue.
    Human {
        /// The assigned user, or `None` for the unassigned queue.
        #[serde(default)]
        user_id: Option<UserId>,
    },
}

/// One person's conversation through one capability, with a monotonically increasing fence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    /// The conversation's id.
    pub id: ConversationId,
    /// The tenant that owns the conversation.
    pub workspace_id: WorkspaceId,
    /// The person on the other side of the conversation.
    pub person_id: PersonId,
    /// The capability used to communicate.
    pub capability_id: CapabilityId,
    /// The capability kind key, retained even if the kind is later removed.
    pub kind_key: String,
    /// Who owes a response; missing reads as `Open`.
    #[serde(default)]
    pub state: ConvState,
    /// The reply executor; missing reads as `Agent`.
    #[serde(default)]
    pub executor: Executor,
    /// The generation captured by queued sends; missing reads as zero.
    #[serde(default)]
    pub executor_generation: u32,
    /// The latest inbound contact, used for reply windows; missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub last_inbound_at: Option<OffsetDateTime>,
    /// The latest outbound contact; missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub last_outbound_at: Option<OffsetDateTime>,
}

impl Conversation {
    /// Record inbound contact, clear any snooze, and make the response ours.
    /// Returns whether a closed conversation was reopened. The executor is unchanged.
    pub fn reopen_on_inbound(&mut self, now: OffsetDateTime) -> bool {
        let reopened = self.state == ConvState::Closed;
        self.state = ConvState::Ours;
        self.last_inbound_at = Some(now);
        reopened
    }

    /// Record outbound contact, clear any snooze, and wait for their response.
    /// Sending a human reply never implicitly changes the executor or its generation.
    pub fn on_outbound(&mut self, now: OffsetDateTime) {
        self.state = ConvState::Theirs;
        self.last_outbound_at = Some(now);
    }

    /// Defer the conversation until `until`, without changing its executor or contact times.
    pub fn snooze(&mut self, until: OffsetDateTime) {
        self.state = ConvState::Snoozed { until };
    }

    /// Clear a snooze and return the conversation to the workspace's response queue.
    pub fn unsnooze(&mut self) {
        self.state = ConvState::Ours;
    }

    /// Hand execution to a human, or the unassigned human queue, returning a fresh generation.
    /// Even a repeated takeover invalidates queued sends. Panics before changing any fields
    /// if the generation is exhausted, rather than wrapping and reusing an old fence.
    pub fn take_over(&mut self, user: Option<UserId>) -> u32 {
        self.change_executor(Executor::Human { user_id: user })
    }

    /// Hand execution to the agent, returning a fresh generation even if it already holds it.
    /// Panics before changing any fields if the generation is exhausted.
    pub fn hand_to_agent(&mut self) -> u32 {
        self.change_executor(Executor::Agent)
    }

    fn change_executor(&mut self, executor: Executor) -> u32 {
        let generation = self
            .executor_generation
            .checked_add(1)
            .expect("executor generation exhausted");
        self.executor = executor;
        self.executor_generation = generation;
        generation
    }
}
