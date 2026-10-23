//! Pure journey creation and reduction. Only `begin_journey` and `reduce` produce persistable proofs.

use std::collections::BTreeSet;

use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{EventSource, JourneyEventId, JourneyId, PersonId, Source, epoch};

/// Fixed funnel stages; terminal outcomes do not participate in the rank ordering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JourneyStatus {
    /// No successful outbound contact yet.
    #[default]
    New,
    /// Successful contact established.
    Contacted,
    /// The failed-call threshold was reached before an advanced milestone.
    Unreachable,
    /// An appointment was booked.
    Appointment,
    /// A meeting was held.
    Met,
    /// A quote was sent.
    Quoted,
    /// A quote was accepted; payment or signature is pending.
    Pending,
    /// A completed sale; never reopened.
    Won,
    /// A lost opportunity; only authorized reopening leaves this state.
    Lost,
}

impl JourneyStatus {
    fn rank(self) -> Option<u8> {
        match self {
            Self::New => Some(0),
            Self::Contacted | Self::Unreachable => Some(1),
            Self::Appointment => Some(2),
            Self::Met => Some(3),
            Self::Quoted => Some(4),
            Self::Pending => Some(5),
            Self::Won | Self::Lost => None,
        }
    }
}

/// A dictionary key and its historical label, preserved when the dictionary changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LostReason {
    /// The workspace dictionary key.
    pub reason_key: String,
    /// The label when the loss was recorded.
    pub reason_label: String,
}

/// Application-supplied, non-persisted reduction context; defaults to no reopen authority.
///
/// At most 64 distinct event keys are accepted. The application supplies keys relevant to the
/// current reduction (including the candidate key if already stored), not an unbounded history.
/// Workspace-wide durable uniqueness and concurrent duplicate prevention remain transactional
/// application/repository responsibilities. This context is never accepted from stored/client
/// JSON; after checking InboxManage AND owner/manager, the application may authorize reopening.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReduceInput {
    last_event_keys: BTreeSet<String>,
    reopen_authorized: bool,
}

impl ReduceInput {
    /// Build bounded context without silently dropping keys that could suppress duplicate effects.
    pub fn new(
        last_event_keys: impl IntoIterator<Item = String>,
        reopen_authorized: bool,
    ) -> Result<Self, ReduceError> {
        let mut keys = BTreeSet::new();
        for key in last_event_keys {
            keys.insert(key);
            if keys.len() > 64 {
                return Err(ReduceError::NotAllowed("too many recent event keys"));
            }
        }
        Ok(Self {
            last_event_keys: keys,
            reopen_authorized,
        })
    }
}

/// A stored acquisition journey. Repositories create through [`InitialJourney`] and change
/// reducer-owned state only through [`Transition`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journey {
    /// Journey identity.
    pub id: JourneyId,
    /// Owning tenant.
    pub workspace_id: WorkspaceId,
    /// Person whose opportunity this represents.
    pub person_id: PersonId,
    /// Reducer-owned stage; absent historical values read as New.
    #[serde(default)]
    pub status: JourneyStatus,
    /// Commission owner, separate from conversation executor.
    #[serde(default)]
    pub owner: Option<UserId>,
    /// Time the journey was opened.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub opened_at: OffsetDateTime,
    /// Terminal closure time, cleared only by reopening a lost journey.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    /// Historical loss reason, cleared on reopening.
    #[serde(default)]
    pub lost_reason: Option<LostReason>,
    /// Failed calls since the last successful contact; saturates rather than wraps.
    #[serde(default)]
    pub unreachable_attempts: u8,
    /// Acquisition source of this journey.
    pub source: Source,
    /// Last applied event time.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// Trusted application context, populated after loading and never deserialized.
    #[serde(skip)]
    pub reduce_input: ReduceInput,
}

/// An unforgeable initial journey, produced only by [`begin_journey`].
///
/// Application code cannot construct a literal or call the crate-private constructor:
/// ```compile_fail
/// use jt_inbox::{InitialJourney, Journey};
/// fn forge(journey: Journey) -> InitialJourney { InitialJourney { journey } }
/// ```
/// ```compile_fail
/// use jt_inbox::{InitialJourney, Journey};
/// fn forge(journey: Journey) -> InitialJourney { InitialJourney::new(journey) }
/// ```
/// Neither deserialization nor Default can bypass domain initialization:
/// ```compile_fail
/// let _: jt_inbox::InitialJourney = serde_json::from_str("{}").unwrap();
/// ```
/// ```compile_fail
/// let _: jt_inbox::InitialJourney = Default::default();
/// ```
/// Its accessor cannot mutate the proof's state:
/// ```compile_fail
/// use jt_inbox::{InitialJourney, JourneyStatus};
/// fn overwrite(initial: &mut InitialJourney) {
///     initial.journey().status = JourneyStatus::Won;
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InitialJourney {
    journey: Journey,
}

impl InitialJourney {
    // Only begin_journey calls this constructor; a stored Journey is not a creation proof.
    pub(crate) fn new(journey: Journey) -> Self {
        Self { journey }
    }

    /// Read the complete domain-initialized row without exposing mutable state.
    pub fn journey(&self) -> &Journey {
        &self.journey
    }
}

/// Initialize a new opportunity with no owner, failed attempts, closure or loss.
///
/// Identity, acquisition source and time are supplied by the application. Stage and reduction
/// context are owned here; callers cannot import a stored or client-supplied stage as creation.
pub fn begin_journey(
    id: JourneyId,
    workspace_id: WorkspaceId,
    person_id: PersonId,
    source: Source,
    at: OffsetDateTime,
) -> InitialJourney {
    InitialJourney::new(Journey {
        id,
        workspace_id,
        person_id,
        status: JourneyStatus::New,
        owner: None,
        opened_at: at,
        closed_at: None,
        lost_reason: None,
        unreachable_attempts: 0,
        source,
        updated_at: at,
        reduce_input: ReduceInput::default(),
    })
}

/// Typed event payload; the actor and historical loss label live on [`JourneyEvent`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JourneyEventKind {
    /// Inbound contact; does not advance the journey.
    MessageReceived,
    /// An outbound reply was sent.
    Replied,
    /// A completed call attempt.
    CallMade {
        /// Whether contact was established.
        connected: bool,
    },
    /// An appointment was booked.
    AppointmentBooked,
    /// A meeting was held.
    MeetingHeld,
    /// A quote was sent.
    QuoteSent,
    /// A quote was accepted.
    QuoteAccepted,
    /// A sale was won.
    Won {
        /// Sold product description, not a provisioning instruction.
        product: String,
        /// Sale amount in minor currency units.
        amount_minor: i64,
        /// Currency of the sale.
        currency: String,
    },
    /// An opportunity was lost; the event must also contain its label snapshot.
    Lost {
        /// Active workspace dictionary key, validated by the application.
        reason_key: String,
    },
    /// Defer the conversation without regressing the journey.
    Snoozed {
        /// When the conversation becomes ours again.
        #[serde(with = "time::serde::rfc3339")]
        until: OffsetDateTime,
    },
    /// Explicitly reopen a lost journey with authorized human intent.
    Reopened,
    /// Move the journey to a merge keeper without changing its stage.
    Merged {
        /// Keeper person; the application performs the move transactionally.
        target: PersonId,
    },
}

/// An immutable event record to be reduced and persisted atomically with its effects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyEvent {
    /// Event identity.
    pub id: JourneyEventId,
    /// Owning tenant.
    pub workspace_id: WorkspaceId,
    /// Journey receiving the event.
    pub journey_id: JourneyId,
    /// Actor derived from the authenticated principal or trusted consumer.
    pub source: EventSource,
    /// Required, nonempty workspace-wide deduplication key.
    pub idempotency_key: String,
    /// Typed event payload.
    pub kind: JourneyEventKind,
    /// Required for Lost: the dictionary label at the time of the event.
    #[serde(default)]
    pub reason_label: Option<String>,
    /// Injected event time; reduction never reads a clock.
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// Workspace policy for failed call attempts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReducePolicy {
    /// Attempts required before an early-stage journey becomes Unreachable.
    pub unreachable_threshold: u8,
}

impl Default for ReducePolicy {
    fn default() -> Self {
        Self {
            unreachable_threshold: 3,
        }
    }
}

/// A rejected event; duplicate detection always takes precedence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReduceError {
    /// The event attempts to change a terminal journey.
    #[error("journey is terminal")]
    Terminal,
    /// Invalid event data or missing authority.
    #[error("event not allowed: {0}")]
    NotAllowed(&'static str),
    /// This key was already applied; the caller must suppress all effects.
    #[error("duplicate journey event")]
    Duplicate,
}

/// Full replacement values for reducer-owned fields, including explicit clears.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JourneyPatch {
    /// Resulting stage.
    pub status: JourneyStatus,
    /// Resulting failed-call count.
    pub unreachable_attempts: u8,
    /// Resulting closure time; None clears it.
    #[serde(with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    /// Resulting loss reason; None clears it.
    pub lost_reason: Option<LostReason>,
    /// Resulting event timestamp, unchanged for terminal system reply no-ops.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Transactional work emitted by reduction; execution belongs to the application layer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JourneyEffect {
    /// Reopen/unsnooze the conversation into the workspace's queue.
    ConversationOurs,
    /// Clear snooze and wait for the person's response.
    ConversationTheirs,
    /// Defer the conversation until the supplied instant.
    ConversationSnoozed {
        /// When the snooze expires.
        #[serde(with = "time::serde::rfc3339")]
        until: OffsetDateTime,
    },
    /// Calculate the owner's commission for the won sale.
    CommissionDue {
        /// Sale amount in minor currency units.
        amount_minor: i64,
        /// Sale currency.
        currency: String,
    },
    /// Complete open tasks after a win.
    CloseTasks,
    /// Close conversations after a loss.
    CloseConversations,
    /// Cancel open tasks after a loss.
    CancelOpenTasks,
}

/// An unforgeable reducer result: read-only, serializable, never deserializable.
///
/// `forged_transition_bypass_injection_rejected`: application code cannot call its constructor:
/// ```compile_fail
/// use jt_inbox::{JourneyPatch, JourneyStatus, Transition};
/// fn forged_transition_bypass_injection_rejected(patch: JourneyPatch) -> Transition {
///     Transition::new(JourneyStatus::New, patch, vec![])
/// }
/// ```
/// Nor can it construct a literal:
/// ```compile_fail
/// use jt_inbox::{JourneyPatch, JourneyStatus, Transition};
/// fn forged_transition_bypass_injection_rejected(patch: JourneyPatch) -> Transition {
///     Transition { from: JourneyStatus::New, patch, effects: vec![] }
/// }
/// ```
/// Deserializing a saved result cannot bypass reduction:
/// ```compile_fail
/// let _: jt_inbox::Transition = serde_json::from_str("{}").unwrap();
/// ```
/// There is no default transition:
/// ```compile_fail
/// let _: jt_inbox::Transition = Default::default();
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Transition {
    from: JourneyStatus,
    patch: JourneyPatch,
    effects: Vec<JourneyEffect>,
}

impl Transition {
    // Only reduce calls this crate-private constructor.
    pub(crate) fn new(
        from: JourneyStatus,
        patch: JourneyPatch,
        effects: Vec<JourneyEffect>,
    ) -> Self {
        Self {
            from,
            patch,
            effects,
        }
    }

    /// Stage before the event.
    pub fn from(&self) -> JourneyStatus {
        self.from
    }

    /// Stage after the event.
    pub fn to(&self) -> JourneyStatus {
        self.patch.status
    }

    /// Complete reducer-owned field replacements.
    pub fn patch(&self) -> &JourneyPatch {
        &self.patch
    }

    /// Effects to execute in the same transaction as the state and event.
    pub fn effects(&self) -> &[JourneyEffect] {
        &self.effects
    }
}

/// Reduce an event without I/O or clocks, using trusted context from `j.reduce_input`.
///
/// Duplicate keys are checked before validation, authorization, or terminal-state rules.
/// The application validates dictionary membership and principal permissions, supplies reopen
/// authority through [`ReduceInput`], and persists the event, patch and effects atomically.
/// Post-Won inbound must be routed to a new Repeat journey before calling this function.
/// Lost inbound emits ConversationOurs; the application also assigns Human{None} as required
/// by the lost-inbound policy, without opening a second journey.
pub fn reduce(
    j: &Journey,
    e: &JourneyEvent,
    policy: &ReducePolicy,
) -> Result<Transition, ReduceError> {
    if j.reduce_input.last_event_keys.contains(&e.idempotency_key) {
        return Err(ReduceError::Duplicate);
    }
    if e.idempotency_key.trim().is_empty() {
        return Err(ReduceError::NotAllowed("idempotency key is required"));
    }
    if e.workspace_id != j.workspace_id || e.journey_id != j.id {
        return Err(ReduceError::NotAllowed("event belongs to another journey"));
    }
    let mut patch = JourneyPatch {
        status: j.status,
        unreachable_attempts: j.unreachable_attempts,
        closed_at: j.closed_at,
        lost_reason: j.lost_reason.clone(),
        updated_at: j.updated_at,
    };
    let mut effects = Vec::new();
    let terminal = j.status.rank().is_none();
    let terminal_reply =
        terminal && e.kind == JourneyEventKind::Replied && e.source == EventSource::System;
    if !terminal_reply {
        if terminal
            && !matches!(e.kind, JourneyEventKind::Merged { .. })
            && !(j.status == JourneyStatus::Lost
                && matches!(
                    e.kind,
                    JourneyEventKind::MessageReceived | JourneyEventKind::Reopened
                ))
        {
            return Err(ReduceError::Terminal);
        }
        patch.updated_at = e.at;
        match &e.kind {
            JourneyEventKind::MessageReceived => effects.push(JourneyEffect::ConversationOurs),
            JourneyEventKind::Replied | JourneyEventKind::CallMade { connected: true } => {
                patch.unreachable_attempts = 0;
                if matches!(j.status, JourneyStatus::New | JourneyStatus::Unreachable) {
                    patch.status = JourneyStatus::Contacted;
                }
                if e.kind == JourneyEventKind::Replied {
                    effects.push(JourneyEffect::ConversationTheirs);
                }
            }
            JourneyEventKind::CallMade { connected: false } => {
                patch.unreachable_attempts = patch.unreachable_attempts.saturating_add(1);
                if matches!(j.status.rank(), Some(0 | 1))
                    && patch.unreachable_attempts >= policy.unreachable_threshold
                {
                    patch.status = JourneyStatus::Unreachable;
                }
            }
            JourneyEventKind::AppointmentBooked => advance(&mut patch, JourneyStatus::Appointment),
            JourneyEventKind::MeetingHeld => advance(&mut patch, JourneyStatus::Met),
            JourneyEventKind::QuoteSent => advance(&mut patch, JourneyStatus::Quoted),
            JourneyEventKind::QuoteAccepted => advance(&mut patch, JourneyStatus::Pending),
            JourneyEventKind::Won {
                amount_minor,
                currency,
                ..
            } => {
                patch.status = JourneyStatus::Won;
                patch.closed_at = Some(e.at);
                effects.push(JourneyEffect::CommissionDue {
                    amount_minor: *amount_minor,
                    currency: currency.clone(),
                });
                effects.push(JourneyEffect::CloseTasks);
            }
            JourneyEventKind::Lost { reason_key } => {
                let reason_label = e
                    .reason_label
                    .as_ref()
                    .filter(|label| !label.trim().is_empty());
                let Some(reason_label) = reason_label.filter(|_| !reason_key.trim().is_empty())
                else {
                    return Err(ReduceError::NotAllowed(
                        "loss requires reason key and label",
                    ));
                };
                patch.status = JourneyStatus::Lost;
                patch.closed_at = Some(e.at);
                patch.lost_reason = Some(LostReason {
                    reason_key: reason_key.clone(),
                    reason_label: reason_label.clone(),
                });
                effects.extend([
                    JourneyEffect::CloseConversations,
                    JourneyEffect::CancelOpenTasks,
                ]);
            }
            JourneyEventKind::Snoozed { until } => {
                effects.push(JourneyEffect::ConversationSnoozed { until: *until });
            }
            JourneyEventKind::Reopened => {
                if j.status != JourneyStatus::Lost {
                    return Err(ReduceError::NotAllowed("only lost journeys can reopen"));
                }
                if !j.reduce_input.reopen_authorized || !matches!(e.source, EventSource::Human(_)) {
                    return Err(ReduceError::NotAllowed(
                        "reopening requires an authorized human",
                    ));
                }
                patch.status = JourneyStatus::Contacted;
                patch.closed_at = None;
                patch.lost_reason = None;
                patch.unreachable_attempts = 0;
            }
            JourneyEventKind::Merged { .. } => {}
        }
    }
    Ok(Transition::new(j.status, patch, effects))
}

fn advance(patch: &mut JourneyPatch, target: JourneyStatus) {
    if let (Some(current), Some(next)) = (patch.status.rank(), target.rank())
        && next > current
    {
        patch.status = target;
    }
}
