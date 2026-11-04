//! An olay: the real context a material comes from (a workshop, an order, a season collection, a
//! special day, a product shoot), with its real dates, place and client (spec 2026-11-03 §4.1).
use crate::{HumanMark, OlayId, StudioError, require_id};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime, UtcOffset};
use uuid::Uuid;

/// The longest olay, in days (a season collection may run most of a year).
pub const MAX_OLAY_DAYS: i64 = 366;
/// The longest title, place and client organization, in characters.
pub const MAX_LABEL_CHARS: usize = 120;
/// The longest notes, in characters.
pub const MAX_NOTES_CHARS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OlayKind {
    /// An atölye.
    Workshop,
    /// An order or project, e.g. a 200-figure club order.
    Order,
    /// A season collection (yılbaşı, cadılar bayramı…).
    Season,
    /// A special day (Anneler Günü, 23 Nisan…).
    SpecialDay,
    ProductShoot,
    Other,
}

impl OlayKind {
    /// Whether its materials live in an occasion's calendar windows (spec D9).
    pub fn is_seasonal(self) -> bool {
        matches!(self, Self::Season | Self::SpecialDay)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OlayStatus {
    /// Created by an agent: makes no material eligible until a human confirms it (spec D3).
    Proposed,
    Confirmed,
}

/// Who the olay was for: an inbox person and/or a company or club. The person's name is read
/// from the inbox when needed, never copied here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayClient {
    #[serde(default)]
    pub person_id: Option<Uuid>,
    #[serde(default)]
    pub organization: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Olay {
    pub id: OlayId,
    pub workspace_id: WorkspaceId,
    pub kind: OlayKind,
    pub title: String,
    /// Istanbul calendar dates, both included.
    #[serde(with = "crate::time_compat::date")]
    pub starts_on: Date,
    #[serde(with = "crate::time_compat::date")]
    pub ends_on: Date,
    pub place: Option<String>,
    pub client: Option<OlayClient>,
    pub notes: String,
    /// The calendar key (`crate::CalendarEntry::key`) of a season or special day; `None` for the
    /// other kinds.
    pub occasion: Option<String>,
    pub status: OlayStatus,
    /// The human who confirmed it, and when (the olay trigger's clock, spec §14 D24).
    pub confirmed: Option<HumanMark>,
    pub revision: u64,
    #[serde(with = "crate::time_compat")]
    pub created_at: OffsetDateTime,
}

fn invalid(field: &'static str) -> StudioError {
    StudioError::InvalidMaterial(field)
}

/// A calendar or tag key: 1–40 of `[a-z0-9_]`.
pub fn valid_key(key: &str) -> bool {
    (1..=40).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `text`, trimmed, is at most `max` characters and (when `required`) not empty.
pub(crate) fn label_ok(text: &str, max: usize, required: bool) -> bool {
    let n = text.trim().chars().count();
    n <= max && (!required || n > 0) && !text.chars().any(char::is_control)
}

impl Olay {
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "olay_id")?;
        require_id(self.workspace_id.0, "workspace_id")?;
        if self.revision == 0 {
            return Err(StudioError::RevisionConflict);
        }
        if !label_ok(&self.title, MAX_LABEL_CHARS, true) {
            return Err(invalid("title"));
        }
        if self.ends_on < self.starts_on
            || (self.ends_on - self.starts_on).whole_days() >= MAX_OLAY_DAYS
        {
            return Err(invalid("dates"));
        }
        if self
            .place
            .as_deref()
            .is_some_and(|p| !label_ok(p, MAX_LABEL_CHARS, true))
        {
            return Err(invalid("place"));
        }
        if self.notes.chars().count() > MAX_NOTES_CHARS {
            return Err(invalid("notes"));
        }
        if let Some(c) = &self.client {
            let org = c.organization.as_deref();
            if (c.person_id.is_none() && org.is_none())
                || c.person_id.is_some_and(|p| p.is_nil())
                || org.is_some_and(|o| !label_ok(o, MAX_LABEL_CHARS, true))
            {
                return Err(invalid("client"));
            }
        }
        match (&self.occasion, self.kind.is_seasonal()) {
            (Some(key), true) if valid_key(key) => {}
            (None, false) => {}
            _ => return Err(invalid("occasion")),
        }
        if (self.status == OlayStatus::Confirmed) != self.confirmed.is_some()
            || self.confirmed.as_ref().is_some_and(|c| c.by.0.is_nil())
        {
            return Err(invalid("status"));
        }
        Ok(())
    }

    pub fn is_confirmed(&self) -> bool {
        self.status == OlayStatus::Confirmed
    }

    /// Whether the olay is over on Istanbul day `day`.
    pub fn has_ended(&self, day: Date) -> bool {
        day > self.ends_on
    }
}

/// The olays a material captured on Istanbul day `day` may belong to (spec §5.3): those, confirmed
/// or proposed, whose dates contain it, the one starting nearest to it first (then the shorter,
/// then by id). A suggestion only: a human chooses, nothing is bound by it.
pub fn olay_suggestions(olays: &[Olay], day: Date) -> Vec<&Olay> {
    let mut out: Vec<&Olay> = olays
        .iter()
        .filter(|o| (o.starts_on..=o.ends_on).contains(&day))
        .collect();
    out.sort_by_key(|o| (day - o.starts_on, o.ends_on - o.starts_on, o.id));
    out
}

/// The Istanbul calendar day of `at` (UTC+03 throughout the supported Studio calendar).
pub fn istanbul_day(at: OffsetDateTime) -> Date {
    at.to_offset(UtcOffset::from_hms(3, 0, 0).expect("Istanbul offset"))
        .date()
}
