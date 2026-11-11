//! Olay-driven publishing's use cases (spec `2026-11-03-studio-materials-design.md` §14): the
//! package requests the planner's triggers write (`studio.post_requests`), an agent's answer
//! with planned posts, validated all-or-nothing and materialized at once
//! (`studio.posts_propose`), the planned posts (`studio.posts_list`), the owner's weekly summary
//! (`studio.weekly_summary`) and the posting policy, a human's (`studio.posting_policy_set`).
//!
//! Each needs an approved strategy (they plan content) and `social.work`. Nothing is published
//! without an eligible material: a package's posts are checked here at their time, and their
//! pieces again at submission and at publish (spec D1). Ledger entries carry ids, codes and
//! times, never captions or the owner's words.
use super::{
    chain::{ORGANIC_KINDS, capability_access},
    control::human_approver,
    files::{decode, encode, key},
    materials::Library,
    planner::stable_id,
    work::gated,
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        CapabilityFilter, LedgerFilter, TenantRepos,
        posts::{
            PackageRequest, PackageRequestId, PackageStatus, PlannedPost, PostRetirement,
            PostingSettings,
        },
        studio::SlotQuery,
    },
    usecases::{Deps, ledger_entry},
};
use jt_capability::{Capability, CapabilityId};
use jt_strategy::{Hypothesis, HypothesisId, LaneKind, StrategyVersion};
use jt_studio::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use url::Url;
use uuid::Uuid;

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

/// The IANA zone `name`, when it is one.
pub(crate) fn zone(name: &str) -> Option<chrono_tz::Tz> {
    name.parse().ok()
}

/// The zone `name`, or Istanbul's when it is none (a stored zone was validated when it was set).
pub(crate) fn zone_or_default(name: &str) -> chrono_tz::Tz {
    zone(name).unwrap_or(chrono_tz::Europe::Istanbul)
}

/// `tz`'s offset from UTC at `at`.
pub(crate) fn offset_at(tz: chrono_tz::Tz, at: OffsetDateTime) -> UtcOffset {
    use chrono::{Offset, TimeZone};
    let Some(utc) = chrono::DateTime::from_timestamp(at.unix_timestamp(), 0) else {
        return UtcOffset::UTC;
    };
    let seconds = tz
        .offset_from_utc_datetime(&utc.naive_utc())
        .fix()
        .local_minus_utc();
    UtcOffset::from_whole_seconds(seconds).unwrap_or(UtcOffset::UTC)
}

/// The local calendar day of `at` in `tz`.
pub(crate) fn local_day(tz: chrono_tz::Tz, at: OffsetDateTime) -> Date {
    at.to_offset(offset_at(tz, at)).date()
}

/// The first instant of local day `day` in `tz`.
pub(crate) fn day_start(tz: chrono_tz::Tz, day: Date) -> OffsetDateTime {
    let guess = day.midnight().assume_utc();
    let first = day
        .midnight()
        .assume_offset(offset_at(tz, guess))
        .to_offset(UtcOffset::UTC);
    day.midnight()
        .assume_offset(offset_at(tz, first))
        .to_offset(UtcOffset::UTC)
}

/// Monday of `day`'s week.
pub(crate) fn monday(day: Date) -> Date {
    day - Duration::days(i64::from(day.weekday().number_days_from_monday()))
}

/// Noon of Istanbul day `day`: inside the day whatever the quiet hours.
pub(crate) fn istanbul_noon(day: Date) -> OffsetDateTime {
    day.with_hms(12, 0, 0)
        .expect("noon")
        .assume_offset(UtcOffset::from_hms(3, 0, 0).expect("Istanbul offset"))
        .to_offset(UtcOffset::UTC)
}

// ---------------------------------------------------------------------------------------------
// Channels, materials and learning, shared with the planner
// ---------------------------------------------------------------------------------------------

/// A hypothesis and content type a channel may take a post for (spec D22): its organic cadence
/// names the content type and the chain rule's conditions short of an arm hold.
#[derive(Clone, Debug)]
pub(crate) struct ChannelOption {
    pub hypothesis_id: HypothesisId,
    pub title: String,
    pub segment_key: String,
    pub content_type: String,
}

/// An organic capability a post may go out on now: connected, its publisher built, chosen by the
/// strategy, and some live hypothesis able to post on it.
#[derive(Clone, Debug)]
pub(crate) struct Channel {
    pub capability: Capability,
    pub options: Vec<ChannelOption>,
}

/// The content types `h`'s organic cadence names for a channel of kind `kind`, the cadence's
/// order kept; none when `h` is retired, posts elsewhere or has no usable organic cadence.
pub(crate) fn content_types(h: &Hypothesis, kind: &str) -> Vec<String> {
    let Some(cadence) = h.cadence.get(&LaneKind::Organic) else {
        return Vec::new();
    };
    if !h.state.is_live()
        || !(h.channel == "any" || h.channel == kind)
        || cadence.validate().is_err()
        || cadence.slots_per_week == 0
    {
        return Vec::new();
    }
    cadence
        .content_types
        .iter()
        .filter(|t| t.max_bps > 0)
        .map(|t| t.key.clone())
        .collect()
}

/// Whether the strategy `frame` chose a channel of kind `kind` in one of `group_ids` (or any).
pub(crate) fn selected(frame: &StrategyVersion, kind: &str, group_ids: &[Uuid]) -> bool {
    frame.sections.channels.iter().any(|choice| {
        (choice.channel == "any" || choice.channel == kind)
            && choice
                .group_id
                .is_none_or(|group| group_ids.contains(&group))
    })
}

pub(crate) async fn group_ids(
    r: &mut dyn TenantRepos,
    c: CapabilityId,
) -> Result<Vec<Uuid>, AppError> {
    Ok(r.capability_groups()
        .list()
        .await?
        .into_iter()
        .filter(|(_, ids)| ids.contains(&c))
        .map(|(g, _)| g.id.0)
        .collect())
}

/// Whether capability `c` may take a post at `now`: an organic kind, connected for writing, with
/// a publisher built for its provider.
pub(crate) fn postable(d: &Deps, c: &Capability, now: OffsetDateTime) -> bool {
    ORGANIC_KINDS.contains(&c.kind_key.as_str())
        && capability_access(c, now, true).is_ok()
        && jt_connector::provider_for_kind(&c.kind_key)
            .is_some_and(|p| d.connectors.publisher(p).is_some())
}

/// The channels posts may go out on at `now`, under strategy `frame`.
pub(crate) async fn channels(
    d: &Deps,
    r: &mut dyn TenantRepos,
    frame: &StrategyVersion,
    now: OffsetDateTime,
) -> Result<Vec<Channel>, AppError> {
    let hypotheses = r.hypotheses().list(frame.id).await?;
    // An account a person paused takes no post (design 2026-11-10 §7.6).
    let paused = r
        .studio_posts()
        .posting_settings()
        .await?
        .paused_capability_ids;
    let mut out = Vec::new();
    for c in r.capabilities().list(CapabilityFilter::default()).await? {
        if paused.contains(&c.id)
            || !postable(d, &c, now)
            || !selected(frame, &c.kind_key, &group_ids(r, c.id).await?)
        {
            continue;
        }
        let mut options = Vec::new();
        let mut live: Vec<&Hypothesis> = hypotheses.iter().collect();
        live.sort_by_key(|h| h.id);
        for h in live {
            for content_type in content_types(h, &c.kind_key) {
                options.push(ChannelOption {
                    hypothesis_id: h.id,
                    title: h.title.clone(),
                    segment_key: h.segment_key.clone(),
                    content_type,
                });
            }
        }
        if !options.is_empty() {
            out.push(Channel {
                capability: c,
                options,
            });
        }
    }
    Ok(out)
}

/// The arm of `option` on a channel of kind `kind`'s posterior mean, `0.5` with no arm yet.
fn posterior_mean(option: &ChannelOption, arms: &[Arm], kind: &str) -> f64 {
    arms.iter()
        .find(|a| {
            a.key.hypothesis_id == option.hypothesis_id
                && a.key.content_type == option.content_type
                && a.key.channel == kind
                && a.key.lane == LaneKind::Organic
        })
        .map_or(0.5, |a| a.alpha / (a.alpha + a.beta))
}

/// The option whose arm has the highest posterior mean (spec D31), the first on a tie.
pub(crate) fn best_option<'a>(
    options: &'a [ChannelOption],
    arms: &[Arm],
    kind: &str,
) -> Option<&'a ChannelOption> {
    let mut best: Option<(&ChannelOption, f64)> = None;
    for o in options {
        let mean = posterior_mean(o, arms, kind);
        if best.is_none_or(|(_, m)| mean > m) {
            best = Some((o, mean));
        }
    }
    best.map(|(o, _)| o)
}

/// When `o`'s materials are first usable as its own subject from `now`: now, or the start of its
/// season year's window when that is later; `None` for a season or special day whose window has
/// no dates.
pub(crate) fn use_time(
    o: &Olay,
    calendar: &Calendar,
    now: OffsetDateTime,
) -> Option<OffsetDateTime> {
    if !o.kind.is_seasonal() {
        return Some(now);
    }
    let key = o.occasion.as_deref()?;
    let year = calendar.season_year(key, o.starts_on)?;
    let (start, _) = calendar.entry(key, year)?.window()?;
    Some(istanbul_noon(start).max(now))
}

/// The occasion `key`'s confirmed olay of season year `year` with materials eligible as its own
/// subject at `at`, one of them an anchor (the earliest such olay), and those materials.
pub(crate) fn season_olay<'a>(
    lib: &'a Library,
    materials: &[Material],
    key: &str,
    year: i32,
    at: OffsetDateTime,
) -> Option<(&'a Olay, Vec<MaterialId>)> {
    let cx = lib.context(at);
    let mut olays: Vec<&Olay> = lib
        .olays
        .iter()
        .filter(|o| {
            o.is_confirmed()
                && o.kind.is_seasonal()
                && o.occasion.as_deref() == Some(key)
                && lib.calendar.season_year(key, o.starts_on) == Some(year)
        })
        .collect();
    olays.sort_by_key(|o| (o.starts_on, o.id));
    olays.into_iter().find_map(|o| {
        let subject = Subject::Olay { olay_id: o.id };
        let mut eligible: Vec<&Material> = materials
            .iter()
            .filter(|m| m.olay_id() == Some(o.id) && classify(m, &subject, &cx).is_ok())
            .collect();
        if !eligible
            .iter()
            .any(|m| check_use(m, UseRole::Anchor, &subject, &cx).is_ok())
        {
            return None;
        }
        eligible.sort_by_key(|m| (material_changed_at(m), m.id));
        Some((o, eligible.into_iter().map(|m| m.id).collect()))
    })
}

/// The generic material a floor post is built on at `at` (spec D26): one that may anchor a
/// generic post, those carrying `need`'s tags first, then the least recently used (never used
/// first), then the freshest, then by id.
pub(crate) async fn generic_anchor(
    r: &mut dyn TenantRepos,
    lib: &Library,
    materials: &[Material],
    posts: &[PlannedPost],
    slots: &[Slot],
    need: &SlotNeed,
    at: OffsetDateTime,
) -> Result<Option<MaterialId>, AppError> {
    let cx = lib.context(at);
    let blocked = super::library::blocked_derivatives(r).await?;
    let state: BTreeMap<SlotId, &Slot> = slots.iter().map(|s| (s.id, s)).collect();
    let mut best: Option<(_, MaterialId)> = None;
    for m in materials.iter().filter(|m| {
        !blocked.contains(&m.id) && check_use(m, UseRole::Anchor, &Subject::Generic, &cx).is_ok()
    }) {
        let planned = posts
            .iter()
            .filter(|p| {
                p.material_ids.contains(&m.id)
                    && p.retired
                        .is_none_or(|x| x.reason != RetirementReason::MissedGrace)
            })
            .map(|p| p.publish_at);
        let mut published = Vec::new();
        for u in r.studio_materials().uses_of(m.id).await? {
            if let Some(s) = state.get(&u.slot_id)
                && matches!(s.state, SlotState::Published | SlotState::Measured)
            {
                published.push(s.scheduled_at);
            }
        }
        let last = planned.chain(published).max();
        let rank = (
            !need.matches(&m.tags),
            last,
            std::cmp::Reverse(m.captured_at.unwrap_or(m.created_at)),
            m.id,
        );
        if best.as_ref().is_none_or(|(k, _)| rank < *k) {
            best = Some((rank, m.id));
        }
    }
    Ok(best.map(|(_, id)| id))
}

/// `need`'s tag keys, for a çekim listesi text.
pub(crate) fn need_text(need: &SlotNeed) -> String {
    need.product_groups
        .iter()
        .map(|t| t.key())
        .chain(need.doors.iter().map(|t| t.key()))
        .chain(need.content_types.iter().map(|t| t.key()))
        .chain(need.labels.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every measured post with a planned post (spec D31): its format, its olay's kind, its
/// hypothesis and its reward. Advisory: unreadable evidence counts for nothing.
pub(crate) async fn outcomes(
    r: &mut dyn TenantRepos,
    posts: &[PlannedPost],
    olays: &[Olay],
) -> Result<Vec<PostOutcome>, AppError> {
    let measurements = r.studio().list_measurements().await?;
    let rewards = observations(&measurements).unwrap_or_default();
    let publications = r.studio().list_publications().await?;
    let mut out = Vec::new();
    for reward in rewards {
        let Some(publication) = reward
            .measurement_ids
            .first()
            .and_then(|id| measurements.iter().find(|m| m.id == *id))
            .and_then(|m| m.publication_id)
            .and_then(|id| publications.iter().find(|p| p.id == id))
        else {
            continue;
        };
        // A story is left out of learning: its insights last a day only.
        let Some(post) = posts
            .iter()
            .find(|p| p.slot_id == publication.slot_id && p.format != PostFormat::Story)
        else {
            continue;
        };
        out.push(PostOutcome {
            format: post.format,
            olay_kind: post
                .olay_id
                .and_then(|id| olays.iter().find(|o| o.id == id))
                .map(|o| o.kind),
            hypothesis_id: reward.chain.hypothesis_id,
            reward: reward.value,
        });
    }
    Ok(out)
}

/// What is wrong with material `m` as a story's one medium (Instagram's `STORIES`): its file's
/// type and size and, for a video, its length read from its `moov` box; `None` when Instagram
/// takes it.
pub(crate) async fn story_refusal(
    d: &Deps,
    r: &mut dyn TenantRepos,
    m: &Material,
) -> Result<Option<StoryMediaRefusal>, AppError> {
    let f = r
        .studio()
        .get_file(m.file_id)
        .await?
        .ok_or_else(|| AppError::not_found("file"))?;
    let (ms, moov_first) = if is_video_mime(&f.mime) {
        super::library::video_facts_of(d, &f).await?
    } else {
        (None, true)
    };
    Ok(story_media_refusal(&f.mime, f.size_bytes, ms, moov_first))
}

/// Records why the post of `slot`, when it has one, was retired at `at`.
pub(crate) async fn retire_post_of(
    r: &mut dyn TenantRepos,
    slot: SlotId,
    reason: RetirementReason,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    if r.studio_posts().get_post(slot).await?.is_some() {
        r.studio_posts()
            .retire_post(slot, PostRetirement { reason, at })
            .await?;
    }
    Ok(())
}

/// The slots of the live posts still to be prepared or sent (planned or ready).
pub(crate) async fn unsent_posts(r: &mut dyn TenantRepos) -> Result<Vec<SlotId>, AppError> {
    let mut out = Vec::new();
    for p in r.studio_posts().list_posts().await? {
        if p.retired.is_none()
            && r.studio()
                .get_slot(p.slot_id)
                .await?
                .is_some_and(|s| matches!(s.state, SlotState::Planned | SlotState::Ready))
        {
            out.push(p.slot_id);
        }
    }
    Ok(out)
}

/// Records why the posts of `unsent` (taken before a strategy change) whose slots the change
/// retired were retired: their hypothesis's retirement, or the strategy's archive.
pub(crate) async fn retire_posts_after(
    r: &mut dyn TenantRepos,
    unsent: &[SlotId],
    archived: bool,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    let reason = if archived {
        RetirementReason::StrategyArchived
    } else {
        RetirementReason::HypothesisRetired
    };
    for slot in unsent {
        if r.studio()
            .get_slot(*slot)
            .await?
            .is_some_and(|s| s.state == SlotState::Retired)
        {
            r.studio_posts()
                .retire_post(*slot, PostRetirement { reason, at })
                .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// studio.post_requests
// ---------------------------------------------------------------------------------------------

/// Which requests `studio.post_requests` answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageFilter {
    #[default]
    Open,
    Answered,
    Expired,
    All,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageQuery {
    #[serde(default)]
    pub status: PackageFilter,
}

/// The package requests, open ones unless `status` says otherwise, newest first.
pub async fn post_requests(
    d: &Deps,
    ctx: &Ctx,
    q: PackageQuery,
) -> Result<Vec<PackageRequest>, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.post_requests",
    ))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.post_requests"),
    )
    .await?;
    Ok(r.studio_posts()
        .list_package_requests()
        .await?
        .into_iter()
        .filter(|x| match q.status {
            PackageFilter::Open => x.status == PackageStatus::Open,
            PackageFilter::Answered => x.status == PackageStatus::Answered,
            PackageFilter::Expired => x.status == PackageStatus::Expired,
            PackageFilter::All => true,
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// studio.posts_propose
// ---------------------------------------------------------------------------------------------

/// One post of an agent's package (spec D27).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedPost {
    pub format: PostFormat,
    /// The channel: an organic capability.
    pub capability_id: CapabilityId,
    #[serde(with = "time::serde::rfc3339")]
    pub publish_at: OffsetDateTime,
    /// The materials it shows, in order, each once.
    pub material_ids: Vec<MaterialId>,
    pub subject: Subject,
    /// A live hypothesis whose organic cadence names a content type for the channel.
    pub hypothesis_id: HypothesisId,
    /// One of the cadence's content types; its first when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

/// `studio.posts_propose`'s input: the request it answers and its posts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageProposalInput {
    pub request_id: PackageRequestId,
    pub request_key: String,
    pub posts: Vec<ProposedPost>,
}

/// A planned post with its slot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostOut {
    pub post: PlannedPost,
    pub slot: Slot,
    /// Whether it is in the agent's pending work: its preparation started and it is still to be
    /// prepared or sent.
    pub pending: bool,
}

/// The answered request and the posts its package materialized.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageProposalOut {
    pub request: PackageRequest,
    pub posts: Vec<PostOut>,
}

pub(crate) fn post_out(post: PlannedPost, slot: Slot, now: OffsetDateTime) -> PostOut {
    PostOut {
        pending: now >= post.prep_start_at
            && post.retired.is_none()
            && matches!(slot.state, SlotState::Planned | SlotState::Ready),
        post,
        slot,
    }
}

/// Why one proposed post is refused.
struct ItemRefusal {
    index: usize,
    reason: &'static str,
    extra: Value,
}

impl ItemRefusal {
    fn new(index: usize, reason: &'static str) -> Self {
        ItemRefusal {
            index,
            reason,
            extra: Value::Null,
        }
    }
    fn to_json(&self) -> Value {
        let mut out = json!({"index": self.index, "reason": self.reason});
        if let (Some(o), Value::Object(more)) = (out.as_object_mut(), &self.extra) {
            o.extend(more.clone());
        }
        out
    }
}

fn package_refused(items: &[ItemRefusal]) -> AppError {
    AppError::validation(
        "the package is refused whole: each refused post names its reason",
        json!({"field": "posts", "reason": "package_refused",
            "items": items.iter().map(ItemRefusal::to_json).collect::<Vec<_>>()}),
    )
}

/// A proposed post that passed the application's checks, with what materializing it needs.
struct Checked {
    capability: Capability,
    content_type: String,
    arm: Arm,
}

fn validate_proposal(i: &PackageProposalInput) -> Result<(), AppError> {
    key(&i.request_key)?;
    if i.posts.is_empty() || i.posts.len() > MAX_PACKAGE_POSTS {
        return Err(AppError::validation(
            format!("a package holds 1 to {MAX_PACKAGE_POSTS} posts"),
            json!({"field": "posts", "reason": "post_count"}),
        ));
    }
    Ok(())
}

/// Answers an open package request with planned posts (spec D27), all-or-nothing: each refused
/// post names its reason (`VALIDATION` `package_refused`, `details.items`). A post is refused for
/// its channel (`channel_unknown`, `channel_not_organic`, `channel_unavailable`, `other_channel`
/// for a floor request's other channel), its format there (`format_unsupported`), its hypothesis
/// (`hypothesis_not_postable`, `content_type_unknown`, `chain_invalid`), its materials
/// (`material_unknown`, `media_count`, `media_type`, `material_refused` with each material's
/// code, `no_eligible_material`, at its `publish_at`), its time (`lead_too_short`,
/// `beyond_horizon`, `quiet_hours`, in the posting policy's zone) or the caps (`cap_per_day`,
/// `spacing`, against every post planned or published and the package's earlier posts). A valid
/// package materializes at once: an arm per hypothesis, content type and channel (kept when it
/// exists), a planned slot per post (`scheduled_at = publish_at`), its post with its preparation
/// start and grace, the request answered. `CONFLICT` `request_not_open` once it is answered or
/// expired; replayed by `request_key`.
pub async fn posts_propose(
    d: &Deps,
    ctx: &Ctx,
    i: PackageProposalInput,
) -> Result<PackageProposalOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.posts_propose",
    ))?;
    validate_proposal(&i)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.posts_propose"),
    )
    .await?;
    r.studio_control().lock_control().await?;
    let out = posts_propose_locked(d, ctx, r.as_mut(), &frame, i).await?;
    r.commit().await?;
    Ok(out)
}

/// Materialize a proposal inside the caller's gated, Studio-locked transaction. Project
/// scheduling uses this to commit its output link and the canonical slot together.
/// The caller owns commit/rollback; every existing proposal validation still runs here.
pub(crate) async fn posts_propose_locked(
    d: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    frame: &StrategyVersion,
    i: PackageProposalInput,
) -> Result<PackageProposalOut, AppError> {
    validate_proposal(&i)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    if let Some(v) = r
        .studio()
        .request_replay("studio.posts_propose", &i.request_key, &payload)
        .await?
    {
        return decode(v);
    }
    let now = ctx.now;
    let request = r
        .studio_posts()
        .get_package_request(i.request_id)
        .await?
        .ok_or_else(|| AppError::not_found("package request"))?;
    if request.status != PackageStatus::Open || now >= request.expires_at() {
        return Err(super::chain::refuse("request_not_open"));
    }
    if request
        .hints
        .max_posts
        .is_some_and(|n| i.posts.len() > usize::from(n))
    {
        return Err(AppError::validation(
            "the request asks for fewer posts",
            json!({"field": "posts", "reason": "too_many_posts",
                "max_posts": request.hints.max_posts}),
        ));
    }
    let settings = r.studio_posts().posting_settings().await?;
    let tz = zone_or_default(&settings.tz);
    let hypotheses = r.hypotheses().list(frame.id).await?;
    let arms = r.studio().list_arms().await?;
    let latest = i
        .posts
        .iter()
        .map(|p| p.publish_at)
        .max()
        .unwrap_or(now)
        .clamp(
            now,
            now + Duration::days(i64::from(MAX_POSTING_HORIZON_DAYS)),
        );
    let lib = super::materials::library(r, latest).await?;

    let mut refusals: Vec<ItemRefusal> = Vec::new();
    let mut checked: Vec<(usize, Checked)> = Vec::new();
    for (index, p) in i.posts.iter().enumerate() {
        match check_item(d, r, frame, &hypotheses, &arms, &lib, &request, p, now).await? {
            Ok(c) => checked.push((index, c)),
            Err(mut refusal) => {
                refusal.index = index;
                refusals.push(refusal);
            }
        }
    }
    // The domain's rules on the posts that passed: lead, horizon, quiet hours, caps, spacing.
    let inputs: Vec<PlannedPostInput> = checked
        .iter()
        .map(|(index, c)| {
            let p = &i.posts[*index];
            PlannedPostInput {
                format: p.format,
                capability_id: p.capability_id,
                kind_key: c.capability.kind_key.clone(),
                publish_at: p.publish_at,
                material_ids: p.material_ids.clone(),
                subject: p.subject,
                hypothesis_id: p.hypothesis_id,
            }
        })
        .collect();
    let existing = existing_posts(r).await?;
    // Each post's hours and day at its own time in the zone (D51).
    let local = |at: OffsetDateTime| offset_at(tz, at);
    if let Err(list) = validate_package(&inputs, &existing, now, &local, &settings.policy) {
        for (n, refusal) in list {
            refusals.push(ItemRefusal::new(checked[n].0, refusal.code()));
        }
    }
    if !refusals.is_empty() {
        refusals.sort_by_key(|x| x.index);
        return Err(package_refused(&refusals));
    }

    // Valid: materialize the package at once.
    let ws = ctx.workspace_id;
    let mut slots = Vec::new();
    let mut planned = Vec::new();
    for (index, c) in &checked {
        let p = &i.posts[*index];
        let arm = r.studio().insert_arm(c.arm.clone()).await?;
        let slot = Slot {
            id: SlotId(stable_id(
                ws,
                &format!("studio.post:{}:{index}", request.id),
            )),
            chain: Chain {
                workspace_id: ws,
                born_version_id: frame.id,
                hypothesis_id: p.hypothesis_id,
                arm_id: arm.id,
            },
            capability_id: p.capability_id,
            scheduled_at: p.publish_at,
            state: SlotState::Planned,
            revision: 0,
        };
        planned.push(PlannedPost {
            slot_id: slot.id,
            workspace_id: ws,
            format: p.format,
            capability_id: p.capability_id,
            publish_at: p.publish_at,
            prep_start_at: prep_start_at(p.format, p.publish_at, &settings.policy),
            grace_until: grace_until(p.format, p.publish_at, &settings.policy),
            olay_id: p.subject.olay_id(),
            package_request_id: request.id,
            material_ids: p.material_ids.clone(),
            subject: p.subject,
            hypothesis_id: p.hypothesis_id,
            content_type: c.content_type.clone(),
            retired: None,
            created_at: now,
        });
        slots.push(slot);
    }
    let slots = r
        .studio()
        .insert_slots(&format!("studio.package:{}", request.id), slots)
        .await?;
    let mut posts = Vec::new();
    for (post, slot) in planned.into_iter().zip(slots) {
        post.validate()
            .map_err(|e| AppError::internal(format!("planned post: {e}")))?;
        r.studio_posts().insert_post(post.clone()).await?;
        let mut e = ledger_entry(
            ctx,
            "studio.slot.planned",
            "studio_slot",
            slot.id,
            json!({"born_version_id": frame.id, "executed_version_id": frame.id,
                "hypothesis_id": post.hypothesis_id, "arm_id": slot.chain.arm_id,
                "scheduled_at": post.publish_at, "format": post.format,
                "package_request_id": request.id, "material_ids": post.material_ids,
                "subject": post.subject}),
        )?;
        e.strategy_version_id = Some(frame.id.0);
        r.ledger().append(e).await?;
        posts.push(post_out(post, slot, now));
    }
    let answered = PackageRequest {
        status: PackageStatus::Answered,
        answered_at: Some(now),
        ..request
    };
    r.studio_posts()
        .update_package_request(answered.clone())
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.package.answered",
        "studio_package_request",
        answered.id,
        json!({"trigger": answered.trigger,
            "slot_ids": posts.iter().map(|p| p.slot.id).collect::<Vec<_>>()}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    let out = PackageProposalOut {
        request: answered,
        posts,
    };
    r.studio()
        .request_receipt(
            "studio.posts_propose",
            &i.request_key,
            &payload,
            &encode(&out)?,
        )
        .await?;
    Ok(out)
}

/// Every post planned or published, which a package's caps and spacing count: the live posts,
/// and the publications of no post (the weekly quotas'), as feed posts.
async fn existing_posts(r: &mut dyn TenantRepos) -> Result<Vec<ExistingPost>, AppError> {
    let posts = r.studio_posts().list_posts().await?;
    let mut out: Vec<ExistingPost> = posts
        .iter()
        .filter(|p| p.retired.is_none())
        .map(|p| ExistingPost {
            format: p.format,
            capability_id: p.capability_id,
            publish_at: p.publish_at,
        })
        .collect();
    let with_post: BTreeSet<SlotId> = posts.iter().map(|p| p.slot_id).collect();
    out.extend(
        r.studio()
            .list_publications()
            .await?
            .into_iter()
            .filter(|p| !with_post.contains(&p.slot_id))
            .map(|p| ExistingPost {
                format: PostFormat::FeedPost,
                capability_id: p.capability_id,
                publish_at: p.published_at,
            }),
    );
    Ok(out)
}

/// The application's checks of one proposed post: `Ok` with what materializing it needs, or its
/// first refusal (its index is set by the caller).
#[allow(clippy::too_many_arguments)]
async fn check_item(
    d: &Deps,
    r: &mut dyn TenantRepos,
    frame: &StrategyVersion,
    hypotheses: &[Hypothesis],
    arms: &[Arm],
    lib: &Library,
    request: &PackageRequest,
    p: &ProposedPost,
    now: OffsetDateTime,
) -> Result<Result<Checked, ItemRefusal>, AppError> {
    let refuse = |reason| Ok(Err(ItemRefusal::new(0, reason)));
    let Some(c) = r.capabilities().find(p.capability_id).await? else {
        return refuse("channel_unknown");
    };
    let kind = c.kind_key.clone();
    if !ORGANIC_KINDS.contains(&kind.as_str()) {
        return refuse("channel_not_organic");
    }
    if !postable(d, &c, now) {
        return refuse("channel_unavailable");
    }
    if r.studio_posts()
        .posting_settings()
        .await?
        .paused_capability_ids
        .contains(&c.id)
    {
        return refuse(super::chain::ACCOUNT_PAUSED);
    }
    if !request.covers(c.id) {
        return refuse("other_channel");
    }
    if !supported_formats(&kind).contains(&p.format) {
        return refuse(PostRefusal::FormatUnsupported.code());
    }
    let Some(h) = hypotheses.iter().find(|h| h.id == p.hypothesis_id) else {
        return refuse("hypothesis_not_postable");
    };
    let types = content_types(h, &kind);
    if types.is_empty() {
        return refuse("hypothesis_not_postable");
    }
    let content_type = match &p.content_type {
        Some(t) if types.contains(t) => t.clone(),
        Some(_) => return refuse("content_type_unknown"),
        None => types[0].clone(),
    };
    let arm = match arms.iter().find(|a| {
        a.key.hypothesis_id == h.id
            && a.key.content_type == content_type
            && a.key.channel == kind
            && a.key.lane == LaneKind::Organic
    }) {
        Some(a) => a.clone(),
        None => Arm::new(
            ArmId(d.ids.uuid()),
            frame.workspace_id,
            ArmKey {
                hypothesis_id: h.id,
                content_type: content_type.clone(),
                channel: kind.clone(),
                lane: LaneKind::Organic,
            },
        )
        .map_err(|e| AppError::internal(format!("arm: {e}")))?,
    };
    let groups = group_ids(r, c.id).await?;
    let chain = Chain {
        workspace_id: frame.workspace_id,
        born_version_id: frame.id,
        hypothesis_id: h.id,
        arm_id: arm.id,
    };
    if validate_chain(
        &chain,
        &ChainContext {
            workspace_id: frame.workspace_id,
            birth_version: frame,
            birth_hypotheses: hypotheses,
            current_version: frame,
            hypotheses,
            arm: &arm,
            target: &c,
            target_group_ids: &groups,
            supported_kinds: ORGANIC_KINDS,
            lane: LaneKind::Organic,
        },
    )
    .is_err()
    {
        return refuse("chain_invalid");
    }
    let mut materials = Vec::new();
    for id in &p.material_ids {
        match r.studio_materials().get_material(*id).await? {
            Some(m) if m.erased_at.is_none() => materials.push(m),
            _ => return refuse("material_unknown"),
        }
    }
    let distinct: BTreeSet<MaterialId> = p.material_ids.iter().copied().collect();
    if distinct.len() != p.material_ids.len() || !media_count_ok(p.format, distinct.len()) {
        return refuse(PostRefusal::MediaCount.code());
    }
    let mimes: Vec<&str> = materials.iter().map(|m| m.mime.as_str()).collect();
    if !media_types_ok(p.format, &kind, &mimes) {
        return refuse(PostRefusal::MediaType.code());
    }
    let blocked = super::library::blocked_derivatives(r).await?;
    if materials.iter().any(|m| blocked.contains(&m.id)) {
        return refuse("source_permission_restricted");
    }
    if p.format == PostFormat::Story
        && let Some(refusal) = story_refusal(d, r, &materials[0]).await?
    {
        return refuse(refusal.code());
    }
    let refs: Vec<&Material> = materials.iter().collect();
    match piece_roles(&refs, &p.subject, &lib.context(p.publish_at)) {
        Ok(_) => {}
        Err(PieceRefusal::NoAnchor) => return refuse("no_eligible_material"),
        Err(PieceRefusal::Refused(list)) => {
            return Ok(Err(ItemRefusal {
                index: 0,
                reason: "material_refused",
                extra: json!({"refusals": list.iter()
                    .map(|(id, x)| json!({"material_id": id, "code": x.code()}))
                    .collect::<Vec<_>>()}),
            }));
        }
    }
    Ok(Ok(Checked {
        capability: c,
        content_type,
        arm,
    }))
}

// ---------------------------------------------------------------------------------------------
// studio.posts_list
// ---------------------------------------------------------------------------------------------

/// `studio.posts_list`'s window: posts whose `publish_at` is in `[from, until)`, every bound
/// optional.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostsQuery {
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub from: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub until: Option<OffsetDateTime>,
}

/// The planned posts with their slots, and the posting settings they were planned under.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostsOut {
    pub posts: Vec<PostOut>,
    pub settings: PostingSettings,
}

/// The planned posts, by `publish_at`, each with its slot and whether it is pending: a post
/// before its preparation start is listed here only (spec §14.3).
pub async fn posts_list(d: &Deps, ctx: &Ctx, q: PostsQuery) -> Result<PostsOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.posts_list",
    ))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.posts_list"),
    )
    .await?;
    let mut posts = Vec::new();
    for p in r.studio_posts().list_posts().await? {
        if q.from.is_some_and(|f| p.publish_at < f) || q.until.is_some_and(|u| p.publish_at >= u) {
            continue;
        }
        let slot = r
            .studio()
            .get_slot(p.slot_id)
            .await?
            .ok_or_else(|| AppError::internal("a post's slot is missing"))?;
        posts.push(post_out(p, slot, ctx.now));
    }
    Ok(PostsOut {
        posts,
        settings: r.studio_posts().posting_settings().await?,
    })
}

// ---------------------------------------------------------------------------------------------
// studio.weekly_summary
// ---------------------------------------------------------------------------------------------

/// `studio.weekly_summary`'s week: its Monday in the posting policy's zone, this week's when left
/// out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SummaryQuery {
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub week: Option<Date>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SummaryPublished {
    pub slot_id: SlotId,
    pub publication_id: PublicationId,
    pub capability_id: CapabilityId,
    /// Its post's format; none for a publication of the weekly quotas.
    pub format: Option<PostFormat>,
    #[serde(with = "time::serde::rfc3339")]
    pub published_at: OffsetDateTime,
    pub url: Option<Url>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SummaryPlanned {
    pub slot_id: SlotId,
    pub capability_id: CapabilityId,
    pub format: PostFormat,
    #[serde(with = "time::serde::rfc3339")]
    pub publish_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub prep_start_at: OffsetDateTime,
    /// `planned` (no piece yet) or `ready`.
    pub state: SlotState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SummaryCancelled {
    pub slot_id: SlotId,
    pub capability_id: CapabilityId,
    /// Its post's format; none for a slot of the weekly quotas.
    pub format: Option<PostFormat>,
    /// Why: `missed_grace`, `cancelled`, `hypothesis_retired`, `strategy_archived`,
    /// `replanned`.
    pub reason: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// What a week brought (spec D32), from durable records: the posts published, those still
/// planned, those cancelled with their reason, and what each format earned per olay kind and
/// hypothesis so far (D31).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeeklySummaryOut {
    #[serde(with = "jt_studio::time_compat::date")]
    pub week_start: Date,
    pub tz: String,
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
    pub published: Vec<SummaryPublished>,
    pub planned: Vec<SummaryPlanned>,
    pub cancelled: Vec<SummaryCancelled>,
    pub scores: Vec<PostScore>,
}

/// The week of `q.week` (a Monday; `VALIDATION` `not_a_monday` otherwise) in the posting
/// policy's zone: publications, planned posts and cancellations within it.
pub async fn weekly_summary(
    d: &Deps,
    ctx: &Ctx,
    q: SummaryQuery,
) -> Result<WeeklySummaryOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.weekly_summary",
    ))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.weekly_summary"),
    )
    .await?;
    let settings = r.studio_posts().posting_settings().await?;
    let tz = zone_or_default(&settings.tz);
    let week_start = match q.week {
        Some(w) if monday(w) != w => {
            return Err(AppError::validation(
                "a week starts on a Monday",
                json!({"field": "week", "reason": "not_a_monday"}),
            ));
        }
        Some(w) => w,
        None => monday(local_day(tz, ctx.now)),
    };
    let from = day_start(tz, week_start);
    let until = day_start(tz, week_start + Duration::days(7));
    let posts = r.studio_posts().list_posts().await?;
    let post_of: BTreeMap<SlotId, &PlannedPost> = posts.iter().map(|p| (p.slot_id, p)).collect();
    let within = |at: OffsetDateTime| at >= from && at < until;

    let mut published: Vec<SummaryPublished> = r
        .studio()
        .list_publications()
        .await?
        .into_iter()
        .filter(|p| within(p.published_at))
        .map(|p| SummaryPublished {
            format: post_of.get(&p.slot_id).map(|x| x.format),
            slot_id: p.slot_id,
            publication_id: p.id,
            capability_id: p.capability_id,
            published_at: p.published_at,
            url: p.url,
        })
        .collect();
    published.sort_by_key(|p| (p.published_at, p.slot_id));

    let slots: BTreeMap<SlotId, Slot> = r
        .studio()
        .list_slots(SlotQuery {
            from,
            until,
            hypothesis_id: None,
            lane: None,
        })
        .await?
        .into_iter()
        .map(|s| (s.id, s))
        .collect();
    let mut planned = Vec::new();
    let mut cancelled = Vec::new();
    for p in &posts {
        if let Some(x) = p.retired {
            if within(x.at) {
                cancelled.push(SummaryCancelled {
                    slot_id: p.slot_id,
                    capability_id: p.capability_id,
                    format: Some(p.format),
                    reason: x.reason.code().into(),
                    at: x.at,
                });
            }
            continue;
        }
        if let Some(s) = slots.get(&p.slot_id)
            && within(p.publish_at)
            && matches!(s.state, SlotState::Planned | SlotState::Ready)
        {
            planned.push(SummaryPlanned {
                slot_id: p.slot_id,
                capability_id: p.capability_id,
                format: p.format,
                publish_at: p.publish_at,
                prep_start_at: p.prep_start_at,
                state: s.state,
            });
        }
    }
    // The weekly quotas' slots retired once for olay-driven publishing (D34) carry no post: the
    // ledger names them.
    let mut before = None;
    loop {
        let page = r
            .ledger()
            .list(LedgerFilter {
                action_prefix: Some("studio.slot.replanned".into()),
                actor_kind: None,
                agent_connection_id: None,
                limit: 500,
                before_id: before,
            })
            .await?;
        let Some(last) = page.last() else {
            break;
        };
        before = Some(last.id);
        for row in page {
            let e = row.entry;
            if !within(e.at) {
                continue;
            }
            let Some(id) = e
                .subject
                .as_ref()
                .and_then(|s| Uuid::parse_str(&s.id).ok())
                .map(SlotId)
            else {
                continue;
            };
            if let Some(s) = r.studio().get_slot(id).await? {
                cancelled.push(SummaryCancelled {
                    slot_id: id,
                    capability_id: s.capability_id,
                    format: None,
                    reason: RetirementReason::Replanned.code().into(),
                    at: e.at,
                });
            }
        }
    }
    cancelled.sort_by_key(|c| (c.at, c.slot_id));
    let lib_olays = r.studio_materials().list_olays().await?;
    let scores = post_scores(&outcomes(r.as_mut(), &posts, &lib_olays).await?);
    Ok(WeeklySummaryOut {
        week_start,
        tz: settings.tz,
        from,
        until,
        published,
        planned,
        cancelled,
        scores,
    })
}

// ---------------------------------------------------------------------------------------------
// studio.posting_policy_set
// ---------------------------------------------------------------------------------------------

/// An owner or manager, in person, sets the posting policy (spec D21, D24–D29): leads, graces,
/// caps and spacing, quiet hours, floor days, the debounce, the horizon, and the IANA zone they
/// are read in. `VALIDATION` naming the field otherwise. The ledger names the settings.
pub async fn posting_policy_set(
    d: &Deps,
    ctx: &Ctx,
    i: PostingSettings,
) -> Result<PostingSettings, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.posting_policy_set",
    ))?;
    human_approver(ctx)?;
    i.policy.validate().map_err(|e| {
        let field = match &e {
            StudioError::InvalidPlanning(f) => *f,
            _ => "policy",
        };
        AppError::validation(e.to_string(), json!({"field": field}))
    })?;
    if i.tz.len() > 64 || zone(&i.tz).is_none() {
        return Err(AppError::validation(
            "an IANA time zone, e.g. Europe/Istanbul",
            json!({"field": "tz"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.posting_policy_set"),
    )
    .await?;
    r.studio_control().lock_control().await?;
    // The paused accounts are `social.account_pause`'s: setting the policy keeps them, and
    // moves the settings' revision as every change does.
    let stored = r.studio_posts().posting_settings().await?;
    let i = PostingSettings {
        paused_capability_ids: stored.paused_capability_ids,
        revision: stored
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("posting settings revision overflow"))?,
        ..i
    };
    r.studio_posts().save_posting_settings(i.clone()).await?;
    let mut e = ledger_entry(
        ctx,
        "studio.posting_policy.set",
        "studio_posting_policy",
        ctx.workspace_id,
        json!({"policy": i.policy, "tz": i.tz}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(i)
}

#[cfg(test)]
mod label_need_tests {
    use super::*;

    #[test]
    fn shoot_request_need_includes_business_labels() {
        let need = SlotNeed::from_keys("boyama.label:fresh bread", "existing_segment");
        assert_eq!(need_text(&need), "boyama, fresh bread");
    }
}
