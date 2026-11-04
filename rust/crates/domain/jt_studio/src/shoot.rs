//! The çekim listesi: what Studio asks the owner to shoot or upload when it wants content but has
//! no eligible material (spec 2026-11-03 §4.6, D1, D11). Studio never borrows another olay's
//! material instead.
use crate::{OlayId, ShootRequestId, StudioError, olay::label_ok};
use jt_ledger::Actor;
use jt_strategy::HypothesisId;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime};

/// The longest request text, in characters.
pub const MAX_SHOOT_TEXT_CHARS: usize = 500;

/// Why the request exists. The system's reasons close themselves once their condition holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ShootReason {
    /// A planned position found no anchor.
    SlotUnfilled {
        hypothesis_id: HypothesisId,
        content_type: String,
    },
    /// An occasion's window opens within its lead (or is open) and nothing of it is eligible.
    SeasonAhead { occasion: String, year: i32 },
    /// An occasion of the year has no dates yet.
    SeasonDatesMissing { occasion: String, year: i32 },
    /// A confirmed olay starts within the lead and has no anchor.
    OlayUpcoming { olay_id: OlayId },
    /// Asked by a person or an agent.
    Requested,
}

impl ShootReason {
    pub fn is_system(&self) -> bool {
        !matches!(self, Self::Requested)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShootStatus {
    Open,
    Done,
    Dismissed,
}

impl ShootStatus {
    pub fn key(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Done => "done",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShootRequest {
    pub id: ShootRequestId,
    pub workspace_id: WorkspaceId,
    /// Unique per workspace: the same need asks once.
    pub key: String,
    pub reason: ShootReason,
    /// What to shoot or upload, in Turkish, for the owner.
    pub text: String,
    /// The Istanbul Monday of the week it belongs to.
    #[serde(with = "crate::time_compat::date")]
    pub week_start: Date,
    pub status: ShootStatus,
    pub created_by: Actor,
    #[serde(with = "crate::time_compat")]
    pub created_at: OffsetDateTime,
    pub resolved_by: Option<Actor>,
    #[serde(default, with = "crate::time_compat::option")]
    pub resolved_at: Option<OffsetDateTime>,
}

impl ShootRequest {
    pub fn validate(&self) -> Result<(), StudioError> {
        crate::require_id(self.id.0, "shoot_request_id")?;
        crate::require_id(self.workspace_id.0, "workspace_id")?;
        if self.key.is_empty() || self.key.len() > 240 || self.key.chars().any(char::is_control) {
            return Err(StudioError::InvalidMaterial("key"));
        }
        if !label_ok(&self.text, MAX_SHOOT_TEXT_CHARS, true) {
            return Err(StudioError::InvalidMaterial("text"));
        }
        if (self.status == ShootStatus::Open) != self.resolved_at.is_none()
            || self.resolved_at.is_some() != self.resolved_by.is_some()
        {
            return Err(StudioError::InvalidMaterial("status"));
        }
        Ok(())
    }
}

/// The key of a planned position's request, once per week.
pub fn slot_request_key(h: HypothesisId, content_type: &str, week_start: Date) -> String {
    format!("slot:{h}:{content_type}:{week_start}")
}

/// The key of an occasion's request, once per year.
pub fn season_request_key(occasion: &str, year: i32) -> String {
    format!("season:{occasion}:{year}")
}

/// The key of an upcoming olay's request.
pub fn olay_request_key(id: OlayId) -> String {
    format!("olay:{id}")
}

const MONTHS: [&str; 12] = [
    "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim",
    "Kasım", "Aralık",
];

/// `day` as Turkish text, e.g. "16 Kasım".
pub fn turkish_day(day: Date) -> String {
    format!(
        "{} {}",
        day.day(),
        MONTHS[usize::from(u8::from(day.month())) - 1]
    )
}

/// The request text for a position with no anchor: the hypothesis title and what it needs.
pub fn slot_request_text(hypothesis_title: &str, content_type: &str, need: &str) -> String {
    let need = if need.is_empty() {
        String::new()
    } else {
        format!(" ({need})")
    };
    cut(format!(
        "“{hypothesis_title}” için uygun materyal yok: {content_type}{need} fotoğraf veya video yükle."
    ))
}

/// The request text for an occasion opening on `start` with nothing eligible.
pub fn season_request_text(name: &str, start: Date) -> String {
    cut(format!(
        "{name} penceresi {} tarihinde açılıyor: bu sezona ait ürün fotoğrafı veya video yükle.",
        turkish_day(start)
    ))
}

/// The request text for an occasion of `year` with no dates.
pub fn season_dates_text(name: &str, year: i32) -> String {
    cut(format!("{name} {year} tarihlerini takvime gir."))
}

/// The request text for an olay starting on `start` with no anchor.
pub fn olay_request_text(title: &str, start: Date) -> String {
    cut(format!(
        "{} {title} için afiş veya hazırlık fotoğrafı yükle.",
        turkish_day(start)
    ))
}

fn cut(text: String) -> String {
    text.chars().take(MAX_SHOOT_TEXT_CHARS).collect()
}
