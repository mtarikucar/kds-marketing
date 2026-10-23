//! Keep log capture in its own test binary: parallel Graph tests can register the same
//! tracing callsite without a subscriber, caching disabled interest process-wide.

mod support;

use std::sync::Arc;

use jt_app::ports::connectors::OAuthProvider;
use jt_connector::Credential;
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};
use tracing::instrument::WithSubscriber;

const USER_TOKEN: &str = "EAAB-long-test";

/// A part of the asset listing left out is logged with its reason: never with a secret the
/// provider echoed.
#[tokio::test]
async fn a_skipped_listing_part_logs_no_echoed_secret() {
    use std::io::Write;
    use std::sync::Mutex;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);
    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let r = rig().await;
    let m = &r.mock;
    m.on("GET", "/fb/v19.0/me/accounts", ok(json!({ "data": [] })));
    let refusal = |token: &str| {
        status(
            403,
            json!({ "error": {
                "message": format!("token {token} lacks ads_read; app {META_APP_SECRET}"),
                "type": "OAuthException", "code": 200,
            }}),
        )
    };
    m.on("GET", "/fb/v19.0/me/adaccounts", refusal(USER_TOKEN));
    m.on("GET", "/fb/v19.0/me/businesses", refusal(USER_TOKEN));

    let buffer = Buffer::default();
    let writer = buffer.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let cred = Credential::OAuth {
        access_token: USER_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(50)),
        scopes: vec!["ads_read".into()],
    };
    let listed = r.meta.list_assets(&cred).with_subscriber(subscriber).await;
    assert!(listed.unwrap().is_empty());
    let logged = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(
        logged.contains("a part of the Meta asset listing was left out"),
        "{logged}"
    );
    assert_no_echo("the log", &logged, &[USER_TOKEN, META_APP_SECRET]);
}
