//! Inbox migration constraints, backfills and tenant isolation against real PostgreSQL.

use jt_pg::{PlatformTx, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use uuid::Uuid;

const UP: &str = include_str!("../../../../migrations/0006_inbox.up.sql");
const DOWN: &str = include_str!("../../../../migrations/0006_inbox.down.sql");
const COMPLIANCE_UP: &str = include_str!("../../../../migrations/0008_inbox_compliance.up.sql");
const COMPLIANCE_DOWN: &str = include_str!("../../../../migrations/0008_inbox_compliance.down.sql");
const TABLES: &[&str] = &[
    "people",
    "identities",
    "conversations",
    "messages",
    "journeys",
    "journey_events",
    "tasks",
    "notes",
    "merges",
    "lost_reasons",
    "event_consumption",
    "outbox",
    "request_keys",
];

async fn person(db: &TestDb, ws: WorkspaceId) -> Uuid {
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into people (id, workspace_id, first_touch, created_at, updated_at) values ($1, $2, '{\"source\":\"import\"}', now(), now())")
        .bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    id
}

async fn journey(db: &TestDb, ws: WorkspaceId, person: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into journeys (id, workspace_id, person_id, opened_at, source, updated_at) values ($1, $2, $3, now(), '\"import\"', now())")
        .bind(id).bind(ws.as_uuid()).bind(person).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    id
}

#[tokio::test]
async fn identity_unique_among_active_rows() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("identity").await;
    let p = person(&db, ws).await;
    let insert = "insert into identities (id, workspace_id, person_id, channel, value_normalized, active, first_seen_at) values ($1, $2, $3, 'phone', '+905550000000', $4, now())";
    // Inactive tombstones do not block a live key; only two active copies conflict.
    for active in [false, false, true] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        sqlx::query(insert)
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(p)
            .bind(active)
            .execute(tx.conn())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(p)
        .bind(true)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn one_open_journey_per_person_index() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("journey").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query("insert into journeys (id, workspace_id, person_id, opened_at, source, updated_at) values ($1, $2, $3, now(), '\"repeat\"', now())")
        .bind(Uuid::now_v7()).bind(ws.as_uuid()).bind(p).execute(tx.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "update journeys set closed_at = now(), status = 'won' where workspace_id = $1 and id = $2",
    )
    .bind(ws.as_uuid())
    .bind(j)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(journey(&db, ws, p).await, j);
}

#[tokio::test]
async fn journey_events_append_only() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("events").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let insert = "insert into journey_events (id, workspace_id, journey_id, source, idempotency_key, payload, at, from_status, to_status) values ($1, $2, $3, '\"system\"', 'key', '\"message_received\"', now(), 'new', 'new')";
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(j)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for sql in [
        "update journey_events set payload = '{}'",
        "delete from journey_events",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let err = sqlx::query(sql).execute(tx.conn()).await.unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(j)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn inbox_force_rls_and_composite_foreign_keys() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let p = person(&db, a).await;
    for table in TABLES {
        let flags: (bool, bool) = sqlx::query_as(
            "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(flags, (true, true), "{table}");
        let count: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table} visible without scope");
    }
    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    let count: i64 = sqlx::query_scalar("select count(*) from people")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
    // Platform scope bypasses RLS, so only the composite FK can reject this reference.
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query("insert into identities (id, workspace_id, person_id, channel, value_normalized, first_seen_at) values ($1,$2,$3,'phone','+905550000000',now())")
        .bind(Uuid::now_v7()).bind(b.as_uuid()).bind(p).execute(tx.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn schema_down_drops_lost_reasons() {
    let db = TestDb::new().await;
    sqlx::raw_sql(COMPLIANCE_DOWN)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (ws, _) = db.seed_workspace("existing").await;
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let keys: Vec<String> =
        sqlx::query_scalar("select key from lost_reasons where active and seeded order by key")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    assert_eq!(
        keys,
        ["diger", "fiyat", "ilgisiz", "rakip", "ulasilamadi", "zaman"]
    );
    sqlx::query("update lost_reasons set label = 'Edited', active = false where key = 'fiyat'")
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let row: (String, bool) =
        sqlx::query_as("select label, active from lost_reasons where key = 'fiyat'")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(row, ("Edited".into(), false));
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(COMPLIANCE_DOWN)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    }
    let exists: bool = sqlx::query_scalar("select to_regclass('lost_reasons') is not null")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn role_backfill_is_idempotent_reversible_and_preserves_custom_grants() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("roles").await;
    sqlx::raw_sql(COMPLIANCE_DOWN)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into roles (id, workspace_id, key, name, permissions, is_system) values ($1,$2,'custom','Custom',array['inbox.work','inbox.manage'],false)")
        .bind(Uuid::now_v7()).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let roles: Vec<(String, Vec<String>)> =
        sqlx::query_as("select key, permissions from roles order by key")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    for (key, permissions) in roles {
        assert_eq!(
            permissions.iter().filter(|p| *p == "inbox.work").count(),
            1,
            "{key}"
        );
        assert_eq!(
            permissions.iter().filter(|p| *p == "inbox.manage").count(),
            usize::from(key != "rep"),
            "{key}"
        );
    }
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(COMPLIANCE_DOWN)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let roles: Vec<(bool, Vec<String>)> =
        sqlx::query_as("select is_system, permissions from roles")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    for (system, permissions) in roles {
        assert_eq!(permissions.contains(&"inbox.work".into()), !system);
        assert_eq!(permissions.contains(&"inbox.manage".into()), !system);
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn call_lookup_index_round_trip_is_idempotent() {
    let db = TestDb::new().await;
    let exists = "select to_regclass('inbound_events_call_lookup') is not null";
    assert!(
        sqlx::query_scalar::<_, bool>(exists)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    );
    for _ in 0..2 {
        sqlx::raw_sql(COMPLIANCE_DOWN)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
        assert!(
            !sqlx::query_scalar::<_, bool>(exists)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
    }
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
        assert!(
            sqlx::query_scalar::<_, bool>(exists)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
    }
}

#[tokio::test]
async fn compliance_tenant_tables_force_rls() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("compliance-rls").await;
    let (other, _) = db.seed_workspace("compliance-other").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let cap = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into capabilities(id,workspace_id,kind_key,name,reach,status,created_at,updated_at) values($1,$2,'mailbox','Mailbox','connector','declared',now(),now())")
        .bind(cap).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    for insert in [
        "insert into consents(id,workspace_id,person_id,channel,kind,source,at) select id,w,p,'email','explicit','form',now() from ctx",
        "insert into suppressions(workspace_id,person_id,channel,reason) select w,p,'email','manual' from ctx",
        "insert into quotes(id,workspace_id,journey_id,amount_minor,currency,valid_until,channel,state,created_at) select id,w,j,100,'TRY',now(),'email','sent',now() from ctx",
        "insert into appointments(id,workspace_id,journey_id,starts_at,ends_at,location,state,created_at) select id,w,j,now(),now()+interval '1 hour','','booked',now() from ctx",
        "insert into commissions(id,workspace_id,journey_id,amount_minor,currency,rate_bp,state,created_at) select id,w,j,100,'TRY',100,'no_payee',now() from ctx",
        "insert into erasure_log(workspace_id,person_id,requested_via,at) select w,p,'test',now() from ctx",
        "insert into erased_identities(workspace_id,channel,value_hash) select w,'email',repeat('a',64) from ctx",
        "insert into outbound_jobs(id,workspace_id,capability_id,state,created_at,updated_at) select id,w,c,'unknown',now(),now() from ctx",
        "insert into mail_cursors(workspace_id,capability_id,mailbox,uidvalidity,last_uid) select w,c,'INBOX',1,0 from ctx",
        "insert into commission_default(workspace_id,rate_bp) select w,100 from ctx",
        "insert into commission_user_rates(workspace_id,user_id,rate_bp) select w,u,200 from ctx",
        "insert into journey_attribution(workspace_id,journey_id,provider,leadgen_id,acquired_at) select w,j,'meta','lead-1',now() from ctx",
    ] {
        let sql = format!(
            "with ctx as (select $1::uuid w,$2::uuid p,$3::uuid j,$4::uuid c,$5::uuid u,$6::uuid id) {insert}"
        );
        sqlx::query(&sql)
            .bind(ws.as_uuid())
            .bind(p)
            .bind(j)
            .bind(cap)
            .bind(user.as_uuid())
            .bind(Uuid::now_v7())
            .execute(tx.conn())
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    for table in [
        "consents",
        "suppressions",
        "quotes",
        "appointments",
        "commissions",
        "erasure_log",
        "erased_identities",
        "outbound_jobs",
        "mail_cursors",
        "commission_default",
        "commission_user_rates",
        "journey_attribution",
    ] {
        let flags: Option<(bool, bool)> = sqlx::query_as(
            "select relrowsecurity, relforcerowsecurity from pg_class where relname=$1 and relnamespace='public'::regnamespace")
            .bind(table).fetch_optional(&db.pool).await.unwrap();
        assert_eq!(
            flags,
            Some((true, true)),
            "{table} must exist and force tenant isolation"
        );
        let count_sql = format!("select count(*) from {table}");
        let unscoped: i64 = sqlx::query_scalar(&count_sql)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(unscoped, 0, "{table} exposed without tenant scope");
        for (scope, expected) in [(ws, 1_i64), (other, 0_i64)] {
            let mut tx = TenantTx::begin(&db.pool, scope).await.unwrap();
            let count: i64 = sqlx::query_scalar(&count_sql)
                .fetch_one(tx.conn())
                .await
                .unwrap();
            assert_eq!(count, expected, "{table} tenant isolation");
            tx.rollback().await.unwrap();
        }
    }
}

#[tokio::test]
async fn mail_provider_check_restored_without_mail_rows() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("mail-check").await;
    for _ in 0..2 {
        sqlx::raw_sql(COMPLIANCE_DOWN)
            .execute(&db.pool)
            .await
            .unwrap();
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let err = sqlx::query("insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at) values($1,$2,'mail','mail-1','message','{}',now())")
            .bind(Uuid::now_v7()).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        tx.rollback().await.unwrap();
    }
    sqlx::raw_sql(COMPLIANCE_UP)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at) values($1,$2,'mail','mail-1','message','{}',now())")
        .bind(Uuid::now_v7()).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn mail_provider_check_retained_with_mail_rows_down_idempotent() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("mail-retained").await;
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(r#"insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,raw,received_at) values($1,$2,'mail','mail-1','message','{"keep":"runtime"}',decode('1234','hex'),now())"#)
        .bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(COMPLIANCE_DOWN)
            .execute(&db.pool)
            .await
            .unwrap();
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let row: (String, serde_json::Value, Vec<u8>) =
            sqlx::query_as("select provider,payload,raw from inbound_events where id=$1")
                .bind(id)
                .fetch_one(tx.conn())
                .await
                .unwrap();
        assert_eq!(
            row,
            (
                "mail".into(),
                serde_json::json!({"keep":"runtime"}),
                vec![0x12, 0x34]
            )
        );
        sqlx::query("insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at) values($1,$2,'mail',$3,'message','{}',now())")
            .bind(Uuid::now_v7()).bind(ws.as_uuid()).bind(Uuid::now_v7().to_string()).execute(tx.conn()).await.unwrap();
        tx.commit().await.unwrap();
    }
    sqlx::raw_sql(COMPLIANCE_UP)
        .execute(&db.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn commission_unique_per_journey_and_composite_tenant_references() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("commission-a").await;
    let (b, _) = db.seed_workspace("commission-b").await;
    let p = person(&db, a).await;
    let j = journey(&db, a, p).await;
    let insert = "insert into commissions(id,workspace_id,journey_id,amount_minor,currency,rate_bp,state,created_at) values($1,$2,$3,123,'TRY',100,'no_payee',now())";
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(a.as_uuid())
        .bind(j)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for (ws, code) in [(a, "23505"), (b, "23503")] {
        let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
        let err = sqlx::query(insert)
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(j)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some(code)
        );
        tx.rollback().await.unwrap();
    }
    for sql in [
        "insert into consents(id,workspace_id,person_id,channel,kind,source,at) values($1,$2,$3,'email','explicit','form',now())",
        "insert into quotes(id,workspace_id,journey_id,amount_minor,currency,valid_until,channel,state,created_at) values($1,$2,$3,100,'TRY',now(),'email','sent',now())",
        "insert into appointments(id,workspace_id,journey_id,starts_at,ends_at,location,state,created_at) values($1,$2,$3,now(),now()+interval '1 hour','','booked',now())",
    ] {
        let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
        let reference = if sql.contains("consents") { p } else { j };
        let err = sqlx::query(sql)
            .bind(Uuid::now_v7())
            .bind(b.as_uuid())
            .bind(reference)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
        tx.rollback().await.unwrap();
    }
}

async fn erasure_scope(tx: &mut TenantTx<'_>, person: Uuid) {
    sqlx::query("select set_config('jeeta.erasure','on',true), set_config('jeeta.erasure_person_id',$1,true)")
        .bind(person.to_string()).execute(tx.conn()).await.unwrap();
}

#[tokio::test]
async fn erasure_flag_is_transaction_local_and_person_scoped() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("erasure-guards").await;
    let p = person(&db, ws).await;
    let other = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let other_j = journey(&db, ws, other).await;
    let cap = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into capabilities(id,workspace_id,kind_key,name,reach,status,created_at,updated_at) values($1,$2,'mailbox','Mailbox','connector','declared',now(),now())")
        .bind(cap).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    for (person_id, journey_id) in [(p, j), (other, other_j)] {
        sqlx::query("insert into journey_events(id,workspace_id,journey_id,source,idempotency_key,payload,reason_label,at,from_status,to_status) values($1,$2,$3,'\"system\"',$4,$5,'Personal label',now(),'new','won')")
            .bind(person_id).bind(ws.as_uuid()).bind(journey_id).bind(person_id.to_string())
            .bind(serde_json::json!({"won":{"product":"Personal product", "amount_minor":1234,"currency":"TRY"}}))
            .execute(tx.conn()).await.unwrap();
        sqlx::query("insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,raw,received_at) values($1,$2,'mail',$3,'message',$4,decode('1234','hex'),now())")
            .bind(person_id).bind(ws.as_uuid()).bind(person_id.to_string())
            .bind(serde_json::json!({"person_id":person_id,"text":"Personal text"}))
            .execute(tx.conn()).await.unwrap();
        sqlx::query("insert into probe_runs(id,workspace_id,capability_id,at,ok,latency_ms,facts) values($1,$2,$3,now(),true,1,$4)")
            .bind(person_id).bind(ws.as_uuid()).bind(cap)
            .bind(serde_json::json!({"person_id":person_id,"text":"Personal text"}))
            .execute(tx.conn()).await.unwrap();
    }
    sqlx::query("insert into journey_attribution(workspace_id,journey_id,provider,leadgen_id,acquired_at) values($1,$2,'meta','lead-1',now())")
        .bind(ws.as_uuid()).bind(j).execute(tx.conn()).await.unwrap();
    sqlx::query("insert into ledger_entries(workspace_id,at,actor_kind,actor_component,action,payload) values($1,now(),'system','test','created',$2)")
        .bind(ws.as_uuid()).bind(serde_json::json!({"person_id":p,"amount_minor":1234,"text":"Stored ledger"}))
        .execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let scrub = [
        "update journey_events set payload=jsonb_set(payload,'{won,product}','\"\"'),reason_label=null where id=$1",
        "update inbound_events set payload=payload-'text',raw=null where id=$1",
        "update probe_runs set facts=facts-'text' where id=$1",
    ];
    // Neither ordinary writes nor the flag without a logged erasure can unlock history.
    for setting in [false, true] {
        for sql in scrub {
            let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
            if setting {
                erasure_scope(&mut tx, p).await;
            }
            let err = sqlx::query(sql)
                .bind(p)
                .execute(tx.conn())
                .await
                .unwrap_err();
            assert!(err.to_string().contains("append-only"), "{err}");
            tx.rollback().await.unwrap();
        }
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into erasure_log(workspace_id,person_id,requested_via,at) values($1,$2,'test',now())")
        .bind(ws.as_uuid()).bind(p).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for sql in scrub {
        // A logged target still cannot erase another person's rows.
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, p).await;
        let err = sqlx::query(sql)
            .bind(other)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
        // The authorized target's personal fields can be scrubbed.
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, p).await;
        assert_eq!(
            sqlx::query(sql)
                .bind(p)
                .execute(tx.conn())
                .await
                .unwrap()
                .rows_affected(),
            1
        );
        tx.commit().await.unwrap();
    }
    // Identity, financial payload, metadata and original scope are never editable.
    for sql in [
        "delete from journey_events where id=$1",
        "delete from inbound_events where id=$1",
        "update journey_events set journey_id=id where id=$1",
        "update journey_events set payload=jsonb_set(payload,'{won,amount_minor}','0') where id=$1",
        "update journey_events set source='{}' where id=$1",
        "update inbound_events set payload='{}',raw=null where id=$1",
        "update inbound_events set external_id='replacement' where id=$1",
        "update probe_runs set facts='{}' where id=$1",
        "update probe_runs set ok=false where id=$1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, p).await;
        let err = sqlx::query(sql)
            .bind(p)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("append-only") || err.to_string().contains("never deleted"),
            "{err}"
        );
        tx.rollback().await.unwrap();
    }
    // No erasure mode permits ledger mutation or loss/replacement of acquisition provenance.
    for sql in [
        "update ledger_entries set payload='{}'",
        "delete from ledger_entries",
        "update journey_attribution set leadgen_id='changed'",
        "delete from journey_attribution",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, p).await;
        let err = sqlx::query(sql).execute(tx.conn()).await.unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let flag: bool =
        sqlx::query_scalar("select coalesce(current_setting('jeeta.erasure',true)='on',false)")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert!(!flag);
    let rows: Vec<(Uuid, serde_json::Value, Option<Vec<u8>>)> =
        sqlx::query_as("select id,payload,raw from inbound_events order by id")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    for (id, payload, raw) in rows {
        assert_eq!(payload["person_id"], id.to_string());
        if id == p {
            assert!(raw.is_none());
            assert!(payload.get("text").is_none());
        } else {
            assert_eq!(raw, Some(vec![0x12, 0x34]));
            assert_eq!(payload["text"], "Personal text");
        }
    }
    let payload: serde_json::Value =
        sqlx::query_scalar("select payload from journey_events where id=$1")
            .bind(p)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"won":{"product":"","amount_minor":1234,"currency":"TRY"}})
    );
    let ledger: serde_json::Value = sqlx::query_scalar("select payload from ledger_entries")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(
        ledger,
        serde_json::json!({"person_id":p,"amount_minor":1234,"text":"Stored ledger"})
    );
    tx.commit().await.unwrap();
    // Even the explicitly logged target is locked again after transaction end.
    for sql in scrub {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        // Use a distinct update: no-op inbound updates were allowed before this migration.
        let sql = if sql.contains("inbound_events") {
            "update inbound_events set payload=payload || '{\"text\":\"again\"}' where id=$1"
        } else {
            sql
        };
        let err = sqlx::query(sql)
            .bind(p)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    // A fresh personal probe is removable only for the selected, logged person.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    erasure_scope(&mut tx, p).await;
    assert_eq!(
        sqlx::query("delete from probe_runs where id=$1")
            .bind(p)
            .execute(tx.conn())
            .await
            .unwrap()
            .rows_affected(),
        1
    );
    tx.commit().await.unwrap();
    // Downgrade restores unconditional event protection, even if settings remain available.
    sqlx::raw_sql(COMPLIANCE_DOWN)
        .execute(&db.pool)
        .await
        .unwrap();
    for sql in [scrub[0], scrub[1], scrub[2]] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, other).await;
        let err = sqlx::query(sql)
            .bind(other)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
}

#[tokio::test]
async fn erasure_scrubs_scalar_event_label_preserving_kind() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("erase-unit-event").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into journey_events(id,workspace_id,journey_id,source,idempotency_key,payload,reason_label,at,from_status,to_status) values($1,$2,$3,'\"system\"','unit','\"replied\"','Personal label',now(),'new','contacted')")
        .bind(id).bind(ws.as_uuid()).bind(j).execute(tx.conn()).await.unwrap();
    sqlx::query("insert into erasure_log(workspace_id,person_id,requested_via,at) values($1,$2,'test',now())")
        .bind(ws.as_uuid()).bind(p).execute(tx.conn()).await.unwrap();
    erasure_scope(&mut tx, p).await;
    sqlx::query("update journey_events set reason_label=null where id=$1")
        .bind(id)
        .execute(tx.conn())
        .await
        .unwrap();
    let row: (serde_json::Value, Option<String>) =
        sqlx::query_as("select payload,reason_label from journey_events where id=$1")
            .bind(id)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(row, (serde_json::json!("replied"), None));
    let err = sqlx::query("update journey_events set payload='\"quote_sent\"' where id=$1")
        .bind(id)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");
}

#[tokio::test]
async fn inbound_erasure_preserves_call_correlation_and_state() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("erase-call-correlation").await;
    let p = person(&db, ws).await;
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,raw,received_at) values($1,$2,'netgsm','call-event','call_event',$3,decode('1234','hex'),now())")
        .bind(id).bind(ws.as_uuid()).bind(serde_json::json!({"person_id":p,"unique_id":"call-42","status":"answered","text":"Personal text","phone":"905000000000"}))
        .execute(tx.conn()).await.unwrap();
    sqlx::query("insert into erasure_log(workspace_id,person_id,requested_via,at) values($1,$2,'test',now())")
        .bind(ws.as_uuid()).bind(p).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for sql in [
        "update inbound_events set raw=null,payload=jsonb_set(payload,'{unique_id}','\"replacement\"') where id=$1",
        "update inbound_events set raw=null,payload=payload-'unique_id' where id=$1",
        "update inbound_events set raw=null,payload=jsonb_set(payload,'{status}','\"failed\"') where id=$1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        erasure_scope(&mut tx, p).await;
        let err = sqlx::query(sql)
            .bind(id)
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    erasure_scope(&mut tx, p).await;
    sqlx::query("update inbound_events set raw=null,payload=payload-'text'-'phone' where id=$1")
        .bind(id)
        .execute(tx.conn())
        .await
        .unwrap();
    let row: (String, serde_json::Value, Option<Vec<u8>>) =
        sqlx::query_as("select call_unique_id,payload,raw from inbound_events where id=$1")
            .bind(id)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(
        row,
        (
            "call-42".into(),
            serde_json::json!({"person_id":p,"unique_id":"call-42","status":"answered"}),
            None
        )
    );
}
