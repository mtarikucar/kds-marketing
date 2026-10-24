use jt_app::{
    error::ErrorCode,
    ports::{files::MediaFetcher, studio::PublishOutcome},
};
use jt_files::CheckedMediaFetcher;
use jt_outbound::Egress;
use jt_studio::RedactedPublishError;
use jt_tenancy::WorkspaceId;
use std::sync::Arc;

#[tokio::test]
async fn real_media_fetch_preserves_transient_and_permanent_failures() {
    use axum::{Router, http::StatusCode, routing::get};
    let app = Router::new()
        .route("/busy", get(|| async { StatusCode::SERVICE_UNAVAILABLE }))
        .route("/limited", get(|| async { StatusCode::TOO_MANY_REQUESTS }))
        .route("/timeout", get(|| async { StatusCode::REQUEST_TIMEOUT }))
        .route("/missing", get(|| async { StatusCode::NOT_FOUND }))
        .route("/invalid", get(|| async { "not an image" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let ws = WorkspaceId::new_v7();
    let egress = Arc::new(Egress::new(&[]));
    egress.allow_tenant_host(ws, &addr.to_string());
    let fetcher = CheckedMediaFetcher(egress.clone());
    for (path, category) in [
        ("busy", RedactedPublishError::Transient),
        ("limited", RedactedPublishError::Transient),
        ("timeout", RedactedPublishError::Transient),
        ("missing", RedactedPublishError::Permanent),
        ("invalid", RedactedPublishError::Permanent),
    ] {
        let url = format!("http://{addr}/{path}?secret=private-token")
            .parse()
            .unwrap();
        let error = fetcher
            .fetch(ws, &url, "image/png", "image.png")
            .await
            .unwrap_err();
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("private-token")
        );
        assert_eq!(
            PublishOutcome::Failed(error).into_redacted(),
            jt_studio::PublishOutcome::Failed(category),
            "{path}"
        );
    }
    // A refused TCP connection is retry-worthy, unlike a disallowed host or invalid bytes.
    let unreachable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = unreachable.local_addr().unwrap();
    egress.allow_tenant_host(ws, &addr.to_string());
    drop(unreachable);
    let url = format!("http://{addr}/asset?secret=private-token")
        .parse()
        .unwrap();
    let error = fetcher
        .fetch(ws, &url, "image/png", "image.png")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UpstreamUnavailable);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-token")
    );
    server.abort();
}

#[tokio::test]
async fn interrupted_media_body_is_transient_and_redacted() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let received = socket.read(&mut request).await.unwrap();
        assert!(received > 0);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n\x89PNG\r\n\x1a\n").await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let ws = WorkspaceId::new_v7();
    let egress = Arc::new(Egress::new(&[]));
    egress.allow_tenant_host(ws, &addr.to_string());
    let url = format!("http://{addr}/asset?secret=private-token")
        .parse()
        .unwrap();
    let error = CheckedMediaFetcher(egress)
        .fetch(ws, &url, "image/png", "image.png")
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.code, ErrorCode::UpstreamUnavailable);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-token")
    );
}
