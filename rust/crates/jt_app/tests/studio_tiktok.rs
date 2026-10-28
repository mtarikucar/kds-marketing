//! The TikTok posting screen (TikTok's Content Sharing Guidelines,
//! <https://developers.tiktok.com/doc/content-sharing-guidelines>): a TikTok piece is published
//! only once a human passed the screen, whatever the lane's approval policy; the screen reads the
//! account fresh each time; the choice is checked against a fresh read again before it is
//! accepted, and nothing reaches TikTok before that; the post then goes out as chosen.
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{
        UnitOfWork,
        connectors::{
            AccountMetrics, MediaUpload, PostMetrics, PublishReceipt, PublishResolution,
            RecentPost, TiktokCreator, TiktokMedia, TiktokPost, TiktokPostMode,
        },
        studio::*,
    },
    usecases::{
        jobs::Job,
        studio::{
            control::{ApprovalInput, approve},
            measure::measure_due,
            pieces::{PieceInput, piece_submit},
            publish::publish_due,
            tiktok::{MetricsSource, TiktokPostInput, tiktok_metrics, tiktok_post, tiktok_posting},
            work,
        },
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_strategy::LaneKind;
use jt_tenancy::{AgentConnectionId, Permission, SystemRole};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};
use time::Duration;

/// The TikTok account's open id.
const ACCOUNT: &str = "tt-open-id";

struct Tiktok {
    w: support::World,
    tt: Arc<ScriptedConnector>,
    slot: Slot,
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// An MP4 of `seconds`: its file type and a movie header (timescale 1000).
fn mp4(seconds: u32) -> MediaUpload {
    let mut mvhd = vec![0; 12];
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&(seconds * 1000).to_be_bytes());
    mvhd.extend_from_slice(&[0; 80]);
    MediaUpload {
        bytes: [
            mp4_box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41"),
            mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)),
        ]
        .concat(),
        mime: "video/mp4".into(),
        filename: "menu.mp4".into(),
    }
}

fn photo(n: u8) -> MediaUpload {
    MediaUpload {
        bytes: [b"\x89PNG\r\n\x1a\n".as_slice(), &[n; 16]].concat(),
        mime: "image/png".into(),
        filename: format!("menu-{n}.png"),
    }
}

/// The world of `support`, with a verified TikTok account whose slot is Ready (revision 1) and
/// due, its piece carrying `media`. The fixture's X slot is cancelled: only TikTok is wired.
async fn tiktok_world(media: Vec<MediaUpload>) -> Tiktok {
    let mut w = support::world().await;
    let tt = Arc::new(ScriptedConnector::new(Provider::Tiktok));
    w.d.connectors = Arc::new(ScriptedRegistry::new().with_connector(tt.clone()));
    w.d.files = Arc::new(MemoryFiles::default());
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .retire_slot(w.f.slot.id, 1, "cancelled")
        .await
        .unwrap();
    let mut c = Capability::new(
        CapabilityId::new_v7(),
        w.f.ws,
        NewCapability {
            kind_key: "tiktok".into(),
            name: "TikTok".into(),
            external_id: Some(ACCOUNT.into()),
            connector_public: json!({"access":{"scopes":["user.info.basic","video.publish","video.list","user.info.stats"],"expires_at":null}}),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    let cred = Credential::OAuth {
        access_token: "tiktok-token".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["video.publish".into()],
    };
    let sealed =
        w.d.seal
            .seal(w.f.ws, &serde_json::to_vec(&cred).unwrap())
            .unwrap();
    r.capabilities()
        .insert(c.clone(), Some(sealed))
        .await
        .unwrap();
    let arm = Arm::new(
        ArmId::new_v7(),
        w.f.ws,
        ArmKey {
            hypothesis_id: w.f.slot.chain.hypothesis_id,
            content_type: "text".into(),
            channel: "tiktok".into(),
            lane: LaneKind::Organic,
        },
    )
    .unwrap();
    r.studio().insert_arm(arm.clone()).await.unwrap();
    let slot = Slot {
        id: SlotId::new_v7(),
        chain: Chain {
            arm_id: arm.id,
            ..w.f.slot.chain.clone()
        },
        capability_id: c.id,
        scheduled_at: FIXED_NOW,
        state: SlotState::Planned,
        revision: 0,
    };
    r.studio()
        .insert_slots("tiktok/organic", vec![slot.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    piece_submit(
        &w.d,
        &w.ctx,
        PieceInput {
            slot_id: slot.id,
            expected_revision: 0,
            request_key: "tiktok-piece".into(),
            text: "Bugünün menüsü #yemek".into(),
            media: media
                .into_iter()
                .map(|upload| MediaAsset::Bytes { upload })
                .collect(),
            adaptations: BTreeMap::new(),
        },
    )
    .await
    .unwrap();
    Tiktok { w, tt, slot }
}

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
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: Some(600),
        cannot_post: None,
    }
}

fn choice(privacy: &str) -> TiktokPost {
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

/// The account's counters, by TikTok's names (`user.info.stats`).
fn account() -> BTreeMap<String, i64> {
    [
        ("follower_count".to_owned(), 1200),
        ("following_count".to_owned(), 45),
        ("likes_count".to_owned(), 8700),
        ("video_count".to_owned(), 31),
    ]
    .into()
}

/// Queues the account's counters, which the screen reads beside the account.
fn counters(tt: &ScriptedConnector) {
    tt.push_account_metrics(Ok(AccountMetrics { metrics: account() }));
}

fn video(id: &str, views: i64) -> RecentPost {
    RecentPost {
        id: id.into(),
        title: Some("Bugünün menüsü".into()),
        cover_image_url: Some("https://p16.tiktokcdn.test/cover.image".parse().unwrap()),
        share_url: Some(
            format!("https://www.tiktok.com/@jeeta_test/video/{id}")
                .parse()
                .unwrap(),
        ),
        created_at: Some(FIXED_NOW),
        metrics: [("view_count".to_owned(), views)].into(),
    }
}

/// Sent to the creator's TikTok drafts: nothing chosen here but a photo's caption.
fn draft(title: &str) -> TiktokPost {
    TiktokPost {
        mode: TiktokPostMode::Draft,
        title: title.into(),
        ..choice("")
    }
}

/// The TikTok account's grant set to `scopes` (a connection made before drafts existed lacks
/// `video.upload`).
async fn grant(t: &Tiktok, scopes: &[&str]) {
    let mut r = t.w.uow.tenant(t.w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(t.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.connector_public["access"]["scopes"] = json!(scopes);
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
}

const ALL_SCOPES: &[&str] = &[
    "user.info.basic",
    "video.publish",
    "video.upload",
    "video.list",
    "user.info.stats",
];

fn input(t: &Tiktok, post: TiktokPost) -> TiktokPostInput {
    TiktokPostInput {
        slot_id: t.slot.id,
        expected_revision: 1,
        post,
    }
}

fn publishes(c: &ScriptedConnector) -> Vec<jt_app::ports::connectors::PublishRequest> {
    c.calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::Publish { request, .. } => Some(request),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_tiktok_piece_is_never_published_without_its_posting_screen() {
    let t = tiktok_world(vec![mp4(30)]).await;
    // Neither the lane nor the capability asks for approval (the default policy).
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 0);
    assert!(publishes(&t.tt).is_empty());
    assert!(t.w.uow.snapshot().studio.attempts.is_empty());
    // It waits for a human, and says where they post it.
    let pending = work::pending(&t.w.d, &t.w.ctx).await.unwrap();
    assert!(pending.approvals.contains(&ApprovalTarget::Slot(t.slot.id)));
    let blocker = pending
        .blockers
        .iter()
        .find(|b| b.target == ApprovalTarget::Slot(t.slot.id))
        .unwrap();
    assert_eq!(blocker.reason, "human_approval_required");
    assert_eq!(
        blocker.next_action.as_deref(),
        Some("tiktok_posting_screen")
    );

    // Approving it as any other channel's piece does not do: the screen is the only way in.
    let e = approve(
        &t.w.d,
        &t.w.ctx,
        ApprovalInput {
            target: ApprovalTarget::Slot(t.slot.id),
            expected_revision: 1,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "tiktok_posting_screen_required");
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());

    // Nor does an approval without the screen's choice, however it was recorded.
    let mut r = t.w.uow.tenant(t.w.f.ws).await.unwrap();
    r.studio()
        .approve_target(
            ApprovalTarget::Slot(t.slot.id),
            ApprovalReceipt {
                revision: 1,
                by: match t.w.ctx.actor {
                    jt_ledger::Actor::Human { user_id } => user_id,
                    _ => unreachable!(),
                },
                at: FIXED_NOW,
                tiktok: None,
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 0);
    assert!(publishes(&t.tt).is_empty());
    assert!(
        work::pending(&t.w.d, &t.w.ctx)
            .await
            .unwrap()
            .approvals
            .contains(&ApprovalTarget::Slot(t.slot.id))
    );
}

/// A due slot waiting for a human to pass its posting screen is not a failure: the publishing
/// job, run every minute, publishes nothing and reports nothing failed while it waits
/// (`studio.pending` names what it waits for).
#[tokio::test]
async fn a_slot_waiting_for_its_posting_screen_does_not_fail_the_publishing_job() {
    let t = tiktok_world(vec![mp4(30)]).await;
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 0);
    let report = Job::StudioPublish.run(&t.w.d, FIXED_NOW).await;
    assert_eq!((report.changed, report.failed), (0, 0));
    assert!(publishes(&t.tt).is_empty());
    assert!(t.w.uow.snapshot().studio.attempts.is_empty());
}

/// Any other refusal still fails the run: the slot's own (checked before its approval), and
/// another due slot's beside one waiting for its screen.
#[tokio::test]
async fn a_refusal_other_than_waiting_for_a_human_still_fails_the_run() {
    let t = tiktok_world(vec![mp4(30)]).await;
    grant(&t, &["user.info.basic"]).await;
    let e = publish_due(&t.w.d, t.w.f.ws).await.unwrap_err();
    assert_eq!(e.details["reason"], "credential_scope_missing");
    assert_eq!(Job::StudioPublish.run(&t.w.d, FIXED_NOW).await.failed, 1);

    let t = tiktok_world(vec![mp4(30)]).await;
    // A due X slot whose account was disconnected, beside the TikTok slot waiting for its screen.
    let x = Slot {
        id: SlotId::new_v7(),
        scheduled_at: FIXED_NOW - Duration::minutes(1),
        state: SlotState::Planned,
        revision: 0,
        ..t.w.f.slot.clone()
    };
    let mut r = t.w.uow.tenant(t.w.f.ws).await.unwrap();
    r.studio()
        .insert_slots("x/organic", vec![x.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    piece_submit(
        &t.w.d,
        &t.w.ctx,
        PieceInput {
            slot_id: x.id,
            expected_revision: 0,
            request_key: "x-piece".into(),
            text: "Bugünün menüsü".into(),
            media: vec![],
            adaptations: BTreeMap::new(),
        },
    )
    .await
    .unwrap();
    let mut r = t.w.uow.tenant(t.w.f.ws).await.unwrap();
    let mut cap = r
        .capabilities()
        .find(x.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.connector_public["reconnect_required"] = json!(true);
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    let e = publish_due(&t.w.d, t.w.f.ws).await.unwrap_err();
    assert_eq!(e.details["reason"], "capability_unavailable");
    assert_eq!(Job::StudioPublish.run(&t.w.d, FIXED_NOW).await.failed, 1);
    assert!(publishes(&t.tt).is_empty());
    assert!(t.w.uow.snapshot().studio.attempts.is_empty());
}

#[tokio::test]
async fn the_screen_reads_the_account_fresh_each_time_and_sends_nothing() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        nickname: Some("Jeeta Yeni".into()),
        ..creator()
    })));
    counters(&t.tt);
    counters(&t.tt);
    let first = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(first.slot.id, t.slot.id);
    assert_eq!(first.slot.revision, 1);
    assert_eq!(first.creator, creator());
    // The drafted caption, editable on the screen; the video, previewed where it is stored.
    assert_eq!(first.title, "Bugünün menüsü #yemek");
    assert_eq!(first.media, TiktokMedia::Video { duration_ms: None });
    assert_eq!(first.max_title_units, 2200);
    assert_eq!(first.previews.len(), 1);
    assert_eq!(first.previews[0].mime, "video/mp4");
    assert!(
        first.previews[0]
            .url
            .as_str()
            .starts_with("https://files.example.com/files/")
    );
    assert!(first.approval.is_none());
    let second = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(second.creator.nickname.as_deref(), Some("Jeeta Yeni"));
    let asked = t.tt.creator_info_calls();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[0]["kind_key"], "tiktok");
    assert_eq!(asked[0]["external_id"], ACCOUNT);
    assert!(publishes(&t.tt).is_empty(), "nothing is sent to TikTok");

    // An account that may not post now says so; the screen shows it rather than failing.
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        cannot_post: Some("spam_risk_too_many_posts".into()),
        ..creator()
    })));
    counters(&t.tt);
    let busy = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(
        busy.creator.cannot_post.as_deref(),
        Some("spam_risk_too_many_posts")
    );
    // A read TikTok refused names why, for the owner.
    t.tt.push_creator_info(Err(ConnectorError::auth(
        "HTTP 401 access_token_invalid: expired",
    )));
    let e = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id)
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "tiktok_creator_info_unavailable");
    assert_eq!(
        e.details["provider_reason"],
        "auth: tiktok: HTTP 401 access_token_invalid: expired"
    );
}

#[tokio::test]
async fn the_choice_made_on_the_screen_is_what_goes_to_tiktok() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    let chosen = TiktokPost {
        title: "Yeni menü, düzenlendi #menu".into(),
        allow_comment: true,
        disclose_commercial: true,
        your_brand: true,
        ..choice("MUTUAL_FOLLOW_FRIENDS")
    };
    let out = tiktok_post(&t.w.d, &t.w.ctx, input(&t, chosen.clone()))
        .await
        .unwrap();
    assert_eq!(out.target, ApprovalTarget::Slot(t.slot.id));
    assert_eq!(out.revision, 1);
    assert_eq!(out.approval.tiktok, Some(chosen.clone()));
    // Accepting the choice read the account again, and sent nothing.
    assert_eq!(t.tt.creator_info_calls().len(), 1);
    assert!(t.tt.calls().is_empty());
    let s = t.w.uow.snapshot();
    let entry = s
        .ledger
        .iter()
        .find(|row| row.entry.action.as_str() == "studio.tiktok_post")
        .expect("a ledger entry");
    assert_eq!(
        entry.entry.payload["tiktok"],
        json!({
            "mode": "direct_post",
            "privacy_level": "MUTUAL_FOLLOW_FRIENDS",
            "allow_comment": true,
            "allow_duet": false,
            "allow_stitch": false,
            "disclose_commercial": true,
            "your_brand": true,
            "branded_content": false,
        })
    );
    let pending = work::pending(&t.w.d, &t.w.ctx).await.unwrap();
    assert!(!pending.approvals.contains(&ApprovalTarget::Slot(t.slot.id)));
    // The screen shows what was chosen.
    t.tt.push_creator_info(Ok(Some(creator())));
    counters(&t.tt);
    let screen = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(screen.approval.unwrap().tiktok, Some(chosen.clone()));

    t.tt.push_publish(Ok(PublishReceipt {
        external_id: "v_pub_file~v2-1.7".into(),
        url: None,
    }));
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 1);
    let sent = publishes(&t.tt);
    assert_eq!(sent.len(), 1);
    let request = &sent[0];
    assert_eq!(request.tiktok, Some(chosen));
    // The caption as left on the screen, in place of the drafted text and link.
    assert_eq!(request.text, "Yeni menü, düzenlendi #menu");
    assert_eq!(request.link, None);
    assert_eq!(request.privacy.as_deref(), Some("MUTUAL_FOLLOW_FRIENDS"));
    assert_eq!(request.media, vec![mp4(30)]);
    assert_eq!(t.w.uow.snapshot().studio.attempts.len(), 1);
}

#[tokio::test]
async fn the_choice_is_checked_against_the_fresh_account_before_it_is_accepted() {
    let t = tiktok_world(vec![mp4(30)]).await;
    let busy = TiktokCreator {
        cannot_post: Some("spam_risk_too_many_posts".into()),
        ..creator()
    };
    let private_account = TiktokCreator {
        privacy_level_options: vec![
            "FOLLOWER_OF_CREATOR".into(),
            "MUTUAL_FOLLOW_FRIENDS".into(),
            "SELF_ONLY".into(),
        ],
        ..creator()
    };
    let branded_private = TiktokPost {
        disclose_commercial: true,
        branded_content: true,
        ..choice("SELF_ONLY")
    };
    let unspecified = TiktokPost {
        disclose_commercial: true,
        ..choice("PUBLIC_TO_EVERYONE")
    };
    let duet = TiktokPost {
        allow_duet: true,
        ..choice("PUBLIC_TO_EVERYONE")
    };
    for (account, post, code, reason) in [
        (
            busy,
            choice("PUBLIC_TO_EVERYONE"),
            ErrorCode::Conflict,
            "tiktok_cannot_post_now",
        ),
        (
            creator(),
            choice(""),
            ErrorCode::Validation,
            "tiktok_privacy_not_chosen",
        ),
        // The account went private since the screen was shown.
        (
            private_account,
            choice("PUBLIC_TO_EVERYONE"),
            ErrorCode::Validation,
            "tiktok_privacy_not_offered",
        ),
        (
            creator(),
            branded_private,
            ErrorCode::Validation,
            "tiktok_branded_content_private",
        ),
        (
            creator(),
            unspecified,
            ErrorCode::Validation,
            "tiktok_commercial_unspecified",
        ),
        // The creator turned Duet off: the screen greys it out.
        (
            creator(),
            duet,
            ErrorCode::Validation,
            "tiktok_interaction_disabled",
        ),
    ] {
        t.tt.push_creator_info(Ok(Some(account)));
        let e = tiktok_post(&t.w.d, &t.w.ctx, input(&t, post))
            .await
            .unwrap_err();
        assert_eq!((e.code, e.details["reason"].as_str()), (code, Some(reason)));
    }
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());
    assert!(t.tt.calls().is_empty());
}

#[tokio::test]
async fn a_video_longer_than_the_account_may_post_is_refused() {
    let t = tiktok_world(vec![mp4(601)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    let e = tiktok_post(&t.w.d, &t.w.ctx, input(&t, choice("PUBLIC_TO_EVERYONE")))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "tiktok_video_too_long");
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());
    // A longer limit takes it.
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        max_video_post_duration_sec: Some(900),
        ..creator()
    })));
    tiktok_post(&t.w.d, &t.w.ctx, input(&t, choice("PUBLIC_TO_EVERYONE")))
        .await
        .unwrap();
}

#[tokio::test]
async fn photos_offer_comments_only() {
    let t = tiktok_world(vec![photo(1), photo(2)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    counters(&t.tt);
    let screen = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(screen.media, TiktokMedia::Photos);
    assert_eq!(screen.max_title_units, 4000);
    assert_eq!(screen.previews.len(), 2);
    assert!(screen.previews.iter().all(|p| p.mime == "image/png"));
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        duet_disabled: false,
        ..creator()
    })));
    let e = tiktok_post(
        &t.w.d,
        &t.w.ctx,
        input(
            &t,
            TiktokPost {
                allow_duet: true,
                ..choice("PUBLIC_TO_EVERYONE")
            },
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "tiktok_photo_interaction");
    t.tt.push_creator_info(Ok(Some(creator())));
    tiktok_post(
        &t.w.d,
        &t.w.ctx,
        input(
            &t,
            TiktokPost {
                allow_comment: true,
                ..choice("SELF_ONLY")
            },
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn only_an_owner_or_manager_passes_the_screen() {
    let t = tiktok_world(vec![mp4(30)]).await;
    let agent = Ctx {
        agent_connection_id: Some(AgentConnectionId::new_v7()),
        ..t.w.ctx.clone()
    };
    let member = Ctx {
        role_key: Some("member".into()),
        ..t.w.ctx.clone()
    };
    let worker = Ctx {
        permissions: [Permission::StudioWork].into_iter().collect(),
        ..t.w.ctx.clone()
    };
    for ctx in [&agent, &member, &worker] {
        let e = tiktok_post(&t.w.d, ctx, input(&t, choice("PUBLIC_TO_EVERYONE")))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden, "{ctx:?}");
    }
    let e = tiktok_posting(&t.w.d, &worker, t.slot.id)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    // Refused before anything was read from TikTok.
    assert!(t.tt.creator_info_calls().is_empty());
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());
    assert!(
        SystemRole::Owner
            .permissions()
            .contains(&Permission::StudioManage)
    );
}

#[tokio::test]
async fn a_stale_revision_or_another_channel_is_refused() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    let e = tiktok_post(
        &t.w.d,
        &t.w.ctx,
        TiktokPostInput {
            expected_revision: 2,
            ..input(&t, choice("PUBLIC_TO_EVERYONE"))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    // The fixture's X slot has no TikTok screen.
    let e = tiktok_posting(&t.w.d, &t.w.ctx, t.w.f.slot.id)
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "not_a_tiktok_slot");
    let e = tiktok_post(
        &t.w.d,
        &t.w.ctx,
        TiktokPostInput {
            slot_id: t.w.f.slot.id,
            ..input(&t, choice("PUBLIC_TO_EVERYONE"))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "not_a_tiktok_slot");
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());
}

#[tokio::test]
async fn the_screen_shows_the_accounts_counters_and_recent_videos() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    counters(&t.tt);
    let recent = vec![
        video("7300000000000000002", 1520),
        video("7300000000000000001", 9400),
    ];
    t.tt.push_recent_posts(Ok(Some(recent.clone())));
    let screen = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    // Read with the account, live: followers, following, likes and videos (`user.info.stats`),
    // and the latest public videos with their counters (`video.list`).
    assert_eq!(screen.account_metrics, Some(account()));
    assert_eq!(screen.recent_posts, Some(recent));
    assert_eq!(t.tt.recent_posts_calls(), [10]);
    assert!(publishes(&t.tt).is_empty());

    // Best effort: reads TikTok refuses leave them out, and the screen still works.
    t.tt.push_creator_info(Ok(Some(creator())));
    t.tt.push_account_metrics(Err(ConnectorError::permission(
        "HTTP 401 scope_not_authorized",
    )));
    t.tt.push_recent_posts(Err(ConnectorError::transient("offline")));
    let screen = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(screen.creator, creator());
    assert_eq!(screen.account_metrics, None);
    assert_eq!(screen.recent_posts, None);
}

#[tokio::test]
async fn a_published_tiktok_post_shows_its_counters() {
    let mut t = tiktok_world(vec![mp4(30)]).await;
    // Not published yet: no post, no counters, and nothing asked of TikTok.
    let before = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(before.post, None);
    assert_eq!(before.metrics, None);
    assert!(t.tt.calls().is_empty());

    t.tt.push_creator_info(Ok(Some(creator())));
    tiktok_post(&t.w.d, &t.w.ctx, input(&t, choice("PUBLIC_TO_EVERYONE")))
        .await
        .unwrap();
    let post = PublishReceipt {
        external_id: "7300000000000000001".into(),
        url: Some(
            "https://www.tiktok.com/@jeeta_test/video/7300000000000000001"
                .parse()
                .unwrap(),
        ),
    };
    t.tt.push_publish(Ok(post.clone()));
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 1);

    // Read live, right after it went out.
    let live: BTreeMap<String, i64> = [
        ("comment_count".to_owned(), 1),
        ("like_count".to_owned(), 3),
        ("share_count".to_owned(), 0),
        ("view_count".to_owned(), 42),
    ]
    .into();
    t.tt.push_post_metrics(Ok(PostMetrics {
        metrics: live.clone(),
    }));
    let out = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(out.post, Some(post.clone()));
    assert_eq!(out.metrics, Some(live));
    assert_eq!(out.source, Some(MetricsSource::Live));
    assert_eq!(out.read_at, Some(FIXED_NOW));
    assert!(matches!(
        t.tt.calls().last(),
        Some(ConnectorCall::PostMetrics { post_id, .. }) if post_id == "7300000000000000001"
    ));

    // A day later the measurement job has measured it; when TikTok cannot be asked, the latest
    // measurement stands in.
    let later = FIXED_NOW + Duration::hours(25);
    t.w.d.clock = Arc::new(FixedClock(later));
    t.tt.push_post_metrics(Ok(PostMetrics {
        metrics: [("view_count".to_owned(), 100), ("like_count".to_owned(), 9)].into(),
    }));
    assert_eq!(measure_due(&t.w.d, t.w.f.ws).await.unwrap(), 1);
    t.tt.push_post_metrics(Err(ConnectorError::transient("offline")));
    let out = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(out.post, Some(post));
    assert_eq!(out.source, Some(MetricsSource::Measurement));
    let metrics = out.metrics.unwrap();
    assert_eq!((metrics["view_count"], metrics["like_count"]), (100, 9));
    assert_eq!(out.read_at, Some(later));
    // Read on its own: nothing is published.
    assert_eq!(publishes(&t.tt).len(), 1);
}

#[tokio::test]
async fn a_post_tiktok_cannot_count_has_no_counters() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    tiktok_post(&t.w.d, &t.w.ctx, input(&t, choice("SELF_ONLY")))
        .await
        .unwrap();
    // Seen by its creator only: TikTok names no public id, and the receipt keeps the publish id.
    let private = PublishReceipt {
        external_id: "v_pub_file~v2-1.7".into(),
        url: None,
    };
    t.tt.push_publish(Ok(private.clone()));
    publish_due(&t.w.d, t.w.f.ws).await.unwrap();
    t.tt.push_post_metrics(Err(ConnectorError::permanent(
        "not a TikTok video id (a post TikTok names no public id for has no counters)",
    )));
    let out = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert_eq!(out.post, Some(private));
    assert_eq!((out.metrics, out.source, out.read_at), (None, None, None));
}

#[tokio::test]
async fn a_posts_counters_are_a_studio_read_of_a_tiktok_slot() {
    let t = tiktok_world(vec![mp4(30)]).await;
    let e = tiktok_metrics(&t.w.d, &t.w.ctx, t.w.f.slot.id)
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "not_a_tiktok_slot");
    let nobody = Ctx {
        permissions: Default::default(),
        ..t.w.ctx.clone()
    };
    let e = tiktok_metrics(&t.w.d, &nobody, t.slot.id)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert!(t.tt.calls().is_empty());
}

#[tokio::test]
async fn drafts_need_a_connection_granted_video_upload() {
    let t = tiktok_world(vec![mp4(30)]).await;
    // Connected before drafts existed: direct posts only, and the screen says so.
    t.tt.push_creator_info(Ok(Some(creator())));
    counters(&t.tt);
    let screen = tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert!(!screen.drafts_available);
    let e = tiktok_post(&t.w.d, &t.w.ctx, input(&t, draft("")))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "tiktok_reconnect_for_drafts");
    // Refused before anything was read from TikTok.
    assert_eq!(t.tt.creator_info_calls().len(), 1);
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());

    // Reconnected with `video.upload`: drafts are offered.
    grant(&t, ALL_SCOPES).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    counters(&t.tt);
    assert!(
        tiktok_posting(&t.w.d, &t.w.ctx, t.slot.id)
            .await
            .unwrap()
            .drafts_available
    );
    // A grant of drafts alone cannot post directly.
    grant(&t, &["user.info.basic", "video.upload"]).await;
    let e = tiktok_post(&t.w.d, &t.w.ctx, input(&t, choice("PUBLIC_TO_EVERYONE")))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "credential_scope_missing");
}

#[tokio::test]
async fn a_draft_names_nothing_tiktok_does_not_take_for_it() {
    let t = tiktok_world(vec![mp4(30)]).await;
    grant(&t, ALL_SCOPES).await;
    for post in [
        TiktokPost {
            privacy_level: "SELF_ONLY".into(),
            ..draft("")
        },
        TiktokPost {
            allow_comment: true,
            ..draft("")
        },
        // A video draft takes no caption: it is written in TikTok.
        draft("Bugünün menüsü"),
    ] {
        t.tt.push_creator_info(Ok(Some(creator())));
        let e = tiktok_post(&t.w.d, &t.w.ctx, input(&t, post))
            .await
            .unwrap_err();
        assert_eq!(
            (e.code, e.details["reason"].as_str()),
            (ErrorCode::Validation, Some("tiktok_draft_settings"))
        );
    }
    assert!(t.w.uow.snapshot().studio.approvals.is_empty());
}

#[tokio::test]
async fn a_draft_goes_to_the_creators_tiktok_drafts_as_chosen() {
    let mut t = tiktok_world(vec![mp4(30)]).await;
    grant(&t, ALL_SCOPES).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    let out = tiktok_post(&t.w.d, &t.w.ctx, input(&t, draft("")))
        .await
        .unwrap();
    assert_eq!(out.approval.tiktok, Some(draft("")));
    let s = t.w.uow.snapshot();
    let entry = s
        .ledger
        .iter()
        .find(|row| row.entry.action.as_str() == "studio.tiktok_post")
        .unwrap();
    assert_eq!(entry.entry.payload["tiktok"]["mode"], "draft");
    // Before it goes out, the slot's counters say it is a draft.
    let before = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert!(before.draft);
    assert_eq!(before.post, None);

    let sent = PublishReceipt {
        external_id: "v_inbox_file~v2-1.7300000000000000010".into(),
        url: None,
    };
    t.tt.push_publish(Ok(sent.clone()));
    // TikTok processes it first, then notifies the creator in its inbox.
    t.tt.push_resolve(Ok(Some(PublishResolution::Pending)));
    assert_eq!(publish_due(&t.w.d, t.w.f.ws).await.unwrap(), 1);
    let request = &publishes(&t.tt)[0];
    assert_eq!(request.tiktok, Some(draft("")));
    // Nothing but the file: no caption, no link, no privacy.
    assert_eq!(request.text, "");
    assert_eq!(request.link, None);
    assert_eq!(request.privacy, None);
    assert_eq!(request.media, vec![mp4(30)]);

    t.w.d.clock = Arc::new(FixedClock(FIXED_NOW + Duration::minutes(1)));
    t.tt.push_resolve(Ok(Some(PublishResolution::Published(sent.clone()))));
    assert_eq!(
        jt_app::usecases::studio::publish::recover_publications(&t.w.d, t.w.f.ws)
            .await
            .unwrap(),
        1
    );
    let s = t.w.uow.snapshot();
    assert_eq!(s.studio.publications[0].external_id, sent.external_id);
    assert_eq!(
        s.studio
            .slots
            .iter()
            .find(|x| x.id == t.slot.id)
            .unwrap()
            .state,
        SlotState::Published
    );
    // Sent to the creator's drafts: no counters to read, and none asked of TikTok.
    let after = tiktok_metrics(&t.w.d, &t.w.ctx, t.slot.id).await.unwrap();
    assert!(after.draft);
    assert_eq!(after.post, Some(sent));
    assert_eq!((after.metrics, after.source), (None, None));
    assert!(
        !t.tt
            .calls()
            .iter()
            .any(|c| matches!(c, ConnectorCall::PostMetrics { .. }))
    );
}

#[tokio::test]
async fn a_photo_draft_carries_its_caption() {
    let t = tiktok_world(vec![photo(1)]).await;
    grant(&t, ALL_SCOPES).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    tiktok_post(&t.w.d, &t.w.ctx, input(&t, draft("Yeni menü #lezzet")))
        .await
        .unwrap();
    t.tt.push_publish(Ok(PublishReceipt {
        external_id: "p_inbox_url~v2-1.7".into(),
        url: None,
    }));
    publish_due(&t.w.d, t.w.f.ws).await.unwrap();
    let request = &publishes(&t.tt)[0];
    assert_eq!(request.text, "Yeni menü #lezzet");
    assert_eq!(request.privacy, None);
    assert_eq!(request.media_urls.len(), 1);
}
