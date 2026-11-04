//! Whether a material may be used, in which role, for which subject, at which time: the lock,
//! permission and time rules (spec 2026-11-03 §4.3, D7–D10). Pure and deterministic.
use crate::{
    Binding, Calendar, Material, MaterialId, Olay, OlayId, Quality, SharePermission, UseRole,
    istanbul_day,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// What a piece speaks about (spec D7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Subject {
    /// That olay: the caption may state its real date, place, name and client.
    Olay { olay_id: OlayId },
    /// A season or special-day olay of an earlier year, presented as last year's, with its year.
    Archive { olay_id: OlayId },
    /// No specific date, place or event ("atölyelerimizden bir an").
    Generic,
}

impl Subject {
    pub fn olay_id(&self) -> Option<OlayId> {
        match self {
            Self::Olay { olay_id } | Self::Archive { olay_id } => Some(*olay_id),
            Self::Generic => None,
        }
    }
}

/// Why a material may not be used: a closed code, shown to agents and, in Turkish, in the panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    Erased,
    ShareUnset,
    NotShareable,
    SensitiveNeedsHuman,
    /// `product_only` on a material that shows a face, a name or a child, or names a person:
    /// nothing hides them yet (spec D39).
    ProductOnlyShowsPerson,
    Quality,
    OlayMissing,
    OlayUnconfirmed,
    OutOfSeason,
    UseArchive,
    ArchiveNotSeason,
    NotFreed,
    OtherOlay,
    GenelGenericOnly,
    AiNotAnchor,
    AiOlayPast,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Erased => "erased",
            Self::ShareUnset => "share_unset",
            Self::NotShareable => "not_shareable",
            Self::SensitiveNeedsHuman => "sensitive_needs_human",
            Self::ProductOnlyShowsPerson => "product_only_shows_person",
            Self::Quality => "quality",
            Self::OlayMissing => "olay_missing",
            Self::OlayUnconfirmed => "olay_unconfirmed",
            Self::OutOfSeason => "out_of_season",
            Self::UseArchive => "use_archive",
            Self::ArchiveNotSeason => "archive_not_season",
            Self::NotFreed => "not_freed",
            Self::OtherOlay => "other_olay",
            Self::GenelGenericOnly => "genel_generic_only",
            Self::AiNotAnchor => "ai_not_anchor",
            Self::AiOlayPast => "ai_olay_past",
        }
    }
}

/// What the rules read besides the material: the workspace's olays and effective calendar, and
/// the time of use (the slot's time when planning or submitting, now when publishing).
#[derive(Clone, Copy, Debug)]
pub struct UseContext<'a> {
    pub at: OffsetDateTime,
    pub olays: &'a [Olay],
    pub calendar: &'a Calendar,
}

impl UseContext<'_> {
    fn olay(&self, id: OlayId) -> Option<&Olay> {
        self.olays.iter().find(|o| o.id == id)
    }
}

/// The windows of olay `o`'s occasion when it is a season or special day: its season year, and the
/// years whose window contains `day`.
fn season(o: &Olay, cx: &UseContext<'_>, day: time::Date) -> Option<(Option<i32>, Vec<i32>)> {
    o.occasion
        .as_deref()
        .filter(|_| o.kind.is_seasonal())
        .map(|key| {
            (
                cx.calendar.season_year(key, o.starts_on),
                cx.calendar.years_containing(key, day),
            )
        })
}

/// Whether material `m` may be used as `role` in a piece about `subject` (spec §4.3).
pub fn check_use(
    m: &Material,
    role: UseRole,
    subject: &Subject,
    cx: &UseContext<'_>,
) -> Result<(), Refusal> {
    if m.erased_at.is_some() {
        return Err(Refusal::Erased);
    }
    match m.share.as_ref().map(|s| s.permission) {
        None => return Err(Refusal::ShareUnset),
        Some(SharePermission::NotShareable) => return Err(Refusal::NotShareable),
        Some(SharePermission::Shareable | SharePermission::ProductOnly) => {}
    }
    if m.needs_human_permission() && m.share.as_ref().is_some_and(|s| s.by.is_none()) {
        return Err(Refusal::SensitiveNeedsHuman);
    }
    // Faces and names are hidden by nothing yet: `product_only` cannot cover a person (D39).
    if m.share
        .as_ref()
        .is_some_and(|s| s.permission == SharePermission::ProductOnly)
        && m.is_personal_data()
    {
        return Err(Refusal::ProductOnlyShowsPerson);
    }
    if m.tags.quality != Some(Quality::Publishable) {
        return Err(Refusal::Quality);
    }
    let day = istanbul_day(cx.at);
    if m.is_ai() {
        return match m.binding {
            // A supporting visual: never an anchor (spec D10).
            Binding::Genel => match role {
                UseRole::Support => Ok(()),
                UseRole::Anchor => Err(Refusal::AiNotAnchor),
            },
            Binding::Olay { olay_id } => {
                let o = cx.olay(olay_id).ok_or(Refusal::OlayMissing)?;
                if !o.is_confirmed() {
                    return Err(Refusal::OlayUnconfirmed);
                }
                if *subject != (Subject::Olay { olay_id }) {
                    return Err(Refusal::OtherOlay);
                }
                if role == UseRole::Anchor && o.has_ended(day) {
                    return Err(Refusal::AiOlayPast);
                }
                // A season's poster, as its real materials, only inside its own window (D9, D42).
                match season(o, cx, day) {
                    Some((Some(sy), years)) if !years.contains(&sy) => Err(Refusal::OutOfSeason),
                    Some((None, _)) => Err(Refusal::OutOfSeason),
                    _ => Ok(()),
                }
            }
        };
    }
    let olay_id = match m.binding {
        Binding::Genel => {
            return if *subject == Subject::Generic {
                Ok(())
            } else {
                Err(Refusal::GenelGenericOnly)
            };
        }
        Binding::Olay { olay_id } => olay_id,
    };
    let o = cx.olay(olay_id).ok_or(Refusal::OlayMissing)?;
    if !o.is_confirmed() {
        return Err(Refusal::OlayUnconfirmed);
    }
    let season = season(o, cx, day);
    match subject {
        Subject::Olay { olay_id: s } if *s == olay_id => match season {
            None => Ok(()),
            Some((Some(sy), years)) if years.contains(&sy) => Ok(()),
            Some((Some(sy), years)) if years.iter().any(|y| *y > sy) => Err(Refusal::UseArchive),
            Some(_) => Err(Refusal::OutOfSeason),
        },
        Subject::Archive { olay_id: s } if *s == olay_id => match season {
            None => Err(Refusal::ArchiveNotSeason),
            Some((Some(sy), years)) if years.iter().any(|y| *y > sy) => Ok(()),
            Some(_) => Err(Refusal::OutOfSeason),
        },
        Subject::Generic => {
            if m.freed.is_none() {
                return Err(Refusal::NotFreed);
            }
            match season {
                None => Ok(()),
                Some((Some(sy), years)) if years.iter().any(|y| *y >= sy) => Ok(()),
                Some(_) => Err(Refusal::OutOfSeason),
            }
        }
        _ => Err(Refusal::OtherOlay),
    }
}

/// The role material `m` takes in a piece about `subject`: an anchor when it may be one, else a
/// supporting visual; the refusal when it may be neither.
pub fn classify(m: &Material, subject: &Subject, cx: &UseContext<'_>) -> Result<UseRole, Refusal> {
    match check_use(m, UseRole::Anchor, subject, cx) {
        Ok(()) => Ok(UseRole::Anchor),
        Err(anchor) => match check_use(m, UseRole::Support, subject, cx) {
            Ok(()) => Ok(UseRole::Support),
            Err(_) => Err(anchor),
        },
    }
}

/// Why a piece's materials do not pass (spec §5.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PieceRefusal {
    /// Some materials are refused, each with its code.
    Refused(Vec<(MaterialId, Refusal)>),
    /// Every material passes, but none as an anchor.
    NoAnchor,
}

/// The role of each of a piece's `materials` (in order, duplicates once) about `subject`: every
/// one passes, and at least one is an anchor.
pub fn piece_roles(
    materials: &[&Material],
    subject: &Subject,
    cx: &UseContext<'_>,
) -> Result<Vec<(MaterialId, UseRole)>, PieceRefusal> {
    let mut roles: Vec<(MaterialId, UseRole)> = Vec::new();
    let mut refused = Vec::new();
    for m in materials {
        if roles.iter().any(|(id, _)| *id == m.id) || refused.iter().any(|(id, _)| *id == m.id) {
            continue;
        }
        match classify(m, subject, cx) {
            Ok(role) => roles.push((m.id, role)),
            Err(r) => refused.push((m.id, r)),
        }
    }
    if !refused.is_empty() {
        return Err(PieceRefusal::Refused(refused));
    }
    if !roles.iter().any(|(_, r)| *r == UseRole::Anchor) {
        return Err(PieceRefusal::NoAnchor);
    }
    Ok(roles)
}
