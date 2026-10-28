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
        connectors::{MediaUpload, PublishReceipt, TiktokCreator, TiktokMedia, TiktokPost},
        studio::*,
    },
    usecases::studio::{
        control::{ApprovalInput, approve},
        pieces::{PieceInput, piece_submit},
        publish::publish_due,
        tiktok::{TiktokPostInput, tiktok_post, tiktok_posting},
        work,
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_strategy::LaneKind;
use jt_tenancy::{AgentConnectionId, Permission, SystemRole};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};

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
    let e = publish_due(&t.w.d, t.w.f.ws).await.unwrap_err();
    assert_eq!(
        e.details["reason"],
        "the TikTok posting screen is required for this revision"
    );
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
    assert!(publish_due(&t.w.d, t.w.f.ws).await.is_err());
    assert!(publishes(&t.tt).is_empty());
    assert!(
        work::pending(&t.w.d, &t.w.ctx)
            .await
            .unwrap()
            .approvals
            .contains(&ApprovalTarget::Slot(t.slot.id))
    );
}

#[tokio::test]
async fn the_screen_reads_the_account_fresh_each_time_and_sends_nothing() {
    let t = tiktok_world(vec![mp4(30)]).await;
    t.tt.push_creator_info(Ok(Some(creator())));
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        nickname: Some("Jeeta Yeni".into()),
        ..creator()
    })));
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
    assert!(t.tt.calls().is_empty(), "nothing is sent to TikTok");

    // An account that may not post now says so; the screen shows it rather than failing.
    t.tt.push_creator_info(Ok(Some(TiktokCreator {
        cannot_post: Some("spam_risk_too_many_posts".into()),
        ..creator()
    })));
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
