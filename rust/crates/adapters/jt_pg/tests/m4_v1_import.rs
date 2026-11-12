// The synthetic leads are large `json!` literals.
#![recursion_limit = "256"]

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
use jt_testkit::{
    TestDb,
    fakes::{FIXED_NOW, PlainSecretBox},
};
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
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW)
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
    let report = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
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
    let again = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
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
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!((down.rolled_back, down.kept), (2, 1));
    assert_eq!(count(&db, ws, "people").await, 1);
    let repeat = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
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
    let up = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
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
            recipient_kind: jt_inbox::RecipientKind::Unknown,
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
        &PlainSecretBox,
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
        &PlainSecretBox,
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
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &[one, two],
        Mode::Rollback,
        FIXED_NOW,
    )
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
    v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
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
    let result = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
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
        v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
            .await
            .is_err()
    );
    assert_eq!(count(&db, ws, "people").await, 0);
    leads[100].status = "NEW".into();
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((dry.imported, dry.duplicates_merged), (101, 100));
    assert_eq!(count(&db, ws, "people").await, 0);
    let up = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((up.imported, up.duplicates_merged), (101, 100));
    assert_eq!(count(&db, ws, "journeys").await, 1);
    assert_eq!(count(&db, ws, "notes").await, 101);
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
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
        &PlainSecretBox,
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

async fn normal_phone_person(
    db: &TestDb,
    ws: jt_tenancy::WorkspaceId,
    raw: &str,
    erase: bool,
) -> PersonId {
    use jt_app::usecases::inbox::{erasure, people};
    struct UniqueIds;
    impl jt_app::ports::IdGen for UniqueIds {
        fn uuid(&self) -> uuid::Uuid {
            uuid::Uuid::now_v7()
        }
    }
    let mut deps = jt_testkit::fakes::deps(std::sync::Arc::new(PgUnitOfWork::new(db.pool.clone())));
    deps.ids = std::sync::Arc::new(UniqueIds);
    let ctx = jt_app::ctx::Ctx {
        workspace_id: ws,
        actor: jt_ledger::Actor::System {
            component: "test".into(),
        },
        permissions: [
            jt_tenancy::Permission::InboxWork,
            jt_tenancy::Permission::InboxManage,
        ]
        .into(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let person = people::create(
        &deps,
        &ctx,
        people::CreateInput {
            display_name: "synthetic normal intake".into(),
            source: jt_inbox::Source::Form,
            identities: vec![people::IdentityInput {
                channel: jt_inbox::IdentityChannel::Phone,
                value: raw.into(),
                capability_id: None,
            }],
        },
    )
    .await
    .unwrap()
    .person
    .id;
    if erase {
        erasure::erase(&deps, &ctx, person, erasure::EraseInput { confirm: true })
            .await
            .unwrap();
    }
    person
}

#[tokio::test]
async fn normal_intake_national_phone_erasure_blocks_all_import_spellings() {
    assert_eq!(
        jt_inbox::normalise(jt_inbox::IdentityChannel::Phone, "5321234567").unwrap(),
        "+905321234567"
    );
    assert_national_phone_erasure_blocks_import("5321234567").await;
}

#[tokio::test]
async fn legacy_national_phone_alias_erasure_blocks_all_import_spellings() {
    assert_national_phone_erasure_blocks_import("+5321234567").await;
}

async fn assert_national_phone_erasure_blocks_import(stored_phone: &str) {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("national phone erasure").await;
    normal_phone_person(&db, ws, stored_phone, true).await;
    for raw in [
        "5321234567",
        "(532) 123 45 67",
        "05321234567",
        "+905321234567",
    ] {
        let mut row = lead(raw);
        row.phone = Some(raw.into());
        row.whatsapp = None;
        row.email = None;
        let report = v1_import::run(
            &PgImportStore(db.pool.clone()),
            &PlainSecretBox,
            ws,
            &[row],
            Mode::Import,
            FIXED_NOW,
        )
        .await
        .unwrap();
        assert_eq!(
            (report.imported, report.erased_skipped),
            (0, 1),
            "national phone tombstone was bypassed"
        );
    }
    assert_eq!(count(&db, ws, "people").await, 1); // the erased runtime tombstone only
    assert_eq!(count(&db, ws, "notes").await, 0);
}

#[tokio::test]
async fn normal_intake_national_phone_owner_is_never_duplicated_or_stolen() {
    assert_national_phone_owner_is_preserved("5321234567", "+905321234567").await;
}

#[tokio::test]
async fn legacy_national_phone_alias_owner_is_never_duplicated_or_stolen() {
    assert_national_phone_owner_is_preserved("+5321234567", "+5321234567").await;
}

async fn assert_national_phone_owner_is_preserved(stored_phone: &str, expected: &str) {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("legacy phone ownership").await;
    let existing = normal_phone_person(&db, ws, stored_phone, false).await;
    let mut row = lead("conflicting national phone");
    row.phone = Some("05321234567".into());
    row.whatsapp = Some("5321234567".into());
    row.email = None;
    let report = v1_import::run(
        &PgImportStore(db.pool.clone()),
        &PlainSecretBox,
        ws,
        &[row],
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        (report.identities_conflicting, report.duplicates_merged),
        (1, 0)
    );
    assert_eq!(count(&db, ws, "identities").await, 1);
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.identities().list(existing).await.unwrap()[0].value_normalized,
        expected
    );
}

struct ObservedImportStore {
    inner: PgImportStore,
    begins: std::sync::atomic::AtomicUsize,
}
impl ObservedImportStore {
    fn new(db: &TestDb) -> Self {
        Self {
            inner: PgImportStore(db.pool.clone()),
            begins: 0.into(),
        }
    }
    fn begins(&self) -> usize {
        self.begins.load(std::sync::atomic::Ordering::SeqCst)
    }
}
#[async_trait::async_trait]
impl jt_app::ports::v1_import::ImportStore for ObservedImportStore {
    async fn lock_run(
        &self,
        ws: jt_tenancy::WorkspaceId,
    ) -> Result<Box<dyn jt_app::ports::v1_import::ImportRunGuard>, jt_app::error::AppError> {
        self.inner.lock_run(ws).await
    }
    async fn begin(
        &self,
        ws: jt_tenancy::WorkspaceId,
    ) -> Result<Box<dyn jt_app::ports::v1_import::ImportRepos>, jt_app::error::AppError> {
        // A separate session must be able to acquire the inbox lock between chunks.
        let mut tx = TenantTx::begin(&self.inner.0, ws).await.unwrap();
        sqlx::query("set local lock_timeout='2s'")
            .execute(tx.conn())
            .await
            .unwrap();
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('inbox:' || $1::text,0))")
            .bind(ws.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        self.begins
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.begin(ws).await
    }
}

#[tokio::test]
async fn dry_run_releases_the_inbox_lock_every_hundred_leads_and_keeps_duplicate_counts() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("bounded rehearsal").await;
    let store = ObservedImportStore::new(&db);
    let mut leads = (0..201)
        .map(|i| lead(&format!("preview-{i}")))
        .collect::<Vec<_>>();
    leads.push(leads[0].clone());
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        (
            dry.imported,
            dry.duplicates_merged,
            dry.already_present,
            dry.tasks,
            dry.opt_outs
        ),
        (201, 200, 1, 201, 603)
    );
    assert!(
        (3..=4).contains(&store.begins()),
        "dry run must open bounded transactions, got {}",
        store.begins()
    );
    assert_eq!(count(&db, ws, "people").await, 0);
    assert_eq!(count(&db, ws, "ledger_entries").await, 0);
    let real = v1_import::run(
        &PgImportStore(db.pool.clone()),
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(dry).unwrap(),
        serde_json::to_value(real).unwrap()
    );
}

#[tokio::test]
async fn three_thousand_marker_lookups_are_bounded_and_chunked() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("marker scaling").await;
    let leads = (0..3000)
        .map(|i| lead(&format!("scale-{i}")))
        .collect::<Vec<_>>();
    let rows=(0..1500).map(|i| json!({"id":entity_id(ws,&format!("scale-{}",2*i),"person"),"workspace_id":ws,
        "display_name":"synthetic","company":"","recipient_kind":"unknown","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z",
        "first_touch":{"source":"import","kind":"import","system":"v1","v1_leads":[{"v1_lead_id":format!("scale-{}",2*i)},{"v1_lead_id":format!("scale-{}",2*i+1)}]}})).collect::<Vec<_>>();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into people select * from jsonb_populate_recordset(null::people,$1)")
        .bind(json!(rows))
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // A test-only RLS probe counts rows actually examined, even in rolled-back transactions.
    // This catches quadratic scans independently of hardware speed or a generous deadline.
    sqlx::raw_sql("create sequence v1_marker_reads; create function v1_marker_read() returns boolean language plpgsql volatile as $$ begin perform nextval('v1_marker_reads'); return true; end $$; create policy v1_read_probe on people as restrictive for select using (v1_marker_read());")
        .execute(&db.pool).await.unwrap();
    let store = ObservedImportStore::new(&db);
    let report = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW),
    )
    .await
    .expect("3000 synthetic leads must finish within 180 seconds")
    .unwrap();
    assert_eq!((report.imported, report.already_present), (0, 3000));
    assert!(
        (31..=32).contains(&store.begins()),
        "import did not use 100-row chunks"
    );
    let reads: i64 = sqlx::query_scalar("select last_value from v1_marker_reads")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(
        reads < 30_000,
        "idempotency scanned {reads} people; expected a single load plus indexed probes"
    );
}

#[tokio::test]
async fn three_thousand_fresh_leads_preview_in_bounded_transactions_without_writes() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("fresh preview scaling").await;
    let leads = (0..3000)
        .map(|i| {
            let mut row = lead(&format!("fresh-{i}"));
            row.phone = None;
            row.whatsapp = None;
            row.email = Some(format!("synthetic-{i}@example.test"));
            row
        })
        .collect::<Vec<_>>();
    let store = ObservedImportStore::new(&db);
    let report = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW),
    )
    .await
    .expect("3000 fresh synthetic leads must preview within 180 seconds")
    .unwrap();
    assert_eq!(
        (
            report.imported,
            report.duplicates_merged,
            report.tasks,
            report.opt_outs
        ),
        (3000, 0, 3000, 9000)
    );
    assert_eq!(store.begins(), 31); // 30 data chunks plus the rolled-back ledger write
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
        assert_eq!(count(&db, ws, table).await, 0, "preview persisted {table}");
    }
}

#[tokio::test]
async fn preview_remembers_new_keys_on_existing_imports_and_matches_mixed_outcomes() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("mixed preview").await;
    let store = PgImportStore(db.pool.clone());
    v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &[lead("existing")],
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    normal_phone_person(&db, ws, "5551112233", false).await;
    normal_phone_person(&db, ws, "5554445566", true).await;
    let mut leads = (0..201)
        .map(|i| {
            let mut row = lead(&format!("mixed-{i}"));
            row.phone = None;
            row.whatsapp = None;
            row.email = None;
            row.status = ["NEW", "WON", "LOST"][i % 3].into();
            row
        })
        .collect::<Vec<_>>();
    leads[0].phone = Some("5321234567".into()); // matches the existing import
    leads[0].email = Some("new-alias@example.test".into());
    leads[100].email = Some("new-alias@example.test".into()); // projected identity across chunks
    leads[101].phone = Some("5551112233".into()); // active runtime owner
    leads[102].phone = Some("05554445566".into()); // historical erasure alias
    leads[103].phone = Some("invalid".into());
    leads.push(leads[100].clone());
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        (
            dry.duplicates_merged,
            dry.identities_conflicting,
            dry.erased_skipped,
            dry.identities_invalid,
            dry.already_present
        ),
        (2, 1, 1, 1, 1)
    );
    let real = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(dry).unwrap(),
        serde_json::to_value(real).unwrap()
    );
}

#[tokio::test]
async fn competing_operator_runs_are_refused_without_holding_the_inbox_lock() {
    use jt_app::ports::v1_import::{ImportRepos, ImportStore};
    use std::sync::Arc;
    struct PausedStore {
        inner: PgImportStore,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        paused: std::sync::atomic::AtomicBool,
    }
    #[async_trait::async_trait]
    impl ImportStore for PausedStore {
        async fn lock_run(
            &self,
            ws: jt_tenancy::WorkspaceId,
        ) -> Result<Box<dyn jt_app::ports::v1_import::ImportRunGuard>, jt_app::error::AppError>
        {
            self.inner.lock_run(ws).await
        }
        async fn begin(
            &self,
            ws: jt_tenancy::WorkspaceId,
        ) -> Result<Box<dyn ImportRepos>, jt_app::error::AppError> {
            if !self.paused.swap(true, std::sync::atomic::Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.inner.begin(ws).await
        }
    }
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("serialized operator runs").await;
    let store = Arc::new(PausedStore {
        inner: PgImportStore(db.pool.clone()),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        paused: false.into(),
    });
    let first = {
        let store = store.clone();
        tokio::spawn(async move {
            v1_import::run(
                &*store,
                &PlainSecretBox,
                ws,
                &[lead("first")],
                Mode::DryRun,
                FIXED_NOW,
            )
            .await
        })
    };
    store.entered.notified().await;
    // The long-lived run guard must not block normal inbox work.
    normal_phone_person(&db, ws, "5551112233", false).await;
    let inner = PgImportStore(db.pool.clone());
    let rows = [lead("second")];
    let blocked = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        v1_import::run(&inner, &PlainSecretBox, ws, &rows, Mode::DryRun, FIXED_NOW),
    )
    .await
    .unwrap();
    store.release.notify_one();
    first.await.unwrap().unwrap();
    assert_eq!(blocked.unwrap_err().message, "v1 import already_running");
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        v1_import::run(&inner, &PlainSecretBox, ws, &rows, Mode::DryRun, FIXED_NOW),
    )
    .await
    .unwrap()
    .unwrap();
}

#[test]
fn normalized_import_identity_lengths_are_bounded() {
    let mut row = lead("length boundaries");
    row.whatsapp = None;
    row.phone = Some("+123456789012345".into());
    row.email = Some(format!("{}@example.test", "a".repeat(241)));
    assert_eq!((row.identities().0.len(), row.identities().1), (2, 0));
    row.phone = Some("+1234567890123456".into());
    row.email = Some(format!("{}@example.test", "a".repeat(242)));
    assert_eq!(row.identities(), (vec![], 2));
}

#[tokio::test]
async fn six_thousand_character_email_is_invalid_in_both_dry_run_and_import() {
    use sha2::{Digest, Sha256};
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("oversized identity").await;
    let mut row = lead("oversized synthetic email");
    let local: String = (0u32..188)
        .map(|i| hex::encode(Sha256::digest(i.to_le_bytes())))
        .collect();
    row.email = Some(format!("{}@example.test", &local[..6000]));
    row.phone = None;
    row.whatsapp = None;
    let store = PgImportStore(db.pool.clone());
    let rows = [row];
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &rows, Mode::DryRun, FIXED_NOW).await;
    let real = v1_import::run(&store, &PlainSecretBox, ws, &rows, Mode::Import, FIXED_NOW).await;
    assert_eq!(
        dry.is_ok(),
        real.is_ok(),
        "dry run and import must agree on oversized identities"
    );
    let dry = dry.unwrap();
    let real = real.unwrap();
    assert_eq!((dry.imported, dry.identities_invalid), (1, 1));
    assert_eq!(
        serde_json::to_value(dry).unwrap(),
        serde_json::to_value(real).unwrap()
    );
    assert_eq!(count(&db, ws, "identities").await, 0);
}

#[tokio::test]
async fn dry_run_executes_every_write_and_matches_import_across_chunks() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("write rehearsal").await;
    // Sequences survive transaction rollback: observe real INSERTs without persisting PII.
    sqlx::raw_sql("create function v1_insert_probe() returns trigger language plpgsql as $$ begin perform nextval(TG_ARGV[0]); return NEW; end $$;")
        .execute(&db.pool).await.unwrap();
    let tables = [
        "people",
        "identities",
        "journeys",
        "notes",
        "tasks",
        "consents",
        "suppressions",
        "ledger_entries",
    ];
    for table in tables {
        sqlx::raw_sql(&format!("create sequence v1_writes_{table}; create trigger v1_insert_probe before insert on {table} for each row execute function v1_insert_probe('v1_writes_{table}');"))
            .execute(&db.pool).await.unwrap();
    }
    let mut rows = (0..201)
        .map(|i| lead(&format!("writes-{i}")))
        .collect::<Vec<_>>();
    rows.push(rows[0].clone());
    let store = ObservedImportStore::new(&db);
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &rows, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    for table in tables {
        let attempts: i64 = sqlx::query_scalar(&format!(
            "select case when is_called then last_value else 0 end from v1_writes_{table}"
        ))
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(attempts > 0, "dry run bypassed {table} writes");
        assert_eq!(count(&db, ws, table).await, 0, "dry run persisted {table}");
        if table == "notes" {
            assert_eq!(attempts, 201, "prior chunks must not be replayed wholesale");
        }
    }
    assert!((3..=4).contains(&store.begins()));
    let real = v1_import::run(
        &PgImportStore(db.pool.clone()),
        &PlainSecretBox,
        ws,
        &rows,
        Mode::Import,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(dry).unwrap(),
        serde_json::to_value(real).unwrap()
    );
}

#[tokio::test]
async fn dry_run_obeys_database_write_constraints() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("constraint rehearsal").await;
    sqlx::raw_sql("alter table notes add constraint synthetic_rehearsal_rejection check (text not like '%PII_CANARY_ONLY_SYNTHETIC_73%');")
        .execute(&db.pool).await.unwrap();
    let rows = [lead("database rejection")];
    let store = PgImportStore(db.pool.clone());
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &rows, Mode::DryRun, FIXED_NOW).await;
    // Drop-on-error closes the session lock connection asynchronously.
    let real = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let result =
                v1_import::run(&store, &PlainSecretBox, ws, &rows, Mode::Import, FIXED_NOW).await;
            if result
                .as_ref()
                .err()
                .is_some_and(|e| e.message == "v1 import already_running")
            {
                tokio::task::yield_now().await;
                continue;
            }
            break result;
        }
    })
    .await
    .expect("failed dry run must release its operator lock");
    assert!(real.is_err());
    assert!(dry.is_err(), "dry run skipped database constraints");
    assert_eq!(count(&db, ws, "people").await, 0);
}

// ---------------------------------------------------------------------------------------------
// L7: routing between the inbox and the pool (spec §10, D23). Synthetic values only.
// ---------------------------------------------------------------------------------------------

/// A format-2 research lead nobody contacted: the pool's case. `n` makes its keys distinct.
fn pool_lead(id: &str, n: u32) -> Value {
    json!({
        "format": 2, "id": id, "businessName": format!("Sentetik İşletme {n}"),
        "contactPerson": "Deneme Kişi", "phone": format!("+90500000{n:04}"), "whatsapp": null,
        "email": format!("isletme{n}@example.invalid"), "address": null, "city": "İzmir",
        "region": "Konak", "businessType": "CAFE", "tableCount": null, "branchCount": 1,
        "currentSystem": null, "source": "AI_RESEARCH", "status": "NEW", "lostReason": null,
        "notes": null, "nextFollowUp": null, "priority": "MEDIUM", "customFields": {},
        "emailOptOut": false, "smsOptOut": false, "waOptOut": false, "emailBouncedAt": null,
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2026-03-01T00:00:00Z",
        "deletedAt": null, "mergedIntoId": null,
        "contact": {"conversationsOutbound": 0, "conversationsInbound": 0, "campaignSent": 0,
                    "mailSent": 0, "activitiesOutbound": 0, "offers": 0, "lastContactAt": null},
        "activities": [], "offers": [], "tags": [], "attribution": null, "research": null,
        "aiScore": 64, "aiScoreReason": null, "scoredAt": null, "ownerEmail": null,
        "emailVerifiedStatus": "UNKNOWN"
    })
}

fn parse(v: Value) -> Lead {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn pool_duplicates_and_in_inbox_are_counted() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("pool counts").await;
    let store = PgImportStore(db.pool.clone());
    // An inbox lead (contacted) and a pool lead sharing its phone, listed pool-first: inbox
    // leads go first, so the pool lead finds the relationship.
    let mut contacted = pool_lead("contacted", 1);
    contacted["contact"]["campaignSent"] = json!(2);
    let shares_inbox = pool_lead("shares-inbox", 1);
    let fresh = pool_lead("fresh", 2);
    let mut same = pool_lead("same-business", 2);
    same["businessName"] = json!("Sentetik İşletme şubesi");
    let mut gone = pool_lead("deleted", 3);
    gone["deletedAt"] = json!("2026-01-01T00:00:00Z");
    let mut merged = pool_lead("merged", 4);
    merged["mergedIntoId"] = json!("fresh");
    let leads: Vec<Lead> = [shares_inbox, fresh, same, contacted, gone, merged]
        .into_iter()
        .map(parse)
        .collect();
    let report = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((report.total, report.to_inbox, report.to_pool), (6, 1, 3));
    assert_eq!((report.skipped_deleted, report.skipped_merged), (1, 1));
    assert_eq!(
        (
            report.imported,
            report.pooled,
            report.pool_in_inbox,
            report.pool_duplicates
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(count(&db, ws, "people").await, 1);
    assert_eq!(count(&db, ws, "prospects").await, 1);
    assert_eq!(count(&db, ws, "prospect_scores").await, 1);
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let id = jt_prospects::ProspectId::from(entity_id(ws, "fresh", "prospect"));
    let p = r.prospects().get(id).await.unwrap().unwrap();
    assert_eq!(p.origin.via, jt_prospects::OriginVia::V1Import);
    assert_eq!(
        p.latest_score.as_ref().map(|s| s.digest.as_str()),
        Some("v1-legacy")
    );
    drop(r);
    // Again: what was imported is present already; nothing new.
    let again = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((again.imported, again.pooled), (0, 0));
    assert_eq!(again.already_present, 2);
    assert_eq!(count(&db, ws, "prospects").await, 1);
}

#[tokio::test]
async fn opt_outs_become_dnc_hashes() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("pool dnc").await;
    let store = PgImportStore(db.pool.clone());
    let mut objected = pool_lead("objected", 5);
    objected["emailOptOut"] = json!(true);
    objected["smsOptOut"] = json!(true);
    // A later lead with the objected email is blocked by the entries the first one wrote.
    let mut later = pool_lead("later", 6);
    later["email"] = json!("isletme5@example.invalid");
    let leads = vec![parse(objected), parse(later)];
    let report = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        (report.pool_dnc, report.pool_blocked, report.pooled),
        (1, 1, 0)
    );
    assert_eq!(count(&db, ws, "prospects").await, 0);
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select kind, reason, key_hash from prospect_blocklist where workspace_id=$1 order by kind",
    )
    .bind(ws.as_uuid())
    .fetch_all(tx.conn())
    .await
    .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| (r.0.as_str(), r.1.as_str()))
            .collect::<Vec<_>>(),
        vec![("email", "do_not_contact"), ("phone", "do_not_contact")]
    );
    // Hashes only: no value is stored.
    assert!(
        rows.iter()
            .all(|r| !r.2.contains("example.invalid") && r.2.len() == 64)
    );
    drop(tx);
    // The objection outlives a rollback.
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(down.prospects_rolled_back, 0);
    assert_eq!(count(&db, ws, "prospect_blocklist").await, 2);
}

#[tokio::test]
async fn dry_run_writes_nothing_and_reports_counts() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("pool dry run").await;
    let store = PgImportStore(db.pool.clone());
    // 149 pool leads, one repeating the first's keys (two chunks), and one opt-out.
    let mut leads: Vec<Lead> = (0..149)
        .map(|n| parse(pool_lead(&format!("dry-{n}"), n)))
        .collect();
    leads.push(parse(pool_lead("dry-repeat", 0)));
    let mut objected = pool_lead("dry-objected", 900);
    objected["waOptOut"] = json!(true);
    leads.push(parse(objected));
    let dry = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::DryRun, FIXED_NOW)
        .await
        .unwrap();
    for table in [
        "prospects",
        "prospect_keys",
        "prospect_scores",
        "prospect_blocklist",
        "ledger_entries",
    ] {
        assert_eq!(count(&db, ws, table).await, 0, "dry run wrote {table}");
    }
    let real = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    let (d, r) = (
        serde_json::to_value(dry).unwrap(),
        serde_json::to_value(real).unwrap(),
    );
    assert_eq!(d, r, "a dry run counts what the import does");
    assert_eq!(
        (
            real.to_pool,
            real.pooled,
            real.pool_duplicates,
            real.pool_dnc
        ),
        (151, 149, 1, 1)
    );
    assert!(d.as_object().unwrap().values().all(Value::is_u64));
    assert!(!d.to_string().contains("example.invalid"));
}

#[tokio::test]
async fn rollback_removes_unchanged_prospects_and_keeps_touched() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("pool rollback").await;
    let store = PgImportStore(db.pool.clone());
    let leads: Vec<Lead> = (10..13)
        .map(|n| parse(pool_lead(&format!("rb-{n}"), n)))
        .collect();
    v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(count(&db, ws, "prospects").await, 3);
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    // One is qualified (a status change), one scored again under a Jeeta rubric.
    let qualified = jt_prospects::ProspectId::from(entity_id(ws, "rb-10", "prospect"));
    let p = r.prospects().get(qualified).await.unwrap().unwrap();
    assert_eq!(
        r.prospects()
            .set_status(
                qualified,
                jt_prospects::ProspectStatus::Qualified,
                None,
                FIXED_NOW,
                p.revision
            )
            .await
            .unwrap(),
        jt_app::ports::prospects::Updated::Ok
    );
    let rescored = jt_prospects::ProspectId::from(entity_id(ws, "rb-11", "prospect"));
    r.prospects()
        .record_score(&jt_app::ports::prospects::ScoreRow {
            id: entity_id(ws, "rb-11", "rescore"),
            prospect_id: rescored,
            score: 90,
            reasons: vec![],
            rubric_digest: "jeeta-rubric".into(),
            strategy_version_id: None,
            recorder: jt_prospects::Recorder::Human { user_id: owner },
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!((down.prospects_rolled_back, down.prospects_kept), (1, 2));
    assert_eq!(count(&db, ws, "prospects").await, 2);
    let repeat = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!(
        (repeat.prospects_rolled_back, repeat.prospects_kept),
        (0, 2)
    );
    // The rolled-back lead imports again under the same deterministic id.
    let up = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!((up.pooled, up.already_present), (1, 2));
}

#[tokio::test]
async fn rollback_keeps_a_person_a_prospect_was_promoted_to() {
    // L1 review note: `prospects_person_fkey` has no on-delete rule, so an imported person a
    // prospect names is kept (never deleted from under it, never unlinked).
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("promoted person").await;
    let store = PgImportStore(db.pool.clone());
    let mut inbox = pool_lead("inbox-person", 20);
    inbox["status"] = json!("CONTACTED");
    let leads = vec![parse(inbox)];
    v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    let person: PersonId = entity_id(ws, "inbox-person", "person").into();
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let journey = r.journeys().open_for(person).await.unwrap().unwrap();
    let record = v1_import::pool_record(ws, &parse(pool_lead("other", 21)), FIXED_NOW).unwrap();
    r.prospects()
        .insert(&record.prospect, &record.keys)
        .await
        .unwrap();
    r.prospects()
        .set_promoted(
            record.prospect.id,
            &jt_prospects::Promotion {
                person_id: person,
                journey_id: journey.id,
                at: FIXED_NOW,
                score: None,
                bucket: None,
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!((down.rolled_back, down.kept), (0, 1));
    assert_eq!(count(&db, ws, "people").await, 1);
}

#[tokio::test]
async fn inbox_route_writes_activity_and_offer_notes_and_maps_the_owner() {
    let db = TestDb::new().await;
    let (ws, owner) = db.seed_workspace("inbox additions").await;
    let store = PgImportStore(db.pool.clone());
    let mut mapped = pool_lead("mapped", 30);
    mapped["status"] = json!("OFFER_SENT");
    mapped["ownerEmail"] = json!(format!("OWNER+{owner}@test.local"));
    mapped["tags"] = json!(["sıcak"]);
    mapped["activities"] = json!([
        {"id": "a1", "type": "CALL", "title": "Arama", "description": null, "outcome": "POSITIVE",
         "createdAt": "2026-01-02T08:00:00Z"},
        {"id": "a2", "type": "STATUS_CHANGE", "title": "NEW to OFFER_SENT", "description": null,
         "outcome": null, "createdAt": "2026-01-02T08:01:00Z"}
    ]);
    mapped["offers"] = json!([
        {"id": "o1", "status": "SENT", "planName": "Başlangıç", "price": 1500, "currency": "TRY",
         "validUntil": null, "createdAt": "2026-01-10T00:00:00Z"}
    ]);
    let mut unmapped = pool_lead("unmapped", 31);
    unmapped["status"] = json!("CONTACTED");
    unmapped["ownerEmail"] = json!("left@example.invalid");
    let leads = vec![parse(mapped), parse(unmapped)];
    let report = v1_import::run(&store, &PlainSecretBox, ws, &leads, Mode::Import, FIXED_NOW)
        .await
        .unwrap();
    assert_eq!(
        (
            report.imported,
            report.activities_as_notes,
            report.offers_as_notes
        ),
        (2, 1, 1)
    );
    assert_eq!((report.owners_mapped, report.owners_unmapped), (1, 1));
    assert_eq!(count(&db, ws, "quotes").await, 0, "v1 offers are no quotes");
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let j = r
        .journeys()
        .get(entity_id(ws, "mapped", "journey").into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(j.owner, Some(owner));
    let live = r.assignments().live(j.id).await.unwrap().unwrap();
    assert_eq!(
        (live.cause, live.user_id),
        (jt_inbox::Cause::Import, Some(owner))
    );
    let texts: Vec<String> = r
        .notes()
        .list(j.id)
        .await
        .unwrap()
        .into_iter()
        .map(|n| n.text)
        .collect();
    assert_eq!(texts.len(), 3, "the lead note, one activity, the offers");
    assert!(
        texts
            .iter()
            .any(|t| t.starts_with("v1 CALL · POSITIVE · Arama"))
    );
    assert!(texts.iter().any(|t| t.starts_with("v1 teklifleri")));
    assert!(texts.iter().any(|t| t.contains("tags: sıcak")));
    let other = r
        .journeys()
        .get(entity_id(ws, "unmapped", "journey").into())
        .await
        .unwrap()
        .unwrap();
    assert!(other.owner.is_none());
    assert!(r.assignments().live(other.id).await.unwrap().is_none());
    drop(r);
    // An imported journey with its v1 owner and its import decision still rolls back.
    let down = v1_import::run(
        &store,
        &PlainSecretBox,
        ws,
        &leads,
        Mode::Rollback,
        FIXED_NOW,
    )
    .await
    .unwrap();
    assert_eq!((down.rolled_back, down.kept), (2, 0));
    assert_eq!(count(&db, ws, "journey_assignments").await, 0);
}
