//! An ordinary integration test: it links the library the way a production build does, without
//! `cfg(test)` and without the `test-loopback` feature, so plain http must be refused even to a
//! loopback literal that is allowed, and `localhost` is judged like any other name.
//!
//! A build that turns `test-loopback` on (a whole-workspace test build, once a crate enables it
//! in its `[dev-dependencies]`, unifies it into this crate) is not a production build, so the file
//! compiles to nothing there; `cargo test -p jt_outbound` builds this crate alone and runs it.
#![cfg(not(feature = "test-loopback"))]

use std::time::Duration;

use jt_outbound::{
    AllowedHost, Egress, EgressError, EgressScope, HostError, Method, Request, Url,
    allow_plain_http, resolve_public,
};
use jt_tenancy::WorkspaceId;
use tokio::net::TcpListener;

#[tokio::test]
async fn plain_http_to_loopback_is_refused_outside_the_test_build() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let egress = Egress::new(&[
        AllowedHost {
            connector: "meta",
            host: "127.0.0.1",
        },
        AllowedHost {
            connector: "meta",
            host: "localhost",
        },
        AllowedHost {
            connector: "meta",
            host: "[::1]",
        },
    ]);
    let ws = WorkspaceId::new_v7();
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        egress.allow_tenant_host(ws, host);
    }

    for scope in [EgressScope::Connector("meta"), EgressScope::Tenant(ws)] {
        for host in ["127.0.0.1", "localhost", "[::1]"] {
            let url = Url::parse(&format!("http://{host}:{port}/")).unwrap();
            match egress.send(scope, Request::new(Method::GET, url)).await {
                Err(EgressError::HostNotAllowed { host: refused }) => assert_eq!(refused, host),
                other => panic!("plain http to {host} must be refused, got {other:?}"),
            }
        }
    }

    let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
    assert!(
        accepted.is_err(),
        "a refused request must not open a socket"
    );
}

#[tokio::test]
async fn localhost_is_refused_by_the_dns_guard_outside_the_test_build() {
    // Judged on the name and the literal alone: nothing is looked up.
    assert_eq!(
        resolve_public("localhost", 80).await,
        Err(HostError::Localhost("localhost".into()))
    );
    assert_eq!(
        resolve_public("127.0.0.1", 80).await,
        Err(HostError::NonPublicAddress("127.0.0.1".parse().unwrap()))
    );
}

#[test]
fn the_netsantral_exception_holds_in_a_production_build() {
    let netgsm = EgressScope::Connector("netgsm");
    assert!(allow_plain_http(&netgsm, "crmsntrl.netgsm.com.tr", 9111));
    assert!(!allow_plain_http(&netgsm, "crmsntrl.netgsm.com.tr", 80));
    assert!(!allow_plain_http(&netgsm, "127.0.0.1", 9111));
    assert!(!allow_plain_http(
        &EgressScope::Connector("meta"),
        "crmsntrl.netgsm.com.tr",
        9111
    ));
}
