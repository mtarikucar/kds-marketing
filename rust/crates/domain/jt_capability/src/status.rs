//! A capability's stored status and the status it effectively has at a given time.

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::capability::Capability;

/// The status written on a capability (spec §6.1 "durum").
///
/// A missing status reads as `Declared`: the one that claims nothing.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum StoredStatus {
    /// Declared but not (or not yet) proven.
    #[default]
    Declared,
    /// Proven: by the connector's probe, or by the agent's evidence.
    Verified,
    /// The last probe or attempt failed.
    Unreachable,
    /// No longer in use; kept for the record.
    Retired,
}

impl StoredStatus {
    /// The stable key, e.g. `"unreachable"`.
    pub fn key(&self) -> &'static str {
        match self {
            StoredStatus::Declared => "declared",
            StoredStatus::Verified => "verified",
            StoredStatus::Unreachable => "unreachable",
            StoredStatus::Retired => "retired",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<StoredStatus> {
        match key {
            "declared" => Some(StoredStatus::Declared),
            "verified" => Some(StoredStatus::Verified),
            "unreachable" => Some(StoredStatus::Unreachable),
            "retired" => Some(StoredStatus::Retired),
            _ => None,
        }
    }
}

/// The status a capability has at a given time: the stored one, except that a verification older
/// than the capability's policy allows no longer counts (`Stale`). Derived, never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveStatus {
    Declared,
    /// Verified, and the verification is within the policy's age.
    Verified,
    /// Verified once, but longer ago than the policy allows: it counts as declared again (spec
    /// §6.4 "eşik aşılınca bildirildi'ye düşer") and needs a fresh verification.
    Stale,
    Unreachable,
    Retired,
}

impl EffectiveStatus {
    /// The stable key, e.g. `"stale"`.
    pub fn key(&self) -> &'static str {
        match self {
            EffectiveStatus::Declared => "declared",
            EffectiveStatus::Verified => "verified",
            EffectiveStatus::Stale => "stale",
            EffectiveStatus::Unreachable => "unreachable",
            EffectiveStatus::Retired => "retired",
        }
    }
}

/// The status `c` has at `now` (Review Focus 4):
///
/// - `Retired`, `Unreachable` and `Declared` read as stored;
/// - `Verified` stays `Verified` while `now - last_verified_at` is at most
///   `policy.verify_max_age_days` days (a verification time ahead of `now` is fresh), and turns
///   `Stale` once it is older, or when there is no verification time at all;
/// - a `verify_max_age_days` of 0 means a verification never goes stale;
/// - for a kind verified by its heartbeat (the voice bridge), the heartbeat's `stale_after` takes
///   the policy's place, 0 days included: `last_verified_at` is its last report.
pub fn effective_status(c: &Capability, now: OffsetDateTime) -> EffectiveStatus {
    match c.status {
        StoredStatus::Declared => EffectiveStatus::Declared,
        StoredStatus::Unreachable => EffectiveStatus::Unreachable,
        StoredStatus::Retired => EffectiveStatus::Retired,
        StoredStatus::Verified => {
            let max_age = match c.kind().and_then(|k| k.heartbeat()) {
                Some(beat) => beat.stale_after,
                None if c.policy.verify_max_age_days == 0 => return EffectiveStatus::Verified,
                None => Duration::days(i64::from(c.policy.verify_max_age_days)),
            };
            let fresh = c.last_verified_at.is_some_and(|at| now - at <= max_age);
            if fresh {
                EffectiveStatus::Verified
            } else {
                EffectiveStatus::Stale
            }
        }
    }
}
