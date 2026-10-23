//! Egress allowlist tests.
//!
//! This file is compiled into the library's own unit-test build: `src/lib.rs` includes it under
//! `cfg(test)`, and `autotests = false` keeps Cargo from also building it as an integration test.
//! That is deliberate. Plain http to a loopback literal is tolerated only under `cfg(test)`, and
//! the tests that must complete a request talk to a local plain-http server. Only the crate's
//! public API is used. No test here reaches the public network.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::routing::{any, get};
use jt_app::error::{AppError, ErrorCode};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::multipart::{Form, Part};
use crate::{
    AllowedHost, Egress, EgressError, EgressScope, FIXED_HOSTS, Method, Request, Response,
    StatusCode, Url, header,
};

/// Serves `app` on an ephemeral 127.0.0.1 port for the rest of the test.
async fn serve(app: Router) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

/// A server that answers `GET /` with `200 hello`.
async fn hello_server() -> SocketAddr {
    serve(Router::new().route("/", get(|| async { "hello" }))).await
}

fn get_req(url: &str) -> Request {
    Request::new(Method::GET, Url::parse(url).unwrap())
}

async fn assert_hello(result: Result<Response, EgressError>) {
    let resp = result.expect("the request should pass the allowlist and complete");
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.text().await.unwrap(), "hello");
}

fn assert_refused(result: Result<Response, EgressError>, expected_host: &str) {
    match result {
        Err(EgressError::HostNotAllowed { host }) => assert_eq!(host, expected_host),
        other => panic!("expected HostNotAllowed({expected_host}), got {other:?}"),
    }
}

/// Asserts nothing connected to `listener` within a short grace period.
async fn assert_no_connection(listener: &TcpListener) {
    let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
    assert!(
        accepted.is_err(),
        "a refused request must not open a socket"
    );
}

#[tokio::test]
async fn disallowed_host_is_refused_without_network() {
    let egress = Egress::new(&[]);
    let started = Instant::now();
    let url = "https://203.0.113.1.invalid/";
    assert_refused(
        egress
            .send(EgressScope::Tenant(WorkspaceId::new_v7()), get_req(url))
            .await,
        "203.0.113.1.invalid",
    );
    assert_refused(
        egress
            .send(EgressScope::Connector("meta"), get_req(url))
            .await,
        "203.0.113.1.invalid",
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "a refusal must not wait on DNS or a socket"
    );
}

#[tokio::test]
async fn refused_request_opens_no_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let egress = Egress::new(&[]);
    egress.allow_tenant_host(WorkspaceId::new_v7(), "127.0.0.1");

    let url = format!("http://127.0.0.1:{port}/");
    assert_refused(
        egress
            .send(EgressScope::Tenant(WorkspaceId::new_v7()), get_req(&url))
            .await,
        "127.0.0.1",
    );
    assert_refused(
        egress
            .send(EgressScope::Connector("meta"), get_req(&url))
            .await,
        "127.0.0.1",
    );
    assert_no_connection(&listener).await;
}

#[tokio::test]
async fn fixed_host_allowed_for_its_connector_only() {
    let addr = hello_server().await;
    let egress = Egress::new(&[AllowedHost {
        connector: "meta",
        host: "127.0.0.1",
    }]);
    let url = format!("http://{addr}/");

    assert_hello(
        egress
            .send(EgressScope::Connector("meta"), get_req(&url))
            .await,
    )
    .await;
    assert_refused(
        egress
            .send(EgressScope::Connector("netgsm"), get_req(&url))
            .await,
        "127.0.0.1",
    );
}

#[tokio::test]
async fn tenant_host_allowed_only_for_that_workspace() {
    let addr = hello_server().await;
    let egress = Egress::new(&[]);
    let (mine, theirs) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
    egress.allow_tenant_host(mine, "127.0.0.1");
    let url = format!("http://{addr}/");

    assert_hello(egress.send(EgressScope::Tenant(mine), get_req(&url)).await).await;
    assert_refused(
        egress
            .send(EgressScope::Tenant(theirs), get_req(&url))
            .await,
        "127.0.0.1",
    );
}

#[tokio::test]
async fn tiers_do_not_cross() {
    let addr = hello_server().await;
    let port = addr.port();
    let egress = Egress::new(&[AllowedHost {
        connector: "meta",
        host: "127.0.0.1",
    }]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "localhost");
    let fixed_url = format!("http://127.0.0.1:{port}/");
    let tenant_url = format!("http://localhost:{port}/");

    // Each scope reaches its own tier...
    assert_hello(
        egress
            .send(EgressScope::Connector("meta"), get_req(&fixed_url))
            .await,
    )
    .await;
    assert_hello(
        egress
            .send(EgressScope::Tenant(ws), get_req(&tenant_url))
            .await,
    )
    .await;
    // ...and never the other one.
    assert_refused(
        egress
            .send(EgressScope::Tenant(ws), get_req(&fixed_url))
            .await,
        "127.0.0.1",
    );
    assert_refused(
        egress
            .send(EgressScope::Connector("meta"), get_req(&tenant_url))
            .await,
        "localhost",
    );
}

#[tokio::test]
async fn http_scheme_refused_outside_tests_for_public_hosts() {
    let egress = Egress::new(&[
        AllowedHost {
            connector: "meta",
            host: "example.com",
        },
        AllowedHost {
            connector: "meta",
            host: "10.0.0.1",
        },
    ]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "example.com");
    egress.allow_tenant_host(ws, "10.0.0.1");

    for scope in [EgressScope::Connector("meta"), EgressScope::Tenant(ws)] {
        // The host is allowed, but plain http is tolerated only for loopback literals.
        assert_refused(
            egress.send(scope, get_req("http://example.com/")).await,
            "example.com",
        );
        assert_refused(
            egress.send(scope, get_req("http://10.0.0.1/")).await,
            "10.0.0.1",
        );
        // Any other scheme is never accepted.
        assert_refused(
            egress.send(scope, get_req("ftp://example.com/")).await,
            "example.com",
        );
        assert_refused(egress.send(scope, get_req("file:///etc/passwd")).await, "");
    }
}

#[tokio::test]
async fn allowed_local_host_round_trip() {
    let addr = hello_server().await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "127.0.0.1");

    assert_hello(
        egress
            .send(EgressScope::Tenant(ws), get_req(&format!("http://{addr}/")))
            .await,
    )
    .await;
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let addr = serve(Router::new().route(
        "/",
        get(|| async {
            (
                StatusCode::FOUND,
                [(header::LOCATION, "https://disallowed.example/landing")],
            )
        }),
    ))
    .await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "127.0.0.1");

    let resp = egress
        .send(EgressScope::Tenant(ws), get_req(&format!("http://{addr}/")))
        .await
        .expect("the 302 itself is a normal response");
    assert_eq!(resp.status(), StatusCode::FOUND);
    assert_eq!(
        resp.headers()[header::LOCATION],
        "https://disallowed.example/landing"
    );
    assert_eq!(resp.url().host_str(), Some("127.0.0.1"));
}

#[tokio::test]
async fn revoked_tenant_host_is_refused() {
    let addr = hello_server().await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    let url = format!("http://{addr}/");

    egress.allow_tenant_host(ws, "127.0.0.1");
    assert_hello(egress.send(EgressScope::Tenant(ws), get_req(&url)).await).await;

    egress.revoke_tenant_host(ws, "127.0.0.1");
    assert_refused(
        egress.send(EgressScope::Tenant(ws), get_req(&url)).await,
        "127.0.0.1",
    );

    // Revoking what was never allowed is a no-op.
    egress.revoke_tenant_host(ws, "127.0.0.1");
    egress.revoke_tenant_host(WorkspaceId::new_v7(), "never.example");
    egress.revoke_tenant_host(ws, "not a host");
}

#[tokio::test]
async fn tenant_entry_with_port_must_match_the_url_port() {
    let addr = hello_server().await;
    let port = addr.port();
    let egress = Egress::new(&[]);
    let (exact, other) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
    egress.allow_tenant_host(exact, &format!("127.0.0.1:{port}"));
    egress.allow_tenant_host(other, &format!("127.0.0.1:{}", port.wrapping_add(1)));
    let url = format!("http://{addr}/");

    assert_hello(egress.send(EgressScope::Tenant(exact), get_req(&url)).await).await;
    assert_refused(
        egress.send(EgressScope::Tenant(other), get_req(&url)).await,
        "127.0.0.1",
    );
}

#[tokio::test]
async fn host_match_is_case_insensitive() {
    let addr = hello_server().await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "LocalHost");

    assert_hello(
        egress
            .send(
                EgressScope::Tenant(ws),
                get_req(&format!("http://LOCALHOST:{}/", addr.port())),
            )
            .await,
    )
    .await;
}

#[tokio::test]
async fn errors_map_to_app_error_codes() {
    let refused: AppError = EgressError::HostNotAllowed {
        host: "evil.example".into(),
    }
    .into();
    assert_eq!(refused.code, ErrorCode::HostNotAllowed);
    assert_eq!(refused.details["host"], "evil.example");

    // A closed local port gives a real transport failure.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "127.0.0.1");
    let err = egress
        .send(
            EgressScope::Tenant(ws),
            get_req(&format!("http://127.0.0.1:{port}/?token=secret")),
        )
        .await
        .expect_err("nothing listens on the port");
    assert!(matches!(err, EgressError::Transport(_)), "{err:?}");
    let internal: AppError = err.into();
    assert_eq!(internal.code, ErrorCode::Internal);
    assert!(
        !internal.message.contains("secret"),
        "the URL must not leak into the error: {}",
        internal.message
    );
}

/// A server that answers every request on `/echo` with what it received: the method, the query,
/// three headers and the body as text.
async fn echo_server() -> SocketAddr {
    async fn echo(
        method: axum::http::Method,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
        body: Bytes,
    ) -> axum::Json<Value> {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        axum::Json(json!({
            "method": method.as_str(),
            "query": uri.query().unwrap_or_default(),
            "content_type": header("content-type"),
            "authorization": header("authorization"),
            "x_test": header("x-test"),
            "body": String::from_utf8_lossy(&body),
        }))
    }
    serve(Router::new().route("/echo", any(echo))).await
}

/// The echo of a request that must have completed.
async fn echoed(result: Result<Response, EgressError>) -> Value {
    let resp = result.expect("the request should pass the allowlist and complete");
    assert_eq!(resp.status(), StatusCode::OK);
    resp.json().await.unwrap()
}

#[tokio::test]
async fn prepared_send_goes_through_the_allowlist() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    let url = Url::parse(&format!("http://127.0.0.1:{port}/echo")).unwrap();

    // However it is built, a request the scope may not send is refused before any socket.
    assert_refused(
        egress
            .prepare(Method::POST, url.clone())
            .header("x-test", "1")
            .bearer("secret-token")
            .query(&[("a", "1")])
            .json(&json!({ "k": "v" }))
            .timeout(Duration::from_secs(1))
            .send(EgressScope::Tenant(ws))
            .await,
        "127.0.0.1",
    );
    assert_refused(
        egress
            .prepare(Method::GET, url.clone())
            .send(EgressScope::Connector("meta"))
            .await,
        "127.0.0.1",
    );
    assert_refused(
        egress
            .prepare(Method::GET, Url::parse("https://evil.example/").unwrap())
            .send(EgressScope::Tenant(ws))
            .await,
        "evil.example",
    );
    // The fixed tier's provider hosts are refused to a tenant, and to a scope over http.
    let egress = Egress::new(FIXED_HOSTS);
    assert_refused(
        egress
            .prepare(
                Method::GET,
                Url::parse("https://graph.facebook.com/me").unwrap(),
            )
            .send(EgressScope::Tenant(ws))
            .await,
        "graph.facebook.com",
    );
    assert_refused(
        egress
            .prepare(
                Method::GET,
                Url::parse("http://graph.facebook.com/me").unwrap(),
            )
            .send(EgressScope::Connector("meta"))
            .await,
        "graph.facebook.com",
    );
    assert_no_connection(&listener).await;

    // Allowed, it is sent as built.
    let addr = echo_server().await;
    let egress = Egress::new(&[]);
    egress.allow_tenant_host(ws, "127.0.0.1");
    let got = echoed(
        egress
            .prepare(
                Method::PUT,
                Url::parse(&format!("http://{addr}/echo")).unwrap(),
            )
            .query(&[("fields", "id,name")])
            .header("x-test", "yes")
            .bearer("tok")
            .json(&json!({ "a": 1 }))
            .send(EgressScope::Tenant(ws))
            .await,
    )
    .await;
    assert_eq!(got["method"], "PUT");
    assert_eq!(got["query"], "fields=id%2Cname");
    assert_eq!(got["x_test"], "yes");
    assert_eq!(got["authorization"], "Bearer tok");
    assert_eq!(got["content_type"], "application/json");
    assert_eq!(got["body"], r#"{"a":1}"#);
}

#[tokio::test]
async fn multipart_and_form_bodies_build() {
    let addr = echo_server().await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "127.0.0.1");
    let url = Url::parse(&format!("http://{addr}/echo")).unwrap();
    let scope = EgressScope::Tenant(ws);

    let got = echoed(
        egress
            .prepare(Method::POST, url.clone())
            .form(&[("usercode", "850"), ("msg", "merhaba dünya")])
            .send(scope)
            .await,
    )
    .await;
    assert_eq!(got["content_type"], "application/x-www-form-urlencoded");
    assert_eq!(got["body"], "usercode=850&msg=merhaba+d%C3%BCnya");

    let form = Form::new().text("caption", "selam").part(
        "file",
        Part::bytes(b"RIFF-voice".to_vec())
            .file_name("ses.wav")
            .mime_str("audio/wav")
            .unwrap(),
    );
    let got = echoed(
        egress
            .prepare(Method::POST, url.clone())
            .multipart(form)
            .send(scope)
            .await,
    )
    .await;
    let content_type = got["content_type"].as_str().unwrap();
    assert!(
        content_type.starts_with("multipart/form-data; boundary="),
        "{content_type}"
    );
    let body = got["body"].as_str().unwrap();
    for needle in [
        r#"name="caption""#,
        "selam",
        r#"name="file"; filename="ses.wav""#,
        "content-type: audio/wav",
        "RIFF-voice",
    ] {
        assert!(
            body.to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase()),
            "{needle:?} in {body:?}"
        );
    }

    let got = echoed(
        egress
            .prepare(Method::POST, url.clone())
            .basic_auth("user", Some("pass"))
            .body("raw bytes")
            .send(scope)
            .await,
    )
    .await;
    assert_eq!(got["authorization"], "Basic dXNlcjpwYXNz");
    assert_eq!(got["body"], "raw bytes");
    let got = echoed(
        egress
            .prepare(Method::GET, url)
            .basic_auth("user", None::<&str>)
            .send(scope)
            .await,
    )
    .await;
    assert_eq!(got["authorization"], "Basic dXNlcjo=");
}

#[tokio::test]
async fn prepared_timeouts_and_build_errors() {
    let addr = serve(Router::new().route(
        "/slow",
        get(|| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            "late"
        }),
    ))
    .await;
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "127.0.0.1");
    let scope = EgressScope::Tenant(ws);

    let started = Instant::now();
    let err = egress
        .prepare(
            Method::GET,
            Url::parse(&format!("http://{addr}/slow?token=secret")).unwrap(),
        )
        .timeout(Duration::from_millis(100))
        .send(scope)
        .await
        .expect_err("the server answers too late");
    assert!(started.elapsed() < Duration::from_secs(4));
    match &err {
        EgressError::Transport(e) => {
            assert!(e.is_timeout(), "{e:?}");
            assert!(
                !format!("{e:?}").contains("secret"),
                "the URL must not travel in the error: {e:?}"
            );
        }
        other => panic!("expected a timeout, got {other:?}"),
    }

    // A request that cannot be built is never sent.
    let err = egress
        .prepare(
            Method::GET,
            Url::parse(&format!("http://{addr}/slow")).unwrap(),
        )
        .header("not a header name", "x")
        .send(scope)
        .await
        .expect_err("the header name is invalid");
    assert!(matches!(err, EgressError::Build(_)), "{err:?}");
    let internal: AppError = err.into();
    assert_eq!(internal.code, ErrorCode::Internal);
}

#[tokio::test]
async fn test_hosts_join_a_connectors_fixed_tier() {
    let addr = hello_server().await;
    let egress = Egress::new(FIXED_HOSTS).with_test_hosts([("netgsm", addr.to_string())]);
    let url = format!("http://{addr}/");

    assert_hello(
        egress
            .send(EgressScope::Connector("netgsm"), get_req(&url))
            .await,
    )
    .await;
    assert_refused(
        egress
            .send(EgressScope::Connector("meta"), get_req(&url))
            .await,
        "127.0.0.1",
    );
    assert_refused(
        egress
            .send(EgressScope::Tenant(WorkspaceId::new_v7()), get_req(&url))
            .await,
        "127.0.0.1",
    );
}

#[test]
#[should_panic(expected = "is not a loopback host")]
fn test_hosts_must_be_loopback() {
    let _ = Egress::new(&[]).with_test_hosts([("meta", "graph.facebook.com")]);
}

#[test]
#[should_panic(expected = "is not a loopback host")]
fn test_hosts_must_be_valid() {
    let _ = Egress::new(&[]).with_test_hosts([("meta", "127.0.0.1/path")]);
}
