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
const WRITE_BACK: &str = include_str!("../../../../scripts/rollback/write_back_post_approval.sql");

async fn table_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_tables where schemaname = 'public' and tablename <> '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn function_exists(pool: &PgPool, name: &str) -> bool {
    sqlx::query_scalar("select exists(select 1 from pg_proc where proname = $1)")
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
        pending_files: vec![],
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
        assert!(!function_exists(&db.pool, "knowledge_revisions_immutable").await);
    }
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, all);
        assert!(function_exists(&db.pool, "knowledge_revisions_immutable").await);
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
    // What schema 46 and a later release write: the six reasons of the knowledge base, and a
    // code this binary does not know.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    for (k, pending, last) in [
        (
            &mixed,
            json!([
                "knowledge_changed",
                "content_revision",
                "posting_resumed",
                "from_a_later_release"
            ]),
            json!(["account_connected", "manual", "from_a_later_release"]),
        ),
        (
            &only_new,
            json!(["knowledge_note", "content_delivered"]),
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
    // This binary reads them: the reasons it knows, the unknown code dropped.
    let mut t = uow.tenant(ws).await.unwrap();
    let rows = t.agent_connections().wakes().await.unwrap();
    let of = |id: ApiKeyId| rows.iter().find(|r| r.api_key_id == id).unwrap().clone();
    assert_eq!(
        of(mixed.id).pending.unwrap().reasons,
        vec![
            WakeReason::KnowledgeChanged,
            WakeReason::ContentRevision,
            WakeReason::PostingResumed
        ]
    );
    assert_eq!(
        of(mixed.id).last.unwrap().reasons,
        vec![WakeReason::AccountConnected, WakeReason::Manual]
    );
    assert_eq!(
        of(only_new.id).pending.unwrap().reasons,
        vec![WakeReason::KnowledgeNote, WakeReason::ContentDelivered]
    );
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

/// Account `kind` of workspace `ws`, stored with its flag off (and retired when `retired`).
async fn social_account(
    uow: &PgUnitOfWork,
    ws: WorkspaceId,
    kind: &str,
    retired: bool,
) -> jt_capability::CapabilityId {
    let mut c = jt_capability::Capability::new(
        jt_capability::CapabilityId::new_v7(),
        ws,
        jt_capability::NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} hesabı"),
            ..jt_capability::NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    if retired {
        c.status = jt_capability::StoredStatus::Retired;
    }
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

async fn stored_flag(uow: &PgUnitOfWork, ws: WorkspaceId, id: jt_capability::CapabilityId) -> bool {
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities()
        .find(id)
        .await
        .unwrap()
        .unwrap()
        .policy
        .requires_human_approval
}

/// Design §7.6: before going back to PR 1's binaries, which read only the stored flag for posts,
/// `write_back_post_approval.sql` writes post approval back onto it: every live social account
/// of a workspace whose switch is on, each listed one of a workspace whose switch is off; one
/// `capability.set_policy {reason: "rollback"}` per account changed; never a flag lowered, never
/// a workspace not seeded, never another kind; and a second run changes nothing.
#[tokio::test]
async fn the_rollback_script_writes_post_approval_back_onto_the_stored_flags_once() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let deps = jt_testkit::fakes::deps(Arc::new(uow.clone()));
    let (listed_ws, a_user) = db.seed_workspace("kb-rollback-list").await;
    let (switch_ws, b_user) = db.seed_workspace("kb-rollback-switch").await;
    let (unseeded_ws, _) = db.seed_workspace("kb-rollback-unseeded").await;
    let listed = social_account(&uow, listed_ws, "instagram", false).await;
    let unlisted = social_account(&uow, listed_ws, "x", false).await;
    let covered = social_account(&uow, switch_ws, "instagram", false).await;
    let tiktok = social_account(&uow, switch_ws, "tiktok", false).await;
    let retired = social_account(&uow, switch_ws, "x", true).await;
    let sms = social_account(&uow, switch_ws, "sms_line", false).await;
    let elsewhere = social_account(&uow, unseeded_ws, "x", false).await;
    for (ws, user) in [(listed_ws, a_user), (switch_ws, b_user)] {
        seed::ensure(&deps, &owner(ws, user)).await.unwrap();
    }
    let mut t = uow.tenant(listed_ws).await.unwrap();
    let mut k = t.knowledge().lock_settings().await.unwrap().unwrap();
    k.post_approval_accounts = vec![listed.as_uuid()];
    t.knowledge().save_settings(&k).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(switch_ws).await.unwrap();
    let mut k = t.knowledge().lock_settings().await.unwrap().unwrap();
    k.post_approval = true;
    t.knowledge().save_settings(&k).await.unwrap();
    t.commit().await.unwrap();

    for _ in 0..2 {
        sqlx::raw_sql(WRITE_BACK).execute(&db.pool).await.unwrap();
        for (ws, id, flagged) in [
            (listed_ws, listed, true),
            (listed_ws, unlisted, false),
            (switch_ws, covered, true),
            (switch_ws, tiktok, true),
            (switch_ws, retired, false),
            (switch_ws, sms, false),
            (unseeded_ws, elsewhere, false),
        ] {
            assert_eq!(stored_flag(&uow, ws, id).await, flagged, "{id:?}");
        }
        for (ws, expected) in [
            (listed_ws, vec![listed]),
            (switch_ws, vec![covered, tiktok]),
            (unseeded_ws, vec![]),
        ] {
            let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
            let rows: Vec<(String, serde_json::Value, String)> = sqlx::query_as(
                "select subject_id, payload, actor_component from ledger_entries                  where workspace_id = $1 and action = 'capability.set_policy' order by id",
            )
            .bind(ws.as_uuid())
            .fetch_all(tx.conn())
            .await
            .unwrap();
            let mut ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
            ids.sort();
            let mut want: Vec<String> = expected.iter().map(|c| c.as_uuid().to_string()).collect();
            want.sort();
            assert_eq!(
                ids, want,
                "one entry per account changed, by the first run only"
            );
            for (_, payload, component) in &rows {
                assert_eq!(payload["reason"], "rollback");
                assert_eq!(payload["policy"]["requires_human_approval"], true);
                assert_eq!(component, "rollback");
            }
        }
    }
}

/// Design §7.6: before going back to PR 3's binaries, which refuse a real material's share with no
/// person on it, `clear_rule_shares.sql` clears every share the person-upload rule gave: the
/// share and its column, the revision raised once, one `studio.material.permission_set {reason:
/// "rollback"}` per material; a person's share is left as it is, and a second run changes nothing.
#[tokio::test]
async fn the_rollback_script_clears_the_shares_the_upload_rule_gave_once() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("kb-rollback-rule-shares").await;
    let by_rule = jt_testkit::studio_contract::seed_material(&uow, ws).await;
    let by_person = jt_testkit::studio_contract::seed_material(&uow, ws).await;
    let mut t = uow.tenant(ws).await.unwrap();
    let mut m = by_rule.clone();
    m.share = Some(jt_studio::ShareDecision {
        permission: jt_studio::SharePermission::Shareable,
        by: None,
        at: FIXED_NOW,
        rule: Some(jt_studio::PERSON_UPLOAD_RULE.into()),
    });
    m.revision += 1;
    t.studio_materials()
        .update_material(m, by_rule.revision)
        .await
        .unwrap();
    t.commit().await.unwrap();

    const CLEAR: &str = include_str!("../../../../scripts/rollback/clear_rule_shares.sql");
    for _ in 0..2 {
        sqlx::raw_sql(CLEAR).execute(&db.pool).await.unwrap();
        let mut t = uow.tenant(ws).await.unwrap();
        let cleared = t
            .studio_materials()
            .get_material(by_rule.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cleared.share, None);
        assert_eq!(cleared.revision, by_rule.revision + 2, "raised once");
        let kept = t
            .studio_materials()
            .get_material(by_person.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept, by_person);
        drop(t);
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let column: Option<String> = sqlx::query_scalar(
            "select share from studio_materials where workspace_id=$1 and id=$2",
        )
        .bind(ws.as_uuid())
        .bind(by_rule.id.0)
        .fetch_one(tx.conn())
        .await
        .unwrap();
        let rows: Vec<(String, serde_json::Value, String)> = sqlx::query_as(
            "select subject_id, payload, actor_component from ledger_entries              where workspace_id = $1 and action = 'studio.material.permission_set' order by id",
        )
        .bind(ws.as_uuid())
        .fetch_all(tx.conn())
        .await
        .unwrap();
        assert_eq!(column, None);
        assert_eq!(rows.len(), 1, "one entry, by the first run only");
        assert_eq!(rows[0].0, by_rule.id.0.to_string());
        assert_eq!(rows[0].1["reason"], "rollback");
        assert_eq!(rows[0].1["share"], serde_json::Value::Null);
        assert_eq!(rows[0].2, "rollback");
    }
}

/// The sample strategy of a fictional business (`jt_knowledge/tests/fixtures`), version 5 of
/// workspace `ws`, approved by `user`, straight to the repos.
async fn approved_sample(uow: &PgUnitOfWork, ws: WorkspaceId, user: UserId) -> StrategyVersionId {
    approved_sample_with(uow, ws, user, |_| {}).await
}

/// [`approved_sample`] with its hypotheses as `edit` leaves them.
async fn approved_sample_with(
    uow: &PgUnitOfWork,
    ws: WorkspaceId,
    user: UserId,
    edit: impl FnOnce(&mut Vec<jt_strategy::Hypothesis>),
) -> StrategyVersionId {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../domain/jt_knowledge/tests/fixtures/strategy-sample.json"
    ))
    .unwrap();
    let sections: Sections = serde_json::from_value(fixture["sections"].clone()).unwrap();
    let mut hypotheses: Vec<jt_strategy::Hypothesis> =
        serde_json::from_value(fixture["hypotheses"].clone()).unwrap();
    edit(&mut hypotheses);
    let id = StrategyVersionId::new_v7();
    let mut t = uow.tenant(ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: ws,
            number: 5,
            status: VersionStatus::Approved,
            sections,
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(user),
            archived_at: None,
        })
        .await
        .unwrap();
    t.hypotheses().replace_all(id, hypotheses).await.unwrap();
    t.commit().await.unwrap();
    id
}

fn settle_ctx(ws: WorkspaceId) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: "scheduler:knowledge_settle".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: FIXED_NOW,
        agent_connection_id: None,
    }
}

/// `(id, status, version)` of every research task of `ws`.
async fn research_tasks(pool: &PgPool, ws: WorkspaceId) -> Vec<(Uuid, String, Uuid)> {
    let mut tx = TenantTx::begin(pool, ws).await.unwrap();
    sqlx::query_as(
        "select id, status, strategy_version_id from research_tasks where workspace_id = $1 \
         order by id",
    )
    .bind(ws.as_uuid())
    .fetch_all(tx.conn())
    .await
    .unwrap()
}

#[tokio::test]
async fn the_first_settle_normalises_the_frame_on_postgres_and_carries_its_research_tasks() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-normalise").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let v5 = approved_sample(&uow, ws, user).await;
    let deps = jt_testkit::fakes::deps(Arc::new(uow.clone()));
    let ctx = settle_ctx(ws);
    let planned = jt_app::usecases::research::plan(&deps, &ctx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(planned.created, 7);
    let before = research_tasks(&db.pool, ws).await;

    let out = jt_app::usecases::knowledge::settle::settle(&deps, &ctx)
        .await
        .unwrap();
    assert!(out.seeded);
    let applied = out.applied.unwrap();
    assert!(applied.applied);
    assert_eq!(applied.number, 6);
    let mut t = uow.tenant(ws).await.unwrap();
    let v6 = t.strategy().current_approved().await.unwrap().unwrap();
    assert_eq!(v6.number, 6);
    assert_eq!(v6.sections.channels.len(), 1);
    assert_eq!(v6.sections.channels[0].channel, "any");
    assert!(v6.sections.cadence.channel_mix.is_empty());
    let topics = t.hypotheses().list(v6.id).await.unwrap();
    assert_eq!(topics.len(), 7);
    assert!(
        topics
            .iter()
            .all(|h| h.channel == "any" && h.state.is_live())
    );
    assert_eq!(
        t.strategy().find(v5).await.unwrap().unwrap().status,
        VersionStatus::Archived
    );
    drop(t);
    let after = research_tasks(&db.pool, ws).await;
    assert_eq!(
        after.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(),
        before.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(),
        "the same task ids"
    );
    for (_, status, version) in &after {
        assert_eq!(status, "open");
        assert_eq!(*version, v6.id.as_uuid());
    }
    // A second tick writes nothing.
    let again = jt_app::usecases::knowledge::settle::settle(&deps, &ctx)
        .await
        .unwrap();
    assert!(!again.changed());
    let mut t = uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.strategy().current_approved().await.unwrap().unwrap().id,
        v6.id
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_hourly_planner_waits_for_a_frame_apply_on_postgres_and_supersedes_nothing() {
    use jt_app::usecases::knowledge::frame::{self, Request, Waking};
    use jt_knowledge::frame::{FrameCause, FrameParts};
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-plan-race").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    approved_sample(&uow, ws, user).await;
    let deps = Arc::new(jt_testkit::fakes::deps(Arc::new(uow.clone())));
    let ctx = settle_ctx(ws);
    jt_app::usecases::research::plan(&deps, &ctx)
        .await
        .unwrap()
        .unwrap();
    seed::ensure(&deps, &ctx).await.unwrap();
    let before = research_tasks(&db.pool, ws).await;

    // The normalisation holds the frame lock, having carried the tasks, while the planner runs.
    let mut r = uow.tenant(ws).await.unwrap();
    let applied = frame::apply(
        &deps,
        &ctx,
        r.as_mut(),
        Request {
            cause: FrameCause::Normalize,
            next: &FrameParts::default(),
            approver: None,
            waking: Waking::Nobody,
        },
    )
    .await
    .unwrap();
    assert!(applied.applied);
    let planner = {
        let (deps, ctx) = (deps.clone(), ctx.clone());
        tokio::spawn(async move { jt_app::usecases::research::plan(&deps, &ctx).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !planner.is_finished(),
        "the planner waits on the frame lock"
    );
    r.commit().await.unwrap();
    let planned = planner.await.unwrap().unwrap().unwrap();
    assert_eq!(
        (planned.superseded, planned.created, planned.carried),
        (0, 0, 0)
    );
    let after = research_tasks(&db.pool, ws).await;
    let v6 = applied.version_id.unwrap().as_uuid();
    assert_eq!(after.len(), before.len());
    for (_, status, version) in &after {
        assert_eq!((status.as_str(), *version), ("open", v6));
    }
}

/// Every way a bundle may end in the no-deadlock test: done, or refused for a reason of its own
/// (a revision moved, a cap reached); never `INTERNAL`, which is what a deadlock or a
/// serialisation failure becomes.
fn settled<T>(what: &str, r: Result<T, jt_app::error::AppError>) {
    if let Err(e) = r {
        assert_ne!(e.code, ErrorCode::Internal, "{what}: {e:?}");
    }
}

/// Design 2026-11-19 §4.10.13 (D35): the Kurallar save of the ad budget (draft, frame, settings,
/// control, general item), the spend paths on the same general item (`reserve_metered_for` and
/// `studio::ads::recheck_periods`, whose `refresh_period` rolls an ad set's reservation over to
/// every new frame: frame, capability, control, items), Bütçe's own writes (the item, then the
/// settings read without a lock) and a rules mirror of the paid-message limit that writes a
/// version each time (draft, frame, settings, control) run at once, many times: none deadlocks
/// (no bundle ends `INTERNAL`), and nothing brakes the paid lane.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn rules_saves_spends_budget_edits_and_frame_applies_never_deadlock_on_postgres() {
    use jt_app::usecases::budget::{self, UpdateBudgetItem};
    use jt_app::usecases::knowledge::rules::{self, RulesInput};
    use jt_capability::{Capability, CapabilityId, NewCapability};
    use jt_knowledge::CapInput;

    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("kb-deadlock").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    // The sample's first topic also runs on ads, on every channel.
    let v5 = approved_sample_with(&uow, ws, user, |h| {
        h[0].channel = "any".into();
        h[0].cadence.insert(
            jt_strategy::LaneKind::Paid,
            jt_strategy::HypothesisCadence {
                slots_per_week: 7,
                exploration_bps: 0,
                content_types: vec![jt_strategy::ContentTypeShare {
                    key: "general".into(),
                    min_bps: 0,
                    max_bps: 10_000,
                }],
            },
        );
    })
    .await;
    let deps = Arc::new(jt_testkit::fakes::deps(Arc::new(uow.clone())));
    let ctx = owner(ws, user);
    seed::ensure(&deps, &ctx).await.unwrap();
    // The general ad budget the seed made (at 0: there was none) is opened in Bütçe and gets a
    // unit price, and an SMS line is metered on it.
    let general = budget::list_items(&deps, &ctx)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.item.general)
        .expect("the seed made the general ad budget")
        .item
        .id;
    budget::update_item(
        &deps,
        &ctx,
        general,
        UpdateBudgetItem {
            cap: Some(2_500),
            unit_cost_minor: Some(Some(1)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let sms = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "SMS".into(),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(sms.clone(), None).await.unwrap();
    t.budget().link(sms.id, general).await.unwrap();
    t.commit().await.unwrap();
    // Every module installed: a lane whose module is not stops (`StudioControl::removed`).
    jt_testkit::studio_contract::install_all_modules(&uow, ws).await;
    let binding = ad_set_on(&deps, &uow, ws, v5, general).await;

    let mut tasks = Vec::new();
    for worker in 0..3_i64 {
        // The owner saves the ad budget, up and down.
        let (d, c, u) = (deps.clone(), ctx.clone(), uow.clone());
        tasks.push(tokio::spawn(async move {
            for round in 0..4_i64 {
                let s = {
                    let mut r = u.tenant(ws).await.unwrap();
                    r.knowledge().settings().await.unwrap().unwrap()
                };
                let input = RulesInput {
                    expected_revision: s.rules_revision,
                    prohibitions: s.prohibitions.clone(),
                    ad_budget: Some(CapInput {
                        amount_minor: 3_000 + 100 * worker + round,
                        period: None,
                    }),
                    message_budget: s.message_cap.as_ref().map(|m| CapInput {
                        amount_minor: m.amount_minor,
                        period: Some(m.period),
                    }),
                    post_approval: s.post_approval,
                    post_approval_accounts: None,
                    auto_reply: None,
                };
                settled("rules_save", rules::rules_save(&d, &c, input).await);
            }
        }));
        // A metered send reserves on the general item.
        let (u, cap) = (uow.clone(), sms.clone());
        tasks.push(tokio::spawn(async move {
            for round in 0..4_i64 {
                let mut r = u.tenant(ws).await.unwrap();
                let out = jt_app::usecases::studio::budget::reserve_metered_for(
                    r.as_mut(),
                    &cap,
                    None,
                    Some(1),
                    format!("send-{worker}-{round}"),
                    FIXED_NOW,
                    Some("inbox"),
                )
                .await;
                if out.is_ok() {
                    settled("reserve commit", r.commit().await);
                } else {
                    settled("reserve_metered_for", out);
                }
            }
        }));
        // Bütçe lowers the general item.
        let (d, c) = (deps.clone(), ctx.clone());
        tasks.push(tokio::spawn(async move {
            for round in 0..4_i64 {
                settled(
                    "update_item",
                    budget::update_item(
                        &d,
                        &c,
                        general,
                        UpdateBudgetItem {
                            cap: Some(2_000 + 10 * worker + round),
                            ..Default::default()
                        },
                    )
                    .await,
                );
            }
        }));
        // A rules mirror of a moved paid-message limit: a new version each time, so the
        // transition hook takes the studio control under contention.
        let (d, u) = (deps.clone(), uow.clone());
        tasks.push(tokio::spawn(async move {
            let ctx = settle_ctx(ws);
            for round in 0..4_i64 {
                let mut r = u.tenant(ws).await.unwrap();
                let out = message_mirror(&d, &ctx, r.as_mut(), 10 * worker + round + 1).await;
                if out.is_ok() {
                    settled("frame apply commit", r.commit().await);
                } else {
                    settled("frame apply", out);
                }
            }
        }));
        // The ad set's reservation is rolled over to every new frame.
        let d = deps.clone();
        tasks.push(tokio::spawn(async move {
            for _ in 0..4 {
                settled(
                    "recheck_periods",
                    jt_app::usecases::studio::ads::recheck_periods(&d, ws).await,
                );
            }
        }));
    }
    for task in tasks {
        tokio::time::timeout(std::time::Duration::from_secs(120), task)
            .await
            .expect("no bundle waits forever")
            .expect("no task panicked");
    }
    // The three numbers agree at the end: the general item at or below the cap of the rules,
    // and the paid lane mirrored from it.
    let mut r = uow.tenant(ws).await.unwrap();
    let s = r.knowledge().settings().await.unwrap().unwrap();
    let cap = s.ad_cap.expect("an ad budget").amount_minor;
    let item = r.budget().find_item(general).await.unwrap().unwrap();
    assert!(item.cap <= cap, "{} > {cap}", item.cap);
    let frame = r.strategy().current_approved().await.unwrap().unwrap();
    let lane = frame
        .sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == jt_strategy::LaneKind::Paid)
        .map(|l| l.cap_minor);
    assert_eq!(lane, Some(cap));
    // The ad set followed the frames without a refusal: nothing braked the paid lane, and its
    // reservation is the frame's.
    let control = r.studio_control().lock_control().await.unwrap();
    assert!(
        !control.is_braked(jt_strategy::LaneKind::Paid),
        "a refresh was refused: {control:?}"
    );
    drop(r);
    jt_app::usecases::studio::ads::recheck_periods(&deps, ws)
        .await
        .unwrap();
    let mut r = uow.tenant(ws).await.unwrap();
    let rows = r.studio_budget().list_reservations().await.unwrap();
    let frame = r.strategy().current_approved().await.unwrap().unwrap();
    assert!(
        rows.iter()
            .any(|(row, _)| row.request.binding_id == Some(binding)
                && row.request.executed_version_id == frame.id),
        "the ad set is reserved under the frame in force"
    );
    assert!(
        !r.studio_control()
            .lock_control()
            .await
            .unwrap()
            .is_braked(jt_strategy::LaneKind::Paid)
    );
}

/// A rules mirror after the paid-message limit moved to `amount_minor`, in `r`'s bundle, as
/// `rules_save` writes it: the draft, the frame and the settings locked, the settings saved, the
/// frame applied (cause `rules`).
async fn message_mirror(
    deps: &jt_app::usecases::Deps,
    ctx: &Ctx,
    r: &mut dyn jt_app::ports::TenantRepos,
    amount_minor: i64,
) -> Result<jt_app::usecases::knowledge::frame::Applied, jt_app::error::AppError> {
    use jt_app::usecases::knowledge::frame::{self, Request, Waking};
    use jt_knowledge::frame::{FrameCause, FrameParts};
    r.strategy().lock_draft().await?;
    r.strategy().lock_execution_frame().await?;
    let mut s = r
        .knowledge()
        .lock_settings()
        .await?
        .expect("the knowledge base is seeded");
    if let Some(cap) = s.message_cap.as_mut() {
        cap.amount_minor = amount_minor;
    }
    r.knowledge().save_settings(&s).await?;
    frame::apply(
        deps,
        ctx,
        r,
        Request {
            cause: FrameCause::Rules,
            next: &FrameParts::default(),
            approver: None,
            waking: Waking::Nobody,
        },
    )
    .await
}

/// An ad set bound on a verified ad account whose spend the general item `general` bounds, for
/// the first topic of version `born` (its paid cadence), with one reservation of its daily
/// budget under the frame in force: what `studio::ads::recheck_periods` rolls over.
async fn ad_set_on(
    deps: &jt_app::usecases::Deps,
    uow: &PgUnitOfWork,
    ws: WorkspaceId,
    born: StrategyVersionId,
    general: jt_capability::BudgetItemId,
) -> jt_studio::AdSetBindingId {
    use jt_studio::{AdSetBinding, AdSetBindingId, Arm, ArmId, ArmKey, Chain, ReserveSpend};
    let mut t = uow.tenant(ws).await.unwrap();
    let topic = t.hypotheses().list(born).await.unwrap()[0].id;
    let mut c = jt_capability::Capability::new(
        jt_capability::CapabilityId::new_v7(),
        ws,
        jt_capability::NewCapability {
            kind_key: "meta_ads".into(),
            name: "Reklam hesabı".into(),
            external_id: Some("act_1".into()),
            connector_public: json!({"access":{"scopes":["ads_read","ads_management"]}}),
            ..jt_capability::NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = jt_capability::StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    let cred = jt_connector::Credential::OAuth {
        access_token: "test".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["ads_read".into(), "ads_management".into()],
    };
    let sealed = deps
        .seal
        .seal(ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    t.capabilities()
        .insert(c.clone(), Some(sealed))
        .await
        .unwrap();
    t.budget().link(c.id, general).await.unwrap();
    let arm = Arm::new(
        ArmId::new_v7(),
        ws,
        ArmKey {
            hypothesis_id: topic,
            content_type: "general".into(),
            channel: "meta_ads".into(),
            lane: jt_strategy::LaneKind::Paid,
        },
    )
    .unwrap();
    t.studio().insert_arm(arm.clone()).await.unwrap();
    let chain = Chain {
        workspace_id: ws,
        born_version_id: born,
        hypothesis_id: topic,
        arm_id: arm.id,
    };
    let b = AdSetBinding {
        id: AdSetBindingId::new_v7(),
        chain: chain.clone(),
        capability_id: c.id,
        account_id: "act_1".into(),
        adset_id: "set_1".into(),
        campaign_id: Some("campaign".into()),
        verified_at: Some(FIXED_NOW),
        verification_evidence: None,
    };
    t.studio().bind_adset(b.clone(), "binding").await.unwrap();
    let frame = t.strategy().current_approved().await.unwrap().unwrap();
    // The daily budget's liability to the end of the paid lane's (monthly) period.
    let (_, until) = jt_capability::period_window(jt_capability::Period::Monthly, FIXED_NOW);
    let liability =
        jt_studio::daily_liability(1, jt_capability::Period::Monthly, FIXED_NOW, until).unwrap();
    let saved = jt_app::usecases::studio::budget::reserve_connector_spend(
        t.as_mut(),
        ReserveSpend {
            binding_id: Some(b.id),
            chain: Some(chain),
            replaces: None,
            workspace_id: ws,
            capability_id: c.id,
            budget_item_ids: vec![general],
            lane: jt_strategy::LaneKind::Paid,
            executed_version_id: frame.id,
            amount_minor: liability,
            daily_budget_minor: Some(1),
            currency: "TRY".into(),
            evidence_key: format!("budget.move:{}", b.id),
            at: FIXED_NOW,
            module: None,
            campaign_id: None,
        },
    )
    .await
    .unwrap();
    t.studio_budget()
        .settle(
            saved.id,
            jt_studio::SpendOutcome::Applied {
                evidence_key: saved.request.evidence_key.clone(),
            },
        )
        .await
        .unwrap();
    t.commit().await.unwrap();
    b.id
}
