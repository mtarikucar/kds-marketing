//! Olay-driven publishing's records (spec 2026-11-03 §14): package requests, planned posts, the
//! media each format takes, the new retirement reasons and learning per format × olay kind.
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use time::macros::{date, datetime};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

fn now() -> OffsetDateTime {
    datetime!(2026-11-04 09:00 UTC)
}
fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

fn request(trigger: PackageTrigger) -> PackageRequest {
    PackageRequest {
        id: PackageRequestId(id(1)),
        workspace_id: WorkspaceId(id(2)),
        key: "olay:x:1".into(),
        trigger,
        status: PackageStatus::Open,
        olay_id: Some(OlayId(id(3))),
        occasion: None,
        year: None,
        capability_id: None,
        material_ids: vec![MaterialId(id(4))],
        best_formats: vec![],
        hints: PackageHints::default(),
        created_at: now(),
        answered_at: None,
        closed_at: None,
    }
}

#[test]
fn a_request_names_what_its_trigger_needs_and_a_status_its_time() {
    assert!(request(PackageTrigger::Olay).validate().is_ok());
    // A calendar request names its occasion, season year and olay; a floor one its channel and
    // one post.
    assert!(request(PackageTrigger::Calendar).validate().is_err());
    let calendar = PackageRequest {
        occasion: Some("yilbasi".into()),
        year: Some(2026),
        ..request(PackageTrigger::Calendar)
    };
    assert!(calendar.validate().is_ok());
    let floor = PackageRequest {
        olay_id: None,
        capability_id: Some(CapabilityId(id(9))),
        ..request(PackageTrigger::Floor)
    };
    assert!(floor.validate().is_err());
    let floor = PackageRequest {
        hints: PackageHints {
            max_posts: Some(1),
            ..Default::default()
        },
        ..floor
    };
    assert!(floor.validate().is_ok());
    assert!(floor.covers(CapabilityId(id(9))));
    assert!(!floor.covers(CapabilityId(id(10))));
    assert!(request(PackageTrigger::Olay).covers(CapabilityId(id(10))));
    // No materials, a repeated one, or a status without its time are refused.
    let mut r = request(PackageTrigger::Olay);
    r.material_ids.clear();
    assert!(r.validate().is_err());
    r.material_ids = vec![MaterialId(id(4)), MaterialId(id(4))];
    assert!(r.validate().is_err());
    let mut r = request(PackageTrigger::Olay);
    r.status = PackageStatus::Answered;
    assert!(r.validate().is_err());
    r.answered_at = Some(now());
    assert!(r.validate().is_ok());
    r.status = PackageStatus::Expired;
    assert!(r.validate().is_err());
    assert_eq!(
        request(PackageTrigger::Olay).expires_at(),
        now() + Duration::days(7)
    );
}

#[test]
fn request_keys_name_their_trigger() {
    let o = OlayId(id(3));
    let (a, b, c) = (MaterialId(id(4)), MaterialId(id(5)), MaterialId(id(6)));
    // An olay's request is named by its listed set, whatever its order, and by how many requests
    // of the olay came before it.
    let key = olay_package_key(o, 0, &[a, b]);
    assert!(key.starts_with(&format!("olay:{o}:0:")), "{key}");
    assert_eq!(key.len(), format!("olay:{o}:0:").len() + 16);
    assert_eq!(key, olay_package_key(o, 0, &[b, a]));
    assert_ne!(key, olay_package_key(o, 0, &[a, c]));
    assert_ne!(key, olay_package_key(o, 0, &[a]));
    assert_ne!(key, olay_package_key(o, 1, &[a, b]));
    assert_eq!(
        calendar_package_key("yilbasi", 2026),
        "calendar:yilbasi:2026"
    );
    let c = CapabilityId(id(9));
    assert_eq!(
        floor_package_key(c, date!(2026 - 11 - 04)),
        format!("floor:{c}:2026-11-04")
    );
}

#[test]
fn a_project_request_is_a_named_single_channel_generic_output() {
    let mut project = PackageRequest {
        key: format!("project:{}:{}", id(11), id(12)),
        olay_id: None,
        capability_id: Some(CapabilityId(id(9))),
        hints: PackageHints {
            max_posts: Some(1),
            subject: Some(Subject::Generic),
            ..Default::default()
        },
        ..request(PackageTrigger::Project)
    };
    assert!(project.validate().is_ok());
    assert_eq!(project.trigger.key(), "project");
    assert!(project.covers(CapabilityId(id(9))));
    assert!(!project.covers(CapabilityId(id(10))));
    project.key = "floor:not-a-project".into();
    assert!(project.validate().is_err());
    project.key = format!("project:{}:{}", id(11), id(12));
    project.olay_id = Some(OlayId(id(3)));
    assert!(project.validate().is_err());
    project.olay_id = None;
    project.hints.max_posts = Some(2);
    assert!(project.validate().is_err());
}

fn post() -> PlannedPost {
    PlannedPost {
        slot_id: SlotId(id(1)),
        workspace_id: WorkspaceId(id(2)),
        format: PostFormat::FeedPost,
        capability_id: CapabilityId(id(9)),
        publish_at: now() + Duration::days(2),
        prep_start_at: now() + Duration::days(1),
        grace_until: now() + Duration::days(2) + Duration::hours(6),
        olay_id: Some(OlayId(id(3))),
        package_request_id: PackageRequestId(id(5)),
        material_ids: vec![MaterialId(id(4))],
        subject: Subject::Olay {
            olay_id: OlayId(id(3)),
        },
        hypothesis_id: HypothesisId(id(6)),
        content_type: "bitmis_urun".into(),
        retired: None,
        created_at: now(),
    }
}

#[test]
fn a_post_prepares_before_and_slips_after_its_time_and_names_its_subjects_olay() {
    assert!(post().validate().is_ok());
    let mut p = post();
    p.prep_start_at = p.publish_at + Duration::minutes(1);
    assert!(p.validate().is_err());
    let mut p = post();
    p.grace_until = p.publish_at - Duration::minutes(1);
    assert!(p.validate().is_err());
    // A generic post has no olay; an olay post names its subject's.
    let mut p = post();
    p.subject = Subject::Generic;
    assert!(p.validate().is_err());
    p.olay_id = None;
    assert!(p.validate().is_ok());
    let mut p = post();
    p.material_ids = (0..11).map(|n| MaterialId(id(100 + n))).collect();
    assert!(p.validate().is_err());
}

#[test]
fn each_format_takes_the_media_its_adapter_publishes() {
    use PostFormat::*;
    let (png, mp4, webp) = ("image/png", "video/mp4", "image/webp");
    // One video on an Instagram feed post would go out as a reel.
    assert!(media_types_ok(FeedPost, "instagram", &[png]));
    assert!(!media_types_ok(FeedPost, "instagram", &[mp4]));
    assert!(media_types_ok(Reel, "instagram", &[mp4]));
    assert!(!media_types_ok(Reel, "instagram", &[png]));
    assert!(media_types_ok(Carousel, "instagram", &[png, mp4]));
    // A Facebook post is an image or a video; its carousel is images only.
    assert!(media_types_ok(FeedPost, "facebook_page", &[mp4]));
    assert!(!media_types_ok(Carousel, "facebook_page", &[png, mp4]));
    assert!(media_types_ok(Carousel, "facebook_page", &[png, png]));
    // X takes images; LinkedIn no WebP; TikTok a video.
    assert!(!media_types_ok(FeedPost, "x", &[mp4]));
    assert!(media_types_ok(FeedPost, "x", &[webp]));
    assert!(!media_types_ok(FeedPost, "linkedin_page", &[webp]));
    assert!(media_types_ok(FeedPost, "linkedin_member", &[mp4]));
    assert!(media_types_ok(TiktokVideo, "tiktok", &[mp4]));
    assert!(!media_types_ok(TiktokVideo, "tiktok", &[png]));
    // A story is an image or a video on Instagram (its own rule says which: a JPEG), nothing on
    // a Page; nothing for an unsupported pair or no media.
    assert!(media_types_ok(Story, "instagram", &[png]));
    assert!(!media_types_ok(Story, "facebook_page", &[png]));
    assert!(!media_types_ok(Reel, "facebook_page", &[mp4]));
    assert!(!media_types_ok(FeedPost, "x", &[]));
    assert_eq!(PostRefusal::MediaType.code(), "media_type");
}

fn slot(state: SlotState, revision: u64) -> Slot {
    Slot {
        id: SlotId(id(1)),
        chain: Chain {
            workspace_id: WorkspaceId(id(2)),
            born_version_id: jt_strategy::StrategyVersionId(id(3)),
            hypothesis_id: HypothesisId(id(4)),
            arm_id: ArmId(id(5)),
        },
        capability_id: CapabilityId(id(6)),
        scheduled_at: now(),
        state,
        revision,
    }
}

#[test]
fn replanned_and_missed_grace_retire_planned_and_ready_slots_only() {
    for reason in [RetirementReason::Replanned, RetirementReason::MissedGrace] {
        for (state, revision) in [(SlotState::Planned, 0), (SlotState::Ready, 1)] {
            let s = slot(state, revision);
            let out = transition_slot(
                &s,
                &SlotEvent::Retire { reason },
                &StudioPolicy {
                    expected_revision: revision,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(out.state, SlotState::Retired);
            assert_eq!(out.revision, revision + 1);
        }
        for state in [SlotState::Published, SlotState::Measured] {
            assert_eq!(
                transition_slot(
                    &slot(state, 2),
                    &SlotEvent::Retire { reason },
                    &StudioPolicy {
                        expected_revision: 2,
                        ..Default::default()
                    },
                ),
                Err(StudioError::InvalidTransition)
            );
        }
    }
    assert_eq!(RetirementReason::Replanned.code(), "replanned");
    assert_eq!(
        serde_json::to_value(RetirementReason::MissedGrace).unwrap(),
        "missed_grace"
    );
}

fn outcome(format: PostFormat, kind: Option<OlayKind>, h: u128, reward: f64) -> PostOutcome {
    PostOutcome {
        format,
        olay_kind: kind,
        hypothesis_id: HypothesisId(id(h)),
        reward,
    }
}

#[test]
fn formats_rank_by_their_mean_reward_for_the_olay_kind() {
    use PostFormat::*;
    let w = Some(OlayKind::Workshop);
    let outcomes = [
        outcome(FeedPost, w, 1, 0.1),
        outcome(Reel, w, 1, 0.4),
        outcome(Reel, w, 2, 0.2),
        outcome(Carousel, w, 2, 0.3),
        // Another kind and a generic post do not count for workshops.
        outcome(FeedPost, Some(OlayKind::Order), 1, 0.9),
        outcome(FeedPost, None, 1, 0.8),
        // A reward outside 0..=1 is ignored.
        outcome(Carousel, w, 1, f64::NAN),
    ];
    let scores = format_scores(&outcomes, w);
    // Reels and carousels tie at 0.3: more posts first. Stories are never measured (D60): never
    // ranked.
    assert_eq!(
        scores.iter().map(|s| s.format).collect::<Vec<_>>(),
        vec![Reel, Carousel, FeedPost, TiktokVideo]
    );
    assert_eq!(scores[0].posts, 2);
    assert!((scores[0].mean.unwrap() - 0.3).abs() < 1e-9);
    assert_eq!(scores[3].mean, None);
    // Nothing measured: the canonical order.
    assert_eq!(
        format_scores(&[], None)
            .iter()
            .map(|s| s.format)
            .collect::<Vec<_>>(),
        vec![FeedPost, Carousel, Reel, TiktokVideo]
    );
    // The table keeps format × olay kind × hypothesis apart.
    let table = post_scores(&outcomes);
    assert_eq!(table.len(), 6);
    let reel_1 = table
        .iter()
        .find(|s| s.format == Reel && s.hypothesis_id == HypothesisId(id(1)))
        .unwrap();
    assert_eq!((reel_1.posts, reel_1.olay_kind), (1, w));
}

#[test]
fn a_material_changes_when_added_and_when_its_permission_is_set() {
    let ws = WorkspaceId(id(2));
    let by = jt_tenancy::UserId(id(7));
    let mut m = Material {
        id: MaterialId(id(4)),
        workspace_id: ws,
        file_id: FileId(id(8)),
        mime: "image/png".into(),
        title: String::new(),
        origin: Origin::Real,
        binding: Binding::Olay {
            olay_id: OlayId(id(3)),
        },
        freed: None,
        share: None,
        tags: Tags::default(),
        tags_reviewed_by: None,
        people: Default::default(),
        captured_at: None,
        created_by: jt_ledger::Actor::Human { user_id: by },
        revision: 1,
        created_at: now(),
        erased_at: None,
    };
    assert_eq!(material_changed_at(&m), now());
    m.share = Some(ShareDecision {
        permission: SharePermission::Shareable,
        by: Some(by),
        at: now() + Duration::minutes(20),
    });
    assert_eq!(material_changed_at(&m), now() + Duration::minutes(20));
}
