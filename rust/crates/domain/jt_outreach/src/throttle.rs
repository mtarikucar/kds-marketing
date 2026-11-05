//! Sending budgets (spec §3.11, D15). The numbers are product defaults the owner can change
//! (spec §15 Q2), not provider facts: a mailbox sends at most [`MAILBOX_DAY_CEILING`] outreach
//! emails a local day, fewer while it warms up; a recipient domain gets at most
//! [`DOMAIN_PER_HOUR`] an hour from one mailbox; a person at most one outreach email in 3 days
//! and 4 in 30 across campaigns; a campaign pauses itself on bounces or complaints.

use serde::{Deserialize, Serialize};
use time::{Date, Duration, OffsetDateTime};

use crate::{PauseReason, SendOutcome};

/// The most outreach emails one mailbox sends in a local day, whatever its own cap.
pub const MAILBOX_DAY_CEILING: u32 = 500;
/// The most outreach emails to one recipient domain an hour, per mailbox.
pub const DOMAIN_PER_HOUR: u32 = 5;
/// How long a send to a domain at its hourly limit waits.
pub const DOMAIN_POSTPONE: Duration = Duration::minutes(20);
/// A mailbox idle longer than this many days warms up from the start again.
pub const WARMUP_IDLE_DAYS: i64 = 30;
/// The bounce rate is over the newest this many sends.
pub const BOUNCE_WINDOW: usize = 50;
/// More than this percent of [`BOUNCE_WINDOW`] sends bounced pauses the campaign.
const BOUNCE_PERCENT: usize = 5;
/// Complaints are counted over the newest this many sends.
pub const COMPLAINT_WINDOW: usize = 200;
/// This many complaints in [`COMPLAINT_WINDOW`] sends pause the campaign.
pub const COMPLAINT_LIMIT: usize = 2;

/// A new mailbox's daily outreach cap grows from `start` by `step` a sending day up to `max`.
/// Stored inside the outreach policy and read key by key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WarmupPolicy {
    /// A person may turn warm-up off for an established mailbox.
    pub enabled: bool,
    pub start: u16,
    pub step: u16,
    pub max: u16,
}

impl Default for WarmupPolicy {
    fn default() -> Self {
        WarmupPolicy {
            enabled: true,
            start: 20,
            step: 10,
            max: 150,
        }
    }
}

/// The warm-up cap on the mailbox's `day_index`-th sending day: `min(start + step × day_index,
/// max)`, or `u32::MAX` while warm-up is off.
pub fn warmup_cap(p: &WarmupPolicy, day_index: u32) -> u32 {
    if !p.enabled {
        return u32::MAX;
    }
    let grown = u64::from(p.start) + u64::from(p.step) * u64::from(day_index);
    u32::try_from(grown.min(u64::from(p.max))).unwrap_or(u32::MAX)
}

/// How many earlier local days (before `today`) the mailbox sent outreach on, counted back from
/// `today` while no gap between two such days (or between the latest and `today`) exceeds
/// [`WARMUP_IDLE_DAYS`]: a mailbox idle that long starts again at 0.
pub fn warmup_day_index(send_days: &[Date], today: Date) -> u32 {
    let mut days: Vec<Date> = send_days.iter().copied().filter(|d| *d < today).collect();
    days.sort_unstable_by(|a, b| b.cmp(a));
    days.dedup();
    let mut count = 0;
    let mut later = today;
    for d in days {
        if (later - d).whole_days() > WARMUP_IDLE_DAYS {
            break;
        }
        count += 1;
        later = d;
    }
    count
}

/// How often one person may get outreach email, across campaigns. Stored inside the outreach
/// policy and read key by key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Frequency {
    /// Days after a send before the next.
    pub min_gap_days: u16,
    /// Sends in any 30 days (at least 1 counts).
    pub max_per_30_days: u16,
}

impl Default for Frequency {
    fn default() -> Self {
        Frequency {
            min_gap_days: 3,
            max_per_30_days: 4,
        }
    }
}

/// When the person may next get outreach email given their earlier `sends` (any order, any
/// campaign): `None` when now is fine, else the first moment both rules hold — `min_gap_days`
/// after the latest send, and fewer than `max_per_30_days` sends in `(t - 30 days, t]`.
pub fn frequency_next_allowed(
    f: &Frequency,
    sends: &[OffsetDateTime],
    now: OffsetDateTime,
) -> Option<OffsetDateTime> {
    let mut sends = sends.to_vec();
    sends.sort_unstable();
    let mut next = now;
    if let Some(last) = sends.last() {
        next = next.max(*last + Duration::days(i64::from(f.min_gap_days)));
    }
    let window = Duration::days(30);
    let max = usize::from(f.max_per_30_days.max(1));
    let recent: Vec<OffsetDateTime> = sends.into_iter().filter(|s| *s > now - window).collect();
    if recent.len() >= max {
        next = next.max(recent[recent.len() - max] + window);
    }
    (next > now).then_some(next)
}

/// What one dispatch run of one campaign may send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BudgetInput {
    /// The mailbox capability's own `daily_ops_cap`.
    pub mailbox_daily_ops_cap: Option<u32>,
    /// [`warmup_cap`] for the mailbox today.
    pub warmup_cap: u32,
    /// Outreach sends of the mailbox this local day.
    pub mailbox_sent_today: u32,
    pub per_day: u16,
    pub campaign_sent_today: u32,
    pub per_hour: u16,
    /// The campaign's sends in the last 60 minutes.
    pub campaign_sent_last_hour: u32,
}

/// The smallest remainder: the mailbox's day (its cap, the warm-up cap and
/// [`MAILBOX_DAY_CEILING`], less today's sends), the campaign's day and hour, and the
/// per-minute pacing `⌈per_hour / 60⌉` (the dispatcher runs every minute).
pub fn budget(b: &BudgetInput) -> u32 {
    let mailbox_cap = b
        .mailbox_daily_ops_cap
        .unwrap_or(u32::MAX)
        .min(b.warmup_cap)
        .min(MAILBOX_DAY_CEILING);
    let mailbox = mailbox_cap.saturating_sub(b.mailbox_sent_today);
    let day = u32::from(b.per_day).saturating_sub(b.campaign_sent_today);
    let hour = u32::from(b.per_hour).saturating_sub(b.campaign_sent_last_hour);
    let pace = u32::from(b.per_hour).div_ceil(60);
    mailbox.min(day).min(hour).min(pace)
}

/// Whether one more send to a domain fits the mailbox's hour, given its sends there in the last
/// 60 minutes.
pub fn domain_ok(sent_last_hour: u32) -> bool {
    sent_last_hour < DOMAIN_PER_HOUR
}

/// Whether a campaign pauses itself, from its newest send outcomes first: more than 5 % hard
/// bounces among the newest [`BOUNCE_WINDOW`] sends (3 of 50; fewer sends count against 50),
/// or [`COMPLAINT_LIMIT`] complaints among the newest [`COMPLAINT_WINDOW`]. Only outcomes that
/// [`SendOutcome::left_the_mailbox`] are sends.
pub fn auto_pause(newest_first: &[SendOutcome]) -> Option<PauseReason> {
    let sends: Vec<SendOutcome> = newest_first
        .iter()
        .copied()
        .filter(|o| o.left_the_mailbox())
        .collect();
    let bounces = sends
        .iter()
        .take(BOUNCE_WINDOW)
        .filter(|o| **o == SendOutcome::Bounced)
        .count();
    if bounces * 100 > BOUNCE_PERCENT * BOUNCE_WINDOW {
        return Some(PauseReason::BounceRate);
    }
    let complaints = sends
        .iter()
        .take(COMPLAINT_WINDOW)
        .filter(|o| **o == SendOutcome::Complained)
        .count();
    (complaints >= COMPLAINT_LIMIT).then_some(PauseReason::Complaints)
}
