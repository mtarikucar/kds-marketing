//! The knowledge base on PostgreSQL (`0046_knowledge_base`): the repository contract, forced RLS
//! for an ordinary role, the append-only history, the tables' own checks, two seedings at once,
//! the migration's guarded down, and the rollback script that strips newer wake reasons.

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::production_projects::{
    ContentPackage, PackageVersion, ProductionProject, VersionCancel,
};
use jt_app::ports::wake::{AgentWakeRow, PendingWake, WakeAttempt, WakeOutcome, WakeReason};
use jt_app::ports::{ApiKeyRow, ApiKeyStatus};
use jt_app::usecases::knowledge::seed;
use jt_knowledge::{Cause, KnowledgeCardId, KnowledgeRevisionId, Revision, Subject};
use jt_ledger::Actor;
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_strategy::{Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{AgentConnectionId, ApiKeyId, Permission, SystemRole, UserId, WorkspaceId};
use jt_testkit::{TestDb, fakes::FIXED_NOW};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const TABLES: [&str; 5] = [
    "knowledge_settings",
    "knowledge_cards",
    "knowledge_revisions",
    "knowledge_notes",
    "knowledge_proposals",
];

const UP: &str = include_str!("../../../../migrations/0046_knowledge_base.up.sql");
const DOWN: &str = include_str!("../../../../migrations/0046_knowledge_base.down.sql");
const STRIP: &str = include_str!("../../../../scripts/rollback/strip_new_wake_reasons.sql");

async fn table_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_tables where schemaname = 'public' and tablename <> '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn index_exists(pool: &PgPool, name: &str) -> bool {
    sqlx::query_scalar("select exists(select 1 from pg_indexes where indexname = $1)")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn owner(ws: WorkspaceId, user: UserId) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    }
}

#[tokio::test]
async fn the_postgres_knowledge_base_keeps_the_repository_contract() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("kb-a").await;
    let (b, _) = db.seed_workspace("kb-b").await;
    jt_testkit::knowledge_contract::exercise(&PgUnitOfWork::new(db.pool.clone()), a, b).await;
}

#[tokio::test]
async fn every_knowledge_table_forces_rls_for_an_ordinary_role() {
    let db = TestDb::new().await;
    let (a, user) = db.seed_workspace("kb-rls-a").await;
    let (b, _) = db.seed_workspace("kb-rls-b").await;
    for table in TABLES {
        let forced: bool = sqlx::query_scalar(
            "select relrowsecurity and relforcerowsecurity from pg_class where relname = $1",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(forced, "{table}");
    }
    jt_pg::recovery::check_rls(&db.pool).await.unwrap();
    let deps = jt_testkit::fakes::deps(Arc::new(PgUnitOfWork::new(db.pool.clone())));
    assert!(seed::ensure(&deps, &owner(a, user)).await.unwrap());
    // Another workspace's transaction sees none of it, even without a filter of its own.
    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    for table in TABLES {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is scoped");
    }
    // ... and cannot write into it.
    let refused = sqlx::query(
        "insert into knowledge_notes (workspace_id, id, text, status, revision, created_at, \
         created_by_user) values ($1, $2, 'x', 'open', 1, now(), $3)",
    )
    .bind(a.as_uuid())
    .bind(Uuid::now_v7())
    .bind(user.as_uuid())
    .execute(tx.conn())
    .await;
    assert!(
        refused.is_err(),
        "the policy's with check refuses another workspace's row"
    );
}

#[tokio::test]
async fn the_history_is_append_only_and_keeps_its_rules() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-history").await;
    let deps = jt_testkit::fakes::deps(Arc::new(PgUnitOfWork::new(db.pool.clone())));
    seed::ensure(&deps, &owner(ws, user)).await.unwrap();
    for statement in [
        "update knowledge_revisions set cause = 'owner' where workspace_id = $1",
        "delete from knowledge_revisions where workspace_id = $1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let e = sqlx::query(statement)
            .bind(ws.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(e.to_string().contains("append-only"), "{e}");
    }
    let uow = PgUnitOfWork::new(db.pool.clone());
    let card = {
        let mut r = uow.tenant(ws).await.unwrap();
        r.knowledge().cards().await.unwrap().remove(0)
    };
    // A rules revision names no card; a card's names one.
    for (subject, card_id) in [(Subject::Rules, Some(card.id)), (Subject::Card, None)] {
        let mut r = uow.tenant(ws).await.unwrap();
        let e = r
            .knowledge()
            .append_revision(&Revision {
                id: KnowledgeRevisionId::new_v7(),
                subject,
                card_id,
                revision: 9,
                kb_revision: 9,
                content: json!({}),
                cause: Cause::System,
                source_id: None,
                at: FIXED_NOW,
                by: Actor::System {
                    component: "test".into(),
                },
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal, "{subject:?}");
    }
    // A key is a seed card's: lowercase ASCII.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let e = sqlx::query(
        "insert into knowledge_cards (workspace_id, id, key, title, position, revision, \
         created_at, created_by_component, updated_at, updated_by_component) \
         values ($1, $2, 'Bad-Key', 't', 0, 1, now(), 'test', now(), 'test')",
    )
    .bind(ws.as_uuid())
    .bind(KnowledgeCardId::new_v7().as_uuid())
    .execute(tx.conn())
    .await;
    assert!(e.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_seedings_at_once_make_one_knowledge_base() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-race").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut t = uow.tenant(ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id: StrategyVersionId::new_v7(),
            workspace_id: ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(user),
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let deps = Arc::new(jt_testkit::fakes::deps(Arc::new(uow.clone())));
    let ctx = owner(ws, user);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let (deps, ctx) = (deps.clone(), ctx.clone());
        tasks.push(tokio::spawn(async move {
            seed::ensure(&deps, &ctx).await.unwrap()
        }));
    }
    let mut seeded = 0;
    for task in tasks {
        if task.await.unwrap() {
            seeded += 1;
        }
    }
    assert_eq!(seeded, 1, "exactly one seeds");
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.knowledge().cards().await.unwrap().len(), 8);
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "select count(*) from ledger_entries where workspace_id = $1 \
         and action = 'strategy.knowledge_seeded'",
    )
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .unwrap();
    assert_eq!(n, 1);
}

/// An area with one version cancelled, with or without the planned post it had.
fn cancelled_area(ws: WorkspaceId, slot: Option<jt_studio::SlotId>) -> ProductionProject {
    let mut p = ProductionProject {
        id: Uuid::now_v7(),
        workspace_id: ws,
        title: "Yılbaşı".into(),
        brief: "Yılbaşı paylaşımı".into(),
        revision: 1,
        archived: false,
        sources: vec![],
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        olay_id: None,
        steps: vec![],
        start_at: None,
        opened_by: Default::default(),
        requested_by: None,
        hints: Default::default(),
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    };
    p.packages.push(ContentPackage {
        revision: 1,
        delivered_at: FIXED_NOW,
        by: AgentConnectionId::new_v7(),
        summary: "Hazır".into(),
        versions: vec![PackageVersion {
            id: Uuid::now_v7(),
            format: jt_studio::PostFormat::FeedPost,
            capability_id: None,
            text: "Yılbaşı".into(),
            title: None,
            tags: vec![],
            link: None,
            material_ids: vec![],
            hypothesis_id: jt_strategy::HypothesisId::new_v7(),
            content_type: None,
            slot_id: slot,
            cancelled: Some(VersionCancel {
                by: UserId::new_v7(),
                at: FIXED_NOW,
                reason: "Sahibi iptal etti".into(),
                slot_id: slot,
            }),
        }],
        released: None,
        steps: vec![],
    });
    p
}

#[tokio::test]
async fn the_down_refuses_a_cancel_without_a_planned_post_and_round_trips() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("kb-down").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let all = table_count(&db.pool).await;
    let slotless = cancelled_area(ws, None);
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(slotless.clone(), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    // The areas table forces RLS: the guard sees the row through `app.platform`.
    let e = sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap_err();
    assert!(e.to_string().contains("down refused"), "{e}");
    assert_eq!(table_count(&db.pool).await, all, "nothing dropped");
    // A cancel that names its planned post reads in every binary: the down goes through.
    let mut r = uow.tenant(ws).await.unwrap();
    let mut fixed = cancelled_area(ws, Some(jt_studio::SlotId::new_v7()));
    fixed.id = slotless.id;
    fixed.revision = 2;
    r.studio_projects()
        .save_project(fixed, Some(1))
        .await
        .unwrap();
    r.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, all - 5);
        assert!(!index_exists(&db.pool, "studio_production_projects_live").await);
    }
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, all);
        assert!(index_exists(&db.pool, "studio_production_projects_live").await);
    }
    jt_pg::recovery::check_rls(&db.pool).await.unwrap();
}

fn key(ws: WorkspaceId, by: UserId) -> ApiKeyRow {
    ApiKeyRow {
        id: ApiKeyId::new_v7(),
        workspace_id: ws,
        name: "agent".into(),
        prefix: "jt_live_abcd".into(),
        key_hash: format!("hash-{}", Uuid::now_v7()),
        scopes: std::collections::BTreeSet::from([Permission::WorkspaceRead]),
        issued_by: by,
        status: ApiKeyStatus::Active,
        created_at: FIXED_NOW,
        last_used_at: None,
        revoked_at: None,
    }
}

#[tokio::test]
async fn the_rollback_script_strips_newer_wake_reasons_and_is_repeatable() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-wakes").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (mixed, only_new, known) = (key(ws, user), key(ws, user), key(ws, user));
    let mut t = uow.tenant(ws).await.unwrap();
    for k in [&mixed, &only_new, &known] {
        t.api_keys().insert(k.clone()).await.unwrap();
        let mut row = AgentWakeRow::new(k.id);
        row.pending = Some(PendingWake {
            first_at: FIXED_NOW,
            last_at: FIXED_NOW,
            reasons: vec![WakeReason::ContentRevision],
            caused_by: vec![user],
            manual: false,
            failures: 0,
            first_failure_at: None,
            retry_at: None,
        });
        row.last = Some(WakeAttempt {
            at: FIXED_NOW,
            reasons: vec![WakeReason::Manual],
            outcome: WakeOutcome::Fired,
            status: Some(200),
            session_id: None,
            session_url: None,
        });
        t.agent_connections().wake_save(row).await.unwrap();
    }
    t.commit().await.unwrap();
    // What a later release writes: codes this binary does not know.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    for (k, pending, last) in [
        (
            &mixed,
            json!(["knowledge_changed", "content_revision", "posting_resumed"]),
            json!(["account_connected", "manual"]),
        ),
        (
            &only_new,
            json!(["knowledge_note"]),
            json!(["knowledge_applied"]),
        ),
    ] {
        sqlx::query(
            "update agent_wakes set data = jsonb_set(jsonb_set(data, '{pending,reasons}', $3), \
             '{last,reasons}', $4) where workspace_id = $1 and api_key_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(k.id.as_uuid())
        .bind(pending)
        .bind(last)
        .execute(tx.conn())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    // This binary already reads them, dropping the unknown codes.
    let mut t = uow.tenant(ws).await.unwrap();
    let rows = t.agent_connections().wakes().await.unwrap();
    let of = |id: ApiKeyId| rows.iter().find(|r| r.api_key_id == id).unwrap().clone();
    assert_eq!(
        of(mixed.id).pending.unwrap().reasons,
        vec![WakeReason::ContentRevision]
    );
    assert!(of(only_new.id).pending.unwrap().reasons.is_empty());
    drop(t);

    for _ in 0..2 {
        sqlx::raw_sql(STRIP).execute(&db.pool).await.unwrap();
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let stored: Vec<(Uuid, serde_json::Value, Option<time::OffsetDateTime>)> = sqlx::query_as(
            "select api_key_id, data, due_at from agent_wakes where workspace_id = $1",
        )
        .bind(ws.as_uuid())
        .fetch_all(tx.conn())
        .await
        .unwrap();
        let row = |id: ApiKeyId| {
            stored
                .iter()
                .find(|(k, _, _)| *k == id.as_uuid())
                .unwrap()
                .clone()
        };
        let (_, data, _) = row(mixed.id);
        assert_eq!(data["pending"]["reasons"], json!(["content_revision"]));
        assert_eq!(data["last"]["reasons"], json!(["manual"]));
        let (_, data, due) = row(only_new.id);
        assert_eq!(
            data["pending"],
            serde_json::Value::Null,
            "no reason left: no wake"
        );
        assert_eq!(due, None);
        assert_eq!(data["last"]["reasons"], json!([]));
        let (_, data, _) = row(known.id);
        assert_eq!(data["pending"]["reasons"], json!(["content_revision"]));
        assert_eq!(data["last"]["reasons"], json!(["manual"]));
    }
    // Every row still reads.
    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(t.agent_connections().wakes().await.unwrap().len(), 3);
}
