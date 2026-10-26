use std::process::Command;
#[test]
fn logs_redact_secret_canaries_on_success_and_error() {
    let out = Command::new(env!("CARGO_BIN_EXE_jeeta"))
        .current_dir(std::env::temp_dir())
        .env_clear()
        .env("JEETA_DATABASE_URL", "postgres://synthetic@127.0.0.1/test")
        .env("JEETA_SECRET_KEY", "ab".repeat(32))
        .env("JEETA_LOG", "CANARY_FILTER=notalevel")
        .arg("serve")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(!stderr.contains("CANARY_FILTER"), "{stderr}");
    for (key, value) in [
        (
            "JEETA_ALLOWED_HOSTS",
            "https://user:CANARY_CONFIG@host/path?token=CANARY_CONFIG",
        ),
        (
            "JEETA_DATABASE_URL",
            "postgres://user:CANARY_CONFIG@127.0.0.1:invalid/db",
        ),
        ("JEETA_RECOVERY_STATUS_DIR", "CANARY_CONFIG/relative"),
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_jeeta"))
            .current_dir(std::env::temp_dir())
            .env_clear()
            .env("JEETA_DATABASE_URL", "postgres://synthetic@127.0.0.1/test")
            .env("JEETA_SECRET_KEY", "ab".repeat(32))
            .env("JEETA_PRICE_MINOR", "123")
            .env("JEETA_PRICE_CURRENCY", "TRY")
            .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
            .env("JEETA_METRICS_TOKEN", "CANARY_TOKEN")
            .env("JEETA_ALLOW_TEST_LOOPBACK", "1")
            .env("JEETA_LOG_FORMAT", "json")
            .env(key, value)
            .arg("serve")
            .output()
            .unwrap();
        assert!(!out.status.success());
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert!(!stderr.contains("CANARY"), "{stderr}");
        for line in stderr.lines() {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
    }
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "log_capture_child", "--nocapture"])
        .env("T063_CAPTURE_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stdout)
    );
    let stderr = String::from_utf8(child.stderr).unwrap();
    assert!(stderr.contains("request"));
    assert!(stderr.contains("provider refused"));
    for secret in [
        "CANARY_SESSION",
        "CANARY_INTERNAL",
        "CANARY_PROVIDER",
        "CANARY_URL",
        "CANARY_QUERY",
        "CANARY_PAYMENT",
        "CANARY_CODE",
        "CANARY_TOKEN",
        "SYNTHETIC-BANK-REFERENCE",
    ] {
        assert!(
            !stderr.contains(secret),
            "stderr exposed {secret}: {stderr}"
        );
    }
}

#[path = "../src/ops.rs"]
mod ops;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use jt_app::ports::ops::*;
use jt_testkit::{
    db::TestDb,
    fakes::{FIXED_NOW, InMemoryUow},
};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use tower::ServiceExt;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "t063-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn probe(pool: sqlx::PgPool, dir: PathBuf) -> Arc<ops::RuntimeOps> {
    let files = Arc::new(
        jt_files::DiskFiles::new(
            &dir,
            "https://files.example.com".parse().unwrap(),
            [7; 32],
            Arc::new(jt_testkit::fakes::FixedClock(FIXED_NOW)),
        )
        .unwrap(),
    );
    probe_with_files(pool, dir, files)
}
fn probe_with_files(
    pool: sqlx::PgPool,
    dir: PathBuf,
    files: Arc<dyn jt_app::ports::files::FileStore>,
) -> Arc<ops::RuntimeOps> {
    Arc::new(ops::RuntimeOps {
        pool,
        files,
        uow: Arc::new(InMemoryUow::new()),
        signals: Arc::new(OpsSignals::default()),
        files_dir: Some(dir),
        recovery_dir: None,
        started_at: FIXED_NOW,
        boot_complete: AtomicBool::new(false),
    })
}
#[tokio::test]
async fn readiness_fails_when_database_unavailable() {
    let dir = Temp::new();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://synthetic@127.0.0.1:1/unavailable")
        .unwrap();
    pool.close().await;
    let p = probe(pool, dir.0.clone());
    p.booted();
    let out = p.snapshot().await.unwrap();
    assert_eq!(out.database, HealthState::Degraded);
    assert_eq!(out.files, HealthState::Ok);
    let response = ops::router(
        p.clone(),
        Arc::new(OpsSignals::default()),
        "secret",
        Some(p),
    )
    .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        to_bytes(response.into_body(), 100).await.unwrap(),
        r#"{"ok":false}"#
    );
}
#[tokio::test]
async fn readiness_distinguishes_file_failure_from_liveness() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let p = probe(db.pool.clone(), dir.0.clone());
    assert!(!p.snapshot().await.unwrap().ready());
    p.booted();
    assert!(p.snapshot().await.unwrap().ready());
    std::fs::remove_dir(&dir.0).unwrap();
    let out = p.snapshot().await.unwrap();
    assert_eq!(out.files, HealthState::Degraded);
    assert!(!out.ready());
    let deps = jt_testkit::fakes::deps(Arc::new(InMemoryUow::new()));
    let app = jt_panel_http::router(jt_panel_http::AppState {
        deps,
        gate: Arc::new(jt_app::gate::NoStrategyYet),
        cookie_secure: false,
        panel_dir: None,
    });
    let resp = app
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(resp.into_body(), 100).await.unwrap(),
        r#"{"ok":true}"#
    );
}
#[tokio::test]
async fn metrics_missing_wrong_token_is_401() {
    let app = ops::router(
        Arc::new(UnknownOps),
        Arc::new(OpsSignals::default()),
        "secret",
        None,
    );
    for auth in [
        None,
        Some("Bearer wrong"),
        Some("Basic secret"),
        Some("Bearer "),
    ] {
        let mut req =
            Request::get("/metrics").header(header::COOKIE, "jt_platform=operator-secret");
        if let Some(auth) = auth {
            req = req.header(header::AUTHORIZATION, auth);
        }
        assert_eq!(
            app.clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
#[tokio::test]
async fn metrics_valid_token_returns_bounded_prometheus_text() {
    let app = ops::router(
        Arc::new(UnknownOps),
        Arc::new(OpsSignals::default()),
        "secret",
        None,
    );
    let out = app
        .oneshot(
            Request::get("/metrics")
                .header(header::AUTHORIZATION, "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(out.status(), StatusCode::OK);
    assert_eq!(
        out.headers()[header::CONTENT_TYPE],
        "text/plain; version=0.0.4"
    );
    let bytes = to_bytes(out.into_body(), 256 * 1024).await.unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.ends_with('\n'));
    assert!(text.contains("jeeta_process_start_time_seconds"));
    assert!(!text.contains("secret"));
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        line.rsplit_once(' ').unwrap().1.parse::<f64>().unwrap();
    }
}
#[test]
fn metric_labels_are_bounded() {
    let signals = OpsSignals::default();
    let mut snapshot = OpsHealthOut::unknown(FIXED_NOW);
    for i in 0..10_000 {
        signals.http(
            &format!("/private/CANARY_URL/{i}?token=CANARY_QUERY"),
            500,
            0.5,
        );
        snapshot.connectors.push(ConnectorHealthCount {
            workspace_id: serde_json::from_value(serde_json::json!(
                "00000000-0000-4000-8000-000000000001"
            ))
            .unwrap(),
            kind_key: format!("CANARY_KIND_{i}"),
            reconnect_required: 1,
            expires_before: None,
        });
    }
    let text = ops::prometheus(&snapshot, &signals);
    assert!(text.len() < 256 * 1024);
    assert!(!text.contains("CANARY"));
    assert!(text.contains("route=\"other\"} 10000"));
    assert!(text.contains("kind=\"other\"} 10000"));
}
#[test]
fn missing_or_future_backup_marker_is_not_healthy() {
    let dir = Temp::new();
    let now = FIXED_NOW;
    for (name, field, threshold) in [
        ("backup-status.json", "completed_at", 86400),
        ("wal-status.json", "archived_at", 900),
    ] {
        assert_eq!(
            ops::marker(Some(&dir.0), name, field, now, threshold).1,
            HealthState::Unknown
        );
        std::fs::write(dir.0.join(name), "malformed").unwrap();
        assert_eq!(
            ops::marker(Some(&dir.0), name, field, now, threshold).1,
            HealthState::Unknown
        );
        for (delta, expected) in [
            (1, HealthState::Degraded),
            (0, HealthState::Ok),
            (-threshold, HealthState::Ok),
            (-threshold - 1, HealthState::Degraded),
        ] {
            let at = (now + time::Duration::seconds(delta))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
            std::fs::write(dir.0.join(name), serde_json::json!({field:at}).to_string()).unwrap();
            assert_eq!(
                ops::marker(Some(&dir.0), name, field, now, threshold).1,
                expected
            );
        }
    }
}
#[tokio::test]
async fn restart_counters_have_explicit_epoch_and_unknown_history() {
    let dir = Temp::new();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://synthetic@127.0.0.1:1/unavailable")
        .unwrap();
    pool.close().await;
    let first = probe(pool.clone(), dir.0.clone());
    first.signals.webhook(WebhookOutcome::Unrouted);
    let name = jt_app::usecases::jobs::Job::ALL[0].name();
    first.signals.job(name, FIXED_NOW, 0);
    first.signals.job(name, FIXED_NOW, 2);
    let old = first.snapshot().await.unwrap();
    assert_eq!(old.webhooks.unrouted, 1);
    assert_eq!(old.jobs[0].last_success_at, Some(FIXED_NOW));
    assert_eq!(old.jobs[0].failed_total, 2);
    let mut second = probe(pool, dir.0.clone());
    Arc::get_mut(&mut second).unwrap().started_at = FIXED_NOW + time::Duration::seconds(1);
    let new = second.snapshot().await.unwrap();
    assert_ne!(old.process_started_at, new.process_started_at);
    assert_eq!(new.history, "unknown_before_process_start");
    assert_eq!(new.webhooks.unrouted, 0);
    assert!(
        new.jobs
            .iter()
            .all(|j| j.last_success_at.is_none() && j.failed_total == 0)
    );
}

#[test]
fn log_capture_child() {
    if std::env::var_os("T063_CAPTURE_CHILD").is_none() {
        return;
    }
    ops::install_tracing("info,rmcp::specific=trace", true);
    tracing::info!(target: "rmcp::specific", session_id="CANARY_SESSION", "session created");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        use axum::response::IntoResponse;
        use jt_app::{
            error::AppError,
            usecases::{billing, jobs, platform_payments},
        };
        let _ = jt_panel_http::ApiError(AppError::internal("CANARY_INTERNAL")).into_response();
        let _ = jt_mcp::errors::public(AppError::internal("CANARY_INTERNAL"));
        let mut w =
            jt_testkit::platform_payment_contract::World::new(Arc::new(InMemoryUow::new())).await;
        let confirmed = platform_payments::confirm(&w.deps, &w.ctx, w.f.ws, w.payment.id)
            .await
            .unwrap();
        let code = confirmed.activation.unwrap().code;
        assert!(
            billing::activate(
                &w.deps,
                &w.owner(),
                billing::ActivateInput {
                    code: "CANARY_CODE".into()
                }
            )
            .await
            .is_err()
        );
        assert!(
            billing::report_payment(
                &w.deps,
                &w.owner(),
                billing::ReportPaymentInput {
                    reference: "CANARY_PAYMENT".into(),
                    amount_minor: 123,
                    paid_at: FIXED_NOW,
                    request_key: "synthetic-request".into()
                }
            )
            .await
            .is_err()
        );
        w.activate(&code).await;
        let credential = jt_connector::Credential::OAuth {
            access_token: "CANARY_TOKEN".into(),
            refresh_token: Some("CANARY_TOKEN".into()),
            expires_at: Some(FIXED_NOW),
            scopes: vec![],
        };
        let mut capability = jt_capability::Capability::new(
            jt_capability::CapabilityId::new_v7(),
            w.f.ws,
            jt_capability::NewCapability {
                kind_key: "x".into(),
                name: "Synthetic".into(),
                external_id: Some("synthetic-account".into()),
                ..Default::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        capability.status = jt_capability::StoredStatus::Verified;
        capability.last_verified_at = Some(FIXED_NOW);
        capability.connector_public = serde_json::json!({"access":credential.redact_for_public()});
        let sealed = w
            .deps
            .seal
            .seal(w.f.ws, &serde_json::to_vec(&credential).unwrap())
            .unwrap();
        let mut r = w.deps.uow.tenant(w.f.ws).await.unwrap();
        r.capabilities()
            .insert(capability, Some(sealed))
            .await
            .unwrap();
        r.commit().await.unwrap();
        let provider = Arc::new(jt_testkit::fakes::ScriptedConnector::new(
            jt_connector::Provider::X,
        ));
        provider.push_refresh(Err(jt_connector::ConnectorError::auth("CANARY_PROVIDER")));
        w.deps.connectors =
            Arc::new(jt_testkit::fakes::ScriptedRegistry::new().with_connector(provider));
        assert_eq!(jobs::run_refresh_tokens(&w.deps, FIXED_NOW).await.failed, 1);
        let signals = w.deps.ops_signals.clone();
        let app = jt_panel_http::router(jt_panel_http::AppState {
            deps: w.deps.clone(),
            gate: Arc::new(jt_app::gate::NoStrategyYet),
            cookie_secure: false,
            panel_dir: None,
        })
        .layer(axum::middleware::from_fn_with_state(
            signals,
            ops::access_log,
        ));
        for path in [
            "/healthz?secret=CANARY_QUERY",
            "/CANARY_URL?secret=CANARY_QUERY",
        ] {
            let _ = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
        }
        let ledger = serde_json::to_string(&w.entries().await).unwrap();
        assert!(ledger.contains("connector.refresh_failed"));
        assert!(ledger.contains("billing.activated"));
        for secret in [
            code.as_str(),
            "CANARY_INTERNAL",
            "CANARY_PROVIDER",
            "CANARY_URL",
            "CANARY_QUERY",
            "CANARY_PAYMENT",
            "CANARY_CODE",
            "CANARY_TOKEN",
            "SYNTHETIC-BANK-REFERENCE",
        ] {
            assert!(!ledger.contains(secret), "ledger exposed {secret}");
        }
    });
}

#[tokio::test]
async fn unrouted_signed_webhook_is_visible() {
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.apps = Arc::new(jt_testkit::fakes::FakeAppConfig::with_all_apps());
    let signals = deps.ops_signals.clone();
    let app = jt_webhook::router(jt_webhook::WebhookState {
        deps: Arc::new(deps),
    });
    let body = include_bytes!(
        "../../../crates/adapters/jt_webhook/tests/fixtures/meta/whatsapp_messages.json"
    );
    let response = app
        .clone()
        .oneshot(
            Request::post("/hooks/meta")
                .header(
                    "X-Hub-Signature-256",
                    "sha256=c70b1f9932fed3aa27e0174486e2d1b71c3cafb01c16cdc61147a4766ff673f3",
                )
                .body(Body::from(body.to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(signals.read().webhooks.unrouted > 0);
    assert_eq!(signals.read().webhooks.accepted, 0);
    assert!(uow.snapshot().inbound_events.is_empty());
    let before = signals.read().webhooks.unrouted;
    let rejected = app
        .oneshot(
            Request::post("/hooks/meta")
                .header("X-Hub-Signature-256", "sha256=wrong")
                .body(Body::from(body.to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(signals.read().webhooks.unrouted, before);
}
#[tokio::test]
async fn connector_projection_pg_fake_parity() {
    use jt_app::ports::UnitOfWork;
    let db = TestDb::new().await;
    for uow in [
        Arc::new(InMemoryUow::new()) as Arc<dyn UnitOfWork>,
        Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())),
    ] {
        let w = jt_testkit::platform_payment_contract::World::new(uow.clone()).await;
        let mut r = uow.tenant(w.f.ws).await.unwrap();
        for (retired, reconnect, expiry) in [
            (false, true, "2026-10-22T12:00:00+03:00"),
            (false, false, "2026-10-22T10:00:00Z"),
            (true, true, "2025-01-01T00:00:00Z"),
        ] {
            let mut c = jt_capability::Capability::new(
                jt_capability::CapabilityId::new_v7(),
                w.f.ws,
                jt_capability::NewCapability {
                    kind_key: "x".into(),
                    name: "CANARY_NAME".into(),
                    external_id: Some(format!("CANARY_ACCOUNT_{expiry}")),
                    ..Default::default()
                },
                FIXED_NOW,
            )
            .unwrap();
            c.status = if retired {
                jt_capability::StoredStatus::Retired
            } else {
                jt_capability::StoredStatus::Verified
            };
            c.connector_public = serde_json::json!({"reconnect_required":reconnect,"access":{"expires_at":expiry},"body":"CANARY_BODY"});
            r.capabilities()
                .insert(c, Some(b"CANARY_SEALED".to_vec()))
                .await
                .unwrap();
        }
        r.commit().await.unwrap();
        let mut r = uow.platform().await.unwrap();
        let rows = r.connector_health_counts().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].workspace_id, w.f.ws);
        assert_eq!(rows[0].kind_key, "x");
        assert_eq!(rows[0].reconnect_required, 1);
        assert_eq!(
            rows[0].expires_before.unwrap(),
            time::OffsetDateTime::parse(
                "2026-10-22T09:00:00Z",
                &time::format_description::well_known::Rfc3339
            )
            .unwrap()
        );
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("CANARY"));
    }
}

#[test]
fn serve_requires_a_nonempty_metrics_token_before_startup() {
    for token in ["", "   "] {
        let output = Command::new(env!("CARGO_BIN_EXE_jeeta"))
            .current_dir(std::env::temp_dir())
            .env_clear()
            .env(
                "JEETA_DATABASE_URL",
                "postgres://synthetic@127.0.0.1:1/unavailable",
            )
            .env("JEETA_SECRET_KEY", "ab".repeat(32))
            .env("JEETA_PRICE_MINOR", "123")
            .env("JEETA_PRICE_CURRENCY", "TRY")
            .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
            .env("JEETA_METRICS_TOKEN", token)
            .arg("serve")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("JEETA_METRICS_TOKEN")
        );
    }
}
struct ProjectionUnavailable;
#[async_trait::async_trait]
impl jt_app::ports::UnitOfWork for ProjectionUnavailable {
    async fn platform(
        &self,
    ) -> Result<Box<dyn jt_app::ports::PlatformRepos>, jt_app::error::AppError> {
        Err(jt_app::error::AppError::internal("CANARY_PROJECTION"))
    }
    async fn user(&self) -> Result<Box<dyn jt_app::ports::UserRepos>, jt_app::error::AppError> {
        Err(jt_app::error::AppError::internal("unavailable"))
    }
    async fn tenant(
        &self,
        _ws: jt_tenancy::WorkspaceId,
    ) -> Result<Box<dyn jt_app::ports::TenantRepos>, jt_app::error::AppError> {
        Err(jt_app::error::AppError::internal("unavailable"))
    }
}
#[tokio::test]
async fn readiness_is_independent_of_connector_reports_and_recovery() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let mut p = probe(db.pool.clone(), dir.0.clone());
    Arc::get_mut(&mut p).unwrap().uow = Arc::new(ProjectionUnavailable);
    p.booted();
    let snapshot = p.snapshot().await.unwrap();
    assert_eq!(snapshot.database, HealthState::Ok);
    assert_eq!(snapshot.connectors_state, HealthState::Degraded);
    assert_eq!(snapshot.backup.backup_state, HealthState::Unknown);
    let response = ops::router(p.clone(), p.signals.clone(), "secret", Some(p))
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 100).await.unwrap(),
        r#"{"ok":true}"#
    );
}

#[test]
fn disk_capacity_threshold_is_strict_and_overflow_safe() {
    assert_eq!(ops::disk_state(9, 100), HealthState::Degraded);
    assert_eq!(ops::disk_state(10, 100), HealthState::Ok);
    assert_eq!(ops::disk_state(u64::MAX, u64::MAX), HealthState::Ok);
    assert_eq!(ops::disk_state(0, 0), HealthState::Degraded);
}

#[tokio::test]
async fn readiness_and_health_fail_when_probe_payload_write_fails() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let files = Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    let p = probe_with_files(db.pool.clone(), dir.0.clone(), files.clone());
    p.booted();
    assert!(p.ready().await);
    assert_eq!(p.snapshot().await.unwrap().files, HealthState::Ok);
    files
        .probe_write_fails
        .store(true, std::sync::atomic::Ordering::Release);
    assert!(!p.ready().await);
    let out = p.snapshot().await.unwrap();
    assert_eq!(out.database, HealthState::Ok);
    assert_eq!(out.files, HealthState::Degraded);
    assert!(!out.ready());
    files
        .probe_write_fails
        .store(false, std::sync::atomic::Ordering::Release);
    assert!(p.ready().await);
}

#[tokio::test]
async fn readiness_fails_when_active_file_store_directory_is_replaced() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let active = dir.0.join("active");
    let old = dir.0.join("old");
    std::fs::create_dir(&active).unwrap();
    let p = probe(db.pool.clone(), active.clone());
    p.booted();
    assert!(p.ready().await);
    std::fs::rename(&active, &old).unwrap();
    std::fs::create_dir(&active).unwrap();
    assert!(!p.ready().await);
    assert_eq!(p.snapshot().await.unwrap().files, HealthState::Degraded);
    assert_eq!(std::fs::read_dir(&active).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&old).unwrap().count(), 0);
}

#[tokio::test]
async fn signed_meta_without_routing_account_is_unresolved_once() {
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.apps = Arc::new(jt_testkit::fakes::FakeAppConfig::with_all_apps());
    let signals = deps.ops_signals.clone();
    let app = jt_webhook::router(jt_webhook::WebhookState {
        deps: Arc::new(deps),
    });
    let rejected = app
        .clone()
        .oneshot(
            Request::post("/hooks/meta")
                .header("X-Hub-Signature-256", "sha256=wrong")
                .body(Body::from(r#"{"object":"page","entry":[{}]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(signals.read().webhooks.unresolved, 0);
    for (body, signature, unresolved) in [
        (
            r#"{"object":"page","entry":[]}"#,
            "sha256=5dcb51eb590634700c8d9cc1fde4d2d5981ca7bb83f250eb3fb71bfd849057ed",
            0,
        ),
        (
            r#"{"object":"page","entry":[{"messaging":[{"message":{"mid":"m"}}]}]}"#,
            "sha256=48e9bae4eba8eca47f26c1dde2d327480f649f81d6fd2f18085b809575b67c42",
            1,
        ),
        (
            r#"{"object":"page","entry":[{},{}]}"#,
            "sha256=a16b40deecce90b822b84831e0de79bd992a03781f4a36574b7ca3258ba13b6d",
            2,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/hooks/meta")
                    .header("X-Hub-Signature-256", signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(signals.read().webhooks.unresolved, unresolved);
        assert_eq!(signals.read().webhooks.unrouted, 0);
        assert_eq!(signals.read().webhooks.accepted, 0);
        assert!(uow.snapshot().inbound_events.is_empty());
    }
}

#[tokio::test]
async fn hung_file_probe_times_out_in_readiness_and_health() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let files = Arc::new(jt_testkit::fakes::files::MemoryFiles::default());
    files
        .probe_hangs
        .store(true, std::sync::atomic::Ordering::Release);
    let p = probe_with_files(db.pool.clone(), dir.0.clone(), files);
    p.booted();
    let ready = tokio::time::timeout(std::time::Duration::from_secs(3), p.ready())
        .await
        .unwrap();
    assert!(!ready);
    let out = tokio::time::timeout(std::time::Duration::from_secs(3), p.snapshot())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.files, HealthState::Degraded);
    assert!(!out.ready());
}
