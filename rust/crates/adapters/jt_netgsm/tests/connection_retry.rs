//! A real refused connection followed by recovery, without releasing a port or racing timers.
//! The retry subscriber lives in its own binary so parallel tests cannot affect callsite interest.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{DeliveryReports, SmsSender};
use jt_netgsm::RetryPolicy;
use support::*;
use time::Duration;
use tokio::net::TcpSocket;
use tracing::instrument::WithSubscriber;
use tracing::{Event, Metadata, Subscriber, span};

const INBOX: &str = "/api/sms/rest/v2/inbox";

struct Recovery {
    socket: Option<TcpSocket>,
    mock: Option<Mock>,
    retries: usize,
}

/// Open the reserved port synchronously at the adapter's retry boundary, after the refused
/// attempt and before the next attempt. No elapsed-time assumption controls server readiness.
struct StartOnRetry(Mutex<Recovery>);

impl Subscriber for StartOnRetry {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.is_event()
            && metadata.target() == "jt_netgsm::client"
            && metadata.fields().field("attempt").is_some()
    }

    fn event(&self, _: &Event<'_>) {
        let mut recovery = self.0.lock().unwrap();
        recovery.retries += 1;
        let listener = recovery
            .socket
            .take()
            .expect("exactly one retry")
            .listen(128)
            .unwrap();
        let mock = Mock::from_listener(listener);
        mock.on("GET", INBOX, rest("inbox"));
        recovery.mock = Some(mock);
    }

    fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
        unreachable!("only retry events are enabled")
    }
    fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
    fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
    fn enter(&self, _: &span::Id) {}
    fn exit(&self, _: &span::Id) {}
}

#[tokio::test]
async fn a_read_retries_once_on_a_connect_failure() {
    // A bound, non-listening socket refuses connections while keeping ownership of its port.
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let addr = socket.local_addr().unwrap();
    let recovery = Arc::new(StartOnRetry(Mutex::new(Recovery {
        socket: Some(socket),
        mock: None,
        retries: 0,
    })));
    let netgsm = connector_at(
        addr,
        RetryPolicy {
            attempts: 2,
            base_delay: StdDuration::ZERO,
        },
        StdDuration::from_secs(5),
    );
    let drafts = netgsm
        .inbox(&sms_cred(), START - Duration::hours(2), START)
        .with_subscriber(recovery.clone())
        .await
        .unwrap();
    assert_eq!(drafts.len(), 2);
    {
        let recovered = recovery.0.lock().unwrap();
        assert_eq!(recovered.retries, 1);
        // The refused attempt never reached the mock; exactly one successful retry did.
        assert_eq!(
            recovered
                .mock
                .as_ref()
                .unwrap()
                .requests("GET", INBOX)
                .len(),
            1
        );
    }

    // Keep another port reserved but not listening for the entire action.
    let closed = TcpSocket::new_v4().unwrap();
    closed.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let netgsm = connector_at(
        closed.local_addr().unwrap(),
        no_pause(),
        StdDuration::from_secs(5),
    );
    let e = netgsm
        .send(&sms_cred(), "905000000001", "Merhaba", None, false)
        .with_subscriber(recovery.clone())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert!(e.reason().unwrap().contains("nothing was sent"), "{e}");
    assert_eq!(recovery.0.lock().unwrap().retries, 1, "actions never retry");
    drop(closed);
}
