//! Olay-driven publishing's pure rules (spec 2026-11-03 §14, D20–D30): post formats, the posting
//! policy, the formats each organic kind publishes and the validation of an agent's package.
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::*;
use time::macros::{datetime, offset};
use time::{Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

/// Wednesday 4 November 2026, 12:00 in Istanbul.
fn now() -> OffsetDateTime {
    datetime!(2026-11-04 09:00 UTC)
}
fn istanbul(_: OffsetDateTime) -> UtcOffset {
    offset!(+3)
}
fn channel(n: u128) -> CapabilityId {
    CapabilityId(Uuid::from_u128(n))
}

const INSTAGRAM: u128 = 10;
const FACEBOOK: u128 = 11;
const TIKTOK: u128 = 12;

fn kind_of(cap: u128) -> &'static str {
    match cap {
        INSTAGRAM => "instagram",
        FACEBOOK => "facebook_page",
        TIKTOK => "tiktok",
        _ => "x",
    }
}

/// A post of `format` on channel `cap` at `at`, with a valid media count.
fn post(format: PostFormat, cap: u128, at: OffsetDateTime) -> PlannedPostInput {
    let n = if format == PostFormat::Carousel { 3 } else { 1 };
    PlannedPostInput {
        format,
        capability_id: channel(cap),
        kind_key: kind_of(cap).into(),
        publish_at: at,
        material_ids: (0..n)
            .map(|i| MaterialId(Uuid::from_u128(500 + i)))
            .collect(),
        subject: Subject::Generic,
        hypothesis_id: HypothesisId(Uuid::from_u128(50)),
    }
}

fn existing(format: PostFormat, cap: u128, at: OffsetDateTime) -> ExistingPost {
    ExistingPost {
        format,
        capability_id: channel(cap),
        publish_at: at,
    }
}

fn validate(
    items: &[PlannedPostInput],
    existing: &[ExistingPost],
) -> Result<(), Vec<(usize, PostRefusal)>> {
    validate_with(items, existing, &PostingPolicy::default())
}

fn validate_with(
    items: &[PlannedPostInput],
    existing: &[ExistingPost],
    policy: &PostingPolicy,
) -> Result<(), Vec<(usize, PostRefusal)>> {
    validate_package(items, existing, now(), &istanbul, policy)
}

fn refused(items: &[PlannedPostInput], existing: &[ExistingPost]) -> Vec<(usize, PostRefusal)> {
    validate(items, existing).unwrap_err()
}

use PostFormat::{Carousel, FeedPost, Reel, Story, TiktokVideo};

#[test]
fn the_default_policy_is_the_specs() {
    let p = PostingPolicy::default();
    p.validate().unwrap();
    for (format, lead, grace) in [
        (Story, 2, 1),
        (FeedPost, 24, 6),
        (Carousel, 24, 6),
        (Reel, 48, 6),
        (TiktokVideo, 48, 6),
    ] {
        assert_eq!(p.lead(format), Duration::hours(lead), "{format:?}");
        assert_eq!(p.grace(format), Duration::hours(grace), "{format:?}");
    }
    let cap = |per_day, spacing_minutes| PostCap {
        per_day,
        spacing_minutes,
    };
    assert_eq!(p.cap(FeedPost), cap(2, 180));
    assert_eq!(p.cap(Carousel), cap(2, 180));
    assert_eq!(p.cap(Reel), cap(2, 180));
    assert_eq!(p.cap(Story), cap(25, 10));
    assert_eq!(p.cap(TiktokVideo), cap(3, 0));
    assert_eq!((p.quiet_start_hour, p.quiet_end_hour), (0, 8));
    assert_eq!(p.floor_days, 4);
    assert_eq!(p.debounce_minutes, 30);
    assert_eq!(p.horizon_days, 30);
    // A stored policy with fields missing reads them as the defaults.
    assert_eq!(
        serde_json::from_value::<PostingPolicy>(serde_json::json!({"floor_days": 4})).unwrap(),
        p
    );
}

#[test]
fn a_policy_out_of_bounds_is_refused() {
    let bad = |f: fn(&mut PostingPolicy)| {
        let mut p = PostingPolicy::default();
        f(&mut p);
        assert!(
            matches!(p.validate(), Err(StudioError::InvalidPlanning(_))),
            "{p:?}"
        );
    };
    bad(|p| p.quiet_end_hour = 24);
    bad(|p| p.quiet_start_hour = 25);
    bad(|p| p.feed_cap.per_day = 0);
    bad(|p| p.story_cap.spacing_minutes = 24 * 60 + 1);
    bad(|p| p.horizon_days = 0);
    bad(|p| p.floor_days = 0);
    bad(|p| p.lead_minutes.reel = 31 * 24 * 60);
    bad(|p| p.grace_minutes.feed_post = 24 * 60 + 1);
    bad(|p| p.debounce_minutes = 24 * 60 + 1);
    let mut wrapped = PostingPolicy {
        quiet_start_hour: 22,
        quiet_end_hour: 7,
        ..PostingPolicy::default()
    };
    wrapped.validate().unwrap();
    assert!(wrapped.is_quiet_hour(23) && wrapped.is_quiet_hour(0) && wrapped.is_quiet_hour(6));
    assert!(!wrapped.is_quiet_hour(7) && !wrapped.is_quiet_hour(21));
    wrapped.quiet_end_hour = 22;
    assert!((0..24).all(|h| !wrapped.is_quiet_hour(h)));
}

#[test]
fn formats_serialize_as_their_keys_and_three_are_feed_formats() {
    for (format, key, feed) in [
        (Story, "story", false),
        (FeedPost, "feed_post", true),
        (Carousel, "carousel", true),
        (Reel, "reel", true),
        (TiktokVideo, "tiktok_video", false),
    ] {
        assert_eq!(format.key(), key);
        assert_eq!(PostFormat::parse(key), Some(format));
        assert_eq!(serde_json::to_value(format).unwrap(), key);
        assert_eq!(format.is_feed(), feed, "{key}");
    }
    assert_eq!(PostFormat::ALL.len(), 5);
    assert_eq!(PostFormat::parse("stories"), None);
}

#[test]
fn each_organic_kind_takes_only_the_formats_its_adapter_publishes() {
    let organic = [
        "x",
        "instagram",
        "facebook_page",
        "tiktok",
        "linkedin_member",
        "linkedin_page",
    ];
    // Stories: Instagram's alone (its Content Publishing API, `media_type=STORIES`); a Facebook
    // Page's stories are not built.
    for kind in organic.iter().chain(&["pinterest", "meta_ads", "nope"]) {
        assert_eq!(
            supported_formats(kind).contains(&Story),
            *kind == "instagram",
            "{kind}"
        );
    }
    for kind in organic {
        assert_eq!(
            supported_formats(kind).contains(&FeedPost),
            kind != "tiktok",
            "{kind}"
        );
        assert_eq!(
            supported_formats(kind).contains(&TiktokVideo),
            kind == "tiktok",
            "{kind}"
        );
    }
    assert_eq!(supported_formats("tiktok"), [TiktokVideo]);
    assert_eq!(
        supported_formats("instagram"),
        [Story, FeedPost, Carousel, Reel]
    );
    assert_eq!(supported_formats("facebook_page"), [FeedPost, Carousel]);
    for kind in ["x", "linkedin_member", "linkedin_page"] {
        assert_eq!(supported_formats(kind), [FeedPost], "{kind}");
    }
    assert!(supported_formats("pinterest").is_empty());
}

#[test]
fn each_format_has_its_media_count() {
    for (format, ok, not) in [
        (Story, &[1][..], &[0, 2][..]),
        (FeedPost, &[1], &[0, 2]),
        (Carousel, &[2, 5, 10], &[0, 1, 11]),
        (Reel, &[1], &[0, 2]),
        (TiktokVideo, &[1], &[0, 2]),
    ] {
        for n in ok {
            assert!(media_count_ok(format, *n), "{format:?} {n}");
        }
        for n in not {
            assert!(!media_count_ok(format, *n), "{format:?} {n}");
        }
    }
}

#[test]
fn a_valid_package_passes_and_a_post_has_its_prep_start_and_grace() {
    let at = datetime!(2026-11-06 14:00 +3);
    let package = [
        post(FeedPost, INSTAGRAM, at),
        post(Carousel, FACEBOOK, at),
        post(Reel, INSTAGRAM, at + Duration::hours(3)),
        post(TiktokVideo, TIKTOK, at),
        post(FeedPost, 1, at),
    ];
    assert_eq!(validate(&package, &[]), Ok(()));
    assert_eq!(validate(&[], &[]), Ok(()));
    let p = PostingPolicy::default();
    assert_eq!(prep_start_at(Reel, at, &p), datetime!(2026-11-04 14:00 +3));
    assert_eq!(prep_start_at(Story, at, &p), datetime!(2026-11-06 12:00 +3));
    assert_eq!(grace_until(Story, at, &p), datetime!(2026-11-06 15:00 +3));
    assert_eq!(
        grace_until(TiktokVideo, at, &p),
        datetime!(2026-11-06 20:00 +3)
    );
}

#[test]
fn a_format_the_channel_does_not_publish_is_refused() {
    let at = datetime!(2026-11-06 10:00 +3);
    assert_eq!(
        refused(&[post(Story, FACEBOOK, at)], &[]),
        [(0, PostRefusal::FormatUnsupported)]
    );
    assert_eq!(validate(&[post(Story, INSTAGRAM, at)], &[]), Ok(()));
    assert_eq!(
        refused(
            &[
                post(FeedPost, TIKTOK, at),
                post(Reel, FACEBOOK, at),
                post(TiktokVideo, INSTAGRAM, at)
            ],
            &[]
        ),
        [
            (0, PostRefusal::FormatUnsupported),
            (1, PostRefusal::FormatUnsupported),
            (2, PostRefusal::FormatUnsupported)
        ]
    );
}

#[test]
fn a_post_closer_than_its_formats_lead_or_beyond_the_horizon_is_refused() {
    let lead = |format, cap, hours| post(format, cap, now() + Duration::hours(hours));
    assert_eq!(
        refused(&[lead(FeedPost, INSTAGRAM, 23)], &[]),
        [(0, PostRefusal::LeadTooShort)]
    );
    assert_eq!(
        refused(&[lead(TiktokVideo, TIKTOK, 47)], &[]),
        [(0, PostRefusal::LeadTooShort)]
    );
    assert_eq!(
        refused(&[lead(FeedPost, INSTAGRAM, -1)], &[]),
        [(0, PostRefusal::LeadTooShort)]
    );
    // Exactly the lead is enough (12:00 local is out of quiet hours).
    assert_eq!(validate(&[lead(FeedPost, INSTAGRAM, 24)], &[]), Ok(()));
    assert_eq!(validate(&[lead(Reel, INSTAGRAM, 48)], &[]), Ok(()));
    assert_eq!(validate(&[lead(FeedPost, INSTAGRAM, 30 * 24)], &[]), Ok(()));
    assert_eq!(
        refused(
            &[post(
                FeedPost,
                INSTAGRAM,
                now() + Duration::days(30) + Duration::minutes(1)
            )],
            &[]
        ),
        [(0, PostRefusal::BeyondHorizon)]
    );
}

#[test]
fn a_post_in_quiet_hours_is_refused() {
    assert_eq!(
        refused(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-06 03:00 +3))],
            &[]
        ),
        [(0, PostRefusal::QuietHours)]
    );
    assert_eq!(
        refused(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-06 07:59 +3))],
            &[]
        ),
        [(0, PostRefusal::QuietHours)]
    );
    // 08:00 local is 05:00 UTC: local time decides.
    assert_eq!(
        validate(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-06 05:00 UTC))],
            &[]
        ),
        Ok(())
    );
    assert_eq!(
        refused(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-06 23:30 UTC))],
            &[]
        ),
        [(0, PostRefusal::QuietHours)]
    );
}

#[test]
fn a_wrong_media_count_is_refused() {
    let at = datetime!(2026-11-06 10:00 +3);
    let with = |format, cap, ids: &[u128]| PlannedPostInput {
        material_ids: ids
            .iter()
            .map(|i| MaterialId(Uuid::from_u128(*i)))
            .collect(),
        ..post(format, cap, at)
    };
    for bad in [
        with(Carousel, INSTAGRAM, &[1]),
        with(Carousel, INSTAGRAM, &(1..=11).collect::<Vec<_>>()),
        with(Carousel, INSTAGRAM, &[1, 1]),
        with(FeedPost, INSTAGRAM, &[1, 2]),
        with(FeedPost, INSTAGRAM, &[]),
        with(TiktokVideo, TIKTOK, &[1, 2]),
    ] {
        assert_eq!(
            refused(std::slice::from_ref(&bad), &[]),
            [(0, PostRefusal::MediaCount)],
            "{:?} {:?}",
            bad.format,
            bad.material_ids
        );
    }
    assert_eq!(validate(&[with(Carousel, INSTAGRAM, &[1, 2])], &[]), Ok(()));
}

#[test]
fn twenty_stories_ten_minutes_apart_pass_and_the_twenty_sixth_breaks_the_cap() {
    // Stories are refused everywhere until a provider's stories are built (spec D30), so the
    // story caps are exercised on a channel kind that is made to take them.
    let start = datetime!(2026-11-06 09:00 +3);
    let stories = |n: i64| -> Vec<PlannedPostInput> {
        (0..n)
            .map(|i| post(Story, 1, start + Duration::minutes(10 * i)))
            .collect()
    };
    let refusals = refused(&stories(20), &[]);
    assert!(
        refusals
            .iter()
            .all(|(_, r)| *r == PostRefusal::FormatUnsupported),
        "only the format refuses: {refusals:?}"
    );
    assert_eq!(
        check_schedule(&stories(20), &[], &istanbul, &PostingPolicy::default()),
        Ok(())
    );
    assert_eq!(
        check_schedule(&stories(26), &[], &istanbul, &PostingPolicy::default()),
        Err(vec![(25, PostRefusal::CapPerDay)])
    );
    // Nine minutes apart is too close.
    let close = [
        post(Story, 1, start),
        post(Story, 1, start + Duration::minutes(9)),
    ];
    assert_eq!(
        check_schedule(&close, &[], &istanbul, &PostingPolicy::default()),
        Err(vec![(1, PostRefusal::Spacing)])
    );
}

#[test]
fn two_feed_posts_closer_than_three_hours_break_the_spacing() {
    let at = datetime!(2026-11-06 10:00 +3);
    assert_eq!(
        refused(
            &[
                post(FeedPost, INSTAGRAM, at),
                post(FeedPost, INSTAGRAM, at + Duration::hours(2))
            ],
            &[]
        ),
        [(1, PostRefusal::Spacing)]
    );
    // Against a post already planned, and in either order of the package.
    assert_eq!(
        refused(
            &[post(Carousel, INSTAGRAM, at + Duration::minutes(170))],
            &[existing(Reel, INSTAGRAM, at)]
        ),
        [(0, PostRefusal::Spacing)]
    );
    assert_eq!(
        refused(
            &[
                post(FeedPost, INSTAGRAM, at + Duration::hours(2)),
                post(FeedPost, INSTAGRAM, at)
            ],
            &[]
        ),
        [(0, PostRefusal::Spacing)]
    );
    // Exactly three hours, another channel, or a story beside a feed post: no conflict.
    assert_eq!(
        validate(
            &[
                post(FeedPost, INSTAGRAM, at),
                post(FeedPost, INSTAGRAM, at + Duration::hours(3)),
                post(FeedPost, FACEBOOK, at + Duration::hours(1)),
            ],
            &[existing(Story, INSTAGRAM, at + Duration::minutes(30))]
        ),
        Ok(())
    );
}

#[test]
fn the_daily_cap_counts_feed_formats_together_per_channel_and_local_day() {
    let at = datetime!(2026-11-06 09:00 +3);
    // Two feed posts already planned that day: a reel the same day is the third.
    assert_eq!(
        refused(
            &[post(Reel, INSTAGRAM, at + Duration::hours(8))],
            &[
                existing(FeedPost, INSTAGRAM, at),
                existing(Carousel, INSTAGRAM, at + Duration::hours(4)),
            ]
        ),
        [(0, PostRefusal::CapPerDay)]
    );
    // Within the package: the third feed format of the day.
    assert_eq!(
        refused(
            &[
                post(FeedPost, INSTAGRAM, at),
                post(Carousel, INSTAGRAM, at + Duration::hours(4)),
                post(Reel, INSTAGRAM, at + Duration::hours(8)),
            ],
            &[]
        ),
        [(2, PostRefusal::CapPerDay)]
    );
    // Another channel's posts, stories and the next day do not count.
    assert_eq!(
        validate(
            &[
                post(Reel, INSTAGRAM, at + Duration::hours(8)),
                post(FeedPost, INSTAGRAM, at + Duration::days(1)),
            ],
            &[
                existing(FeedPost, INSTAGRAM, at),
                existing(FeedPost, FACEBOOK, at + Duration::hours(4)),
                existing(Story, INSTAGRAM, at + Duration::hours(4)),
            ]
        ),
        Ok(())
    );
}

#[test]
fn the_day_of_the_cap_is_the_local_day() {
    // No quiet hours, so a post just after local midnight may be planned.
    let policy = PostingPolicy {
        quiet_start_hour: 0,
        quiet_end_hour: 0,
        ..PostingPolicy::default()
    };
    let planned = [
        existing(FeedPost, INSTAGRAM, datetime!(2026-11-07 10:00 +3)),
        existing(FeedPost, INSTAGRAM, datetime!(2026-11-07 14:00 +3)),
    ];
    // 22:30 UTC on the 7th is 01:30 on the 8th in Istanbul: another day.
    assert_eq!(
        validate_with(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-07 22:30 UTC))],
            &planned,
            &policy
        ),
        Ok(())
    );
    // 20:30 UTC is 23:30 the same Istanbul day.
    assert_eq!(
        validate_with(
            &[post(FeedPost, INSTAGRAM, datetime!(2026-11-07 20:30 UTC))],
            &planned,
            &policy
        ),
        Err(vec![(0, PostRefusal::CapPerDay)])
    );
}

#[test]
fn tiktok_takes_three_videos_a_day() {
    let at = datetime!(2026-11-07 10:00 +3);
    let videos: Vec<_> = (0..4)
        .map(|i| post(TiktokVideo, TIKTOK, at + Duration::minutes(i)))
        .collect();
    assert_eq!(validate(&videos[..3], &[]), Ok(()));
    assert_eq!(refused(&videos, &[]), [(3, PostRefusal::CapPerDay)]);
}

#[test]
fn the_package_is_refused_whole_with_a_reason_per_failing_item_only() {
    let at = datetime!(2026-11-06 10:00 +3);
    let mut one_medium_carousel = post(Carousel, INSTAGRAM, at);
    one_medium_carousel.material_ids.truncate(1);
    let package = [
        one_medium_carousel,
        // Valid: the refused carousel above does not count against its spacing.
        post(FeedPost, INSTAGRAM, at + Duration::hours(1)),
        post(FeedPost, INSTAGRAM, datetime!(2026-11-06 03:00 +3)),
        post(Story, FACEBOOK, at),
        post(FeedPost, INSTAGRAM, now() + Duration::hours(2)),
        post(FeedPost, INSTAGRAM, now() + Duration::days(40)),
    ];
    assert_eq!(
        refused(&package, &[]),
        [
            (0, PostRefusal::MediaCount),
            (2, PostRefusal::QuietHours),
            (3, PostRefusal::FormatUnsupported),
            (4, PostRefusal::LeadTooShort),
            (5, PostRefusal::BeyondHorizon),
        ]
    );
}

#[test]
fn refusal_codes_serialize_as_their_closed_names() {
    for (r, key) in [
        (PostRefusal::FormatUnsupported, "format_unsupported"),
        (PostRefusal::LeadTooShort, "lead_too_short"),
        (PostRefusal::BeyondHorizon, "beyond_horizon"),
        (PostRefusal::QuietHours, "quiet_hours"),
        (PostRefusal::CapPerDay, "cap_per_day"),
        (PostRefusal::Spacing, "spacing"),
        (PostRefusal::MediaCount, "media_count"),
    ] {
        assert_eq!(r.code(), key);
        assert_eq!(serde_json::to_value(r).unwrap(), key);
    }
}

/// Each post's hour and day are read at its own time in the zone (spec D51): across a change of
/// the clocks a post takes its own day's offset, not the proposal's.
#[test]
fn quiet_hours_and_days_are_read_at_each_posts_own_offset() {
    // Summer time (UTC+2) until 2026-10-25 01:00 UTC, winter time (UTC+1) after.
    let berlin = |at: OffsetDateTime| {
        if at < datetime!(2026-10-25 01:00 UTC) {
            offset!(+2)
        } else {
            offset!(+1)
        }
    };
    let proposed = datetime!(2026-10-22 10:00 UTC);
    let policy = PostingPolicy::default();
    // 06:30 UTC on 27 October is 07:30 local: quiet, though 08:30 at the proposal's offset.
    let quiet = [post(FeedPost, 1, datetime!(2026-10-27 06:30 UTC))];
    assert_eq!(
        validate_package(&quiet, &[], proposed, &berlin, &policy),
        Err(vec![(0, PostRefusal::QuietHours)])
    );
    let fine = [post(FeedPost, 1, datetime!(2026-10-27 07:30 UTC))];
    assert_eq!(
        validate_package(&fine, &[], proposed, &berlin, &policy),
        Ok(())
    );
    // 23:30 UTC on 24 October is 01:30 on the 25th in summer time: quiet.
    let summer_night = [post(FeedPost, 1, datetime!(2026-10-24 23:30 UTC))];
    assert_eq!(
        validate_package(&summer_night, &[], proposed, &berlin, &policy),
        Err(vec![(0, PostRefusal::QuietHours)])
    );
    let day = |hour: u8| datetime!(2026-10-27 00:00 UTC) + Duration::hours(i64::from(hour));
    // A local day's cap, in winter time: 09:00, 13:00 and 17:00 on 27 October are 08:00,
    // 12:00 and 16:00 UTC.
    let three = [
        post(FeedPost, 1, day(8)),
        post(FeedPost, 1, day(12)),
        post(FeedPost, 1, day(16)),
    ];
    assert_eq!(
        check_schedule(&three, &[], &berlin, &policy),
        Err(vec![(2, PostRefusal::CapPerDay)])
    );
}

/// An Instagram story is one image or one video (the count is one); its own media rules say
/// what to fix: a JPEG only, at most 8 MB; an MP4 of 3 to 60 seconds, at most 100 MB.
#[test]
fn a_story_takes_one_jpeg_up_to_8_mb_or_one_video_of_3_to_60_seconds() {
    assert!(media_types_ok(Story, "instagram", &["image/jpeg"]));
    assert!(media_types_ok(Story, "instagram", &["video/mp4"]));
    // A PNG is a story's image type to fix, named by its own rule below.
    assert!(media_types_ok(Story, "instagram", &["image/png"]));
    assert!(!media_types_ok(Story, "facebook_page", &["image/jpeg"]));
    assert!(!media_types_ok(Story, "x", &["image/jpeg"]));
    let mb = 1_000_000;
    assert_eq!(story_media_refusal("image/jpeg", 8 * mb, None, true), None);
    assert_eq!(
        story_media_refusal("image/png", mb, None, true),
        Some(StoryMediaRefusal::ImageJpegOnly)
    );
    assert_eq!(
        story_media_refusal("image/jpeg", 8 * mb + 1, None, true),
        Some(StoryMediaRefusal::ImageTooLarge)
    );
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, Some(3_000), true),
        None
    );
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, Some(60_000), true),
        None
    );
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, Some(2_999), true),
        Some(StoryMediaRefusal::VideoLength)
    );
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, Some(60_001), true),
        Some(StoryMediaRefusal::VideoLength)
    );
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, None, false),
        Some(StoryMediaRefusal::VideoLengthUnknown)
    );
    assert_eq!(
        story_media_refusal("video/mp4", 100 * mb + 1, Some(10_000), true),
        Some(StoryMediaRefusal::VideoTooLarge)
    );
    // Meta reads a video's `moov` box at its front ("fast start"): one after the media data is
    // refused, saying how to export it.
    assert_eq!(
        story_media_refusal("video/mp4", 10 * mb, Some(10_000), false),
        Some(StoryMediaRefusal::VideoNotFastStart)
    );
    for (r, code) in [
        (
            StoryMediaRefusal::VideoNotFastStart,
            "story_video_not_fast_start",
        ),
        (StoryMediaRefusal::ImageJpegOnly, "story_image_jpeg_only"),
        (StoryMediaRefusal::ImageTooLarge, "story_image_too_large"),
        (StoryMediaRefusal::VideoTooLarge, "story_video_too_large"),
        (StoryMediaRefusal::VideoLength, "story_video_length"),
        (
            StoryMediaRefusal::VideoLengthUnknown,
            "story_video_length_unknown",
        ),
    ] {
        assert_eq!(r.code(), code);
    }
}
