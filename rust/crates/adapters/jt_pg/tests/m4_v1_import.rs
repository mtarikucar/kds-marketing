use jt_app::usecases::v1_import::{Lead, map_status};
use jt_inbox::JourneyStatus;

#[test]
fn maps_every_v1_status_and_rejects_unknown() {
    for (raw, expected) in [
        ("NEW", JourneyStatus::New),
        ("CONTACTED", JourneyStatus::Contacted),
        ("NOT_REACHABLE", JourneyStatus::Unreachable),
        ("DEMO_SCHEDULED", JourneyStatus::Appointment),
        ("MEETING_DONE", JourneyStatus::Met),
        ("OFFER_SENT", JourneyStatus::Quoted),
        ("WAITING", JourneyStatus::Pending),
        ("WON", JourneyStatus::Won),
        ("LOST", JourneyStatus::Lost),
    ] {
        assert_eq!(map_status(raw).unwrap(), expected);
    }
    assert!(map_status("unexpected").is_err());
}

#[test]
fn rejects_non_allowlisted_input_fields() {
    assert!(serde_json::from_value::<Lead>(serde_json::json!({"accessToken":"canary"})).is_err());
}

use jt_app::{
    ports::UnitOfWork,
    usecases::v1_import::{self, Mode, entity_id},
};
use jt_inbox::{Channel, ConsentKind, EventSource, Note, NoteId, PersonId};
use jt_pg::{PgUnitOfWork, TenantTx, v1_import::PgImportStore};
use jt_testkit::{TestDb, fakes::FIXED_NOW};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../scripts/tests/fixtures/v1-import/lead.jsonl");
fn lead(id: &str) -> Lead {
    let mut row: Value = serde_json::from_str(FIXTURE).unwrap();
    row["id"] = json!(id);
    serde_json::from_value(row).unwrap()
}
#[test]
fn normalizers_notes_withdrawals_and_deterministic_ids() {
    let mut row = lead("mapping");
    let (keys, invalid) = row.identities();
    assert_eq!(invalid, 0);
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0].1, "+905321234567");
    assert_eq!(keys[1].1, "synthetic@example.test");
    row.phone = Some("bad".into());
    row.whatsapp = None;
    row.email = Some("no-at".into());
    assert_eq!(row.identities(), (vec![], 2));
    assert_eq!(
        row.withdrawals(),
        vec![Channel::Email, Channel::Sms, Channel::WhatsApp]
    );
    row.email_opt_out = false;
    row.sms_opt_out = false;
    row.wa_opt_out = false;
    assert!(row.withdrawals().is_empty());
    let text = row.note().unwrap();
    for expected in [
        "v1 bilgileri",
        "city: Example city",
        "region: Example region",
        "address: Example street",
        "businessType: CAFE",
        "tableCount: 12",
        "branchCount: 2",
        "currentSystem: Example system",
        "priority: HIGH",
        "example: synthetic",
    ] {
        assert!(text.contains(expected));
    }
    row.notes = None;
    row.city = None;
    row.region = None;
    row.address = None;
    row.business_type.clear();
    row.table_count = None;
    row.branch_count = None;
    row.current_system = None;
    row.priority.clear();
    row.custom_fields = json!({});
    assert!(row.note().is_none());
    let ws = jt_tenancy::WorkspaceId::new_v7();
    assert_eq!(
        entity_id(ws, "one", "person"),
        entity_id(ws, "one", "person")
    );
    assert_eq!(entity_id(ws, "one", "person").get_version_num(), 5);
    assert_ne!(
        entity_id(ws, "one", "person"),
        entity_id(ws, "one", "journey")
    );
    assert_ne!(
        entity_id(ws, "one", "person"),
        entity_id(jt_tenancy::WorkspaceId::new_v7(), "one", "person")
    );
}

async fn count(db: &TestDb, ws: jt_tenancy::WorkspaceId, table: &str) -> i64 {
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query_scalar(&format!(
        "select count(*) from {table} where workspace_id=$1"
    ))
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .unwrap()
}

#[tokio::test]
async fn exported_jsonl_dry_run_import_reimport_touched_rollback_and_rls() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("import target").await;
    let (other, _) = db.seed_workspace("isolated tenant").await;
    let store = PgImportStore(db.pool.clone());
    let mut conn = db.pool.acquire().await.unwrap();
    // Prisma model Lead maps to leads. Exact allowlist plus the three WHERE columns only.
    sqlx::raw_sql(r#"create temporary table leads (
        id text, "workspaceId" text, "businessName" text, "contactPerson" text, phone text, whatsapp text,
        email text, address text, city text, region text, "businessType" text, "tableCount" integer,
        "branchCount" integer, "currentSystem" text, source text, status text, "lostReason" text,
        notes text, "nextFollowUp" timestamp, priority text, "customFields" jsonb,
        "emailOptOut" boolean, "smsOptOut" boolean, "waOptOut" boolean, "emailBouncedAt" timestamp,
        "createdAt" timestamp, "updatedAt" timestamp, "deletedAt" timestamp, "mergedIntoId" text
    )"#).execute(&mut *conn).await.unwrap();
    let mut rows = Vec::new();
    for (id, status) in [
        ("a", "NEW"),
        ("b", "LOST"),
        ("c", "WON"),
        ("duplicate", "NEW"),
        ("deleted", "NEW"),
        ("merged", "NEW"),
        ("other", "NEW"),
    ] {
        let mut row: Value = serde_json::from_str(FIXTURE).unwrap();
        row["id"] = json!(id);
        row["status"] = json!(status);
        row["workspaceId"] = json!("v1-workspace");
        if id == "b" || id == "c" {
            row["phone"] = Value::Null;
            row["whatsapp"] = Value::Null;
            row["email"] = json!(format!("{id}@example.test"));
        }
        if id == "deleted" {
            row["deletedAt"] = json!("2025-01-01");
        }
        if id == "merged" {
            row["mergedIntoId"] = json!("a");
        }
        if id == "other" {
            row["workspaceId"] = json!("another-workspace");
        }
        rows.push(row);
    }
    sqlx::query("insert into leads select * from jsonb_populate_recordset(null::leads,$1)")
        .bind(json!(rows))
        .execute(&mut *conn)
        .await
        .unwrap();
    let export = include_str!("../../../../scripts/v1-export-leads.sql")
        .lines()
        .filter(|line| !line.starts_with('\\'))
        .collect::<Vec<_>>()
        .join("\n")
        .replace(":'v1_workspace_id'", "$1");
    let lines: Vec<String> = sqlx::query_scalar(&export)
        .bind("v1-workspace")
        .fetch_all(&mut *conn)
        .await
        .unwrap();
    assert_eq!(lines.len(), 4);
    let expected: Value = serde_json::from_str(FIXTURE).unwrap();
    for line in &lines {
        let actual: Value = serde_json::from_str(line).unwrap();
        assert_eq!(
            actual.as_object().unwrap().keys().collect::<Vec<_>>(),
            expected.as_object().unwrap().keys().collect::<Vec<_>>()
        );
    }
    let leads: Vec<Lead> = lines
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    drop(conn);
    let dry = v1_import::run(&store, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((dry.imported, dry.duplicates_merged, dry.tasks), (4, 1, 2));
    for table in [
        "people",
        "identities",
        "journeys",
        "notes",
        "tasks",
        "consents",
        "suppressions",
        "ledger_entries",
    ] {
        assert_eq!(count(&db, ws, table).await, 0, "dry run wrote {table}");
    }
    let report = v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        (report.imported, report.duplicates_merged, report.opt_outs),
        (4, 1, 12)
    );
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("PII_CANARY")
    );
    assert_eq!(count(&db, ws, "people").await, 3);
    assert_eq!(count(&db, other, "people").await, 0);
    let no_scope: i64 = sqlx::query_scalar("select count(*) from people")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(no_scope, 0);
    let again = v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((again.imported, again.already_present), (0, 4));
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let person: PersonId = entity_id(ws, "a", "person").into();
    let p = r.people().get(person).await.unwrap().unwrap();
    assert_eq!(p.company, "PII_CANARY_ONLY_SYNTHETIC_73");
    assert_eq!(p.created_at.year(), 2025);
    let journey = r.journeys().open_for(person).await.unwrap().unwrap();
    assert!(journey.owner.is_none());
    assert_eq!(r.notes().list(journey.id).await.unwrap().len(), 2);
    assert!(
        r.consents()
            .list(person)
            .await
            .unwrap()
            .iter()
            .all(|c| c.kind == ConsentKind::Withdrawn)
    );
    assert_eq!(r.suppressions().list(person).await.unwrap().len(), 4);
    for (id, status) in [("b", JourneyStatus::Lost), ("c", JourneyStatus::Won)] {
        let j = r
            .journeys()
            .get(entity_id(ws, id, "journey").into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(j.status, status);
        assert!(j.closed_at.is_some());
        assert!(r.tasks().list(j.id).await.unwrap().is_empty());
    }
    r.notes()
        .insert(Note {
            id: NoteId::new_v7(),
            workspace_id: ws,
            journey_id: journey.id,
            author: EventSource::System,
            text: "operator edit".into(),
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let down = v1_import::run(&store, ws, &leads, Mode::Rollback, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((down.rolled_back, down.kept), (2, 1));
    assert_eq!(count(&db, ws, "people").await, 1);
    let repeat = v1_import::run(&store, ws, &leads, Mode::Rollback, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((repeat.rolled_back, repeat.kept), (0, 1));
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let ledger: Vec<Value>=sqlx::query_scalar("select to_jsonb(l) from ledger_entries l where workspace_id=$1 and action='import.v1_leads'").bind(ws.as_uuid()).fetch_all(tx.conn()).await.unwrap();
    assert_eq!(ledger.len(), 4);
    for entry in ledger {
        assert_eq!(entry["actor_kind"], json!("system"));
        assert_eq!(entry["actor_component"], json!("v1_import"));
        assert!(
            entry["payload"]
                .as_object()
                .unwrap()
                .values()
                .all(Value::is_u64)
        );
        assert!(!entry.to_string().contains("PII_CANARY"));
    }
    drop(tx);
    // Up -> down -> up: untouched groups can be imported again with the same deterministic ids.
    let up = v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((up.imported, up.already_present), (2, 2));
}

#[tokio::test]
async fn never_steals_non_imported_identities_and_never_rebaselines_touched_people() {
    use jt_inbox::{FirstTouch, Identity, IdentityChannel, IdentityId, Person, Source};
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("conflicts").await;
    let store = PgImportStore(db.pool.clone());
    let uow = PgUnitOfWork::new(db.pool.clone());
    let existing = PersonId::new_v7();
    let mut r = uow.tenant(ws).await.unwrap();
    r.people()
        .insert(Person {
            id: existing,
            workspace_id: ws,
            display_name: "runtime person".into(),
            company: "".into(),
            first_touch: FirstTouch {
                source: Source::Form,
                capability_id: None,
                at: FIXED_NOW,
            },
            merged_into: None,
            erased_at: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: ws,
            person_id: existing,
            channel: IdentityChannel::Phone,
            value_normalized: "+905321234567".into(),
            value_display: "".into(),
            active: true,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let one = lead("one");
    let report = v1_import::run(
        &store,
        ws,
        std::slice::from_ref(&one),
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        (
            report.imported,
            report.identities_conflicting,
            report.duplicates_merged
        ),
        (1, 1, 0)
    );
    let imported: PersonId = entity_id(ws, "one", "person").into();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("update people set company='operator changed' where workspace_id=$1 and id=$2")
        .bind(ws.as_uuid())
        .bind(imported.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let two = lead("two");
    let report = v1_import::run(
        &store,
        ws,
        std::slice::from_ref(&two),
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        (report.duplicates_merged, report.identities_conflicting),
        (0, 2)
    );
    let down = v1_import::run(&store, ws, &[one, two], Mode::Rollback, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((down.rolled_back, down.kept), (1, 1));
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.identities().list(existing).await.unwrap().len(), 1);
    assert_eq!(
        r.people()
            .get(existing)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "runtime person"
    );
    assert_eq!(
        r.people().get(imported).await.unwrap().unwrap().company,
        "operator changed"
    );
}

#[tokio::test]
async fn rollback_keeps_changed_note_task_identity_consent_and_extra_journey() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("rollback guards").await;
    let store = PgImportStore(db.pool.clone());
    let mut leads = Vec::new();
    for i in 0..6 {
        let mut row = lead(&format!("guard-{i}"));
        row.phone = None;
        row.whatsapp = None;
        row.email = Some(format!("guard-{i}@example.test"));
        leads.push(row);
    }
    v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    for (index, sql, kind) in [
        (
            0,
            "update notes set text='changed' where workspace_id=$1 and id=$2",
            "note",
        ),
        (
            1,
            "update tasks set status='done' where workspace_id=$1 and id=$2",
            "task",
        ),
        (
            2,
            "update identities set active=false where workspace_id=$1 and id=$2",
            "identity:0",
        ),
        (
            3,
            "update consents set sync_state='sent',attempts=1 where workspace_id=$1 and id=$2",
            "withdrawal:Email",
        ),
    ] {
        assert_eq!(
            sqlx::query(sql)
                .bind(ws.as_uuid())
                .bind(entity_id(ws, &format!("guard-{index}"), kind))
                .execute(tx.conn())
                .await
                .unwrap()
                .rows_affected(),
            1
        );
    }
    tx.commit().await.unwrap();
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let extra = jt_inbox::import_journey(jt_inbox::ImportedJourney {
        id: jt_inbox::JourneyId::new_v7(),
        workspace_id: ws,
        person_id: entity_id(ws, "guard-4", "person").into(),
        lead_id: "extra".into(),
        source: "OTHER".into(),
        status: "LOST".into(),
        lost_reason: "".into(),
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    })
    .unwrap();
    r.journeys().insert_initial(extra).await.unwrap();
    r.commit().await.unwrap();
    let result = v1_import::run(&store, ws, &leads, Mode::Rollback, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((result.rolled_back, result.kept), (1, 5));
    assert_eq!(count(&db, ws, "people").await, 5);
}

#[tokio::test]
async fn chunk_boundary_duplicates_and_prevalidation_are_atomic() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("chunks").await;
    let store = PgImportStore(db.pool.clone());
    let mut leads = (0..101)
        .map(|i| {
            let mut l = lead(&format!("chunk-{i}"));
            l.email_opt_out = false;
            l.sms_opt_out = false;
            l.wa_opt_out = false;
            l.email_bounced_at = None;
            l
        })
        .collect::<Vec<_>>();
    leads[100].status = "UNKNOWN".into();
    assert!(
        v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
            .await
            .is_err()
    );
    assert_eq!(count(&db, ws, "people").await, 0);
    leads[100].status = "NEW".into();
    let dry = v1_import::run(&store, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((dry.imported, dry.duplicates_merged), (101, 100));
    assert_eq!(count(&db, ws, "people").await, 0);
    let up = v1_import::run(&store, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((up.imported, up.duplicates_merged), (101, 100));
    assert_eq!(count(&db, ws, "journeys").await, 1);
    assert_eq!(count(&db, ws, "notes").await, 101);
    let down = v1_import::run(&store, ws, &leads, Mode::Rollback, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((down.rolled_back, down.kept), (1, 0));
    assert_eq!(count(&db, ws, "people").await, 0);
}

#[tokio::test]
async fn erased_identity_tombstone_prevents_reintroducing_the_entire_lead() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("erasure invariant").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    r.erasure()
        .remember_identity(
            jt_inbox::IdentityChannel::Phone,
            &jt_inbox::identity_hash(jt_inbox::IdentityChannel::Phone, "+905321234567"),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = v1_import::run(
        &PgImportStore(db.pool.clone()),
        ws,
        &[lead("erased")],
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!((report.imported, report.erased_skipped), (0, 1));
    for table in [
        "people",
        "identities",
        "journeys",
        "notes",
        "tasks",
        "consents",
        "suppressions",
    ] {
        assert_eq!(count(&db, ws, table).await, 0);
    }
}
