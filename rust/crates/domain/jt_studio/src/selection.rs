//! Studio picks real material first (spec 2026-11-03 §4.5, D1): the slot's need, the deterministic
//! choice of its anchor, and the slot brief that records it.
use crate::{
    Binding, ContentType, Door, Material, MaterialId, Olay, ProductGroup, SlotId, Subject, TagKey,
    Tags, UseContext, UseRole, check_use, istanbul_day,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::{Duration, OffsetDateTime};

/// The per-workspace materials settings (spec D18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialPolicy {
    /// Days before a season window (or an olay) Studio prepares and asks for material.
    pub lead_days: u16,
    /// Days within which Studio avoids showing the same material again.
    pub reuse_days: u16,
    /// Days after an olay ends during which its material is a recap's first choice.
    pub recap_days: u16,
}

impl Default for MaterialPolicy {
    fn default() -> Self {
        MaterialPolicy {
            lead_days: 21,
            reuse_days: 14,
            recap_days: 30,
        }
    }
}

impl MaterialPolicy {
    pub fn validate(&self) -> Result<(), crate::StudioError> {
        if self.lead_days > crate::MAX_LEAD_DAYS || self.reuse_days > 365 || self.recap_days > 365 {
            return Err(crate::StudioError::InvalidMaterial("policy"));
        }
        Ok(())
    }
}

/// The tags a slot's material must carry, from its hypothesis's segment and its arm's content type.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotNeed {
    #[serde(default)]
    pub product_groups: BTreeSet<ProductGroup>,
    #[serde(default)]
    pub doors: BTreeSet<Door>,
    #[serde(default)]
    pub content_types: BTreeSet<ContentType>,
}

impl SlotNeed {
    /// The need named by the parts of `content_type` and `segment_key` (split on `.`, `:` and `/`)
    /// that are tag keys; a strategy that names none needs no tag.
    pub fn from_keys(content_type: &str, segment_key: &str) -> SlotNeed {
        let mut need = SlotNeed::default();
        for part in [content_type, segment_key]
            .into_iter()
            .flat_map(|k| k.split(['.', ':', '/']))
            .map(str::trim)
        {
            if let Some(g) = ProductGroup::parse(part) {
                need.product_groups.insert(g);
            }
            if let Some(d) = Door::parse(part) {
                need.doors.insert(d);
            }
            if let Some(c) = ContentType::parse(part) {
                need.content_types.insert(c);
            }
        }
        need
    }

    pub fn matches(&self, tags: &Tags) -> bool {
        self.product_groups.is_subset(&tags.product_groups)
            && self.doors.is_subset(&tags.doors)
            && self.content_types.is_subset(&tags.content_types)
    }

    pub fn is_empty(&self) -> bool {
        self.product_groups.is_empty() && self.doors.is_empty() && self.content_types.is_empty()
    }
}

/// A past or planned use of a material: a publication that showed it, or a slot brief that picked
/// it, at its time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialUsage {
    pub material_id: MaterialId,
    #[serde(with = "crate::time_compat")]
    pub at: OffsetDateTime,
}

/// The planner's choice for a slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pick {
    pub material_id: MaterialId,
    pub subject: Subject,
}

/// What the planner recorded for a slot (`studio_slot_briefs`): the anchor it found and the
/// subject the content takes by default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotBrief {
    pub slot_id: SlotId,
    pub material_id: MaterialId,
    pub subject: Subject,
    pub need: SlotNeed,
    #[serde(with = "crate::time_compat")]
    pub picked_at: OffsetDateTime,
}

/// The order of a candidate (lower first): its subject's rank, whether it was used within the
/// reuse window, its last use, its freshness (newest first) and its id.
type Rank = (
    u8,
    bool,
    Option<OffsetDateTime>,
    std::cmp::Reverse<OffsetDateTime>,
    MaterialId,
);

/// The subjects material `m` can take as an anchor: its olay's own, its archive, and generic.
fn subjects(m: &Material) -> Vec<Subject> {
    match m.binding {
        Binding::Genel => vec![Subject::Generic],
        Binding::Olay { olay_id } => vec![
            Subject::Olay { olay_id },
            Subject::Archive { olay_id },
            Subject::Generic,
        ],
    }
}

/// The preference rank of using `m`'s `subject` at `cx.at` (lower first, spec §4.5).
fn rank(subject: &Subject, olays: &[Olay], cx: &UseContext<'_>, recap_days: u16) -> u8 {
    let day = istanbul_day(cx.at);
    match subject {
        Subject::Olay { olay_id } => {
            let Some(o) = olays.iter().find(|o| o.id == *olay_id) else {
                return 5;
            };
            if o.kind.is_seasonal() {
                0
            } else if !o.has_ended(day) {
                1
            } else if day - o.ends_on <= Duration::days(i64::from(recap_days)) {
                2
            } else {
                4
            }
        }
        Subject::Archive { .. } => 3,
        Subject::Generic => 5,
    }
}

/// A material a slot's piece may show at the slot's time: the subject it takes and its role.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub material_id: MaterialId,
    pub subject: Subject,
    pub role: UseRole,
    /// Whether its tags carry what the slot needs: what [`select_anchor`] asks of an anchor.
    pub matches_need: bool,
}

/// What a slot's piece may show at `cx.at` (spec §8, `studio.slot_materials`): every subject a
/// live material passes for, as an anchor or as a supporting visual, best first (the anchors
/// that match `need` in [`select_anchor`]'s order, then the other anchors, then the supporting
/// visuals); and each live material that passes for none, with its own subject's refusal (its
/// olay's, or generic for a genel one). Erased materials are left out.
pub fn rank_materials(
    need: &SlotNeed,
    materials: &[Material],
    usage: &[MaterialUsage],
    policy: &MaterialPolicy,
    cx: &UseContext<'_>,
) -> (Vec<Candidate>, Vec<(MaterialId, crate::Refusal)>) {
    let reuse = Duration::days(i64::from(policy.reuse_days));
    let mut ranked: Vec<((bool, bool, Rank), Candidate)> = Vec::new();
    let mut refused = Vec::new();
    for m in materials.iter().filter(|m| m.erased_at.is_none()) {
        let last = usage
            .iter()
            .filter(|u| u.material_id == m.id)
            .map(|u| u.at)
            .max();
        let recent = last.is_some_and(|at| (cx.at - at).abs() < reuse);
        let fresh = std::cmp::Reverse(m.captured_at.unwrap_or(m.created_at));
        let matches_need = need.matches(&m.tags);
        let mut any = false;
        for subject in subjects(m) {
            let Ok(role) = crate::classify(m, &subject, cx) else {
                continue;
            };
            any = true;
            let key = (
                role != UseRole::Anchor,
                !matches_need,
                (
                    rank(&subject, cx.olays, cx, policy.recap_days),
                    recent,
                    last,
                    fresh,
                    m.id,
                ),
            );
            ranked.push((
                key,
                Candidate {
                    material_id: m.id,
                    subject,
                    role,
                    matches_need,
                },
            ));
        }
        if !any {
            let own = match m.binding {
                Binding::Olay { olay_id } => Subject::Olay { olay_id },
                Binding::Genel => Subject::Generic,
            };
            if let Err(r) = crate::classify(m, &own, cx) {
                refused.push((m.id, r));
            }
        }
    }
    ranked.sort_by_key(|a| a.0);
    (ranked.into_iter().map(|(_, c)| c).collect(), refused)
}

/// The anchor Studio builds a slot at `cx.at` on, from `materials`, or `None` when no eligible
/// material matches `need` (spec D1: then no slot). Deterministic: rank, then not used within
/// `reuse_days`, then least recently used, then most recently captured or created, then id.
pub fn select_anchor(
    need: &SlotNeed,
    materials: &[Material],
    usage: &[MaterialUsage],
    policy: &MaterialPolicy,
    cx: &UseContext<'_>,
) -> Option<Pick> {
    let reuse = Duration::days(i64::from(policy.reuse_days));
    let mut best: Option<(Rank, Pick)> = None;
    for m in materials.iter().filter(|m| need.matches(&m.tags)) {
        let last = usage
            .iter()
            .filter(|u| u.material_id == m.id)
            .map(|u| u.at)
            .max();
        let recent = last.is_some_and(|at| (cx.at - at).abs() < reuse);
        let fresh = std::cmp::Reverse(m.captured_at.unwrap_or(m.created_at));
        for subject in subjects(m) {
            if check_use(m, UseRole::Anchor, &subject, cx).is_err() {
                continue;
            }
            let key = (
                rank(&subject, cx.olays, cx, policy.recap_days),
                recent,
                last,
                fresh,
                m.id,
            );
            if best.as_ref().is_none_or(|(k, _)| key < *k) {
                best = Some((
                    key,
                    Pick {
                        material_id: m.id,
                        subject,
                    },
                ));
            }
        }
    }
    best.map(|(_, pick)| pick)
}
