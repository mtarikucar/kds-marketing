//! An ordinary integration test: it links the library the way a production build does, without
//! `cfg(test)`, so plain http must be refused even to a loopback literal that is allowed.

use std::time::Duration;

use jt_outbound::{AllowedHost, Egress, EgressError, EgressScope, Method, Request, Url};
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
