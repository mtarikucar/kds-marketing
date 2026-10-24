//! Fixed Istanbul calendar positions; randomness is supplied by the caller, never trends.
use crate::{Arm, ArmId, StudioError};
use jt_capability::CapabilityId;
use jt_strategy::{ChannelChoice, HypothesisCadence, HypothesisId, LaneKind};
use time::{Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct LearningPolicy {
    pub exploration_bps: u16,
}
#[derive(Clone, Debug)]
pub struct PlanningAccount {
    pub capability_id: CapabilityId,
    pub channel: String,
    pub group_ids: Vec<Uuid>,
    /// Only accounts with a supported, connected operation enter this list.
    pub lane: LaneKind,
}
#[derive(Clone, Debug)]
pub struct PlanningLane {
    pub hypothesis_id: HypothesisId,
    pub lane: LaneKind,
    pub channel: String,
    pub cadence: HypothesisCadence,
}
#[derive(Clone, Debug)]
pub struct ExistingPosition {
    pub hypothesis_id: HypothesisId,
    pub lane: LaneKind,
    pub week_start: OffsetDateTime,
    pub ordinal: u16,
    pub arm_id: ArmId,
}
#[derive(Clone, Debug)]
pub struct PlanningInput {
    pub now: OffsetDateTime,
    pub lanes: Vec<PlanningLane>,
    pub selected_channels: Vec<ChannelChoice>,
    pub paid_enabled: bool,
    pub accounts: Vec<PlanningAccount>,
    pub arms: Vec<Arm>,
    /// Includes past and retired positions: cancellation must never recreate a position.
    pub existing: Vec<ExistingPosition>,
    /// Display context only; deliberately not read by selection or quotas.
    pub trends: Vec<crate::TrendSignal>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedSlot {
    pub arm_id: ArmId,
    pub capability_id: CapabilityId,
    pub scheduled_at: OffsetDateTime,
    pub ordinal: u16,
}
/// Istanbul has used UTC+03 throughout the supported Studio calendar (2016 onward).
pub fn istanbul_week_start(now: OffsetDateTime) -> OffsetDateTime {
    let local = now.to_offset(UtcOffset::from_hms(3, 0, 0).expect("Istanbul offset"));
    (local.date() - Duration::days(i64::from(local.weekday().number_days_from_monday())))
        .midnight()
        .assume_offset(local.offset())
        .to_offset(UtcOffset::UTC)
}
fn invalid(reason: &'static str) -> StudioError {
    StudioError::InvalidPlanning(reason)
}
fn draw_valid(v: f64) -> bool {
    v.is_finite() && (0.0..1.0).contains(&v)
}
/// `samples` contains one injected Beta(alpha,beta) sample per eligible arm, in input order.
pub fn select_arm(
    arms: &[Arm],
    samples: &[f64],
    explore_draw: f64,
    uniform_draw: f64,
    policy: &LearningPolicy,
) -> Result<ArmId, StudioError> {
    if arms.is_empty()
        || arms.len() != samples.len()
        || policy.exploration_bps > 10000
        || !draw_valid(explore_draw)
        || !draw_valid(uniform_draw)
        || samples
            .iter()
            .any(|x| !x.is_finite() || !(0.0..=1.0).contains(x))
    {
        return Err(StudioError::InvalidLearning);
    }
    for a in arms {
        a.validate()?;
    }
    let mut order: Vec<usize> = (0..arms.len()).collect();
    order.sort_by_key(|&i| arms[i].id);
    if explore_draw < f64::from(policy.exploration_bps) / 10000.0 {
        return Ok(arms[order[(uniform_draw * order.len() as f64) as usize]].id);
    }
    let mut best = order[0];
    for i in order {
        if samples[i] > samples[best] {
            best = i;
        }
    }
    Ok(arms[best].id)
}
/// Integer bounds are validated independently of account availability, including proposals.
pub fn integer_quotas(c: &HypothesisCadence) -> Result<Vec<(String, u16, u16)>, StudioError> {
    c.validate().map_err(invalid)?;
    let n = u32::from(c.slots_per_week);
    let mut bounds: Vec<_> = c
        .content_types
        .iter()
        .map(|s| {
            (
                s.key.clone(),
                (n * u32::from(s.min_bps)).div_ceil(10000) as u16,
                (n * u32::from(s.max_bps) / 10000) as u16,
            )
        })
        .collect();
    if bounds.iter().any(|(_, min, max)| min > max)
        || bounds
            .iter()
            .map(|(_, min, _)| u32::from(*min))
            .sum::<u32>()
            > n
        || bounds
            .iter()
            .map(|(_, _, max)| u32::from(*max))
            .sum::<u32>()
            < n
    {
        return Err(invalid("infeasible integer content type quotas"));
    }
    bounds.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(bounds)
}
/// Bounded largest-remainder allocation after reserving minima and existing positions.
fn allocate(
    c: &HypothesisCadence,
    arms: &[Arm],
    existing: &[&ExistingPosition],
    all_arms: &[Arm],
) -> Result<Vec<(String, u16)>, StudioError> {
    let bounds = integer_quotas(c)?;
    let mut counts = Vec::new();
    let mut maxima = Vec::new();
    let mut weights = Vec::new();
    for (key, min, max) in &bounds {
        let used = existing
            .iter()
            .filter(|e| {
                all_arms
                    .iter()
                    .any(|a| a.id == e.arm_id && a.key.content_type == *key)
            })
            .count() as u16;
        let eligible: Vec<_> = arms.iter().filter(|a| a.key.content_type == *key).collect();
        let max = if eligible.is_empty() { used } else { *max };
        let count = (*min).max(used);
        if count > max {
            return Err(invalid("content quota has no eligible arm or was exceeded"));
        }
        counts.push(count);
        maxima.push(max);
        weights.push(if eligible.is_empty() {
            0.0
        } else {
            eligible
                .iter()
                .map(|a| a.alpha / (a.alpha + a.beta))
                .sum::<f64>()
                / eligible.len() as f64
        });
    }
    let used: u32 = counts.iter().map(|n| u32::from(*n)).sum();
    if used > u32::from(c.slots_per_week) {
        return Err(invalid("existing positions exceed content quotas"));
    }
    let mut left = u32::from(c.slots_per_week) - used;
    while left > 0 {
        let eligible: Vec<_> = (0..counts.len())
            .filter(|&i| counts[i] < maxima[i])
            .collect();
        if eligible.is_empty() {
            return Err(invalid("content quotas cannot fill the week"));
        }
        let weight: f64 = eligible.iter().map(|&i| weights[i]).sum();
        let mut remainders = Vec::new();
        let before = left;
        for &i in &eligible {
            let exact = f64::from(before) * weights[i] / weight;
            let floor = (exact.floor() as u32).min(u32::from(maxima[i] - counts[i]));
            counts[i] += floor as u16;
            left -= floor;
            remainders.push((i, exact - exact.floor()));
        }
        remainders.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        for (i, _) in remainders {
            if left > 0 && counts[i] < maxima[i] {
                counts[i] += 1;
                left -= 1;
            }
        }
    }
    for e in existing {
        let a = all_arms
            .iter()
            .find(|a| a.id == e.arm_id)
            .ok_or_else(|| invalid("existing arm missing"))?;
        let i = bounds
            .iter()
            .position(|b| b.0 == a.key.content_type)
            .ok_or_else(|| invalid("existing content type removed"))?;
        counts[i] = counts[i]
            .checked_sub(1)
            .ok_or_else(|| invalid("existing quota exceeded"))?;
    }
    Ok(bounds
        .into_iter()
        .zip(counts)
        .map(|((k, _, _), n)| (k, n))
        .collect())
}
/// Draw layout: for each lane, then each of two weeks, then each ordinal: one sample per
/// input arm followed by exploration and uniform draws. Even missed/existing positions consume
/// draws, keeping fixtures independent of the rolling window. No overdue position is emitted.
pub fn plan_week(
    input: &PlanningInput,
    random_draws: &[f64],
) -> Result<Vec<PlannedSlot>, StudioError> {
    let start = istanbul_week_start(input.now);
    let until = input.now + Duration::days(7);
    let mut cursor = 0;
    let mut result = Vec::new();
    for lane in &input.lanes {
        integer_quotas(&lane.cadence)?;
        if lane.cadence.slots_per_week == 0 || (lane.lane == LaneKind::Paid && !input.paid_enabled)
        {
            continue;
        }
        let mut accounts: Vec<_> = input
            .accounts
            .iter()
            .filter(|a| {
                a.lane == lane.lane
                    && (lane.channel == "any" || lane.channel == a.channel)
                    && input.selected_channels.iter().any(|s| {
                        (s.channel == "any" || s.channel == a.channel)
                            && s.group_id.is_none_or(|g| a.group_ids.contains(&g))
                    })
            })
            .collect();
        accounts.sort_by_key(|a| a.capability_id);
        if accounts.is_empty() {
            continue;
        }
        let eligible: Vec<Arm> = input
            .arms
            .iter()
            .filter(|a| {
                a.key.hypothesis_id == lane.hypothesis_id
                    && a.key.lane == lane.lane
                    && accounts.iter().any(|c| c.channel == a.key.channel)
            })
            .cloned()
            .collect();
        for week in [start, start + Duration::days(7)] {
            let existing: Vec<_> = input
                .existing
                .iter()
                .filter(|e| {
                    e.hypothesis_id == lane.hypothesis_id
                        && e.lane == lane.lane
                        && e.week_start == week
                })
                .collect();
            let mut quotas = allocate(&lane.cadence, &eligible, &existing, &input.arms)?;
            for ordinal in 0..lane.cadence.slots_per_week {
                let width = input.arms.len() + 2;
                let draws = random_draws
                    .get(cursor..cursor + width)
                    .ok_or_else(|| invalid("not enough injected draws"))?;
                cursor += width;
                if existing.iter().any(|e| e.ordinal == ordinal) {
                    continue;
                }
                let kind = quotas
                    .iter_mut()
                    .find(|(_, n)| *n > 0)
                    .ok_or_else(|| invalid("quota exhausted"))?;
                kind.1 -= 1;
                let arms: Vec<_> = eligible
                    .iter()
                    .filter(|a| a.key.content_type == kind.0)
                    .cloned()
                    .collect();
                let samples: Vec<_> = arms
                    .iter()
                    .map(|a| {
                        draws[input
                            .arms
                            .iter()
                            .position(|x| x.id == a.id)
                            .expect("eligible arm")]
                    })
                    .collect();
                let arm_id = select_arm(
                    &arms,
                    &samples,
                    draws[width - 2],
                    draws[width - 1],
                    &LearningPolicy {
                        exploration_bps: lane.cadence.exploration_bps,
                    },
                )?;
                let at = week
                    + Duration::seconds(
                        i64::from(ordinal) * 604800 / i64::from(lane.cadence.slots_per_week),
                    );
                if at < input.now || at >= until {
                    continue;
                }
                let arm = arms.iter().find(|a| a.id == arm_id).expect("selected arm");
                let account = accounts
                    .iter()
                    .find(|a| a.channel == arm.key.channel)
                    .expect("eligible account");
                result.push(PlannedSlot {
                    arm_id,
                    capability_id: account.capability_id,
                    scheduled_at: at,
                    ordinal,
                });
            }
        }
    }
    result.sort_by_key(|s| (s.scheduled_at, s.arm_id, s.capability_id));
    Ok(result)
}
