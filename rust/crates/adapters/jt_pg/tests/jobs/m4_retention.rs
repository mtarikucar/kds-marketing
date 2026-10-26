//! Production cleanup jobs, ordinary PostgreSQL role, exact boundary and retained row images.
use jt_app::{
    ports::{ProbeRun, ProbeRunId, UnitOfWork},
    usecases::jobs::Job,
};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::{TestDb, fakes, inbox_contract::Fixture};
use serde_json::{Value, json};
use std::sync::Arc;
use time::{Duration, OffsetDateTime};

async fn snapshot(db: &TestDb, ws: jt_tenancy::WorkspaceId, table: &str) -> Value {
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query_scalar(&format!("select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from {table} t where workspace_id=$1"))
        .bind(ws.as_uuid()).fetch_one(tx.conn()).await.unwrap()
}

#[tokio::test]
async fn raw_bodies_and_probe_runs_obey_thirty_day_boundaries() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let deps = fakes::deps(uow.clone());
    let now: OffsetDateTime = sqlx::query_scalar("select now()")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut expected = Vec::new();
    // Purges include pending and suspended tenants, not just active tenants.
    for (index, status) in [
        jt_tenancy::WorkspaceStatus::Active,
        jt_tenancy::WorkspaceStatus::PendingPayment,
        jt_tenancy::WorkspaceStatus::Suspended,
    ]
    .into_iter()
    .enumerate()
    {
        let f = Fixture::new(uow.clone()).await;
        let cap = f.capability().await;
        let mut r = uow.platform().await.unwrap();
        r.workspace_set_status(
            f.ws,
            status,
            "synthetic retention fixture",
            &jt_ledger::Actor::System {
                component: "retention".into(),
            },
        )
        .await
        .unwrap();
        r.commit().await.unwrap();
        let mut r = uow.tenant(f.ws).await.unwrap();
        let mut kept = Vec::new();
        for (n, at) in [
            now - Duration::days(30) - Duration::microseconds(1),
            now - Duration::days(30),
            now - Duration::days(30) + Duration::microseconds(1),
            now - Duration::days(1),
        ]
        .into_iter()
        .enumerate()
        {
            let event = InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: f.ws,
                capability_id: Some(cap),
                provider: Provider::Netgsm,
                external_id: format!("retention-{index}-{n}"),
                kind: EventKind::Unknown("synthetic".into()),
                payload: json!({"synthetic":n}),
                received_at: at,
                processed_at: None,
            };
            r.inbound_events()
                .insert_if_new(event, Some(vec![n as u8]))
                .await
                .unwrap();
            let probe = ProbeRun {
                id: ProbeRunId::new_v7(),
                workspace_id: f.ws,
                capability_id: cap,
                at,
                ok: true,
                error_kind: None,
                latency_ms: 1,
                facts: json!({}),
            };
            if n != 0 {
                kept.push(probe.id);
            }
            r.probe_runs().append(probe).await.unwrap();
        }
        r.commit().await.unwrap();
        expected.push((f.ws, cap, kept, snapshot(&db, f.ws, "inbound_events").await));
    }
    for job in [Job::PurgeRawBodies, Job::PurgeProbeRuns] {
        let result = job.run(&deps, now).await;
        assert_eq!((result.changed, result.failed), (3, 0), "{job:?}");
        let repeated = job.run(&deps, now).await;
        assert_eq!((repeated.changed, repeated.failed), (0, 0));
    }
    for (ws, cap, kept, before) in expected {
        let mut expected_events = before;
        for event in expected_events.as_array_mut().unwrap() {
            if event["external_id"].as_str().unwrap().ends_with("-0") {
                event["raw"] = Value::Null;
            }
        }
        assert_eq!(snapshot(&db, ws, "inbound_events").await, expected_events);
        let mut r = uow.tenant(ws).await.unwrap();
        let mut actual: Vec<_> = r
            .probe_runs()
            .list(cap, 10)
            .await
            .unwrap()
            .iter()
            .map(|p| p.id)
            .collect();
        let mut kept = kept;
        kept.sort();
        actual.sort();
        assert_eq!(actual, kept);
    }
    let unsafe_role: bool = sqlx::query_scalar(
        "select rolsuper or rolbypassrls from pg_roles where rolname=current_user",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!unsafe_role);
}

#[tokio::test]
async fn retention_preserves_messages_publication_evidence_and_ledger() {
    use jt_app::ports::studio::PublishOutcome;
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let deps = fakes::deps(uow.clone());
    let now: OffsetDateTime = sqlx::query_scalar("select now()")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let f = Fixture::new(uow.clone()).await;
    let person = f.insert_person("Synthetic retention").await;
    let cap = f.capability().await;
    let conversation = f.conversation(person.id, cap);
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(conversation.clone())
        .await
        .unwrap();
    for (n, at) in [now - Duration::days(400), now - Duration::days(1)]
        .into_iter()
        .enumerate()
    {
        let mut message = f.message(conversation.id);
        message.at = at;
        message.external_id = Some(format!("retained-{n}"));
        r.messages().insert_if_new(message).await.unwrap();
        r.ledger()
            .append(jt_ledger::LedgerEntry::new(
                f.ws,
                jt_ledger::Actor::System {
                    component: "retention".into(),
                },
                jt_ledger::Action::new("retention.evidence").unwrap(),
                json!({"synthetic":n}),
                at,
            ))
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let mut snapshots = vec![
        (f.ws, "messages", snapshot(&db, f.ws, "messages").await),
        (
            f.ws,
            "ledger_entries",
            snapshot(&db, f.ws, "ledger_entries").await,
        ),
    ];
    for at in [now - Duration::days(400), now - Duration::days(1)] {
        let studio = jt_testkit::studio_contract::ready(uow.as_ref()).await;
        let mut r = uow.tenant(studio.ws).await.unwrap();
        let attempt = r
            .studio()
            .claim_publication_for(studio.slot.id, fakes::FIXED_NOW)
            .await
            .unwrap()
            .unwrap();
        r.studio()
            .finish_publication(
                attempt.id(),
                PublishOutcome::Succeeded(jt_studio::PublishReceipt {
                    external_id: "synthetic-retained".into(),
                    url: None,
                }),
                at,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
        for table in [
            "studio_publications",
            "studio_publish_attempts",
            "studio_pieces",
            "studio_slots",
        ] {
            let rows = snapshot(&db, studio.ws, table).await;
            assert!(!rows.as_array().unwrap().is_empty(), "{table}");
            snapshots.push((studio.ws, table, rows));
        }
    }
    assert_eq!(snapshots[0].2.as_array().unwrap().len(), 2);
    assert_eq!(snapshots[1].2.as_array().unwrap().len(), 2);
    for job in [
        Job::PurgeRawBodies,
        Job::PurgeProbeRuns,
        Job::PurgeOAuthPending,
        Job::StudioFilesCleanup,
    ] {
        assert_eq!(job.run(&deps, now).await.failed, 0, "{job:?}");
    }
    for (ws, table, before) in snapshots {
        assert_eq!(snapshot(&db, ws, table).await, before, "{table}");
    }
}
