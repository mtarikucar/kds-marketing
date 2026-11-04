//! The LinkedIn adapter as Studio uses it, through the port objects: what a publication and a
//! measurement record when LinkedIn refuses them (the failure line of
//! `jt_app::usecases::failure`), and that publishing is synchronous.

mod support;

use std::sync::Arc;

use jt_app::ports::connectors::{InsightsReader, LinkedinApp, PublishRequest, Publisher};
use jt_app::usecases::failure::{failure_kind, failure_reason, http_status};
use jt_connector::Provider;
use support::*;

fn post(text: &str) -> PublishRequest {
    PublishRequest {
        text: text.into(),
        ..PublishRequest::default()
    }
}

#[tokio::test]
async fn a_retired_version_fails_with_a_line_naming_it() {
    let apps = TestApps {
        linkedin: Some(LinkedinApp {
            api_version: Some("202401".into()),
            ..linkedin_app(false)
        }),
    };
    let r = rig_with(apps, jt_linkedin::ATTEMPT_TIMEOUT).await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(426, "error_426"));
    let publisher: Arc<dyn Publisher> = Arc::new(r.li);
    let e = publisher
        .publish(&member_cred(), &member_public(), &post("Merhaba"))
        .await
        .unwrap_err();
    let line = failure_reason(Some(Provider::Linkedin), &e);
    assert_eq!(
        line,
        "permanent: linkedin: HTTP 426 NONEXISTENT_VERSION: Requested version 202401 is not \
         active (Linkedin-Version 202401 sent)"
    );
    assert_eq!(failure_kind(&line), "permanent");
    assert_eq!(http_status(&line), Some(426));
    assert_no_secret(&line);
}

#[tokio::test]
async fn a_missing_page_role_or_scope_fails_as_permission() {
    let r = rig().await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(403, "error_403"));
    let e =
        r.li.publish(&page_cred(), &page_public(), &post("Merhaba"))
            .await
            .unwrap_err();
    assert_eq!(
        failure_reason(Some(Provider::Linkedin), &e),
        "permission: linkedin: HTTP 403 ACCESS_DENIED: Not enough permissions to access: \
         partnerApiPostsExternal.CREATE.20261001"
    );
}

#[tokio::test]
async fn member_measurement_is_permanently_unsupported() {
    let r = rig().await;
    let insights: Arc<dyn InsightsReader> = Arc::new(r.li);
    let e = insights
        .post_metrics(&member_cred(), &member_public(), SHARE)
        .await
        .unwrap_err();
    assert!(!e.is_retriable(), "no retry storm: {e}");
    assert_eq!(
        failure_reason(Some(Provider::Linkedin), &e),
        "permanent: linkedin: LinkedIn exposes no member post metrics"
    );
    let e = insights
        .account_metrics(&member_cred(), &member_public())
        .await
        .unwrap_err();
    assert_eq!(
        failure_reason(Some(Provider::Linkedin), &e),
        "permanent: linkedin: LinkedIn exposes no member account metrics"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn a_throttle_and_a_lost_answer_have_their_own_lines() {
    let r = rig().await;
    r.mock
        .on("POST", POSTS, r.mock.answer_with(429, "error_429"));
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba"))
            .await
            .unwrap_err();
    assert_eq!(
        failure_reason(Some(Provider::Linkedin), &e),
        "throttle: linkedin"
    );

    // Accepted without the post id: it may be live, so it is never published again blindly.
    r.mock.set("POST", POSTS, raw(201, ""));
    let e =
        r.li.publish(&member_cred(), &member_public(), &post("Merhaba"))
            .await
            .unwrap_err();
    let line = failure_reason(Some(Provider::Linkedin), &e);
    assert_eq!(
        line,
        "unknown: linkedin: accepted response lacks a valid post id"
    );
    assert_eq!(failure_kind(&line), "unknown");
}

#[tokio::test]
async fn publishing_is_synchronous_the_receipt_is_the_post() {
    let r = rig().await;
    r.mock.on("POST", POSTS, created(SHARE));
    let publisher: Arc<dyn Publisher> = Arc::new(r.li);
    let receipt = publisher
        .publish(&page_cred(), &page_public(), &post("Merhaba"))
        .await
        .unwrap();
    assert_eq!(receipt.external_id, SHARE);
    assert_eq!(
        receipt.url.as_ref().map(url::Url::as_str),
        Some("https://www.linkedin.com/feed/update/urn:li:share:7100000000000000001/")
    );
    // Nothing to resolve: LinkedIn answers once the post exists.
    assert_eq!(
        publisher
            .resolve(&page_cred(), &page_public(), &receipt)
            .await
            .unwrap(),
        None
    );
    assert_eq!(r.mock.requests("POST", POSTS).len(), 1);
}
