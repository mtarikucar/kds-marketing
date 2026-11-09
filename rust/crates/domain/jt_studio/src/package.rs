//! Olay-driven publishing's records (spec 2026-11-03 §14, D20, D23–D26, D31): the package
//! requests the triggers write for agents, the planned post a slot carries, and what each format
//! earned per olay kind and hypothesis. Pure; the application stores and fills them.
use crate::{
    Material, MaterialId, OlayId, OlayKind, PackageRequestId, PostFormat, RetirementReason, SlotId,
    StudioError, Subject, require_id, supported_formats,
};
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use time::{Date, Duration, OffsetDateTime};

/// How long an open package request waits for an answer (spec §14.2).
pub const PACKAGE_REQUEST_DAYS: i64 = 7;
/// The most posts one package may hold.
pub const MAX_PACKAGE_POSTS: usize = 50;
/// The most materials one request lists.
pub const MAX_PACKAGE_MATERIALS: usize = 200;
/// The most media one post carries (a carousel's ten).
pub const MAX_POST_MATERIALS: usize = 10;

/// The organic kinds whose formats [`format_scores`] ranks.
const ORGANIC_KINDS: &[&str] = &[
    "instagram",
    "facebook_page",
    "x",
    "linkedin_member",
    "linkedin_page",
    "tiktok",
];

/// What wrote a package request (spec D23).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageTrigger {
    /// An olay gained confirmed, eligible materials (spec D24).
    Olay,
    /// An occasion's window is within its lead (spec D25).
    Calendar,
    /// A channel went `floor_days` without a feed post (spec D26).
    Floor,
    /// A production workspace output deliberately scheduled by its owner or delegated agent.
    Project,
}

impl PackageTrigger {
    pub fn key(self) -> &'static str {
        match self {
            Self::Olay => "olay",
            Self::Calendar => "calendar",
            Self::Floor => "floor",
            Self::Project => "project",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageStatus {
    /// Waiting for an agent's package (`studio.posts_propose`).
    Open,
    /// A valid package was materialized for it.
    Answered,
    /// Nobody answered it within [`PACKAGE_REQUEST_DAYS`].
    Expired,
}

impl PackageStatus {
    pub fn key(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Answered => "answered",
            Self::Expired => "expired",
        }
    }
}

/// How one format did for an olay kind (spec D31): the mean reward of its measured posts, `None`
/// with no measured post.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormatScore {
    pub format: PostFormat,
    pub mean: Option<f64>,
    pub posts: u32,
}

/// What a request suggests beyond its materials.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PackageHints {
    /// The most posts the package may hold (the floor's one); `None`: only the caps limit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_posts: Option<u16>,
    /// The subject the posts speak about by default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<Subject>,
    /// The hypothesis and content type the floor chose by the arms' posterior mean (spec D31).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypothesis_id: Option<HypothesisId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// The occasion's window, for a calendar request: posts about it belong inside.
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "crate::time_compat::date_option"
    )]
    pub window_start: Option<Date>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "crate::time_compat::date_option"
    )]
    pub window_end: Option<Date>,
}

/// A work item for agents: plan posts from these materials (spec D23, `studio_package_requests`).
/// It never creates a post; `studio.posts_propose` answers it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PackageRequest {
    pub id: PackageRequestId,
    pub workspace_id: WorkspaceId,
    /// Unique per workspace: `olay:{id}:{last change}`, `calendar:{key}:{year}` or
    /// `floor:{capability}:{day}`.
    pub key: String,
    pub trigger: PackageTrigger,
    pub status: PackageStatus,
    /// The olay it is about: the olay trigger's, the calendar's confirmed olay.
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    /// The calendar occasion and its season year (calendar trigger).
    #[serde(default)]
    pub occasion: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    /// The channel a floor request is for; the others may take any channel.
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
    /// The materials to build on, in order.
    pub material_ids: Vec<MaterialId>,
    /// The formats, best first, for the request's olay kind (generic for none).
    pub best_formats: Vec<FormatScore>,
    pub hints: PackageHints,
    #[serde(with = "crate::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "crate::time_compat::option")]
    pub answered_at: Option<OffsetDateTime>,
    /// When it expired.
    #[serde(default, with = "crate::time_compat::option")]
    pub closed_at: Option<OffsetDateTime>,
}

fn invalid(field: &'static str) -> StudioError {
    StudioError::InvalidPlanning(field)
}

fn distinct<T: Ord>(items: &[T]) -> bool {
    items.iter().collect::<BTreeSet<_>>().len() == items.len()
}

impl PackageRequest {
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "package_request_id")?;
        require_id(self.workspace_id.0, "workspace_id")?;
        if self.key.is_empty() || self.key.len() > 240 || self.key.chars().any(char::is_control) {
            return Err(invalid("package_request.key"));
        }
        let fields_ok = match self.trigger {
            PackageTrigger::Olay => self.olay_id.is_some() && self.occasion.is_none(),
            PackageTrigger::Calendar => {
                self.olay_id.is_some() && self.occasion.is_some() && self.year.is_some()
            }
            PackageTrigger::Floor => {
                self.capability_id.is_some() && self.hints.max_posts == Some(1)
            }
            PackageTrigger::Project => {
                self.key.starts_with("project:")
                    && self.olay_id.is_none()
                    && self.occasion.is_none()
                    && self.year.is_none()
                    && self.capability_id.is_some()
                    && self.hints.max_posts == Some(1)
                    && self.hints.subject == Some(crate::Subject::Generic)
            }
        };
        if !fields_ok {
            return Err(invalid("package_request.trigger"));
        }
        if self.material_ids.is_empty()
            || self.material_ids.len() > MAX_PACKAGE_MATERIALS
            || !distinct(&self.material_ids)
        {
            return Err(invalid("package_request.material_ids"));
        }
        let status_ok = match self.status {
            PackageStatus::Open => self.answered_at.is_none() && self.closed_at.is_none(),
            PackageStatus::Answered => self.answered_at.is_some() && self.closed_at.is_none(),
            PackageStatus::Expired => self.answered_at.is_none() && self.closed_at.is_some(),
        };
        if !status_ok {
            return Err(invalid("package_request.status"));
        }
        Ok(())
    }

    /// When an open request expires.
    pub fn expires_at(&self) -> OffsetDateTime {
        self.created_at + Duration::days(PACKAGE_REQUEST_DAYS)
    }

    /// Whether a package for it may post on `capability`: a floor request on its own channel only.
    pub fn covers(&self, capability: CapabilityId) -> bool {
        self.capability_id.is_none_or(|c| c == capability)
    }
}

/// The key of an olay's request listing `materials` (spec D48): the olay, how many requests of
/// it were written before (`earlier`, so an expired request's materials may be asked for again)
/// and a digest of the listed set (FNV-1a over the sorted ids), so two sets never share a key,
/// whatever times their changes carry.
pub fn olay_package_key(olay: OlayId, earlier: usize, materials: &[MaterialId]) -> String {
    let mut ids: Vec<MaterialId> = materials.to_vec();
    ids.sort();
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    for id in &ids {
        for byte in id.0.as_bytes() {
            digest ^= u64::from(*byte);
            digest = digest.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("olay:{olay}:{earlier}:{digest:016x}")
}

/// The key of an occasion's request, once per season year.
pub fn calendar_package_key(occasion: &str, year: i32) -> String {
    format!("calendar:{occasion}:{year}")
}

/// The key of a channel's floor request on local day `day`.
pub fn floor_package_key(capability: CapabilityId, day: Date) -> String {
    format!("floor:{capability}:{day}")
}

/// When a material last changed in a way the olay trigger waits on (spec D24): it was added, or
/// its share permission was set.
pub fn material_changed_at(m: &Material) -> OffsetDateTime {
    m.share
        .as_ref()
        .map_or(m.created_at, |s| s.at.max(m.created_at))
}

/// Why and when a planned post's slot was retired.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostRetirement {
    pub reason: RetirementReason,
    #[serde(with = "crate::time_compat")]
    pub at: OffsetDateTime,
}

/// A slot's planned post (spec D20, `studio_posts`): the slot keeps the chain, the channel, the
/// time (`scheduled_at = publish_at`) and the state; this keeps the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedPost {
    pub slot_id: SlotId,
    pub workspace_id: WorkspaceId,
    pub format: PostFormat,
    pub capability_id: CapabilityId,
    #[serde(with = "crate::time_compat")]
    pub publish_at: OffsetDateTime,
    /// When it enters the agent's pending work (`publish_at − lead(format)`).
    #[serde(with = "crate::time_compat")]
    pub prep_start_at: OffsetDateTime,
    /// Until when it may still go out (`publish_at + grace(format)`).
    #[serde(with = "crate::time_compat")]
    pub grace_until: OffsetDateTime,
    /// Its olay: its subject's (none for a generic post).
    pub olay_id: Option<OlayId>,
    pub package_request_id: PackageRequestId,
    /// The materials it was planned with, in order.
    pub material_ids: Vec<MaterialId>,
    pub subject: Subject,
    pub hypothesis_id: HypothesisId,
    /// The arm's content type: one its hypothesis's organic cadence names.
    pub content_type: String,
    /// Set once, when its slot is retired.
    #[serde(default)]
    pub retired: Option<PostRetirement>,
    #[serde(with = "crate::time_compat")]
    pub created_at: OffsetDateTime,
}

impl PlannedPost {
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.slot_id.0, "slot_id")?;
        require_id(self.workspace_id.0, "workspace_id")?;
        require_id(self.capability_id.0, "capability_id")?;
        require_id(self.package_request_id.0, "package_request_id")?;
        require_id(self.hypothesis_id.0, "hypothesis_id")?;
        if self.prep_start_at > self.publish_at || self.grace_until < self.publish_at {
            return Err(invalid("post.times"));
        }
        if self.olay_id != self.subject.olay_id() {
            return Err(invalid("post.olay_id"));
        }
        if self.material_ids.is_empty()
            || self.material_ids.len() > MAX_POST_MATERIALS
            || !distinct(&self.material_ids)
        {
            return Err(invalid("post.material_ids"));
        }
        if self.content_type.trim().is_empty() || self.content_type.len() > 200 {
            return Err(invalid("post.content_type"));
        }
        Ok(())
    }
}

/// One measured post (spec D31): its format, its olay's kind (`None` for a generic post), its
/// hypothesis and its reward (`observations`' value, 0 to 1).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PostOutcome {
    pub format: PostFormat,
    pub olay_kind: Option<OlayKind>,
    pub hypothesis_id: HypothesisId,
    pub reward: f64,
}

/// What one format earned for one olay kind under one hypothesis (spec D31).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PostScore {
    pub format: PostFormat,
    pub olay_kind: Option<OlayKind>,
    pub hypothesis_id: HypothesisId,
    pub mean: f64,
    pub posts: u32,
}

fn finite_rewards<'a>(outcomes: &'a [PostOutcome]) -> impl Iterator<Item = &'a PostOutcome> + 'a {
    outcomes
        .iter()
        .filter(|o| o.reward.is_finite() && (0.0..=1.0).contains(&o.reward))
}

/// The mean reward per format × olay kind × hypothesis, in that order.
pub fn post_scores(outcomes: &[PostOutcome]) -> Vec<PostScore> {
    let mut sums: BTreeMap<(PostFormat, Option<OlayKind>, HypothesisId), (f64, u32)> =
        BTreeMap::new();
    for o in finite_rewards(outcomes) {
        let e = sums
            .entry((o.format, o.olay_kind, o.hypothesis_id))
            .or_default();
        e.0 += o.reward;
        e.1 += 1;
    }
    sums.into_iter()
        .map(|((format, olay_kind, hypothesis_id), (sum, n))| PostScore {
            format,
            olay_kind,
            hypothesis_id,
            mean: sum / f64::from(n),
            posts: n,
        })
        .collect()
}

/// The formats some organic kind publishes, best first for `olay_kind` (spec D31): the formats
/// measured for it by their mean reward (more posts first on a tie), then the others in
/// [`PostFormat::ALL`]'s order. Every hypothesis counts.
pub fn format_scores(outcomes: &[PostOutcome], olay_kind: Option<OlayKind>) -> Vec<FormatScore> {
    // A story is never measured (its insights last a day): it is never ranked.
    let mut scores: Vec<FormatScore> = PostFormat::ALL
        .into_iter()
        .filter(|f| {
            *f != PostFormat::Story
                && ORGANIC_KINDS
                    .iter()
                    .any(|k| supported_formats(k).contains(f))
        })
        .map(|format| {
            let rewards: Vec<f64> = finite_rewards(outcomes)
                .filter(|o| o.format == format && o.olay_kind == olay_kind)
                .map(|o| o.reward)
                .collect();
            FormatScore {
                format,
                mean: (!rewards.is_empty())
                    .then(|| rewards.iter().sum::<f64>() / rewards.len() as f64),
                posts: rewards.len() as u32,
            }
        })
        .collect();
    scores.sort_by(|a, b| match (a.mean, b.mean) {
        (Some(x), Some(y)) => y
            .total_cmp(&x)
            .then(b.posts.cmp(&a.posts))
            .then(a.format.cmp(&b.format)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.format.cmp(&b.format),
    });
    scores
}
