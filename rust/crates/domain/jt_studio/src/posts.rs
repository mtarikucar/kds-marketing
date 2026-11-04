//! Olay-driven publishing's pure rules (spec 2026-11-03 §14, D20–D30): the format of a planned
//! post, the per-workspace posting policy (leads, graces, protective caps, quiet hours), the
//! formats each organic channel kind publishes, and the all-or-nothing validation of a package an
//! agent proposes.
//!
//! The workspace's time zone is the application's: it passes the local UTC offset in. Material
//! eligibility (`piece_roles` at `publish_at`), the request being open and the channel being an
//! organic, connected capability of the workspace are checked by the application too.
use crate::{MaterialId, StudioError, Subject};
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::{Date, Duration, OffsetDateTime, UtcOffset};

/// Minutes in a day: the most a grace, a spacing or the debounce may be.
pub const MAX_POSTING_MINUTES: u32 = 24 * 60;
/// The longest horizon, in days.
pub const MAX_POSTING_HORIZON_DAYS: u16 = 90;
/// The longest floor, in days.
pub const MAX_FLOOR_DAYS: u16 = 90;
/// The highest daily cap of a format.
pub const MAX_POSTS_PER_DAY: u16 = 100;

/// What a planned post is (spec D20).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostFormat {
    Story,
    FeedPost,
    Carousel,
    Reel,
    TiktokVideo,
}

impl PostFormat {
    pub const ALL: [PostFormat; 5] = [
        Self::Story,
        Self::FeedPost,
        Self::Carousel,
        Self::Reel,
        Self::TiktokVideo,
    ];

    /// Its stable key, its serde name.
    pub fn key(self) -> &'static str {
        match self {
            Self::Story => "story",
            Self::FeedPost => "feed_post",
            Self::Carousel => "carousel",
            Self::Reel => "reel",
            Self::TiktokVideo => "tiktok_video",
        }
    }

    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.key() == key)
    }

    /// Whether it is a feed format: feed formats share one daily cap and spacing per channel,
    /// and the floor trigger watches them (spec D26, D29).
    pub fn is_feed(self) -> bool {
        matches!(self, Self::FeedPost | Self::Carousel | Self::Reel)
    }
}

/// The cap a format counts against: the feed formats together, stories, TikTok videos.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapGroup {
    Feed,
    Story,
    TiktokVideo,
}

fn cap_group(format: PostFormat) -> CapGroup {
    match format {
        PostFormat::Story => CapGroup::Story,
        PostFormat::TiktokVideo => CapGroup::TiktokVideo,
        PostFormat::FeedPost | PostFormat::Carousel | PostFormat::Reel => CapGroup::Feed,
    }
}

/// A number of minutes per format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormatMinutes {
    pub story: u32,
    pub feed_post: u32,
    pub carousel: u32,
    pub reel: u32,
    pub tiktok_video: u32,
}

impl FormatMinutes {
    pub fn get(&self, format: PostFormat) -> u32 {
        match format {
            PostFormat::Story => self.story,
            PostFormat::FeedPost => self.feed_post,
            PostFormat::Carousel => self.carousel,
            PostFormat::Reel => self.reel,
            PostFormat::TiktokVideo => self.tiktok_video,
        }
    }
}

/// A protective cap (spec D29): at most `per_day` posts per channel per local day, at least
/// `spacing_minutes` apart on the channel (0: no spacing).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostCap {
    pub per_day: u16,
    pub spacing_minutes: u32,
}

/// The per-workspace posting settings (spec D21, D24–D29, `studio_posting_policy`). A stored
/// policy reads a missing field as its default. The time zone the hours are read in is stored
/// beside it by the application.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PostingPolicy {
    /// How long before `publish_at` a post's preparation starts (spec D21, D28).
    pub lead_minutes: FormatMinutes,
    /// How long after `publish_at` a post not ready may still go out (spec D28).
    pub grace_minutes: FormatMinutes,
    /// The feed formats' cap, counted together.
    pub feed_cap: PostCap,
    pub story_cap: PostCap,
    pub tiktok_video_cap: PostCap,
    /// Quiet hours, local: no post at `quiet_start_hour:00 ..< quiet_end_hour:00`, wrapping past
    /// midnight when the start is later than the end; equal hours: none.
    pub quiet_start_hour: u8,
    pub quiet_end_hour: u8,
    /// Days without a feed post on a channel before the floor trigger asks for one (spec D26).
    pub floor_days: u16,
    /// Minutes after an olay's last material change before the olay trigger fires (spec D24).
    pub debounce_minutes: u32,
    /// How far ahead a post may be planned, in days (spec D27).
    pub horizon_days: u16,
}

impl Default for PostingPolicy {
    fn default() -> Self {
        let hours = |h: u32| h * 60;
        PostingPolicy {
            lead_minutes: FormatMinutes {
                story: hours(2),
                feed_post: hours(24),
                carousel: hours(24),
                reel: hours(48),
                tiktok_video: hours(48),
            },
            grace_minutes: FormatMinutes {
                story: hours(1),
                feed_post: hours(6),
                carousel: hours(6),
                reel: hours(6),
                tiktok_video: hours(6),
            },
            feed_cap: PostCap {
                per_day: 2,
                spacing_minutes: hours(3),
            },
            story_cap: PostCap {
                per_day: 25,
                spacing_minutes: 10,
            },
            tiktok_video_cap: PostCap {
                per_day: 3,
                spacing_minutes: 0,
            },
            quiet_start_hour: 0,
            quiet_end_hour: 8,
            floor_days: 4,
            debounce_minutes: 30,
            horizon_days: 30,
        }
    }
}

impl PostingPolicy {
    pub fn validate(&self) -> Result<(), StudioError> {
        let invalid = |field| Err(StudioError::InvalidPlanning(field));
        if !(1..=MAX_POSTING_HORIZON_DAYS).contains(&self.horizon_days) {
            return invalid("posting_policy.horizon_days");
        }
        let horizon = u32::from(self.horizon_days) * MAX_POSTING_MINUTES;
        if PostFormat::ALL
            .iter()
            .any(|f| self.lead_minutes.get(*f) > horizon)
        {
            return invalid("posting_policy.lead_minutes");
        }
        if PostFormat::ALL
            .iter()
            .any(|f| self.grace_minutes.get(*f) > MAX_POSTING_MINUTES)
        {
            return invalid("posting_policy.grace_minutes");
        }
        if [self.feed_cap, self.story_cap, self.tiktok_video_cap]
            .iter()
            .any(|c| {
                !(1..=MAX_POSTS_PER_DAY).contains(&c.per_day)
                    || c.spacing_minutes > MAX_POSTING_MINUTES
            })
        {
            return invalid("posting_policy.caps");
        }
        if self.quiet_start_hour > 23 || self.quiet_end_hour > 23 {
            return invalid("posting_policy.quiet_hours");
        }
        if !(1..=MAX_FLOOR_DAYS).contains(&self.floor_days) {
            return invalid("posting_policy.floor_days");
        }
        if self.debounce_minutes > MAX_POSTING_MINUTES {
            return invalid("posting_policy.debounce_minutes");
        }
        Ok(())
    }

    pub fn lead(&self, format: PostFormat) -> Duration {
        Duration::minutes(i64::from(self.lead_minutes.get(format)))
    }

    pub fn grace(&self, format: PostFormat) -> Duration {
        Duration::minutes(i64::from(self.grace_minutes.get(format)))
    }

    pub fn horizon(&self) -> Duration {
        Duration::days(i64::from(self.horizon_days))
    }

    /// The cap `format` counts against.
    pub fn cap(&self, format: PostFormat) -> PostCap {
        match cap_group(format) {
            CapGroup::Feed => self.feed_cap,
            CapGroup::Story => self.story_cap,
            CapGroup::TiktokVideo => self.tiktok_video_cap,
        }
    }

    /// Whether local hour `hour` (0–23) is a quiet hour.
    pub fn is_quiet_hour(&self, hour: u8) -> bool {
        let (start, end) = (self.quiet_start_hour, self.quiet_end_hour);
        if start <= end {
            (start..end).contains(&hour)
        } else {
            hour >= start || hour < end
        }
    }
}

/// The formats a channel of organic kind `kind_key` publishes: only what its adapter builds
/// (spec D30). No kind takes `story`: no adapter publishes stories yet, so a story is refused
/// as `format_unsupported` until one does. A kind that is not organic takes nothing.
pub fn supported_formats(kind_key: &str) -> &'static [PostFormat] {
    use PostFormat::{Carousel, FeedPost, Reel, TiktokVideo};
    match kind_key {
        // `jt_meta` publishes one image as a post, one video as a reel (a `REELS` container) and
        // 2 to 10 items as a carousel (a `CAROUSEL` container).
        "instagram" => &[FeedPost, Carousel, Reel],
        // `jt_meta` publishes one image or one video as a post and 2 to 10 images as one post of
        // attached photos (images only: a video goes alone). A video goes to the Page's videos:
        // reels are not built in the adapter yet.
        "facebook_page" => &[FeedPost, Carousel],
        "x" | "linkedin_member" | "linkedin_page" => &[FeedPost],
        // TikTok takes a video with its posting screen, nothing else.
        "tiktok" => &[TiktokVideo],
        _ => &[],
    }
}

/// Whether a post of `format` may carry `n` media: a carousel 2 to 10, every other format one.
pub fn media_count_ok(format: PostFormat, n: usize) -> bool {
    match format {
        PostFormat::Carousel => (2..=10).contains(&n),
        PostFormat::Story | PostFormat::FeedPost | PostFormat::Reel | PostFormat::TiktokVideo => {
            n == 1
        }
    }
}

/// The image types a Studio file may have.
const IMAGE_MIMES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];
/// The video type a Studio file may have.
const VIDEO_MIME: &str = "video/mp4";

/// Whether `mime` is a Studio image type.
pub fn is_image_mime(mime: &str) -> bool {
    IMAGE_MIMES.contains(&mime.trim().to_ascii_lowercase().as_str())
}

/// Whether `mime` is an image type LinkedIn takes (JPEG, PNG or GIF).
fn linkedin_image_mime(mime: &str) -> bool {
    matches!(
        mime.trim().to_ascii_lowercase().as_str(),
        "image/jpeg" | "image/png" | "image/gif"
    )
}

/// Whether `mime` is the Studio video type.
pub fn is_video_mime(mime: &str) -> bool {
    mime.trim().eq_ignore_ascii_case(VIDEO_MIME)
}

/// Whether a post of `format` on a channel of kind `kind_key` may carry media of `mimes`, in
/// order (spec D30). The adapters choose image or video from the file, not from the format, so
/// the format fixes the types: on Instagram a feed post is one image (one video goes out as a
/// reel), a reel one video and a carousel images or videos; a Facebook Page post is one image or
/// one video and its carousel images only (a video goes alone); X takes images; LinkedIn JPEG,
/// PNG or GIF images or one video; TikTok one video. The count is [`media_count_ok`]'s.
pub fn media_types_ok(format: PostFormat, kind_key: &str, mimes: &[&str]) -> bool {
    let all = |f: fn(&str) -> bool| !mimes.is_empty() && mimes.iter().all(|m| f(m));
    match (format, kind_key) {
        (PostFormat::FeedPost, "instagram") => all(is_image_mime),
        (PostFormat::FeedPost, "facebook_page") => all(|m| is_image_mime(m) || is_video_mime(m)),
        (PostFormat::FeedPost, "x") => all(is_image_mime),
        (PostFormat::FeedPost, "linkedin_member" | "linkedin_page") => {
            all(|m| linkedin_image_mime(m) || is_video_mime(m))
        }
        (PostFormat::Carousel, "instagram") => all(|m| is_image_mime(m) || is_video_mime(m)),
        (PostFormat::Carousel, "facebook_page") => all(is_image_mime),
        (PostFormat::Reel, "instagram") => all(is_video_mime),
        (PostFormat::TiktokVideo, "tiktok") => all(is_video_mime),
        _ => false,
    }
}

/// One post of a package an agent proposes (spec D27).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedPostInput {
    pub format: PostFormat,
    /// The channel: an organic capability.
    pub capability_id: CapabilityId,
    /// The channel's kind (`jt_capability` kind key).
    pub kind_key: String,
    #[serde(with = "crate::time_compat")]
    pub publish_at: OffsetDateTime,
    /// The materials it shows, in order, each once.
    pub material_ids: Vec<MaterialId>,
    pub subject: Subject,
    /// The hypothesis the agent chose among the live ones.
    pub hypothesis_id: HypothesisId,
}

/// A post already planned or published on a channel, which a package's caps and spacing count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExistingPost {
    pub format: PostFormat,
    pub capability_id: CapabilityId,
    #[serde(with = "crate::time_compat")]
    pub publish_at: OffsetDateTime,
}

/// Why a proposed post is refused: a closed code, shown to agents and, in Turkish, in the panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostRefusal {
    /// The channel's kind does not publish the format (spec D30).
    FormatUnsupported,
    /// `publish_at` is closer than the format's lead.
    LeadTooShort,
    /// `publish_at` is past the horizon.
    BeyondHorizon,
    /// `publish_at` is in the local quiet hours.
    QuietHours,
    /// The channel's cap for the format's group that local day is full.
    CapPerDay,
    /// Too close to another post of the format's group on the channel.
    Spacing,
    /// The format's media count is not met, or a material repeats.
    MediaCount,
    /// A medium's type is not one the format takes on the channel's kind
    /// ([`media_types_ok`]); the application checks it, it knows the files.
    MediaType,
}

impl PostRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::FormatUnsupported => "format_unsupported",
            Self::LeadTooShort => "lead_too_short",
            Self::BeyondHorizon => "beyond_horizon",
            Self::QuietHours => "quiet_hours",
            Self::CapPerDay => "cap_per_day",
            Self::Spacing => "spacing",
            Self::MediaCount => "media_count",
            Self::MediaType => "media_type",
        }
    }
}

/// When a post of `format` to be published at `publish_at` enters the agent's pending work.
pub fn prep_start_at(
    format: PostFormat,
    publish_at: OffsetDateTime,
    policy: &PostingPolicy,
) -> OffsetDateTime {
    publish_at - policy.lead(format)
}

/// Until when a post of `format` not ready at `publish_at` may still go out.
pub fn grace_until(
    format: PostFormat,
    publish_at: OffsetDateTime,
    policy: &PostingPolicy,
) -> OffsetDateTime {
    publish_at + policy.grace(format)
}

/// The local calendar day of `at`.
fn local_day(at: OffsetDateTime, local_offset: UtcOffset) -> Date {
    at.checked_to_offset(local_offset).unwrap_or(at).date()
}

/// The first rule post `item` breaks on its own, in this order: format, media count, lead,
/// horizon, quiet hours.
fn own_refusal(
    item: &PlannedPostInput,
    now: OffsetDateTime,
    local_offset: UtcOffset,
    policy: &PostingPolicy,
) -> Option<PostRefusal> {
    let distinct: BTreeSet<&MaterialId> = item.material_ids.iter().collect();
    let local_hour = item
        .publish_at
        .checked_to_offset(local_offset)
        .unwrap_or(item.publish_at)
        .hour();
    if !supported_formats(&item.kind_key).contains(&item.format) {
        Some(PostRefusal::FormatUnsupported)
    } else if distinct.len() != item.material_ids.len()
        || !media_count_ok(item.format, distinct.len())
    {
        Some(PostRefusal::MediaCount)
    } else if item.publish_at < now + policy.lead(item.format) {
        Some(PostRefusal::LeadTooShort)
    } else if item.publish_at > now + policy.horizon() {
        Some(PostRefusal::BeyondHorizon)
    } else if policy.is_quiet_hour(local_hour) {
        Some(PostRefusal::QuietHours)
    } else {
        None
    }
}

/// The caps and spacing of `items` (index, post) against `existing` and each other. Items are
/// taken in time order (then index); an item counts against later ones only once it passes, so
/// a refusal names the post that breaks a rule, not the one it collides with.
fn schedule_refusals<'a>(
    items: impl IntoIterator<Item = (usize, &'a PlannedPostInput)>,
    existing: &[ExistingPost],
    local_offset: UtcOffset,
    policy: &PostingPolicy,
) -> Vec<(usize, PostRefusal)> {
    let mut items: Vec<(usize, &PlannedPostInput)> = items.into_iter().collect();
    items.sort_by_key(|(i, p)| (p.publish_at, *i));
    let mut placed: Vec<(CapabilityId, CapGroup, OffsetDateTime)> = existing
        .iter()
        .map(|p| (p.capability_id, cap_group(p.format), p.publish_at))
        .collect();
    let mut refusals = Vec::new();
    for (i, post) in items {
        let group = cap_group(post.format);
        let cap = policy.cap(post.format);
        let day = local_day(post.publish_at, local_offset);
        let same: Vec<OffsetDateTime> = placed
            .iter()
            .filter(|(c, g, _)| *c == post.capability_id && *g == group)
            .map(|(_, _, at)| *at)
            .collect();
        let spacing = Duration::minutes(i64::from(cap.spacing_minutes));
        if same
            .iter()
            .filter(|at| local_day(**at, local_offset) == day)
            .count()
            >= usize::from(cap.per_day)
        {
            refusals.push((i, PostRefusal::CapPerDay));
        } else if same
            .iter()
            .any(|at| (*at - post.publish_at).abs() < spacing)
        {
            refusals.push((i, PostRefusal::Spacing));
        } else {
            placed.push((post.capability_id, group, post.publish_at));
        }
    }
    refusals
}

/// Only the caps and spacing of `items` against `existing` (spec D29), a reason per failing
/// item by its index; [`validate_package`] runs this after each item's own rules.
pub fn check_schedule(
    items: &[PlannedPostInput],
    existing: &[ExistingPost],
    local_offset: UtcOffset,
    policy: &PostingPolicy,
) -> Result<(), Vec<(usize, PostRefusal)>> {
    let mut refusals = schedule_refusals(items.iter().enumerate(), existing, local_offset, policy);
    refusals.sort_by_key(|(i, _)| *i);
    if refusals.is_empty() {
        Ok(())
    } else {
        Err(refusals)
    }
}

/// Validates a proposed package all-or-nothing (spec D27, D29, D30): `Err` lists, by index, the
/// one reason each failing item is refused. An item's own rules come first (format, media
/// count, lead from `now`, horizon, quiet hours at `local_offset`); then the items that pass
/// them are checked for the daily caps (per channel and local day: the feed formats together,
/// stories, TikTok videos) and spacing, against `existing` (every post planned or published on
/// those channels) and the package's earlier posts. Material eligibility is not checked here.
pub fn validate_package(
    items: &[PlannedPostInput],
    existing: &[ExistingPost],
    now: OffsetDateTime,
    local_offset: UtcOffset,
    policy: &PostingPolicy,
) -> Result<(), Vec<(usize, PostRefusal)>> {
    let mut refusals = Vec::new();
    let mut passing = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match own_refusal(item, now, local_offset, policy) {
            Some(r) => refusals.push((i, r)),
            None => passing.push((i, item)),
        }
    }
    refusals.extend(schedule_refusals(passing, existing, local_offset, policy));
    refusals.sort_by_key(|(i, _)| *i);
    if refusals.is_empty() {
        Ok(())
    } else {
        Err(refusals)
    }
}
