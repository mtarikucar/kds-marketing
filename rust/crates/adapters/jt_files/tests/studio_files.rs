use jt_app::ports::{connectors::MediaUpload, files::FileStore};
use jt_files::DiskFiles;
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use std::{path::PathBuf, sync::Arc};
use time::Duration;
fn root() -> PathBuf {
    let p = std::env::temp_dir().join(format!("t047-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&p).unwrap();
    p
}
fn disk(p: &std::path::Path) -> DiskFiles {
    DiskFiles::new(
        p,
        "https://files.example.com".parse().unwrap(),
        [42; 32],
        Arc::new(FixedClock(FIXED_NOW)),
    )
    .unwrap()
}
fn upload() -> MediaUpload {
    MediaUpload {
        bytes: b"\x89PNG\r\n\x1a\nexample-content".to_vec(),
        mime: "image/png".into(),
        filename: "asset.png".into(),
    }
}
#[tokio::test]
async fn x_bytes_reload_after_restart() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let id = FileId::new_v7();
    disk(&p).put(ws, id, upload()).await.unwrap();
    assert_eq!(disk(&p).read(ws, id).await.unwrap(), upload());
    assert!(disk(&p).read(WorkspaceId::new_v7(), id).await.is_err());
    std::fs::remove_dir_all(p).unwrap();
}
#[tokio::test]
async fn path_traversal_and_symlink_escape_rejected() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let id = FileId::new_v7();
    let d = disk(&p);
    let mut u = upload();
    u.filename = "../../escape".into();
    assert!(d.put(ws, id, u).await.is_err());
    let outside = root();
    std::os::unix::fs::symlink(&outside, p.join(ws.to_string())).unwrap();
    assert!(d.put(ws, id, upload()).await.is_err());
    assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    std::fs::remove_dir_all(p).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}
#[tokio::test]
async fn interrupted_file_write_never_returns_corrupt_asset() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let id = FileId::new_v7();
    let d = disk(&p);
    d.put(ws, id, upload()).await.unwrap();
    std::fs::write(p.join(ws.to_string()).join(id.to_string()), b"interrupted").unwrap();
    assert!(disk(&p).read(ws, id).await.is_err());
    std::fs::remove_dir_all(p).unwrap();
}
#[tokio::test]
async fn provider_url_expires_at_24_hours_and_is_tenant_signed() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let id = FileId::new_v7();
    let d = disk(&p);
    d.put(ws, id, upload()).await.unwrap();
    let url = d
        .provider_url(ws, id, FIXED_NOW + Duration::hours(24))
        .await
        .unwrap();
    let q: std::collections::HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let expiry = q["expires"].parse().unwrap();
    assert_eq!(expiry, (FIXED_NOW + Duration::hours(24)).unix_timestamp());
    assert!(jt_files::verify(&[42; 32], ws, id, expiry, &q["signature"], FIXED_NOW).is_ok());
    assert!(
        jt_files::verify(
            &[42; 32],
            WorkspaceId::new_v7(),
            id,
            expiry,
            &q["signature"],
            FIXED_NOW
        )
        .is_err()
    );
    assert!(
        jt_files::verify(
            &[42; 32],
            ws,
            id,
            expiry,
            &q["signature"],
            FIXED_NOW + Duration::hours(24)
        )
        .is_err()
    );
    assert!(
        d.provider_url(ws, id, FIXED_NOW + Duration::hours(25))
            .await
            .is_err()
    );
    std::fs::remove_dir_all(p).unwrap();
}
#[tokio::test]
async fn a_pulled_file_is_kept_and_a_url_may_live_shorter_than_a_day() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let d = disk(&p);
    // A file a device bridge pulled off a phone: any bytes, none too, kept as uploaded.
    for (bytes, filename) in [
        (b"\x00\x01any bytes".to_vec(), "pulled.bin"),
        (Vec::new(), "empty.bin"),
    ] {
        let id = FileId::new_v7();
        let u = MediaUpload {
            bytes,
            mime: "application/octet-stream".into(),
            filename: filename.into(),
        };
        d.put(ws, id, u.clone()).await.unwrap();
        assert_eq!(disk(&p).read(ws, id).await.unwrap(), u);
    }
    // A ten-minute URL (a device bridge's `push_file`) reads the file until it expires.
    let id = FileId::new_v7();
    d.put(ws, id, upload()).await.unwrap();
    let url = d
        .provider_url(ws, id, FIXED_NOW + Duration::minutes(10))
        .await
        .unwrap();
    assert_eq!(url.scheme(), "https");
    let q: std::collections::HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let expiry: i64 = q["expires"].parse().unwrap();
    assert_eq!(expiry, (FIXED_NOW + Duration::minutes(10)).unix_timestamp());
    let verify = |now| jt_files::verify(&[42; 32], ws, id, expiry, &q["signature"], now);
    assert!(verify(FIXED_NOW + Duration::minutes(9)).is_ok());
    assert!(verify(FIXED_NOW + Duration::minutes(10)).is_err());
    // A URL that would be over already is refused.
    assert!(d.provider_url(ws, id, FIXED_NOW).await.is_err());
    std::fs::remove_dir_all(p).unwrap();
}
#[tokio::test]
async fn a_streamed_file_is_hashed_as_it_comes_and_linked_whole() {
    use jt_testkit::fakes::files::Chunks;
    let p = root();
    let ws = WorkspaceId::new_v7();
    let d = disk(&p);
    // A pulled file in three chunks reads back whole, with its size and hash.
    let id = FileId::new_v7();
    let mut source = Chunks(vec![b"ab".to_vec(), Vec::new(), b"cd\x00e".to_vec()].into());
    let f = d
        .put_stream(
            ws,
            id,
            "application/octet-stream",
            "pulled.bin",
            &mut source,
        )
        .await
        .unwrap();
    assert_eq!(f.size_bytes, 6);
    let back = disk(&p).read(ws, id).await.unwrap();
    assert_eq!(back.bytes, b"abcd\x00e");
    assert_eq!(f.sha256, hex_of(&back.bytes));
    // A PNG streams too; one that is not a PNG is refused and leaves no file behind.
    let shot = FileId::new_v7();
    let mut source = Chunks(vec![b"\x89PNG".to_vec(), b"\r\n\x1a\nscreen".to_vec()].into());
    d.put_stream(ws, shot, "image/png", "shot.png", &mut source)
        .await
        .unwrap();
    let fake = FileId::new_v7();
    let mut source = Chunks::of(b"not a png");
    assert!(
        d.put_stream(ws, fake, "image/png", "fake.png", &mut source)
            .await
            .is_err()
    );
    let names: Vec<String> = std::fs::read_dir(p.join(ws.to_string()))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
    // A streamed file is new: its id is not taken again.
    let mut source = Chunks::of(b"again");
    let e = d
        .put_stream(
            ws,
            id,
            "application/octet-stream",
            "pulled.bin",
            &mut source,
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Conflict);
    // A URL for a file that is not there is NOT_FOUND; for one that is, it is signed from the
    // file's header alone.
    let e = d
        .provider_url(ws, FileId::new_v7(), FIXED_NOW + Duration::minutes(10))
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::NotFound);
    assert!(
        d.provider_url(ws, id, FIXED_NOW + Duration::minutes(10))
            .await
            .is_ok()
    );
    std::fs::remove_dir_all(p).unwrap();
}
fn hex_of(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[test]
fn file_config_requires_dir_and_public_base() {
    let p = root();
    assert!(
        DiskFiles::new(
            &p,
            "http://files.example.com".parse().unwrap(),
            [42; 32],
            Arc::new(FixedClock(FIXED_NOW))
        )
        .is_err()
    );
    assert!(
        DiskFiles::new(
            &p.join("missing"),
            "https://files.example.com".parse().unwrap(),
            [42; 32],
            Arc::new(FixedClock(FIXED_NOW))
        )
        .is_err()
    );
    std::fs::remove_dir_all(p).unwrap();
}

async fn media_server() -> (url::Url, tokio::task::JoinHandle<()>) {
    use axum::{Router, response::Redirect, routing::get};
    let app = Router::new()
        .route(
            "/asset",
            get(|| async { b"\x89PNG\r\n\x1a\nasset".as_slice() }),
        )
        .route(
            "/redirect",
            get(|| async { Redirect::temporary("http://169.254.169.254/private") }),
        )
        .route(
            "/large",
            get(|| async { ([("content-length", "25000001")], "too large") }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/").parse().unwrap(), task)
}
#[tokio::test]
async fn media_url_fetch_obeys_tenant_egress_and_redirects() {
    use jt_app::ports::files::MediaFetcher;
    let (base, task) = media_server().await;
    let e = Arc::new(jt_outbound::Egress::new(&[]));
    let ws = WorkspaceId::new_v7();
    let fetch = jt_files::CheckedMediaFetcher(e.clone());
    assert!(
        fetch
            .fetch(ws, &base.join("asset").unwrap(), "image/png", "x.png")
            .await
            .is_err()
    );
    e.allow_tenant_host(ws, &format!("127.0.0.1:{}", base.port().unwrap()));
    assert!(
        fetch
            .fetch(ws, &base.join("asset").unwrap(), "image/png", "x.png")
            .await
            .is_ok()
    );
    assert!(
        fetch
            .fetch(
                WorkspaceId::new_v7(),
                &base.join("asset").unwrap(),
                "image/png",
                "x.png"
            )
            .await
            .is_err()
    );
    assert!(
        fetch
            .fetch(ws, &base.join("redirect").unwrap(), "image/png", "x.png")
            .await
            .is_err()
    );
    assert!(
        fetch
            .fetch(ws, &base.join("large").unwrap(), "image/png", "x.png")
            .await
            .is_err()
    );
    assert!(
        fetch
            .fetch(
                ws,
                &"https://127.0.0.2/x".parse().unwrap(),
                "image/png",
                "x.png"
            )
            .await
            .is_err()
    );
    task.abort();
}
#[tokio::test]
async fn hosted_url_remains_direct_and_x_fetch_is_bounded() {
    use jt_app::usecases::studio::files::resolve_media;
    let (base, task) = media_server().await;
    let e = Arc::new(jt_outbound::Egress::new(&[]));
    let ws = WorkspaceId::new_v7();
    e.allow_tenant_host(ws, &format!("127.0.0.1:{}", base.port().unwrap()));
    let mut d = jt_testkit::fakes::deps(Arc::new(jt_testkit::fakes::InMemoryUow::new()));
    d.media_fetch = Arc::new(jt_files::CheckedMediaFetcher(e));
    let url = base.join("asset").unwrap();
    let media = [jt_studio::MediaAsset::HostedUrl {
        url: url.clone(),
        mime: "image/png".into(),
        size_bytes: 13,
    }];
    let (urls, bytes) = resolve_media(&d, ws, &media, "instagram").await.unwrap();
    assert_eq!(urls, vec![url]);
    assert!(bytes.is_empty());
    let (urls, bytes) = resolve_media(&d, ws, &media, "x").await.unwrap();
    assert!(urls.is_empty());
    assert_eq!(bytes[0].bytes, b"\x89PNG\r\n\x1a\nasset");
    let bad = [jt_studio::MediaAsset::HostedUrl {
        url: base.join("large").unwrap(),
        mime: "image/png".into(),
        size_bytes: 25_000_001,
    }];
    assert!(resolve_media(&d, ws, &bad, "x").await.is_err());
    task.abort();
}
#[tokio::test]
async fn interrupted_temporary_write_is_repaired_and_orphans_are_reconciled() {
    use jt_app::ports::{UnitOfWork, files::FileMaintenance};
    let p = root();
    let d = Arc::new(disk(&p));
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    let fixture = jt_testkit::studio_contract::ready(uow.as_ref()).await;
    let orphan = FileId::new_v7();
    d.put(fixture.ws, orphan, upload()).await.unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(172800);
    let tenant = p.join(fixture.ws.to_string());
    let partial = tenant.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&partial, b"partial").unwrap();
    for path in [&partial, &tenant.join(orphan.to_string())] {
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.files = d.clone();
    deps.file_maintenance = d.clone();
    deps.clock = Arc::new(jt_app::std_impls::SystemClock);
    let known = d.put(fixture.ws, FileId::new_v7(), upload()).await.unwrap();
    assert!(!partial.exists());
    let mut r = uow.tenant(fixture.ws).await.unwrap();
    r.studio().save_file(known.clone()).await.unwrap();
    r.commit().await.unwrap();
    let due = time::OffsetDateTime::now_utc() - Duration::hours(24);
    assert_eq!(
        d.orphan_candidates(fixture.ws, due).await.unwrap(),
        vec![orphan]
    );
    jt_app::usecases::studio::files::cleanup_files(&deps, fixture.ws)
        .await
        .unwrap();
    assert!(d.read(fixture.ws, orphan).await.is_err());
    assert!(d.read(fixture.ws, known.id).await.is_ok());
    std::fs::remove_dir_all(p).unwrap();
}
#[tokio::test]
async fn file_bytes_and_signed_tokens_absent_from_logs() {
    use std::io::Write;
    use tower::ServiceExt;
    #[derive(Clone)]
    struct Capture(Arc<std::sync::Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let capture = Capture(Arc::new(std::sync::Mutex::new(vec![])));
    let out = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || out.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let p = root();
    let d = Arc::new(disk(&p));
    let ws = WorkspaceId::new_v7();
    let id = FileId::new_v7();
    d.put(ws, id, upload()).await.unwrap();
    let url = d
        .provider_url(ws, id, FIXED_NOW + Duration::hours(24))
        .await
        .unwrap();
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "signature")
        .unwrap()
        .1
        .into_owned();
    let app = jt_files::router(d, Arc::new(FixedClock(FIXED_NOW)), [42; 32]);
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::get(format!("{}?{}", url.path(), url.query().unwrap()))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let bad = app
        .oneshot(
            axum::http::Request::get(format!(
                "{}?{}&extra=token",
                url.path(),
                url.query().unwrap()
            ))
            .body(axum::body::Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(!bad.status().is_success());
    tracing::info!("capture sentinel");
    tracing::debug!(upload=?upload(),"redacted media debug");
    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("capture sentinel"));
    assert!(!logs.contains("example-content"));
    assert!(!logs.contains(&token));
    assert!(!logs.contains(url.as_str()));
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn fragmented_mp4_url_ingestion_accepts_iso5_with_iso6_mp41() {
    use axum::{Router, routing::get};
    use jt_app::{
        ctx::Ctx,
        ports::UnitOfWork,
        usecases::studio::files::{FileUploadInput, UploadContent, file_upload},
    };
    // ftyp size 24: major iso5, minor version 0, compatible iso6/mp41.
    const HEADER: &[u8] = b"\0\0\0\x18ftypiso5\0\0\0\0iso6mp41";
    let app = Router::new().route(
        "/fragmented.mp4",
        get(|| async { ([("content-type", "video/mp4")], HEADER) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    let fixture = jt_testkit::studio_contract::ready(uow.as_ref()).await;
    let mut r = uow.tenant(fixture.ws).await.unwrap();
    let frame = r.strategy().current_approved().await.unwrap().unwrap();
    drop(r);
    let ctx = Ctx {
        workspace_id: fixture.ws,
        actor: frame.created_by,
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let egress = Arc::new(jt_outbound::Egress::new(&[]));
    egress.allow_tenant_host(fixture.ws, &addr.to_string());
    let p = root();
    let mut d = jt_testkit::fakes::deps(uow);
    d.files = Arc::new(disk(&p));
    d.media_fetch = Arc::new(jt_files::CheckedMediaFetcher(egress));
    let result = file_upload(
        &d,
        &ctx,
        FileUploadInput {
            request_key: "fragmented-url".into(),
            filename: "fragmented.mp4".into(),
            mime: "video/mp4".into(),
            content: UploadContent::SourceUrl {
                url: format!("http://{addr}/fragmented.mp4").parse().unwrap(),
            },
        },
    )
    .await;
    server.abort();
    let stored = result.unwrap();
    assert_eq!(stored.mime, "video/mp4");
    assert_eq!(stored.size_bytes, HEADER.len() as u64);
    assert_eq!(
        d.files.read(fixture.ws, stored.id).await.unwrap().bytes,
        HEADER
    );
    std::fs::remove_dir_all(p).unwrap();
}
