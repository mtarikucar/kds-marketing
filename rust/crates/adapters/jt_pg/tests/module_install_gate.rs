//! Whether a module is installed, answered from `workspace_modules` (design
//! 2026-11-10-uc-modul-ve-panel-iskeleti-design.md S25).
use jt_app::gate::StrategyGate;
use jt_pg::{PgStrategyGate, TenantTx};
use jt_testkit::TestDb;
use serde_json::json;

const STUDIO_MODULES: [&str; 4] = ["content", "social", "ads", "materials"];

async fn set_registry(db: &TestDb, ws: jt_tenancy::WorkspaceId, data: serde_json::Value) {
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into workspace_modules (workspace_id, data) values ($1, $2) \
         on conflict (workspace_id) do update set data = excluded.data",
    )
    .bind(ws.as_uuid())
    .bind(data)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

fn entry(id: &str, installed: bool) -> serde_json::Value {
    json!({
        "blueprint": {"id": id, "name": id, "description": "", "version": "1.0",
                      "requirements": [], "workflow": [], "builtin": true},
        "installed": installed, "required": false,
        "config": {"brief": "", "agent_ids": [], "capability_ids": []}, "revision": 2
    })
}

#[tokio::test]
async fn a_module_is_installed_by_the_registry_of_its_own_workspace() {
    let db = TestDb::new().await;
    let gate = PgStrategyGate::new(db.pool.clone());
    let (a, _) = db.seed_new_workspace("install-a").await;
    let (b, _) = db.seed_new_workspace("install-b").await;

    // No registry row: the strategy and nothing else.
    assert!(gate.module_installed(a, "strategy").await.unwrap());
    for module in STUDIO_MODULES {
        assert!(!gate.module_installed(a, module).await.unwrap(), "{module}");
    }

    // A registry from before the split: every builtin module, in that workspace only.
    set_registry(&db, a, json!({"legacy": true, "modules": []})).await;
    for module in STUDIO_MODULES {
        assert!(gate.module_installed(a, module).await.unwrap(), "{module}");
        assert!(!gate.module_installed(b, module).await.unwrap(), "{module}");
    }

    // A removed module is not installed; the library stays while another module needs it.
    set_registry(
        &db,
        a,
        json!({"legacy": true, "modules": [entry("ads", false), entry("materials", false)]}),
    )
    .await;
    assert!(!gate.module_installed(a, "ads").await.unwrap());
    assert!(gate.module_installed(a, "social").await.unwrap());
    assert!(gate.module_installed(a, "materials").await.unwrap());

    // Installed one by one in a workspace that started with the strategy only.
    set_registry(
        &db,
        b,
        json!({"legacy": false, "modules": [entry("content", true)]}),
    )
    .await;
    assert!(gate.module_installed(b, "content").await.unwrap());
    assert!(gate.module_installed(b, "materials").await.unwrap());
    assert!(!gate.module_installed(b, "social").await.unwrap());
    assert!(!gate.module_installed(b, "ads").await.unwrap());
}
