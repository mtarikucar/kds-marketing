//! Human commission snapshots and exact integer arithmetic.

use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};

use crate::JourneyId;

/// Human approval/payment lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommissionState {
    /// No human owner was available; cannot be paid.
    NoPayee,
    /// Awaiting manager approval.
    Pending,
    /// Approved for payment.
    Approved,
    /// Paid.
    Paid,
}

/// Amount and rate captured when a journey is won.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commission {
    /// Won journey; persistence permits one commission per journey.
    pub journey_id: JourneyId,
    /// Human owner at the time of winning, or the unassigned queue.
    #[serde(default)]
    pub payee: Option<UserId>,
    /// Rounded amount in minor currency units.
    pub amount_minor: i64,
    /// ISO 4217 currency of the sale.
    pub currency: String,
    /// Snapshot rate in basis points (10,000 = 100%).
    pub rate_bp: u16,
    /// Approval/payment state.
    pub state: CommissionState,
}

/// Compute `amount_minor * rate_bp / 10000`, rounding ties to the nearest even integer.
/// Intermediate multiplication uses i128, including for negative amounts/refunds.
///
/// # Panics
/// Panics if the rounded result does not fit i64; callers must validate sale/rate bounds.
pub fn commission_for(amount_minor: i64, rate_bp: u16) -> i64 {
    let numerator = i128::from(amount_minor) * i128::from(rate_bp);
    let quotient = numerator / 10_000;
    let remainder = (numerator % 10_000).abs();
    let round_away = remainder > 5_000 || (remainder == 5_000 && quotient % 2 != 0);
    let rounded = quotient + if round_away { numerator.signum() } else { 0 };
    i64::try_from(rounded).expect("commission amount exceeds i64")
}
