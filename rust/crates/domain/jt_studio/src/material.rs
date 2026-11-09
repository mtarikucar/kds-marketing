//! A material: a real photo or video (or an AI-generated image) in the file store, with its olay
//! or `genel`, its share permission and its tags (spec 2026-11-03 §4.2).
use crate::{FileId, MaterialId, OlayId, PieceId, SlotId, StudioError, olay::label_ok, require_id};
use jt_ledger::Actor;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::{Date, Month, OffsetDateTime};
use uuid::Uuid;

/// The longest title of a material, in characters.
pub const MAX_MATERIAL_TITLE_CHARS: usize = 120;
/// The most people a material may name.
pub const MAX_MATERIAL_PEOPLE: usize = 50;
/// Maximum number of labels on a material or in one label request.
pub const MAX_MATERIAL_LABELS: usize = 32;
/// Maximum label length, counted in Unicode scalar values after normalization.
pub const MAX_MATERIAL_LABEL_CHARS: usize = 64;
/// How long a material that shows people is kept after its olay (spec D16), in months.
pub const RETENTION_MONTHS: u32 = 24;

/// `day` moved `months` calendar months on, at the month's last day when it is shorter.
pub fn add_months(day: Date, months: u32) -> Date {
    let index = i64::from(u8::from(day.month())) - 1 + i64::from(months);
    let year = day.year() + i32::try_from(index.div_euclid(12)).unwrap_or(i32::MAX);
    let month = Month::try_from(u8::try_from(index.rem_euclid(12) + 1).unwrap_or(1))
        .unwrap_or(Month::January);
    Date::from_calendar_date(year, month, day.day().min(month.length(year))).unwrap_or(Date::MAX)
}

fn invalid(field: &'static str) -> StudioError {
    StudioError::InvalidMaterial(field)
}

/// A closed tag vocabulary: each value has a stable key, its serde name.
pub trait TagKey: Sized + Copy + 'static {
    const ALL: &'static [Self];
    fn key(self) -> &'static str;
    fn parse(key: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|v| v.key() == key)
    }
}

macro_rules! tag_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $key:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $key)] $variant),+
        }
        impl TagKey for $name {
            const ALL: &'static [Self] = &[$(Self::$variant),+];
            fn key(self) -> &'static str {
                match self { $(Self::$variant => $key),+ }
            }
        }
    };
}

tag_enum!(
    /// What the material shows, by product group.
    ProductGroup {
        Figur => "figur",
        DioramaTablo => "diorama_tablo",
        AnlamliYerMaket => "anlamli_yer_maket",
        SezonUrunu => "sezon_urunu",
        Atolye => "atolye",
        Pazaryeri => "pazaryeri",
    }
);
tag_enum!(
    /// The sales door it speaks to.
    Door {
        KisiyeOzel => "kisiye_ozel",
        TopluSiparis => "toplu_siparis",
        Ortaklik => "ortaklik",
    }
);
tag_enum!(
    /// The kind of content it is.
    ContentType {
        BitmisUrun => "bitmis_urun",
        OnceSonra => "once_sonra",
        UretimBaski => "uretim_baski",
        Boyama => "boyama",
        Paketleme => "paketleme",
        TeslimTepki => "teslim_tepki",
        AtolyeAni => "atolye_ani",
    }
);
tag_enum!(
    Quality {
        Publishable => "publishable",
        NeedsCrop => "needs_crop",
        Unusable => "unusable",
    }
);
tag_enum!(
    /// What in the material needs a human's permission (spec §4.2, D5, D17).
    Depicts {
        Face => "face",
        Name => "name",
        Child => "child",
        ClientLogo => "client_logo",
        CorporateRef => "corporate_ref",
    }
);

/// AI-suggested, human-correctable tags.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tags {
    #[serde(default)]
    pub product_groups: BTreeSet<ProductGroup>,
    #[serde(default)]
    pub doors: BTreeSet<Door>,
    #[serde(default)]
    pub content_types: BTreeSet<ContentType>,
    #[serde(default)]
    pub quality: Option<Quality>,
    #[serde(default)]
    pub depicts: BTreeSet<Depicts>,
    /// Business-specific, normalized labels. Older material records have none.
    #[serde(default)]
    pub labels: BTreeSet<String>,
}

/// Normalize user or agent labels before storage. Control characters are rejected; other Unicode
/// whitespace is trimmed and collapsed, and Unicode lowercase is applied. Duplicates coalesce.
pub fn normalize_material_labels(labels: &[String]) -> Result<BTreeSet<String>, StudioError> {
    if labels.len() > MAX_MATERIAL_LABELS {
        return Err(invalid("labels"));
    }
    let mut normalized = BTreeSet::new();
    for label in labels {
        if label.chars().any(char::is_control) {
            return Err(invalid("labels"));
        }
        let value = label
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if value.is_empty() || value.chars().count() > MAX_MATERIAL_LABEL_CHARS {
            return Err(invalid("labels"));
        }
        normalized.insert(value);
    }
    Ok(normalized)
}

/// Where a material comes from; fixed at birth (spec D6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Origin {
    Real,
    AiGenerated { generator: String },
}

/// The material's real context: one olay, or explicitly genel (evergreen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Binding {
    Olay { olay_id: OlayId },
    Genel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharePermission {
    Shareable,
    NotShareable,
    /// Usable with faces and names hidden: the caption names no person or client.
    ProductOnly,
}

/// A share permission and who gave it: a human, or (`by: None`) the agent that added an AI image
/// with no `depicts` flag and no person (spec D5, D17, D38).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareDecision {
    pub permission: SharePermission,
    pub by: Option<UserId>,
    #[serde(with = "crate::time_compat")]
    pub at: OffsetDateTime,
}

/// A human's decision, with when it was taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanMark {
    pub by: UserId,
    #[serde(with = "crate::time_compat")]
    pub at: OffsetDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Material {
    pub id: MaterialId,
    pub workspace_id: WorkspaceId,
    pub file_id: FileId,
    pub mime: String,
    pub title: String,
    pub origin: Origin,
    pub binding: Binding,
    /// A human marked it "genel kullanılabilir" (spec D8).
    pub freed: Option<HumanMark>,
    pub share: Option<ShareDecision>,
    pub tags: Tags,
    /// The human who confirmed or corrected the tags last.
    pub tags_reviewed_by: Option<UserId>,
    /// The inbox persons the material shows (KVKK, spec §9).
    pub people: BTreeSet<Uuid>,
    #[serde(default, with = "crate::time_compat::option")]
    pub captured_at: Option<OffsetDateTime>,
    pub created_by: Actor,
    pub revision: u64,
    #[serde(with = "crate::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "crate::time_compat::option")]
    pub erased_at: Option<OffsetDateTime>,
}

/// A generator name: 1–40 of `[a-z0-9_.-]`.
pub fn valid_generator(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

impl Material {
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "material_id")?;
        require_id(self.workspace_id.0, "workspace_id")?;
        require_id(self.file_id.0, "file_id")?;
        if self.revision == 0 {
            return Err(StudioError::RevisionConflict);
        }
        if self.mime.trim().is_empty() {
            return Err(invalid("mime"));
        }
        if !label_ok(&self.title, MAX_MATERIAL_TITLE_CHARS, false) {
            return Err(invalid("title"));
        }
        if let Origin::AiGenerated { generator } = &self.origin
            && !valid_generator(generator)
        {
            return Err(invalid("generator"));
        }
        if let Binding::Olay { olay_id } = self.binding {
            require_id(olay_id.0, "olay_id")?;
        }
        if self.binding == Binding::Genel && !self.is_ai() && self.freed.is_none() {
            return Err(invalid("binding"));
        }
        if let Some(share) = &self.share
            && share.by.is_none()
            && (!self.is_ai() || self.needs_human_permission())
        {
            return Err(invalid("share"));
        }
        let labels: Vec<_> = self.tags.labels.iter().cloned().collect();
        if normalize_material_labels(&labels)? != self.tags.labels {
            return Err(invalid("labels"));
        }
        if self.people.len() > MAX_MATERIAL_PEOPLE || self.people.iter().any(Uuid::is_nil) {
            return Err(invalid("people"));
        }
        Ok(())
    }

    pub fn is_ai(&self) -> bool {
        matches!(self.origin, Origin::AiGenerated { .. })
    }

    /// Whether only a human may give its share permission (spec D5, D17, D38): it has a `depicts`
    /// flag, or names a person (`people`), which counts as one.
    pub fn needs_human_permission(&self) -> bool {
        !self.tags.depicts.is_empty() || !self.people.is_empty()
    }

    pub fn olay_id(&self) -> Option<OlayId> {
        match self.binding {
            Binding::Olay { olay_id } => Some(olay_id),
            Binding::Genel => None,
        }
    }

    /// Whether it is personal data (spec §9.1): it shows a face, a name or a child, or names a
    /// person.
    pub fn is_personal_data(&self) -> bool {
        !self.people.is_empty()
            || self
                .tags
                .depicts
                .iter()
                .any(|d| matches!(d, Depicts::Face | Depicts::Name | Depicts::Child))
    }

    /// The last Istanbul day a material that is personal data is kept (spec D16, §9.3):
    /// [`RETENTION_MONTHS`] after its olay's last day (`olay_end`), or after the day it was added
    /// when it has no olay (genel).
    pub fn kept_until(&self, olay_end: Option<Date>) -> Date {
        add_months(
            olay_end.unwrap_or_else(|| crate::istanbul_day(self.created_at)),
            RETENTION_MONTHS,
        )
    }

    /// Whether the retention rule erases the material at `now`: it is live, personal data, and
    /// [`Material::kept_until`] has passed.
    pub fn retention_due(&self, olay_end: Option<Date>, now: OffsetDateTime) -> bool {
        self.erased_at.is_none()
            && self.is_personal_data()
            && crate::istanbul_day(now) > self.kept_until(olay_end)
    }

    /// The material as erasure leaves it (spec §9.2): its id, file, origin and binding, and a
    /// human's freeing of it (a decision, not personal data, which a genel material needs).
    pub fn redacted(&self, at: OffsetDateTime) -> Material {
        Material {
            title: String::new(),
            share: None,
            tags: Tags::default(),
            tags_reviewed_by: None,
            people: BTreeSet::new(),
            captured_at: None,
            erased_at: Some(self.erased_at.unwrap_or(at)),
            revision: self.revision.saturating_add(1),
            ..self.clone()
        }
    }
}

/// How a material is used in a piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UseRole {
    /// The real material (or an upcoming olay's AI poster) the piece is built on.
    Anchor,
    /// A supporting visual beside an anchor.
    Support,
}

/// One material a piece revision shows (`studio_piece_materials`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PieceMaterial {
    pub piece_id: PieceId,
    pub slot_id: SlotId,
    pub revision: u64,
    pub material_id: MaterialId,
    pub role: UseRole,
}
