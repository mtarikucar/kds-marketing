//! Probe runs keep why they failed (migration 0013): the failure line is stored and read back,
//! `unknown` is a legal error kind, and the reason column is bounded like the failure line.

use jt_app::error::ErrorCode;
use jt_app::ports::{ProbeRun, ProbeRunId, UnitOfWork};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_connector::{ConnectorError, ProbeResult, Provider};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::TestDb;
use serde_json::json;
use time::OffsetDateTime;
use time::macros::datetime;
use uuid::Uuid;

const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

#[tokio::test]
async fn unknown_kind_is_storable_with_reason() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("probe-reason").await;
    let pbx = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "netgsm_pbx".into(),
            name: "Santral".into(),
            external_id: Some("8508001234".into()),
            ..NewCapability::default()
        },
        T0,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(pbx.clone(), None).await.unwrap();
    t.commit().await.unwrap();

    // An adapter that answers a probe with `Unknown` no longer breaks the check: the run is
    // stored, kind and failure line both.
    let unknown = ProbeRun::from_result(
        ProbeRunId::new_v7(),
        ws,
        pbx.id,
        T0,
        Some(Provider::Netgsm),
        &ProbeResult::failure(
            40,
            ConnectorError::unknown(r#"timed out after sending {"password":"pbx-pass-1"}"#),
        ),
    );
    assert_eq!(unknown.error_kind.as_deref(), Some("unknown"));
    let reason = unknown.reason.clone().expect("a failure line");
    assert!(reason.starts_with("unknown: netgsm: timed out"), "{reason}");
    assert!(!reason.contains("pbx-pass-1"), "{reason}");
    let ok = ProbeRun::from_result(
        ProbeRunId::new_v7(),
        ws,
        pbx.id,
        T0 + time::Duration::minutes(1),
        Some(Provider::Netgsm),
        &ProbeResult::success(12, json!({ "account_id": "8508001234" })),
    );
    let mut t = uow.tenant(ws).await.unwrap();
    t.probe_runs().append(unknown.clone()).await.unwrap();
    t.probe_runs().append(ok.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.probe_runs().list(pbx.id, 10).await.unwrap(),
        vec![ok.clone(), unknown.clone()]
    );
    assert_eq!(t.probe_runs().latest(pbx.id).await.unwrap(), Some(ok));
    // A reason longer than the failure line's bound breaks its check constraint.
    let long = ProbeRun {
        id: ProbeRunId::new_v7(),
        reason: Some("x".repeat(301)),
        ..unknown.clone()
    };
    assert_eq!(
        t.probe_runs().append(long).await.unwrap_err().code,
        ErrorCode::Internal
    );
    drop(t);

    // The same bound in SQL, and an error kind off the taxonomy still breaks its check.
    for statement in [
        "insert into probe_runs (id, workspace_id, capability_id, at, ok, error_kind, reason, \
         latency_ms, facts) values ($1, $2, $3, now(), false, 'unknown', repeat('x', 301), 1, '{}')",
        "insert into probe_runs (id, workspace_id, capability_id, at, ok, error_kind, reason, \
         latency_ms, facts) values ($1, $2, $3, now(), false, 'oops', 'oops', 1, '{}')",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let err = sqlx::query(statement)
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(pbx.id.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(
            db_err.code().as_deref(),
            Some("23514"),
            "{statement}: {db_err}"
        );
        tx.rollback().await.unwrap();
    }
}
