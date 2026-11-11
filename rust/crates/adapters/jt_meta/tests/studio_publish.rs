mod support;
use jt_app::ports::connectors::{PublishRequest, Publisher};
use jt_connector::Credential;
use serde_json::json;
use support::*;
#[tokio::test]
async fn accepted_missing_or_unreadable_receipt_is_unknown() {
    let r = rig().await;
    let cred = Credential::PageToken {
        page_id: "123".into(),
        token: "test".into(),
    };
    for reply in [ok(json!({})), raw(200, "broken json")] {
        r.mock.set("POST", "/fb/v19.0/123/feed", reply);
        let result = r
            .meta
            .publish(
                &cred,
                &json!({"kind_key":"facebook_page","external_id":"123"}),
                &PublishRequest {
                    text: "hello".into(),
                    ..Default::default()
                },
            )
            .await;
        assert_eq!(result.unwrap_err().kind(), "unknown");
    }
    assert_eq!(r.mock.requests("POST", "/fb/v19.0/123/feed").len(), 2);
}

// ---------------------------------------------------------------------------------------------
// A Page post left with Facebook's own scheduler (design 2026-11-10 §7.3, B47)
// ---------------------------------------------------------------------------------------------

use jt_app::ports::connectors::{PostFormat, PublishReceipt, Scheduled};
use time::{Duration, macros::datetime};

fn page() -> (Credential, serde_json::Value) {
    (
        Credential::PageToken {
            page_id: "123".into(),
            token: "test".into(),
        },
        json!({"kind_key":"facebook_page","external_id":"123"}),
    )
}

fn photo(mime: &str) -> PublishRequest {
    PublishRequest {
        text: "hello".into(),
        media_urls: vec!["https://files.example/a".parse().unwrap()],
        media_mimes: vec![mime.into()],
        ..Default::default()
    }
}

fn scheduled_post() -> PublishReceipt {
    PublishReceipt {
        external_id: "123_456".into(),
        url: None,
    }
}

#[tokio::test]
async fn facebooks_scheduler_takes_a_text_link_or_single_photo_page_post_only() {
    let r = rig().await;
    let (_, public) = page();
    let text = PublishRequest {
        text: "hello".into(),
        ..Default::default()
    };
    let window = Some((Duration::minutes(15), Duration::days(29)));
    assert_eq!(r.meta.schedule_window(&public, &text), window);
    assert_eq!(
        r.meta.schedule_window(&public, &photo("image/jpeg")),
        window
    );
    assert_eq!(
        r.meta.schedule_window(
            &public,
            &PublishRequest {
                format: Some(PostFormat::FeedPost),
                link: Some("https://example.com/a".parse().unwrap()),
                ..text.clone()
            }
        ),
        window
    );
    // A video, several photos, a story or a reel, a post with a privacy of its own, and
    // anything that is not a Facebook Page: Jeeta sends those itself.
    let mut two = photo("image/jpeg");
    two.media_urls
        .push("https://files.example/b".parse().unwrap());
    two.media_mimes.push("image/jpeg".into());
    for request in [
        photo("video/mp4"),
        two,
        PublishRequest {
            format: Some(PostFormat::Story),
            ..text.clone()
        },
        PublishRequest {
            format: Some(PostFormat::Reel),
            ..text.clone()
        },
        PublishRequest {
            privacy: Some("SELF".into()),
            ..text.clone()
        },
    ] {
        assert_eq!(
            r.meta.schedule_window(&public, &request),
            None,
            "{request:?}"
        );
    }
    for kind in ["instagram", "meta_ads", "x"] {
        assert_eq!(
            r.meta
                .schedule_window(&json!({"kind_key":kind,"external_id":"123"}), &text),
            None,
            "{kind}"
        );
    }
    assert!(r.mock.recorded().is_empty(), "asking sends nothing");
}

#[tokio::test]
async fn a_text_and_link_post_is_left_unpublished_with_its_time() {
    let r = rig().await;
    let (cred, public) = page();
    let at = datetime!(2026-10-24 10:00 UTC);
    r.mock
        .set("POST", "/fb/v19.0/123/feed", ok(json!({"id":"123_456"})));
    let receipt = r
        .meta
        .schedule(
            &cred,
            &public,
            &PublishRequest {
                text: "hello".into(),
                link: Some("https://example.com/a".parse().unwrap()),
                ..Default::default()
            },
            at,
        )
        .await
        .unwrap();
    assert_eq!(receipt, scheduled_post());
    let sent = r.mock.request("POST", "/fb/v19.0/123/feed");
    assert_graph_auth(&sent, "test");
    assert_eq!(
        sent.json(),
        json!({"message":"hello","link":"https://example.com/a","published":false,
               "scheduled_publish_time":at.unix_timestamp()})
    );
}

#[tokio::test]
async fn a_single_photo_post_is_uploaded_unpublished_and_scheduled_on_the_feed() {
    let r = rig().await;
    let (cred, public) = page();
    let at = datetime!(2026-10-24 10:00 UTC);
    r.mock
        .set("POST", "/fb/v19.0/123/photos", ok(json!({"id":"777"})));
    r.mock
        .set("POST", "/fb/v19.0/123/feed", ok(json!({"id":"123_456"})));
    let receipt = r
        .meta
        .schedule(&cred, &public, &photo("image/jpeg"), at)
        .await
        .unwrap();
    assert_eq!(receipt, scheduled_post());
    // The photo carries no time of its own: scheduled on the photos edge, Meta answers without
    // the post's id (seen on a real Page), and the post could be neither read nor taken back.
    let upload = r.mock.request("POST", "/fb/v19.0/123/photos");
    assert_graph_auth(&upload, "test");
    assert_eq!(
        upload.json(),
        json!({"url":"https://files.example/a","published":false,"temporary":true})
    );
    assert_eq!(
        r.mock.request("POST", "/fb/v19.0/123/feed").json(),
        json!({"message":"hello","attached_media":[{"media_fbid":"777"}],"published":false,
               "scheduled_publish_time":at.unix_timestamp(),
               "unpublished_content_type":"SCHEDULED"})
    );
    // A feed answer without the post's id: a post may be scheduled that nobody can follow.
    r.mock.set("POST", "/fb/v19.0/123/feed", ok(json!({})));
    let e = r
        .meta
        .schedule(&cred, &public, &photo("image/jpeg"), at)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "unknown");
}

#[tokio::test]
async fn a_photo_upload_that_fails_schedules_nothing_and_is_never_unknown() {
    let r = rig().await;
    let (cred, public) = page();
    let at = datetime!(2026-10-24 10:00 UTC);
    r.mock
        .set("POST", "/fb/v19.0/123/feed", ok(json!({"id":"123_456"})));
    for (answer, kind) in [
        (ok(json!({})), "permanent"),
        (ok(json!({"id":"../x"})), "permanent"),
        (raw(502, "bad gateway"), "transient"),
        (
            status(
                400,
                json!({"error":{"message":"(#100) Invalid url","type":"OAuthException","code":100}}),
            ),
            "permanent",
        ),
    ] {
        r.mock.set("POST", "/fb/v19.0/123/photos", answer);
        let e = r
            .meta
            .schedule(&cred, &public, &photo("image/jpeg"), at)
            .await
            .unwrap_err();
        assert_eq!(e.kind(), kind, "{e}");
    }
    assert!(
        r.mock.requests("POST", "/fb/v19.0/123/feed").is_empty(),
        "no post is scheduled without its photo"
    );
}

#[tokio::test]
async fn a_scheduling_answer_that_neither_took_nor_refused_is_unknown_and_a_refusal_is_not() {
    let r = rig().await;
    let (cred, public) = page();
    let at = datetime!(2026-10-24 10:00 UTC);
    let text = PublishRequest {
        text: "hello".into(),
        ..Default::default()
    };
    r.mock
        .set("POST", "/fb/v19.0/123/feed", raw(502, "bad gateway"));
    let e = r
        .meta
        .schedule(&cred, &public, &text, at)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "unknown");
    r.mock.set(
        "POST",
        "/fb/v19.0/123/feed",
        status(
            400,
            json!({"error":{"message":"(#100) The specified scheduled publish time is invalid.",
                            "type":"OAuthException","code":100}}),
        ),
    );
    let e = r
        .meta
        .schedule(&cred, &public, &text, at)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    // What the scheduler does not take is refused before anything is sent.
    r.mock.clear();
    let e = r
        .meta
        .schedule(&cred, &public, &photo("video/mp4"), at)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    let e = r
        .meta
        .schedule(
            &cred,
            &json!({"kind_key":"instagram","external_id":"123"}),
            &text,
            at,
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn a_scheduled_post_reads_as_waiting_published_or_gone() {
    let r = rig().await;
    let (cred, public) = page();
    let path = "/fb/v19.0/123_456";
    r.mock.set(
        "GET",
        path,
        ok(json!({"id":"123_456","is_published":false})),
    );
    assert_eq!(
        r.meta
            .scheduled(&cred, &public, &scheduled_post())
            .await
            .unwrap(),
        Scheduled::Waiting
    );
    assert_eq!(
        r.mock.request("GET", path).param("fields"),
        Some("id,is_published")
    );
    r.mock
        .set("GET", path, ok(json!({"id":"123_456","is_published":true})));
    let Scheduled::Published(post) = r
        .meta
        .scheduled(&cred, &public, &scheduled_post())
        .await
        .unwrap()
    else {
        panic!("published")
    };
    assert_eq!(post.external_id, "123_456");
    assert!(post.url.is_some());
    // Graph says the object is not there: it will not go out.
    r.mock.set(
        "GET",
        path,
        status(
            400,
            json!({"error":{"message":"Unsupported get request. Object with ID '123_456' does not exist",
                            "type":"GraphMethodException","code":100,"error_subcode":33}}),
        ),
    );
    assert_eq!(
        r.meta
            .scheduled(&cred, &public, &scheduled_post())
            .await
            .unwrap(),
        Scheduled::Gone
    );
    // An answer that does not say, or names another post, is no answer.
    for body in [
        json!({"id":"123_456"}),
        json!({"id":"999","is_published":true}),
    ] {
        r.mock.set("GET", path, ok(body));
        assert!(
            r.meta
                .scheduled(&cred, &public, &scheduled_post())
                .await
                .is_err()
        );
    }
    // A passing failure is a failure, not "gone".
    r.mock.set("GET", path, raw(503, "unavailable"));
    let e = r
        .meta
        .scheduled(&cred, &public, &scheduled_post())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient");
}

#[tokio::test]
async fn a_withdrawal_deletes_only_a_post_that_still_waits() {
    let r = rig().await;
    let (cred, public) = page();
    let path = "/fb/v19.0/123_456";
    let waiting = || ok(json!({"id":"123_456","is_published":false}));

    // Waiting: read, then deleted.
    r.mock.set("GET", path, waiting());
    r.mock.set("DELETE", path, ok(json!({"success":true})));
    assert!(
        r.meta
            .withdraw(&cred, &public, &scheduled_post())
            .await
            .unwrap()
    );
    assert_eq!(r.mock.requests("DELETE", path).len(), 1);
    assert_graph_auth(&r.mock.request("DELETE", path), "test");

    // Out already: left alone, and said so. Gone already: nothing to delete.
    r.mock.clear();
    r.mock
        .set("GET", path, ok(json!({"id":"123_456","is_published":true})));
    assert!(
        !r.meta
            .withdraw(&cred, &public, &scheduled_post())
            .await
            .unwrap()
    );
    r.mock.set(
        "GET",
        path,
        status(404, json!({"error":{"message":"not found"}})),
    );
    assert!(
        r.meta
            .withdraw(&cred, &public, &scheduled_post())
            .await
            .unwrap()
    );
    assert!(
        r.mock.requests("DELETE", path).is_empty(),
        "a post that is out, or not there, is never deleted"
    );

    // Facebook refuses the deletion, or does not confirm it: not withdrawn.
    r.mock.set("GET", path, waiting());
    r.mock.set(
        "DELETE",
        path,
        status(
            403,
            json!({"error":{"message":"(#200) Permissions error","type":"OAuthException","code":200}}),
        ),
    );
    let e = r
        .meta
        .withdraw(&cred, &public, &scheduled_post())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permission");
    r.mock.set("DELETE", path, ok(json!({"success":false})));
    let e = r
        .meta
        .withdraw(&cred, &public, &scheduled_post())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "unknown");
    // Deleted in between (it does not exist any more): withdrawn.
    r.mock.set(
        "DELETE",
        path,
        status(
            400,
            json!({"error":{"message":"Object does not exist","type":"GraphMethodException",
                            "code":100,"error_subcode":33}}),
        ),
    );
    assert!(
        r.meta
            .withdraw(&cred, &public, &scheduled_post())
            .await
            .unwrap()
    );
}
