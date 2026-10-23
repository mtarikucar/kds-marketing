//! Conservative merge decisions; applying and undoing a merge belongs to the application.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::PersonId;

/// Merge-relevant person fields assembled from a person and its active identities.
/// Email and phone must already be normalized. Empty strings represent absent values.
/// Comparisons preserve supplied names and companies exactly, favoring review over data loss.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonView {
    /// Person identity.
    pub id: PersonId,
    /// Creation time, used to retain the older person and their first-touch attribution.
    pub created_at: OffsetDateTime,
    /// Number of open journeys for this person.
    pub open_journeys: u32,
    /// Current display name, or empty.
    pub display_name: String,
    /// Normalized email, or empty.
    pub email: String,
    /// Normalized phone number, or empty.
    pub phone: String,
    /// Current company, or empty.
    pub company: String,
}

/// A reason a pair needs an explicit merge decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeConflict {
    /// The combined records contain more than one open journey.
    TwoOpenJourneys,
    /// Both have nonempty, differing names.
    DisplayName,
    /// Both have nonempty, differing emails.
    Email,
    /// Both have nonempty, differing phones.
    Phone,
    /// Both have nonempty, differing companies.
    Company,
}

/// A safe automatic keeper, or the complete set of conflicts for review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeDecision {
    /// The records have at most one open journey and no conflicting populated fields.
    Auto {
        /// Older person whose first touch must be retained.
        keep: PersonId,
        /// Person to move into the keeper.
        merge: PersonId,
    },
    /// Conflicts requiring review; two open journeys must be resolved before any merge.
    Suggest(Vec<MergeConflict>),
}

/// Choose the older keeper only when no conflict exists. Equal timestamps use the lower id
/// for a stable decision independent of argument order. Inputs must be distinct same-tenant
/// people; the application checks tenant membership, permissions, and alias/erasure state.
pub fn decide_merge(a: &PersonView, b: &PersonView) -> MergeDecision {
    let mut conflicts = Vec::new();
    if a.open_journeys > 1 || b.open_journeys > 1 || (a.open_journeys == 1 && b.open_journeys == 1)
    {
        conflicts.push(MergeConflict::TwoOpenJourneys);
    }
    for (left, right, conflict) in [
        (&a.display_name, &b.display_name, MergeConflict::DisplayName),
        (&a.email, &b.email, MergeConflict::Email),
        (&a.phone, &b.phone, MergeConflict::Phone),
        (&a.company, &b.company, MergeConflict::Company),
    ] {
        if !left.is_empty() && !right.is_empty() && left != right {
            conflicts.push(conflict);
        }
    }
    if !conflicts.is_empty() {
        return MergeDecision::Suggest(conflicts);
    }
    let (keep, merge) = if (a.created_at, a.id) <= (b.created_at, b.id) {
        (a.id, b.id)
    } else {
        (b.id, a.id)
    };
    MergeDecision::Auto { keep, merge }
}
