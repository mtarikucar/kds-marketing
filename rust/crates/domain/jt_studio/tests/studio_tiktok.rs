//! The TikTok posting screen's rules (TikTok's Content Sharing Guidelines,
//! <https://developers.tiktok.com/doc/content-sharing-guidelines>): only a human's choice made
//! against the account's fresh `creator_info` is posted, and only after they consent.
use jt_studio::*;
use jt_tenancy::UserId;
use time::macros::datetime;

fn creator() -> TiktokCreator {
    TiktokCreator {
        nickname: Some("Jeeta Test".into()),
        username: Some("jeeta_test".into()),
        avatar_url: Some("https://p16.tiktokcdn.test/avatar.jpeg".parse().unwrap()),
        privacy_level_options: vec![
            "PUBLIC_TO_EVERYONE".into(),
            "MUTUAL_FOLLOW_FRIENDS".into(),
            "SELF_ONLY".into(),
        ],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: Some(600),
        cannot_post: None,
    }
}

/// What the screen starts from: nothing chosen but the privacy (which has no default).
fn post(privacy: &str) -> TiktokPost {
    TiktokPost {
        mode: TiktokPostMode::DirectPost,
        title: "Bugünün menüsü #yemek".into(),
        privacy_level: privacy.into(),
        allow_comment: false,
        allow_duet: false,
        allow_stitch: false,
        disclose_commercial: false,
        your_brand: false,
        branded_content: false,
    }
}

fn video(seconds: u64) -> TiktokMedia {
    TiktokMedia::Video {
        duration_ms: Some(seconds * 1000),
    }
}

#[test]
fn only_tiktok_pieces_pass_a_posting_screen() {
    assert!(requires_posting_screen("tiktok"));
    for kind in [
        "x",
        "instagram",
        "facebook_page",
        "linkedin_member",
        "linkedin_page",
        "meta_ads",
        "TikTok",
        "",
    ] {
        assert!(!requires_posting_screen(kind), "{kind}");
    }
}

#[test]
fn a_chosen_privacy_among_the_fresh_options_is_postable() {
    for privacy in ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] {
        assert_eq!(
            post(privacy).check(&creator(), &video(30)),
            Ok(()),
            "{privacy}"
        );
    }
    // No default: a privacy left unchosen is refused, and so is one the account is not offered
    // (a private account is offered followers, not everyone).
    assert_eq!(
        post("").check(&creator(), &video(30)),
        Err(TiktokPostRefusal::PrivacyNotChosen)
    );
    assert_eq!(
        post(" ").check(&creator(), &video(30)),
        Err(TiktokPostRefusal::PrivacyNotChosen)
    );
    assert_eq!(
        post("FOLLOWER_OF_CREATOR").check(&creator(), &video(30)),
        Err(TiktokPostRefusal::PrivacyNotOffered)
    );
    assert_eq!(
        post("public_to_everyone").check(&creator(), &video(30)),
        Err(TiktokPostRefusal::PrivacyNotOffered)
    );
}

#[test]
fn an_account_that_cannot_post_now_is_refused() {
    let busy = TiktokCreator {
        cannot_post: Some("spam_risk_too_many_posts".into()),
        ..creator()
    };
    assert_eq!(
        post("PUBLIC_TO_EVERYONE").check(&busy, &video(30)),
        Err(TiktokPostRefusal::CannotPostNow)
    );
    assert_eq!(
        post("PUBLIC_TO_EVERYONE").check_postable(&busy, &video(30)),
        Err(TiktokPostRefusal::CannotPostNow)
    );
}

#[test]
fn branded_content_is_never_private() {
    let branded = TiktokPost {
        disclose_commercial: true,
        branded_content: true,
        ..post("SELF_ONLY")
    };
    assert_eq!(
        branded.check(&creator(), &video(30)),
        Err(TiktokPostRefusal::BrandedContentPrivate)
    );
    for privacy in ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"] {
        let public = TiktokPost {
            privacy_level: privacy.into(),
            ..branded.clone()
        };
        assert_eq!(public.check(&creator(), &video(30)), Ok(()), "{privacy}");
    }
    // Promoting one's own brand may stay private.
    let own = TiktokPost {
        disclose_commercial: true,
        your_brand: true,
        ..post("SELF_ONLY")
    };
    assert_eq!(own.check(&creator(), &TiktokMedia::Photos), Ok(()));
}

#[test]
fn a_disclosed_commercial_post_names_whom_it_promotes() {
    let unspecified = TiktokPost {
        disclose_commercial: true,
        ..post("PUBLIC_TO_EVERYONE")
    };
    assert_eq!(
        unspecified.check(&creator(), &video(30)),
        Err(TiktokPostRefusal::CommercialUnspecified)
    );
    // A box only counts with the disclosure turned on.
    for (your_brand, branded_content) in [(true, false), (false, true), (true, true)] {
        let hidden = TiktokPost {
            your_brand,
            branded_content,
            ..post("PUBLIC_TO_EVERYONE")
        };
        assert_eq!(
            hidden.check(&creator(), &video(30)),
            Err(TiktokPostRefusal::CommercialNotDisclosed)
        );
        let disclosed = TiktokPost {
            disclose_commercial: true,
            ..hidden
        };
        assert_eq!(disclosed.check(&creator(), &video(30)), Ok(()));
        let flags = disclosed.flags(&creator());
        assert_eq!(flags.brand_organic_toggle, your_brand);
        assert_eq!(flags.brand_content_toggle, branded_content);
    }
}

#[test]
fn interactions_are_off_unless_allowed_and_never_over_the_creators_settings() {
    let none = post("PUBLIC_TO_EVERYONE");
    assert_eq!(
        none.flags(&creator()),
        TiktokPostFlags {
            disable_comment: true,
            disable_duet: true,
            disable_stitch: true,
            brand_content_toggle: false,
            brand_organic_toggle: false,
        }
    );
    let all = TiktokPost {
        allow_comment: true,
        allow_duet: true,
        allow_stitch: true,
        ..none
    };
    let flags = all.flags(&creator());
    assert!(!flags.disable_comment && !flags.disable_duet && !flags.disable_stitch);
    // The screen greys out what the creator turned off: allowing it is refused there ...
    for off in ["comment", "duet", "stitch"] {
        let account = TiktokCreator {
            comment_disabled: off == "comment",
            duet_disabled: off == "duet",
            stitch_disabled: off == "stitch",
            ..creator()
        };
        assert_eq!(
            all.check(&account, &video(30)),
            Err(TiktokPostRefusal::InteractionDisabled),
            "{off}"
        );
        // ... and once approved, a setting the creator turned off since is sent off.
        assert_eq!(all.check_postable(&account, &video(30)), Ok(()), "{off}");
        let flags = all.flags(&account);
        assert_eq!(
            (
                flags.disable_comment,
                flags.disable_duet,
                flags.disable_stitch
            ),
            (off == "comment", off == "duet", off == "stitch"),
        );
    }
}

#[test]
fn photo_posts_offer_comments_only() {
    let comment = TiktokPost {
        allow_comment: true,
        ..post("PUBLIC_TO_EVERYONE")
    };
    assert_eq!(comment.check(&creator(), &TiktokMedia::Photos), Ok(()));
    for (duet, stitch) in [(true, false), (false, true)] {
        let photo = TiktokPost {
            allow_duet: duet,
            allow_stitch: stitch,
            ..comment.clone()
        };
        assert_eq!(
            photo.check(&creator(), &TiktokMedia::Photos),
            Err(TiktokPostRefusal::PhotoInteraction)
        );
    }
}

#[test]
fn a_video_longer_than_the_account_may_post_is_refused() {
    let choice = post("PUBLIC_TO_EVERYONE");
    assert_eq!(choice.check(&creator(), &video(600)), Ok(()));
    let long = TiktokMedia::Video {
        duration_ms: Some(600_001),
    };
    assert_eq!(
        choice.check(&creator(), &long),
        Err(TiktokPostRefusal::VideoTooLong)
    );
    assert_eq!(
        choice.check_postable(&creator(), &long),
        Err(TiktokPostRefusal::VideoTooLong)
    );
    // A length that could not be read, or no limit named, leaves the check to TikTok.
    let unread = TiktokMedia::Video { duration_ms: None };
    assert_eq!(choice.check(&creator(), &unread), Ok(()));
    let unlimited = TiktokCreator {
        max_video_post_duration_sec: None,
        ..creator()
    };
    assert_eq!(choice.check(&unlimited, &long), Ok(()));
}

#[test]
fn the_caption_fits_tiktoks_limit_in_utf16_units() {
    let with = |title: String| TiktokPost {
        title,
        ..post("PUBLIC_TO_EVERYONE")
    };
    assert_eq!(
        with("ş".repeat(MAX_TIKTOK_TITLE_UNITS)).check(&creator(), &video(1)),
        Ok(())
    );
    // An emoji outside the BMP is two units.
    assert_eq!(
        with("😀".repeat(1101)).check(&creator(), &video(1)),
        Err(TiktokPostRefusal::TitleTooLong)
    );
    assert_eq!(
        with("a".repeat(MAX_TIKTOK_DESCRIPTION_UNITS)).check(&creator(), &TiktokMedia::Photos),
        Ok(())
    );
    assert_eq!(
        with("a".repeat(MAX_TIKTOK_DESCRIPTION_UNITS + 1)).check(&creator(), &TiktokMedia::Photos),
        Err(TiktokPostRefusal::TitleTooLong)
    );
    assert_eq!(TiktokMedia::Photos.max_title_units(), 4000);
    assert_eq!(video(1).max_title_units(), 2200);
}

#[test]
fn refusals_read_as_stable_reasons() {
    for (refusal, reason) in [
        (TiktokPostRefusal::CannotPostNow, "tiktok_cannot_post_now"),
        (
            TiktokPostRefusal::PrivacyNotChosen,
            "tiktok_privacy_not_chosen",
        ),
        (
            TiktokPostRefusal::PrivacyNotOffered,
            "tiktok_privacy_not_offered",
        ),
        (
            TiktokPostRefusal::BrandedContentPrivate,
            "tiktok_branded_content_private",
        ),
        (
            TiktokPostRefusal::CommercialUnspecified,
            "tiktok_commercial_unspecified",
        ),
        (
            TiktokPostRefusal::CommercialNotDisclosed,
            "tiktok_commercial_not_disclosed",
        ),
        (
            TiktokPostRefusal::InteractionDisabled,
            "tiktok_interaction_disabled",
        ),
        (
            TiktokPostRefusal::PhotoInteraction,
            "tiktok_photo_interaction",
        ),
        (TiktokPostRefusal::VideoTooLong, "tiktok_video_too_long"),
        (TiktokPostRefusal::TitleTooLong, "tiktok_title_too_long"),
        (TiktokPostRefusal::DraftSettings, "tiktok_draft_settings"),
    ] {
        assert_eq!(refusal.reason(), reason);
        assert_eq!(refusal.to_string(), reason);
    }
}

#[test]
fn a_choice_reads_back_strictly() {
    let choice = TiktokPost {
        allow_comment: true,
        disclose_commercial: true,
        your_brand: true,
        ..post("MUTUAL_FOLLOW_FRIENDS")
    };
    let json = serde_json::to_value(&choice).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "mode": "direct_post",
            "title": "Bugünün menüsü #yemek",
            "privacy_level": "MUTUAL_FOLLOW_FRIENDS",
            "allow_comment": true,
            "allow_duet": false,
            "allow_stitch": false,
            "disclose_commercial": true,
            "your_brand": true,
            "branded_content": false,
        })
    );
    assert_eq!(
        serde_json::from_value::<TiktokPost>(json.clone()).unwrap(),
        choice
    );
    let mut extra = json.clone();
    extra["auto_add_music"] = true.into();
    assert!(serde_json::from_value::<TiktokPost>(extra).is_err());
    // A choice recorded before drafts existed was a direct post.
    let mut before = json;
    before.as_object_mut().unwrap().remove("mode");
    assert_eq!(
        serde_json::from_value::<TiktokPost>(before).unwrap().mode,
        TiktokPostMode::DirectPost
    );
    assert_eq!(
        serde_json::to_value(TiktokPostMode::Draft).unwrap(),
        serde_json::json!("draft")
    );
    assert_eq!(
        serde_json::to_value(TiktokMedia::Photos).unwrap(),
        serde_json::json!({ "kind": "photos" })
    );
    assert_eq!(
        serde_json::to_value(video(2)).unwrap(),
        serde_json::json!({ "kind": "video", "duration_ms": 2000 })
    );
}

#[test]
fn an_approval_carries_the_posting_screens_choice_only_when_one_was_made() {
    let plain = ApprovalReceipt {
        revision: 2,
        by: UserId::new_v7(),
        at: datetime!(2026-10-28 9:00 UTC),
        tiktok: None,
    };
    let json = serde_json::to_value(&plain).unwrap();
    // Receipts written before the screen existed read back unchanged.
    assert!(json.get("tiktok").is_none(), "{json}");
    assert_eq!(
        serde_json::from_value::<ApprovalReceipt>(json).unwrap(),
        plain
    );
    let posted = ApprovalReceipt {
        tiktok: Some(post("SELF_ONLY")),
        ..plain.clone()
    };
    let back: ApprovalReceipt =
        serde_json::from_value(serde_json::to_value(&posted).unwrap()).unwrap();
    assert_eq!(back, posted);

    // A posting screen is required whatever the approval policy: a plain approval does not do.
    let mut policy = StudioPolicy {
        expected_revision: 2,
        posting_screen_required: true,
        ..Default::default()
    };
    assert_eq!(
        policy.check_approval(2),
        Err(StudioError::PostingScreenRequired)
    );
    policy.approval = Some(plain);
    assert_eq!(
        policy.check_approval(2),
        Err(StudioError::PostingScreenRequired)
    );
    policy.approval = Some(posted);
    assert_eq!(policy.check_approval(2), Ok(()));
    // Bound to its revision, like every approval.
    assert_eq!(
        policy.check_approval(3),
        Err(StudioError::PostingScreenRequired)
    );
}

// ---------------------------------------------------------------------------------------------
// A video's length, read from its MP4 boxes
// ---------------------------------------------------------------------------------------------

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn ftyp() -> Vec<u8> {
    mp4_box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41")
}

/// An `mvhd` of version 0 with `timescale` and `duration`.
fn mvhd0(timescale: u32, duration: u32) -> Vec<u8> {
    let mut p = vec![0, 0, 0, 0];
    p.extend_from_slice(&[0; 8]);
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&duration.to_be_bytes());
    p.extend_from_slice(&[0; 80]);
    mp4_box(b"mvhd", &p)
}

fn mvhd1(timescale: u32, duration: u64) -> Vec<u8> {
    let mut p = vec![1, 0, 0, 0];
    p.extend_from_slice(&[0; 16]);
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&duration.to_be_bytes());
    p.extend_from_slice(&[0; 80]);
    mp4_box(b"mvhd", &p)
}

fn mp4(parts: &[Vec<u8>]) -> MediaUpload {
    MediaUpload {
        bytes: parts.concat(),
        mime: "video/mp4".into(),
        filename: "clip.mp4".into(),
    }
}

#[test]
fn a_videos_length_is_read_from_its_movie_header() {
    let moov = mp4_box(b"moov", &mvhd0(1000, 15_000));
    assert_eq!(mp4(&[ftyp(), moov]).video_duration_ms(), Some(15_000));
    // After the media data, as most encoders write it; a 90 kHz timescale.
    let moov = mp4_box(b"moov", &mvhd0(90_000, 2_700_000));
    let mdat = mp4_box(b"mdat", &[7; 64]);
    assert_eq!(mp4(&[ftyp(), mdat, moov]).video_duration_ms(), Some(30_000));
    // Version 1 headers carry 64-bit durations.
    let moov = mp4_box(b"moov", &mvhd1(600, 600 * 3600));
    assert_eq!(mp4(&[ftyp(), moov]).video_duration_ms(), Some(3_600_000));
    // A 64-bit box size.
    let mut large = 1u32.to_be_bytes().to_vec();
    large.extend_from_slice(b"free");
    large.extend_from_slice(&24u64.to_be_bytes());
    large.extend_from_slice(&[0; 8]);
    let moov = mp4_box(b"moov", &mvhd0(1000, 5_000));
    assert_eq!(mp4(&[ftyp(), large, moov]).video_duration_ms(), Some(5_000));
    // A media type compared as uploads are.
    let mut upload = mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(1000, 1_000))]);
    upload.mime = " Video/MP4 ".into();
    assert_eq!(upload.video_duration_ms(), Some(1_000));
}

#[test]
fn a_fragmented_videos_length_is_read_from_its_extends_header() {
    let mut mehd = vec![0, 0, 0, 0];
    mehd.extend_from_slice(&42_000u32.to_be_bytes());
    let mvex = mp4_box(b"mvex", &mp4_box(b"mehd", &mehd));
    let moov = mp4_box(b"moov", &[mvhd0(1000, 0), mvex].concat());
    assert_eq!(mp4(&[ftyp(), moov]).video_duration_ms(), Some(42_000));
}

#[test]
fn a_length_that_cannot_be_read_is_unknown() {
    let image = MediaUpload {
        mime: "image/png".into(),
        ..mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(1000, 1_000))])
    };
    for upload in [
        image,
        // Not an MP4 at all.
        MediaUpload {
            bytes: vec![7; 4096],
            mime: "video/mp4".into(),
            filename: "x.mp4".into(),
        },
        // No movie box; an empty one; a zero timescale; an unknown or zero duration.
        mp4(&[ftyp()]),
        mp4(&[ftyp(), mp4_box(b"moov", &[])]),
        mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(0, 1_000))]),
        mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(1000, u32::MAX))]),
        mp4(&[ftyp(), mp4_box(b"moov", &mvhd1(1000, u64::MAX))]),
        mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(1000, 0))]),
        // A header cut short, a box claiming more bytes than there are, or fewer than its own.
        mp4(&[ftyp(), mp4_box(b"moov", &mvhd0(1000, 1_000)[..20])]),
        mp4(&[ftyp(), {
            let mut b = mp4_box(b"moov", &mvhd0(1000, 1_000));
            b[..4].copy_from_slice(&10_000u32.to_be_bytes());
            b
        }]),
        mp4(&[ftyp(), {
            let mut b = mp4_box(b"moov", &mvhd0(1000, 1_000));
            b[..4].copy_from_slice(&4u32.to_be_bytes());
            b
        }]),
    ] {
        assert_eq!(upload.video_duration_ms(), None, "{upload:?}");
    }
}

/// A draft (the Content Posting API's upload, <https://developers.tiktok.com/doc/content-posting-api-reference-upload-video>)
/// carries only what TikTok takes for it: nothing with a video, a caption with photos. Privacy,
/// interactions and the commercial content disclosure are the Direct Post's.
fn draft(title: &str) -> TiktokPost {
    TiktokPost {
        mode: TiktokPostMode::Draft,
        title: title.into(),
        ..post("")
    }
}

#[test]
fn a_draft_carries_only_what_tiktok_takes_for_it() {
    // No privacy to choose, whatever the account offers.
    let account = TiktokCreator {
        privacy_level_options: vec![],
        ..creator()
    };
    assert_eq!(draft("").check(&account, &video(30)), Ok(()));
    assert_eq!(
        draft("Bugünün menüsü #yemek").check(&account, &TiktokMedia::Photos),
        Ok(())
    );
    // A video draft takes no caption: it is written in TikTok.
    assert_eq!(
        draft("Bugünün menüsü").check(&account, &video(30)),
        Err(TiktokPostRefusal::DraftSettings)
    );
    for settings in [
        TiktokPost {
            privacy_level: "SELF_ONLY".into(),
            ..draft("")
        },
        TiktokPost {
            allow_comment: true,
            ..draft("")
        },
        TiktokPost {
            allow_duet: true,
            ..draft("")
        },
        TiktokPost {
            allow_stitch: true,
            ..draft("")
        },
        TiktokPost {
            disclose_commercial: true,
            your_brand: true,
            ..draft("")
        },
        TiktokPost {
            branded_content: true,
            ..draft("")
        },
    ] {
        assert_eq!(
            settings.check(&account, &video(30)),
            Err(TiktokPostRefusal::DraftSettings),
            "{settings:?}"
        );
        assert_eq!(
            settings.check_postable(&account, &video(30)),
            Err(TiktokPostRefusal::DraftSettings),
            "{settings:?}"
        );
    }
    // The account's own limits still hold.
    let busy = TiktokCreator {
        cannot_post: Some("spam_risk_user_banned_from_posting".into()),
        ..creator()
    };
    assert_eq!(
        draft("").check(&busy, &video(30)),
        Err(TiktokPostRefusal::CannotPostNow)
    );
    assert_eq!(
        draft("").check(&account, &video(601)),
        Err(TiktokPostRefusal::VideoTooLong)
    );
    assert_eq!(
        draft(&"a".repeat(MAX_TIKTOK_DESCRIPTION_UNITS + 1)).check(&account, &TiktokMedia::Photos),
        Err(TiktokPostRefusal::TitleTooLong)
    );
    assert!(draft("").is_draft() && !post("SELF_ONLY").is_draft());
}
