//! Waking an agent when a person gives it work (`usecases::wake`): what is stored per agent and
//! the outbound port that calls it.
//!
//! An agent here is an API key: the key is what an agent checks in with, it outlives the client
//! versions its connections record (a routine that updates its client makes a new connection,
//! not a new agent), and the panel's agents page lists one row per key. Each key has at most one
//! [`AgentWakeRow`]: its wake address (set and removed only by a person), the wake waiting to go
//! out (an outbox: recorded in the person's own transaction, sent by the `agent_wake` job), the
//! recent fires the rate limits count, the last outcome, and the recent check-ins its interval
//! is learned from.
//!
//! The address's token (a routine's bearer token, a webhook's secret) is sealed beside the row,
//! never inside it: [`AgentWakeRow`] has no field that could carry it, so no read, log line or
//! ledger entry built from a row can either.

use async_trait::async_trait;
use jt_tenancy::{ApiKeyId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

/// A wake goes out this long after the last request for its agent, so several requests in a
/// row (five uploads) make one call.
pub const WAKE_SETTLE: Duration = Duration::seconds(45);
/// ... but never later than this after the first request, however many follow it.
pub const WAKE_SETTLE_MAX: Duration = Duration::minutes(3);
/// At most one fire per agent in this time.
pub const WAKE_MIN_GAP: Duration = Duration::minutes(3);
/// At most this many fires per agent per hour (the routine endpoint allows 30 per routine and
/// 100 per account; staying well below leaves room for the agent's own schedule and other
/// routines of the account).
pub const WAKE_HOURLY_CAP: usize = 20;
/// The first retry after a network error or a `5xx` waits this long; each next one twice as
/// long, up to [`WAKE_RETRY_MAX_DELAY`].
pub const WAKE_RETRY_BASE: Duration = Duration::seconds(30);
/// The longest wait between two retries.
pub const WAKE_RETRY_MAX_DELAY: Duration = Duration::minutes(10);
/// A wake still failing this long after its first failed attempt is given up.
pub const WAKE_RETRY_FOR: Duration = Duration::minutes(30);
/// The most reason codes a pending wake keeps (distinct ones; the first kept).
pub const WAKE_REASONS_CAP: usize = 8;
/// The most people a pending wake names as having caused it.
pub const WAKE_CAUSED_BY_CAP: usize = 8;
/// The most check-ins a row keeps for learning the agent's interval.
pub const CHECKIN_MARKS_CAP: usize = 8;
/// A check-in this soon after the last kept one is part of the same run: not kept.
pub const CHECKIN_MARK_RESOLUTION: Duration = Duration::minutes(5);
/// A check-in this soon after a fire is the woken run's, not the agent's own schedule: kept, but
/// not counted when the interval is learned.
pub const WOKEN_WINDOW: Duration = Duration::minutes(10);
/// The fewest gaps between scheduled check-ins an interval is learned from.
pub const MIN_LEARNING_GAPS: usize = 2;

/// How an agent is woken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeKind {
    /// A Claude Code routine's API trigger: `POST /v1/claude_code/routines/{id}/fire`.
    ClaudeRoutine,
    /// Any HTTPS URL, for an agent hosted elsewhere.
    Webhook,
}

impl WakeKind {
    pub fn key(self) -> &'static str {
        match self {
            WakeKind::ClaudeRoutine => "claude_routine",
            WakeKind::Webhook => "webhook",
        }
    }
}

/// Why a wake was asked for: one code per kind of a person's action. The text sent to a routine
/// is built from these codes only ([`WakeReason::sentence`]), never from what the person wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeReason {
    /// A person sent a content back for a revision (`content.area_redo`).
    ContentRevision,
    /// A person asked for a new content (a production area opened, or its start moved to now).
    ContentRequested,
    /// A person answered an agent's capture request: the area goes back to the agent.
    CaptureAnswered,
    /// A person asked for a derivative of a material (`studio.material_production_request`).
    ProductionRequested,
    /// A person uploaded a file that waits for its analysis.
    MaterialUploaded,
    /// A person put a material's analysis back in the queue.
    AnalysisRetried,
    /// A person accepted a held delivery: its platform versions wait for a time.
    DeliveryAccepted,
    /// A person resumed a social account: versions waiting for a time can go out on it again.
    AccountResumed,
    /// A person opened, approved or resumed an ad campaign, which waits for its plan.
    AdCampaignOpened,
    /// A person created or reopened a research task.
    ResearchRequested,
    /// A person handed a conversation to the agent.
    ConversationHanded,
    /// A person approved the strategy, which opens the agent's standing work.
    StrategyApproved,
    /// A person pressed "run now".
    Manual,
    /// A person changed a card of the knowledge base a derivation reads.
    KnowledgeChanged,
    /// A person told the agents something to file in the knowledge base.
    KnowledgeNote,
    /// The knowledge base changed what the agents work from (a frame applied).
    KnowledgeApplied,
    /// A content a person asked for was delivered and waits for its time.
    ContentDelivered,
    /// A person connected an account that unsent posts can take.
    AccountConnected,
    /// A person resumed posting.
    PostingResumed,
}

impl WakeReason {
    pub fn key(self) -> &'static str {
        match self {
            WakeReason::ContentRevision => "content_revision",
            WakeReason::ContentRequested => "content_requested",
            WakeReason::CaptureAnswered => "capture_answered",
            WakeReason::ProductionRequested => "production_requested",
            WakeReason::MaterialUploaded => "material_uploaded",
            WakeReason::AnalysisRetried => "analysis_retried",
            WakeReason::DeliveryAccepted => "delivery_accepted",
            WakeReason::AccountResumed => "account_resumed",
            WakeReason::AdCampaignOpened => "ad_campaign_opened",
            WakeReason::ResearchRequested => "research_requested",
            WakeReason::ConversationHanded => "conversation_handed",
            WakeReason::StrategyApproved => "strategy_approved",
            WakeReason::Manual => "manual",
            WakeReason::KnowledgeChanged => "knowledge_changed",
            WakeReason::KnowledgeNote => "knowledge_note",
            WakeReason::KnowledgeApplied => "knowledge_applied",
            WakeReason::ContentDelivered => "content_delivered",
            WakeReason::AccountConnected => "account_connected",
            WakeReason::PostingResumed => "posting_resumed",
        }
    }

    /// One short neutral sentence in English for the routine's `text`. Fixed per code on
    /// purpose: the text leaves Jeeta for a third party's session log, so it carries no customer
    /// data, no names and no content; what the work is about the agent reads from Jeeta itself,
    /// with its own key, at its check-in.
    pub fn sentence(self) -> &'static str {
        match self {
            WakeReason::ContentRevision => "A person asked for a revision of a content.",
            WakeReason::ContentRequested => "A person asked for a new content.",
            WakeReason::CaptureAnswered => "A person answered a capture request.",
            WakeReason::ProductionRequested => "A person asked for a new version of a material.",
            WakeReason::MaterialUploaded => "A person uploaded a file that waits for analysis.",
            WakeReason::AnalysisRetried => "A person asked for a material to be analysed again.",
            WakeReason::DeliveryAccepted => {
                "A person accepted a delivery; its versions wait for a time."
            }
            WakeReason::AccountResumed => "A person resumed a social account.",
            WakeReason::AdCampaignOpened => {
                "A person opened an ad campaign that waits for its plan."
            }
            WakeReason::ResearchRequested => "A person created a research task.",
            WakeReason::ConversationHanded => "A person handed a conversation to the agent.",
            WakeReason::StrategyApproved => "A person approved the strategy.",
            WakeReason::Manual => "A person asked the agent to run now.",
            WakeReason::KnowledgeChanged => "A person changed the knowledge base.",
            WakeReason::KnowledgeNote => {
                "A person told the agents something to file in the knowledge base."
            }
            WakeReason::KnowledgeApplied => "The knowledge base changed what the agents work from.",
            WakeReason::ContentDelivered => "A content a person asked for is ready for its time.",
            WakeReason::AccountConnected => {
                "A person connected an account that unsent posts can take."
            }
            WakeReason::PostingResumed => {
                "A person resumed posting: posts waiting for a time can go out again."
            }
        }
    }
}

/// The closing sentence of every routine `text`.
pub const WAKE_TEXT_CLOSING: &str = "Check in now with jeeta.work.checkin and do the pending work.";

/// The `text` sent to a routine for `reasons`: one sentence per distinct reason, then
/// [`WAKE_TEXT_CLOSING`]. Far below the endpoint's 65,536 characters.
pub fn wake_text(reasons: &[WakeReason]) -> String {
    let mut out = String::new();
    let mut seen = Vec::new();
    for r in reasons {
        if !seen.contains(r) {
            seen.push(*r);
            out.push_str(r.sentence());
            out.push(' ');
        }
    }
    out.push_str(WAKE_TEXT_CLOSING);
    out
}

/// A key's wake address, as a person set it. The token or secret is not here (see the module
/// docs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WakeAddress {
    pub kind: WakeKind,
    /// The routine's id (`trig_…`), or the webhook's whole URL.
    pub target: String,
    /// Whether a token (always, for a routine) or a webhook secret is sealed beside the row.
    pub has_secret: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub set_at: OffsetDateTime,
    pub set_by: UserId,
    /// When the target refused the token (`401`, `403`, `404`), or the webhook's host stopped
    /// being public: nothing is sent until a person sets the address again.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub refused_at: Option<OffsetDateTime>,
}

/// A wake waiting to go out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingWake {
    #[serde(with = "time::serde::rfc3339")]
    pub first_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_at: OffsetDateTime,
    /// Distinct, in the order first asked, at most [`WAKE_REASONS_CAP`]. A code a later release
    /// wrote is dropped on read (`known_reasons`).
    #[serde(deserialize_with = "known_reasons::deserialize")]
    pub reasons: Vec<WakeReason>,
    /// The people whose actions asked for it, distinct, at most [`WAKE_CAUSED_BY_CAP`].
    pub caused_by: Vec<UserId>,
    /// A person pressed "run now": no settle time.
    #[serde(default)]
    pub manual: bool,
    /// Attempts that failed for the network or a `5xx`.
    #[serde(default)]
    pub failures: u32,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub first_failure_at: Option<OffsetDateTime>,
    /// Not before this (a `Retry-After`, or the backoff after a failure).
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub retry_at: Option<OffsetDateTime>,
}

/// What became of an attempt to wake an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeOutcome {
    /// The target accepted it (`2xx`).
    Fired,
    /// The target was over its limit (`429`); tried again after its `Retry-After`.
    RateLimited,
    /// The network or a `5xx`; tried again with backoff.
    Unavailable,
    /// Still failing [`WAKE_RETRY_FOR`] after the first failure: given up.
    GaveUp,
    /// The target refused the token (`401`, `403`, `404`), or the host is not public.
    Refused,
    /// The target refused the request otherwise (another `4xx`): not tried again.
    Rejected,
}

impl WakeOutcome {
    pub fn key(self) -> &'static str {
        match self {
            WakeOutcome::Fired => "fired",
            WakeOutcome::RateLimited => "rate_limited",
            WakeOutcome::Unavailable => "unavailable",
            WakeOutcome::GaveUp => "gave_up",
            WakeOutcome::Refused => "refused",
            WakeOutcome::Rejected => "rejected",
        }
    }
}

/// The last attempt to wake the agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WakeAttempt {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// A code a later release wrote is dropped on read (`known_reasons`).
    #[serde(deserialize_with = "known_reasons::deserialize")]
    pub reasons: Vec<WakeReason>,
    pub outcome: WakeOutcome,
    /// The HTTP status the target answered, when it answered.
    #[serde(default)]
    pub status: Option<u16>,
    /// The session a routine's fire created (its id and its address in claude.ai).
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_url: Option<String>,
}

/// A check-in kept for learning the agent's interval.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckinMark {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Within [`WOKEN_WINDOW`] after a fire: the woken run's, not the schedule's.
    pub woken: bool,
}

/// One key's wake state (see the module docs). A row exists once the key's agent checked in or
/// a person set an address; removing the address keeps the row (its check-ins).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentWakeRow {
    pub api_key_id: ApiKeyId,
    #[serde(default)]
    pub address: Option<WakeAddress>,
    #[serde(default)]
    pub pending: Option<PendingWake>,
    /// Counts the requests ever recorded: a check-in compares it before and after it reads its
    /// pending work, so a request recorded meanwhile is never dropped as seen.
    #[serde(default)]
    pub seq: u64,
    /// The accepted fires of the last hour, oldest first, at most [`WAKE_HOURLY_CAP`].
    #[serde(default, with = "rfc3339_vec")]
    pub fires: Vec<OffsetDateTime>,
    #[serde(default)]
    pub last: Option<WakeAttempt>,
    /// Oldest first, at most [`CHECKIN_MARKS_CAP`].
    #[serde(default)]
    pub checkins: Vec<CheckinMark>,
}

/// Why a pending wake has not gone out yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitingFor {
    /// The settle time after the last request.
    Settle,
    /// The rate limits ([`WAKE_MIN_GAP`], [`WAKE_HOURLY_CAP`]).
    Rate,
    /// A retry after a failure or a `429`.
    Retry,
}

impl AgentWakeRow {
    /// A row with nothing in it yet.
    pub fn new(api_key_id: ApiKeyId) -> AgentWakeRow {
        AgentWakeRow {
            api_key_id,
            address: None,
            pending: None,
            seq: 0,
            fires: Vec::new(),
            last: None,
            checkins: Vec::new(),
        }
    }

    /// Whether the row has an address that is not refused.
    pub fn usable(&self) -> bool {
        self.address
            .as_ref()
            .is_some_and(|a| a.refused_at.is_none())
    }

    /// The earliest time the rate limits let a fire go out (`None`: now).
    pub fn rate_free_at(&self) -> Option<OffsetDateTime> {
        let mut at = self.fires.last().map(|last| *last + WAKE_MIN_GAP);
        if self.fires.len() >= WAKE_HOURLY_CAP {
            let nth = self.fires[self.fires.len() - WAKE_HOURLY_CAP] + Duration::hours(1);
            at = Some(at.map_or(nth, |a| a.max(nth)));
        }
        at
    }

    /// When the pending wake goes out, and what it waits for until then: `None` without a
    /// pending wake or a usable address. The settle time ([`WAKE_SETTLE`] after the last request,
    /// at most [`WAKE_SETTLE_MAX`] after the first; none for "run now"), then any retry time,
    /// then the rate limits: whichever comes last.
    pub fn due(&self) -> Option<(OffsetDateTime, WaitingFor)> {
        let p = self.pending.as_ref()?;
        if !self.usable() {
            return None;
        }
        let mut due = if p.manual {
            (p.last_at, WaitingFor::Settle)
        } else {
            (
                (p.last_at + WAKE_SETTLE).min(p.first_at + WAKE_SETTLE_MAX),
                WaitingFor::Settle,
            )
        };
        if let Some(retry) = p.retry_at
            && retry > due.0
        {
            due = (retry, WaitingFor::Retry);
        }
        if let Some(free) = self.rate_free_at()
            && free > due.0
        {
            due = (free, WaitingFor::Rate);
        }
        Some(due)
    }

    /// [`AgentWakeRow::due`]'s time: what the store keeps in its `due_at` column.
    pub fn due_at(&self) -> Option<OffsetDateTime> {
        self.due().map(|(at, _)| at)
    }

    /// The interval the agent's own schedule shows, in minutes: the median gap between its
    /// scheduled (not woken) check-ins, once there are [`MIN_LEARNING_GAPS`] gaps, bounded by
    /// `min..=max`. `None` before that.
    pub fn learned_interval_minutes(&self, min: u32, max: u32) -> Option<u32> {
        let scheduled: Vec<OffsetDateTime> = self
            .checkins
            .iter()
            .filter(|c| !c.woken)
            .map(|c| c.at)
            .collect();
        let mut gaps: Vec<i64> = scheduled
            .windows(2)
            .map(|w| (w[1] - w[0]).whole_minutes())
            .filter(|m| *m > 0)
            .collect();
        if gaps.len() < MIN_LEARNING_GAPS {
            return None;
        }
        gaps.sort_unstable();
        let mid = gaps.len() / 2;
        let median = if gaps.len().is_multiple_of(2) {
            (gaps[mid - 1] + gaps[mid]) / 2
        } else {
            gaps[mid]
        };
        let median = u32::try_from(median).unwrap_or(u32::MAX);
        Some(median.clamp(min, max))
    }

    /// The last check-in of the agent's own schedule (not a woken one).
    pub fn last_scheduled_checkin(&self) -> Option<OffsetDateTime> {
        self.checkins.iter().rev().find(|c| !c.woken).map(|c| c.at)
    }

    /// Keeps a check-in at `at` when it is [`CHECKIN_MARK_RESOLUTION`] after the last kept one,
    /// marked woken when it follows an accepted fire within [`WOKEN_WINDOW`]. Whether it was
    /// kept.
    pub fn mark_checkin(&mut self, at: OffsetDateTime) -> bool {
        if self
            .checkins
            .last()
            .is_some_and(|c| at - c.at < CHECKIN_MARK_RESOLUTION)
        {
            return false;
        }
        let woken = self
            .fires
            .last()
            .is_some_and(|f| *f <= at && at - *f <= WOKEN_WINDOW);
        self.checkins.push(CheckinMark { at, woken });
        let over = self.checkins.len().saturating_sub(CHECKIN_MARKS_CAP);
        self.checkins = self.checkins.split_off(over);
        true
    }

    /// Counts an accepted fire at `at`, keeping only the last hour's, at most
    /// [`WAKE_HOURLY_CAP`].
    pub fn record_fire(&mut self, at: OffsetDateTime) {
        self.fires.retain(|f| at - *f < Duration::hours(1));
        self.fires.push(at);
        let over = self.fires.len().saturating_sub(WAKE_HOURLY_CAP);
        self.fires = self.fires.split_off(over);
    }
}

/// A stored list of [`WakeReason`] codes, read tolerantly (design 2026-11-19 "Paylaşımlar and
/// Bilgi bankası" §4.2): a code this binary does not know, one a later release added, is dropped
/// instead of failing the whole row, so a rollback to this binary still reads every wake row.
/// Only a string is a code: any other element still fails the row, as a corrupt one should.
/// Written as it is.
mod known_reasons {
    use serde::de::IntoDeserializer;
    use serde::de::value::{Error, StrDeserializer};
    use serde::{Deserialize, Deserializer};

    use super::WakeReason;

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<WakeReason>, D::Error> {
        Ok(Vec::<String>::deserialize(d)?
            .iter()
            .filter_map(|code| {
                let code: StrDeserializer<'_, Error> = code.as_str().into_deserializer();
                WakeReason::deserialize(code).ok()
            })
            .collect())
    }
}

/// `Vec<OffsetDateTime>` as RFC 3339 strings.
mod rfc3339_vec {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    pub fn serialize<S: Serializer>(v: &[OffsetDateTime], s: S) -> Result<S::Ok, S::Error> {
        let texts: Vec<String> = v
            .iter()
            .map(|t| t.format(&Rfc3339).map_err(serde::ser::Error::custom))
            .collect::<Result<_, _>>()?;
        texts.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<OffsetDateTime>, D::Error> {
        let texts = Vec::<String>::deserialize(d)?;
        texts
            .iter()
            .map(|t| OffsetDateTime::parse(t, &Rfc3339).map_err(serde::de::Error::custom))
            .collect()
    }
}

/// What a wake target answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WakeAnswer {
    /// `2xx`; a routine names the session it created.
    Fired {
        status: u16,
        session_id: Option<String>,
        session_url: Option<String>,
    },
    /// `429`, with its `Retry-After` in seconds when it gave one.
    RateLimited { retry_after: Option<Duration> },
    /// `401`, `403` or `404` (`status`), or the host is not allowed or not public (`None`).
    Refused { status: Option<u16> },
    /// Another `4xx`.
    Rejected { status: u16 },
    /// A `5xx` (`status`), or the network (`None`).
    Unavailable { status: Option<u16> },
}

/// The body a webhook wake posts: who and why, never what (no content, no personal data).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WebhookWake {
    pub workspace_id: WorkspaceId,
    /// The agent: its API key's id.
    pub agent_id: ApiKeyId,
    pub reasons: Vec<WakeReason>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// Calls a wake target. Implementations send through the egress client and never log the token,
/// the secret or the URL's query string.
#[async_trait]
pub trait AgentWaker: Send + Sync {
    /// Fires routine `routine_id` with bearer `token` and `text` as the session's first message.
    async fn fire_routine(&self, routine_id: &str, token: &str, text: &str) -> WakeAnswer;
    /// Posts `body` to `url` (HTTPS, a public host), with `secret` as a bearer token when given.
    async fn post_webhook(&self, url: &str, secret: Option<&str>, body: &WebhookWake)
    -> WakeAnswer;
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn row() -> AgentWakeRow {
        let mut r = AgentWakeRow::new(ApiKeyId::new_v7());
        r.address = Some(WakeAddress {
            kind: WakeKind::ClaudeRoutine,
            target: "trig_1".into(),
            has_secret: true,
            set_at: datetime!(2026-11-19 10:00 UTC),
            set_by: UserId::new_v7(),
            refused_at: None,
        });
        r
    }

    fn pending(first: OffsetDateTime, last: OffsetDateTime) -> PendingWake {
        PendingWake {
            first_at: first,
            last_at: last,
            reasons: vec![WakeReason::ContentRevision],
            caused_by: Vec::new(),
            manual: false,
            failures: 0,
            first_failure_at: None,
            retry_at: None,
        }
    }

    #[test]
    fn a_wake_settles_after_the_last_request_and_at_most_three_minutes_after_the_first() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = row();
        r.pending = Some(pending(t, t));
        assert_eq!(
            r.due(),
            Some((t + Duration::seconds(45), WaitingFor::Settle))
        );
        r.pending = Some(pending(t, t + Duration::seconds(30)));
        assert_eq!(r.due_at(), Some(t + Duration::seconds(75)));
        r.pending = Some(pending(t, t + Duration::seconds(170)));
        assert_eq!(r.due_at(), Some(t + Duration::minutes(3)));
    }

    #[test]
    fn the_rate_limits_hold_a_wake_back() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = row();
        r.record_fire(t);
        r.pending = Some(pending(
            t + Duration::seconds(10),
            t + Duration::seconds(10),
        ));
        assert_eq!(r.due(), Some((t + Duration::minutes(3), WaitingFor::Rate)));
        let mut r = row();
        for i in 0..20 {
            r.record_fire(t + Duration::minutes(i * 3));
        }
        r.pending = Some(pending(
            t + Duration::minutes(58),
            t + Duration::minutes(58),
        ));
        assert_eq!(r.due(), Some((t + Duration::hours(1), WaitingFor::Rate)));
    }

    #[test]
    fn a_refused_address_or_none_sends_nothing() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = row();
        r.pending = Some(pending(t, t));
        r.address.as_mut().unwrap().refused_at = Some(t);
        assert_eq!(r.due(), None);
        r.address = None;
        assert_eq!(r.due(), None);
    }

    #[test]
    fn the_interval_is_the_median_of_the_scheduled_gaps() {
        let t = datetime!(2026-11-19 08:00 UTC);
        let mut r = row();
        for h in 0..4 {
            assert!(r.mark_checkin(t + Duration::hours(h)));
        }
        // A second call of the same run is not kept.
        assert!(!r.mark_checkin(t + Duration::hours(3) + Duration::minutes(2)));
        // A woken run between two scheduled ones does not change the interval.
        r.record_fire(t + Duration::hours(3) + Duration::minutes(40));
        assert!(r.mark_checkin(t + Duration::hours(3) + Duration::minutes(42)));
        assert!(r.checkins.last().unwrap().woken);
        assert!(r.mark_checkin(t + Duration::hours(4)));
        assert_eq!(r.learned_interval_minutes(15, 10_080), Some(60));
        assert_eq!(r.last_scheduled_checkin(), Some(t + Duration::hours(4)));
        // Too few gaps: nothing learned.
        let mut r = row();
        r.mark_checkin(t);
        r.mark_checkin(t + Duration::hours(1));
        assert_eq!(r.learned_interval_minutes(15, 10_080), None);
    }

    #[test]
    fn a_reason_code_of_a_later_release_is_dropped_on_read() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut stored = serde_json::to_value(row()).unwrap();
        stored["pending"] = serde_json::to_value(pending(t, t)).unwrap();
        stored["pending"]["reasons"] =
            serde_json::json!(["a_later_reason", "content_revision", "knowledge_changed"]);
        stored["last"] = serde_json::json!({
            "at": "2026-11-19T11:00:00Z",
            "reasons": ["another_later_reason", "manual"],
            "outcome": "fired",
        });
        let read: AgentWakeRow = serde_json::from_value(stored).unwrap();
        assert_eq!(
            read.pending.unwrap().reasons,
            vec![WakeReason::ContentRevision, WakeReason::KnowledgeChanged]
        );
        assert_eq!(read.last.unwrap().reasons, vec![WakeReason::Manual]);
        // Only unknown codes: the wake still reads, with no reason.
        let mut stored = serde_json::to_value(row()).unwrap();
        stored["pending"] = serde_json::to_value(pending(t, t)).unwrap();
        stored["pending"]["reasons"] = serde_json::json!(["a_later_reason"]);
        let read: AgentWakeRow = serde_json::from_value(stored.clone()).unwrap();
        assert!(read.pending.unwrap().reasons.is_empty());
        // Only a string is a code: anything else in the list is a corrupt row, refused.
        for corrupt in [
            serde_json::json!([1]),
            serde_json::json!([null]),
            serde_json::json!(["manual", {"code": "manual"}]),
            serde_json::json!([["manual"]]),
        ] {
            stored["pending"]["reasons"] = corrupt.clone();
            assert!(
                serde_json::from_value::<AgentWakeRow>(stored.clone()).is_err(),
                "{corrupt}"
            );
        }
    }

    #[test]
    fn the_text_is_one_neutral_sentence_per_reason() {
        let text = wake_text(&[
            WakeReason::ContentRevision,
            WakeReason::ContentRevision,
            WakeReason::MaterialUploaded,
        ]);
        assert_eq!(
            text,
            "A person asked for a revision of a content. A person uploaded a file that waits \
             for analysis. Check in now with jeeta.work.checkin and do the pending work."
        );
    }
}
