mod support;
use jt_app::ports::connectors::{MediaUpload, PublishRequest, Publisher};
use serde_json::json;
use support::*;
fn post(text: String) -> PublishRequest {
    PublishRequest {
        text,
        ..Default::default()
    }
}
#[tokio::test]
async fn x_duplicate_content_is_not_assumed_success() {
    let r = rig().await;
    r.mock.on(
        "POST",
        TWEETS,
        status(
            403,
            json!({"detail":"You are not allowed to create a Tweet with duplicate content."}),
        ),
    );
    assert!(
        r.x.publish(&cred(), &public(), &post("duplicate".into()))
            .await
            .is_err()
    );
    assert_eq!(r.mock.requests("POST", TWEETS).len(), 1);
}
#[tokio::test]
async fn x_bare_domain_weight_and_media_rules() {
    let r = rig().await;
    r.mock.on("POST", TWEETS, answer("tweet_created"));
    let text = format!("{} example.com/{}", "a".repeat(256), "p".repeat(200));
    r.x.publish(&cred(), &public(), &post(text)).await.unwrap();
    r.mock.clear();
    let short = format!("{} a.co", "a".repeat(257));
    assert!(r.x.publish(&cred(), &public(), &post(short)).await.is_err());
    assert!(
        r.x.publish(&cred(), &public(), &post("界".repeat(141)))
            .await
            .is_err()
    );
    let gif = MediaUpload {
        bytes: vec![1],
        mime: "image/gif".into(),
        filename: "a.gif".into(),
    };
    let mut p = post("media".into());
    p.media = vec![gif.clone(), gif];
    assert!(r.x.publish(&cred(), &public(), &p).await.is_err());
    p.media.pop();
    p.media_urls = vec![
        "https://example.com/a.gif".parse().unwrap(),
        "https://example.com/b.gif".parse().unwrap(),
    ];
    assert!(r.x.publish(&cred(), &public(), &p).await.is_err());
    assert!(r.mock.requests("POST", TWEETS).is_empty());
    assert!(r.mock.requests("POST", UPLOAD).is_empty());
}
#[tokio::test]
async fn accepted_missing_or_unreadable_receipt_is_unknown() {
    let r = rig().await;
    for reply in [ok(json!({"data":{}})), raw(200, "broken json")] {
        r.mock.set("POST", TWEETS, reply);
        assert_eq!(
            r.x.publish(&cred(), &public(), &post("hello".into()))
                .await
                .unwrap_err()
                .kind(),
            "unknown"
        );
    }
}
