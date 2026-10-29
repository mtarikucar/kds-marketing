//! The signed retrieval route as a client meets it: a file is served as a stream, a file that
//! fails its check is never served whole (an error to a real HTTP client, a `404` when it fits in
//! its first chunk), a few files are served at a time (per file, per workspace and use, and
//! process-wide), and a client that stops reading does not keep its turn.
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::StreamExt;
use jt_app::ports::{connectors::MediaUpload, files::FileStore};
use jt_files::{DiskFiles, READ_CHUNK, ReadLimits};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::files::Chunks;
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use time::Duration;
use tower::ServiceExt;

const KEY: [u8; 32] = [42; 32];

fn root() -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("serve-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&p).unwrap();
    p
}

fn disk(p: &std::path::Path) -> Arc<DiskFiles> {
    Arc::new(
        DiskFiles::new(
            p,
            "https://files.example.com".parse().unwrap(),
            KEY,
            Arc::new(FixedClock(FIXED_NOW)),
        )
        .unwrap(),
    )
}

/// A pulled file of a mebibyte and a bit (17 chunks), stored by `d` in `ws`.
async fn large(d: &DiskFiles, ws: WorkspaceId) -> (FileId, Vec<u8>) {
    let bytes: Vec<u8> = (0..(1024 * 1024 + 5)).map(|i| (i % 251) as u8).collect();
    let id = FileId::new_v7();
    let mut source = Chunks(bytes.chunks(256 * 1024).map(<[u8]>::to_vec).collect());
    d.put_stream(
        ws,
        id,
        "application/octet-stream",
        "pulled.bin",
        &mut source,
    )
    .await
    .unwrap();
    (id, bytes)
}

/// The path and query of file `id`'s address, signed for ten minutes.
async fn signed(d: &DiskFiles, ws: WorkspaceId, id: FileId) -> String {
    let url = d
        .provider_url(ws, id, FIXED_NOW + Duration::minutes(10))
        .await
        .unwrap();
    format!("{}?{}", url.path(), url.query().unwrap())
}

fn get(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
}

/// Flips a byte of the stored file of `id`, `from_end` bytes before its end: its length stays.
fn tamper(p: &std::path::Path, ws: WorkspaceId, id: FileId, from_end: usize) {
    let path = p.join(ws.to_string()).join(id.to_string());
    let mut stored = std::fs::read(&path).unwrap();
    let at = stored.len() - from_end;
    stored[at] ^= 0xff;
    std::fs::write(&path, &stored).unwrap();
}

/// The body's bytes until it ends or fails, and whether it failed.
async fn drain(body: Body) -> (Vec<u8>, bool) {
    let mut stream = body.into_data_stream();
    let mut got = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => got.extend_from_slice(&chunk),
            Err(_) => return (got, true),
        }
    }
    (got, false)
}

#[tokio::test]
async fn a_tampered_file_is_an_error_to_a_real_client() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let d = disk(&p);
    let (id, bytes) = large(&d, ws).await;
    let path = signed(&d, ws, id).await;
    let app = jt_files::router(d.clone(), Arc::new(FixedClock(FIXED_NOW)), KEY);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let egress = jt_outbound::Egress::new(&[]);
    egress.allow_tenant_host(ws, &format!("127.0.0.1:{}", addr.port()));
    let url: jt_outbound::Url = format!("http://{addr}{path}").parse().unwrap();
    let fetch = || async {
        let mut response = egress
            .prepare(jt_outbound::Method::GET, url.clone())
            .send(jt_outbound::EgressScope::Tenant(ws))
            .await
            .unwrap();
        let status = response.status().as_u16();
        let length = response.content_length();
        let mut got = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => got.extend_from_slice(&chunk),
                Ok(None) => return (status, length, got, false),
                Err(_) => return (status, length, got, true),
            }
        }
    };
    // Whole, over a real connection.
    let (status, length, got, failed) = fetch().await;
    assert_eq!(
        (status, length, failed),
        (200, Some(bytes.len() as u64), false)
    );
    assert_eq!(got, bytes);
    // Changed on disk: the client is told its length, gets less, and sees an error, never a
    // clean end.
    tamper(&p, ws, id, 200_000);
    let (status, length, got, failed) = fetch().await;
    assert_eq!((status, length), (200, Some(bytes.len() as u64)));
    assert!(failed, "a short body must read as an error");
    assert!(got.len() < bytes.len(), "{}", got.len());
    server.abort();
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn a_tampered_file_that_fits_its_first_chunk_is_not_found() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let d = disk(&p);
    let app = jt_files::router(d.clone(), Arc::new(FixedClock(FIXED_NOW)), KEY);
    // A screenshot, well under a chunk.
    let shot = FileId::new_v7();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(std::iter::repeat_n(7u8, READ_CHUNK / 2));
    d.put(
        ws,
        shot,
        MediaUpload {
            bytes: png.clone(),
            mime: "image/png".into(),
            filename: "shot.png".into(),
        },
    )
    .await
    .unwrap();
    let path = signed(&d, ws, shot).await;
    let response = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(drain(response.into_body()).await, (png, false));
    tamper(&p, ws, shot, 10);
    let response = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // An empty file whose header's hash is not its bytes': not found either.
    let empty = FileId::new_v7();
    d.put_stream(
        ws,
        empty,
        "application/octet-stream",
        "empty.bin",
        &mut Chunks(Default::default()),
    )
    .await
    .unwrap();
    let path = signed(&d, ws, empty).await;
    let response = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "0");
    let stored = p.join(ws.to_string()).join(empty.to_string());
    let mut raw = std::fs::read(&stored).unwrap();
    let field = b"\"sha256\":\"";
    let at = raw.windows(field.len()).position(|w| w == field).unwrap() + field.len();
    raw[at] = if raw[at] == b'0' { b'1' } else { b'0' };
    std::fs::write(&stored, &raw).unwrap();
    let response = app.oneshot(get(&path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn a_few_files_are_served_at_a_time_and_a_stalled_reader_lets_go() {
    let p = root();
    let ws = WorkspaceId::new_v7();
    let d = disk(&p);
    let (id, bytes) = large(&d, ws).await;
    let path = signed(&d, ws, id).await;
    let limits = ReadLimits {
        global: 1,
        per_workspace: 1,
        per_file: 1,
        turn_wait: StdDuration::from_millis(200),
        idle: StdDuration::from_millis(400),
        deadline: StdDuration::from_secs(60),
    };
    let app = jt_files::router_with_limits(d.clone(), Arc::new(FixedClock(FIXED_NOW)), KEY, limits);
    // One response holds the only turn while its client takes nothing.
    let stalled = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(stalled.status(), StatusCode::OK);
    // Another waits for a turn, then is told to come back.
    let started = Instant::now();
    let busy = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.headers()["retry-after"], "5");
    assert!(started.elapsed() >= StdDuration::from_millis(200));
    // Past the idle time the stalled response is cut off: its turn is free again, and its client,
    // reading at last, gets what was read before and then an error.
    tokio::time::sleep(StdDuration::from_millis(700)).await;
    let started = Instant::now();
    let next = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(next.status(), StatusCode::OK);
    assert!(started.elapsed() < StdDuration::from_millis(150));
    let (got, failed) = drain(stalled.into_body()).await;
    assert!(failed && got.len() < bytes.len(), "{}", got.len());
    // Read whole, a response gives its turn back at its end.
    assert_eq!(drain(next.into_body()).await, (bytes.clone(), false));
    // Dropped unread (its client went away), it gives its turn back at once.
    let dropped = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(dropped.status(), StatusCode::OK);
    drop(dropped);
    let started = Instant::now();
    let after = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(after.status(), StatusCode::OK);
    assert!(started.elapsed() < StdDuration::from_millis(150));
    drop(after);

    // However steadily it is read, a response ends at its deadline.
    let limits = ReadLimits {
        global: 4,
        per_workspace: 4,
        per_file: 4,
        turn_wait: StdDuration::from_millis(200),
        idle: StdDuration::from_secs(10),
        deadline: StdDuration::from_millis(300),
    };
    let app = jt_files::router_with_limits(d.clone(), Arc::new(FixedClock(FIXED_NOW)), KEY, limits);
    let slow = app.oneshot(get(&path)).await.unwrap();
    let mut stream = slow.into_body().into_data_stream();
    assert!(stream.next().await.unwrap().is_ok());
    tokio::time::sleep(StdDuration::from_millis(400)).await;
    let mut failed = false;
    while let Some(chunk) = stream.next().await {
        if chunk.is_err() {
            failed = true;
            break;
        }
    }
    assert!(failed);
    std::fs::remove_dir_all(p).unwrap();
}

#[test]
fn the_route_limits_are_named() {
    assert_eq!(jt_files::READS_PER_WORKSPACE, 8);
    assert_eq!(jt_files::READS_PER_FILE, 3);
    assert_eq!(jt_files::MAX_CONCURRENT_READS, 96);
    assert_eq!(jt_files::READ_TURN_WAIT, StdDuration::from_secs(10));
    assert_eq!(jt_files::READ_IDLE, StdDuration::from_secs(30));
    assert_eq!(jt_files::READ_DEADLINE, StdDuration::from_secs(30 * 60));
    assert_eq!(
        ReadLimits::default(),
        ReadLimits {
            global: jt_files::MAX_CONCURRENT_READS,
            per_workspace: jt_files::READS_PER_WORKSPACE,
            per_file: jt_files::READS_PER_FILE,
            turn_wait: jt_files::READ_TURN_WAIT,
            idle: jt_files::READ_IDLE,
            deadline: jt_files::READ_DEADLINE,
        }
    );
}

/// Limits for the pool tests: a turn waited for 200 ms, nothing cut off while they run.
fn pools(global: usize, per_workspace: usize, per_file: usize) -> ReadLimits {
    ReadLimits {
        global,
        per_workspace,
        per_file,
        turn_wait: StdDuration::from_millis(200),
        idle: StdDuration::from_secs(30),
        deadline: StdDuration::from_secs(60),
    }
}

/// The path and query of file `id`'s device address (a `push_file` download, a `file_url`),
/// signed for ten minutes.
async fn device_signed(d: &DiskFiles, ws: WorkspaceId, id: FileId) -> String {
    let url = d
        .device_url(ws, id, FIXED_NOW + Duration::minutes(10))
        .await
        .unwrap();
    format!("{}?{}", url.path(), url.query().unwrap())
}

#[tokio::test]
async fn one_workspaces_full_pool_does_not_hold_up_another() {
    let p = root();
    let d = disk(&p);
    let (a, b) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
    let ((a1, _), (a2, _), (b1, _)) = (large(&d, a).await, large(&d, a).await, large(&d, b).await);
    let app = jt_files::router_with_limits(
        d.clone(),
        Arc::new(FixedClock(FIXED_NOW)),
        KEY,
        pools(8, 1, 4),
    );
    // A's one turn is taken by a reader that takes nothing.
    let held = app
        .clone()
        .oneshot(get(&signed(&d, a, a1).await))
        .await
        .unwrap();
    assert_eq!(held.status(), StatusCode::OK);
    // A's next read, of another file, waits for it and is told to come back.
    let busy = app
        .clone()
        .oneshot(get(&signed(&d, a, a2).await))
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    // B is served at once.
    let started = Instant::now();
    let other = app
        .clone()
        .oneshot(get(&signed(&d, b, b1).await))
        .await
        .unwrap();
    assert_eq!(other.status(), StatusCode::OK);
    assert!(started.elapsed() < StdDuration::from_millis(150));
    drop((held, other));
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn one_file_takes_at_most_its_cap() {
    let p = root();
    let d = disk(&p);
    let ws = WorkspaceId::new_v7();
    let ((leaked, _), (other, _)) = (large(&d, ws).await, large(&d, ws).await);
    let app = jt_files::router_with_limits(
        d.clone(),
        Arc::new(FixedClock(FIXED_NOW)),
        KEY,
        pools(8, 4, 2),
    );
    // A leaked address read by many at once: its file's turns run out, the workspace's do not.
    let path = signed(&d, ws, leaked).await;
    let first = app.clone().oneshot(get(&path)).await.unwrap();
    let second = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(
        (first.status(), second.status()),
        (StatusCode::OK, StatusCode::OK)
    );
    let third = app.clone().oneshot(get(&path)).await.unwrap();
    assert_eq!(third.status(), StatusCode::SERVICE_UNAVAILABLE);
    let started = Instant::now();
    let another = app
        .clone()
        .oneshot(get(&signed(&d, ws, other).await))
        .await
        .unwrap();
    assert_eq!(another.status(), StatusCode::OK);
    assert!(started.elapsed() < StdDuration::from_millis(150));
    drop((first, second, another));
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn the_ceiling_holds_across_workspaces() {
    let p = root();
    let d = disk(&p);
    let (a, b) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
    let ((a1, _), (b1, _)) = (large(&d, a).await, large(&d, b).await);
    let app = jt_files::router_with_limits(
        d.clone(),
        Arc::new(FixedClock(FIXED_NOW)),
        KEY,
        pools(1, 8, 4),
    );
    let held = app
        .clone()
        .oneshot(get(&signed(&d, a, a1).await))
        .await
        .unwrap();
    assert_eq!(held.status(), StatusCode::OK);
    let busy = app
        .clone()
        .oneshot(get(&signed(&d, b, b1).await))
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(held);
    let after = app
        .clone()
        .oneshot(get(&signed(&d, b, b1).await))
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::OK);
    drop(after);
    std::fs::remove_dir_all(p).unwrap();
}

#[tokio::test]
async fn device_downloads_never_hold_up_provider_fetches() {
    let p = root();
    let d = disk(&p);
    let ws = WorkspaceId::new_v7();
    let ((pushed, bytes), (media, _), (more, _)) = (
        large(&d, ws).await,
        large(&d, ws).await,
        large(&d, ws).await,
    );
    let app = jt_files::router_with_limits(
        d.clone(),
        Arc::new(FixedClock(FIXED_NOW)),
        KEY,
        pools(8, 1, 4),
    );
    // A device address says so, and is signed for it.
    let device = device_signed(&d, ws, pushed).await;
    assert!(device.contains("purpose=device"), "{device}");
    // A phone's download holds the workspace's device turn.
    let download = app.clone().oneshot(get(&device)).await.unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    // Another device read waits; a provider's fetch of the workspace's media does not.
    let busy = app
        .clone()
        .oneshot(get(&device_signed(&d, ws, more).await))
        .await
        .unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    let started = Instant::now();
    let fetch = app
        .clone()
        .oneshot(get(&signed(&d, ws, media).await))
        .await
        .unwrap();
    assert_eq!(fetch.status(), StatusCode::OK);
    assert!(started.elapsed() < StdDuration::from_millis(150));
    drop(fetch);
    assert_eq!(drain(download.into_body()).await, (bytes, false));
    // The purpose is signed: dropped, or changed, the address no longer verifies.
    let plain = device.replace("&purpose=device", "");
    let response = app.clone().oneshot(get(&plain)).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let other = device.replace("purpose=device", "purpose=studio");
    let response = app.clone().oneshot(get(&other)).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // And a provider's address does not verify as a device's.
    let provider = signed(&d, ws, media).await;
    let response = app
        .oneshot(get(&format!("{provider}&purpose=device")))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(p).unwrap();
}
