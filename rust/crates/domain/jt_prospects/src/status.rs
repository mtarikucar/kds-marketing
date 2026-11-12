//! The pool's status machine (spec §3.2): one pure function decides every move; who may make
//! it (an agent promotes only qualified prospects, only a manager reopens) is the application's.

use serde::{Deserialize, Serialize};

use crate::{ContactFields, Prospect};

/// Where a prospect stands in the pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProspectStatus {
    New,
    Qualified,
    Rejected,
    /// Became an inbox person and journey; terminal in the pool.
    Promoted,
    /// The business objected (or the law says so): scrubbed, its keys only hashes.
    DoNotContact,
}

impl ProspectStatus {
    /// Every status.
    pub const ALL: &[ProspectStatus] = &[
        ProspectStatus::New,
        ProspectStatus::Qualified,
        ProspectStatus::Rejected,
        ProspectStatus::Promoted,
        ProspectStatus::DoNotContact,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            ProspectStatus::New => "new",
            ProspectStatus::Qualified => "qualified",
            ProspectStatus::Rejected => "rejected",
            ProspectStatus::Promoted => "promoted",
            ProspectStatus::DoNotContact => "do_not_contact",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<ProspectStatus> {
        ProspectStatus::ALL.iter().copied().find(|s| s.key() == key)
    }
}

/// Why a prospect was rejected; `other` needs a note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    NotIcp,
    ClosedBusiness,
    NoContactData,
    Competitor,
    AlreadyCustomer,
    Duplicate,
    Other,
}

impl RejectReason {
    /// Every reason.
    pub const ALL: &[RejectReason] = &[
        RejectReason::NotIcp,
        RejectReason::ClosedBusiness,
        RejectReason::NoContactData,
        RejectReason::Competitor,
        RejectReason::AlreadyCustomer,
        RejectReason::Duplicate,
        RejectReason::Other,
    ];

    /// The stable key.
    pub fn key(self) -> &'static str {
        match self {
            RejectReason::NotIcp => "not_icp",
            RejectReason::ClosedBusiness => "closed_business",
            RejectReason::NoContactData => "no_contact_data",
            RejectReason::Competitor => "competitor",
            RejectReason::AlreadyCustomer => "already_customer",
            RejectReason::Duplicate => "duplicate",
            RejectReason::Other => "other",
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<RejectReason> {
        RejectReason::ALL.iter().copied().find(|r| r.key() == key)
    }
}

/// Why a business is on the do-not-contact list; `other` needs a note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DncReason {
    /// The business asked not to be contacted.
    Objected,
    Legal,
    Other,
}

impl DncReason {
    /// Every reason.
    pub const ALL: &[DncReason] = &[DncReason::Objected, DncReason::Legal, DncReason::Other];

    /// The stable key.
    pub fn key(self) -> &'static str {
        match self {
            DncReason::Objected => "objected",
            DncReason::Legal => "legal",
            DncReason::Other => "other",
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<DncReason> {
        DncReason::ALL.iter().copied().find(|r| r.key() == key)
    }
}

/// A move of the status machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusEvent {
    Qualify,
    Reject { reason: RejectReason },
    Reopen,
    Promote,
    DoNotContact { reason: DncReason },
}

impl StatusEvent {
    /// The event as a refusal reads it: "a promoted prospect cannot be **rejected**".
    fn done(&self) -> &'static str {
        match self {
            StatusEvent::Qualify => "qualified",
            StatusEvent::Reject { .. } => "rejected",
            StatusEvent::Reopen => "reopened",
            StatusEvent::Promote => "promoted",
            StatusEvent::DoNotContact { .. } => "marked do_not_contact",
        }
    }
}

/// A move the table of spec §3.2 does not have; nothing is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a {from} prospect cannot be {event}")]
pub struct StatusError {
    /// The status key the prospect is in.
    pub from: &'static str,
    /// The refused event, as a past participle.
    pub event: &'static str,
}

/// The status `event` moves a `from` prospect to:
/// `new → qualified` (Qualify); `new | qualified → rejected` (Reject); `rejected → new`
/// (Reopen); `new | qualified → promoted` (Promote); `new | qualified | rejected →
/// do_not_contact` (DoNotContact). Any other pair is a [`StatusError`].
pub fn next_status(
    from: ProspectStatus,
    event: &StatusEvent,
) -> Result<ProspectStatus, StatusError> {
    use ProspectStatus::*;
    let to = match (from, event) {
        (New, StatusEvent::Qualify) => Some(Qualified),
        (New | Qualified, StatusEvent::Reject { .. }) => Some(Rejected),
        (Rejected, StatusEvent::Reopen) => Some(New),
        (New | Qualified, StatusEvent::Promote) => Some(Promoted),
        (New | Qualified | Rejected, StatusEvent::DoNotContact { .. }) => Some(DoNotContact),
        _ => None,
    };
    to.ok_or(StatusError {
        from: from.key(),
        event: event.done(),
    })
}

/// Empties what a do-not-contact prospect must not keep (spec §3.2): the business name becomes
/// `"—"`; contact fields, size, signals, notes, labels and the pages it was discovered on are
/// emptied. Ids, status, the origin's recorder and time, the decision, the score summary and the
/// coarse business facts (sector, city, district, country, language, segment) stay.
pub fn scrub_for_dnc(p: &mut Prospect) {
    p.business_name = "—".to_owned();
    p.contact = ContactFields::default();
    p.size = None;
    p.signals.clear();
    p.notes.clear();
    p.labels.clear();
    p.origin.discovered_at.clear();
}
