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
