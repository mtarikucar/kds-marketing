//! What the Studio sees of the TikTok adapter: the failure lines its refusals become
//! (`kind: tiktok: reason`, `jt_app::usecases::failure`), and a video piece published end to end
//! as chosen on its posting screen, its receipt resolved from pending to the live post.

mod support;

use jt_app::ports::connectors::{
    MediaUpload, PublishReceipt, PublishRequest, PublishResolution, Publisher,
};
use jt_app::usecases::failure::{failure_kind, failure_reason, http_status};
use jt_connector::{ConnectorError, Provider};
use serde_json::json;
use support::*;
use url::Url;

fn line(e: &ConnectorError) -> String {
    failure_reason(Some(Provider::Tiktok), e)
}

fn video(len: usize) -> PublishRequest {
    PublishRequest {
        text: "Bugünün menüsü".into(),
        media: vec![MediaUpload {
            bytes: vec![7; len],
            mime: "video/mp4".into(),
            filename: "menu.mp4".into(),
        }],
        tiktok: Some(choice("PUBLIC_TO_EVERYONE")),
        ..PublishRequest::default()
    }
}

fn photos() -> PublishRequest {
    PublishRequest {
        text: "Bugünün menüsü".into(),
        media_urls: vec![Url::parse("https://media.jeeta.test/p/0.jpg").unwrap()],
        tiktok: Some(choice("PUBLIC_TO_EVERYONE")),
        ..PublishRequest::default()
    }
}

#[tokio::test]
async fn failure_lines_read_kind_provider_and_tiktoks_words() {
    let r = rig().await;
    // A grant without `video.publish`: TikTok's 401 is a permission, not a dead credential.
    r.mock
        .on("POST", CREATOR_INFO, answer_with(401, "error_scope"));
    let e =
        r.tt.publish(&cred(), &public(), &video(10))
            .await
            .unwrap_err();
    let scope = line(&e);
    assert!(
        scope.starts_with("permission: tiktok: HTTP 401 scope_not_authorized"),
        "{scope}"
    );
    assert_eq!(failure_kind(&scope), "permission");
    assert_eq!(http_status(&scope), Some(401));

    // An app TikTok has not audited posts nowhere but privately, and says so.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_self_only"));
    let e =
        r.tt.publish(&cred(), &public(), &video(10))
            .await
            .unwrap_err();
    assert_eq!(
        line(&e),
        "permission: tiktok: privacy level PUBLIC_TO_EVERYONE not available (app not audited or \
         private account)"
    );

    // Photos from a media host not verified in the TikTok portal: TikTok's own words.
    r.mock
        .set("POST", CREATOR_INFO, answer("creator_info_public"));
    r.mock.on(
        "POST",
        CONTENT_INIT,
        answer_with(403, "error_url_ownership"),
    );
    let e =
        r.tt.publish(&cred(), &public(), &photos())
            .await
            .unwrap_err();
    let ownership = line(&e);
    assert!(
        ownership.starts_with("permanent: tiktok: HTTP 403 url_ownership_unverified: "),
        "{ownership}"
    );

    // A dead token; the daily post cap (a throttle has no reason); text alone.
    r.mock
        .set("POST", CREATOR_INFO, answer_with(401, "error_auth"));
    let e =
        r.tt.publish(&cred(), &public(), &video(10))
            .await
            .unwrap_err();
    assert!(
        line(&e).starts_with("auth: tiktok: HTTP 401 access_token_invalid: "),
        "{}",
        line(&e)
    );
    r.mock.set("POST", CREATOR_INFO, answer("error_spam"));
    let e =
        r.tt.publish(&cred(), &public(), &video(10))
            .await
            .unwrap_err();
    assert_eq!(line(&e), "throttle: tiktok");
    let text_only = PublishRequest {
        text: "Merhaba".into(),
        ..PublishRequest::default()
    };
    let e =
        r.tt.publish(&cred(), &public(), &text_only)
            .await
            .unwrap_err();
    assert_eq!(
        line(&e),
        "permanent: tiktok: a TikTok post is a video or photos: text alone cannot be posted"
    );

    // A video TikTok refused after accepting it: the status names why.
    r.mock.on("POST", STATUS, answer("status_failed"));
    let resolved =
        r.tt.resolve(
            &cred(),
            &public(),
            &PublishReceipt {
                external_id: PUBLISH_ID.into(),
                url: None,
            },
        )
        .await
        .unwrap();
    let Some(PublishResolution::Failed(e)) = resolved else {
        panic!("not failed: {resolved:?}");
    };
    assert_eq!(
        line(&e),
        "permanent: tiktok: publish failed: duration_check_failed"
    );
    for l in [scope, ownership] {
        assert_no_secret(&l);
        assert!(l.chars().count() <= 300);
    }
}

#[tokio::test]
async fn a_video_piece_publishes_end_to_end_through_resolve() {
    let r = rig().await;
    script_video(&r.mock);
    r.mock.on("POST", STATUS, answer("status_processing"));
    r.mock.on("POST", STATUS, answer("status_complete"));
    // As the use cases hand the capability over: the asset's username, the last probe's facts.
    let stored = json!({
        "provider": "tiktok",
        "kind_key": "tiktok",
        "external_id": OPEN_ID,
        "facts": { "account_id": OPEN_ID, "username": USERNAME },
        "asset": { "username": USERNAME, "display_name": DISPLAY_NAME },
    });
    let receipt = r.tt.publish(&cred(), &stored, &video(4_096)).await.unwrap();
    // Published in the background: the receipt is TikTok's publish id, without a URL yet.
    assert_eq!(
        receipt,
        PublishReceipt {
            external_id: PUBLISH_ID.into(),
            url: None,
        }
    );
    assert_eq!(
        r.tt.resolve(&cred(), &stored, &receipt).await.unwrap(),
        Some(PublishResolution::Pending)
    );
    assert_eq!(
        r.tt.resolve(&cred(), &stored, &receipt).await.unwrap(),
        Some(PublishResolution::Published(PublishReceipt {
            external_id: VIDEO_ID.into(),
            url: Some(
                Url::parse("https://www.tiktok.com/@jeeta_test/video/7300000000000000001").unwrap()
            ),
        }))
    );
    assert_eq!(
        r.mock.lines(),
        [
            format!("POST {CREATOR_INFO}"),
            format!("POST {VIDEO_INIT}"),
            format!("PUT {UPLOAD}"),
            format!("POST {STATUS}"),
            format!("POST {STATUS}"),
        ]
    );
    assert_eq!(r.mock.request("PUT", UPLOAD).bytes, vec![7; 4_096]);
}
