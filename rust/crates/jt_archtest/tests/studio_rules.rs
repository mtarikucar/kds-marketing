//! M3 invariants: runtime bypass attempts plus syntax-tree boundary checks.
#[path = "../../jt_app/tests/support/studio_acceptance.rs"]
mod scenarios;
use jt_app::{
    catalog::{CATALOG, GateMode, Risk, StatusExemption},
    error::ErrorCode,
    gate::{NoStrategyYet, check_gate},
    ports::UnitOfWork,
    usecases::{
        jobs::Job,
        studio::{ads, chain::dispatch_execution, publish, tiktok},
    },
};
use jt_archtest::{direct_deps, rust_sources_in, workspace_dir};
use jt_tenancy::{Permission, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, sync::Arc};
use syn::visit::Visit;

const ACTIONS: &[&str] = &[
    "brake",
    "policy_set",
    "approve",
    "pending",
    "slot_get",
    "slot_cancel",
    "trend_record",
    "hypothesis_propose",
    "file_upload",
    "piece_submit",
    "learned",
    "judgment_record",
    "adsets_list",
    "adset_bind",
    "budget_move",
    "overview",
    "ledger",
    "ledger_export",
    "olays_list",
    "olay_get",
    "olay_create",
    "olay_update",
    "materials_list",
    "material_get",
    "material_add",
    "material_tag",
    "slot_materials",
    "calendar_list",
    "shoot_list",
    "shoot_request",
    "shoot_resolve",
];
/// The materials library and its uploads need no approved strategy (spec 2026-11-03 D35).
const EXEMPT: &[&str] = &[
    "brake",
    "ledger",
    "ledger_export",
    "file_upload",
    "olays_list",
    "olay_get",
    "olay_create",
    "olay_update",
    "materials_list",
    "material_get",
    "material_add",
    "material_tag",
    "slot_materials",
    "calendar_list",
    "shoot_list",
    "shoot_request",
    "shoot_resolve",
    "olay_confirm",
    "material_permission",
    "material_free",
    "material_bind",
    "material_delete",
    "calendar_set",
    "material_policy_set",
];
/// The TikTok posting screen: panel routes without an MCP tool, since only a human passes it
/// (TikTok's Content Sharing Guidelines), and its published post's counters.
/// The materials library's human decisions (D4), releasing a slot's caption findings (§7) among
/// them, are panel routes without a tool too.
const PANEL_ONLY: &[&str] = &[
    "tiktok_posting",
    "tiktok_post",
    "tiktok_metrics",
    "olay_confirm",
    "material_permission",
    "material_free",
    "material_bind",
    "material_delete",
    "calendar_set",
    "material_policy_set",
    "material_check_release",
];
fn set<'a>(values: impl IntoIterator<Item = &'a str>) -> BTreeSet<&'a str> {
    values.into_iter().collect()
}

#[tokio::test]
async fn studio_exact_catalog_and_gate_set() {
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|r| r.id.starts_with("studio."))
        .collect();
    assert_eq!(rows.len(), 42);
    assert_eq!(
        set(rows.iter().map(|r| r.id.strip_prefix("studio.").unwrap())),
        set(ACTIONS.iter().chain(PANEL_ONLY).copied())
    );
    for row in &rows {
        let panel_only = PANEL_ONLY.contains(&row.id.strip_prefix("studio.").unwrap());
        assert_eq!(row.panel_only, panel_only, "{}", row.id);
        assert_eq!(row.mcp_tool.is_none(), panel_only, "{}", row.id);
    }
    assert_eq!(
        set(rows
            .iter()
            .filter(|r| r.gate == GateMode::Exempt)
            .map(|r| r.id.strip_prefix("studio.").unwrap())),
        set(EXEMPT.iter().copied())
    );
    for row in rows {
        assert_eq!(row.status_exemption, StatusExemption::Never);
        for status in [WorkspaceStatus::Suspended, WorkspaceStatus::PendingPayment] {
            assert_eq!(
                check_gate(row, status, &NoStrategyYet, WorkspaceId::new_v7())
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::WorkspaceInactive
            );
        }
        let result = check_gate(
            row,
            WorkspaceStatus::Active,
            &NoStrategyYet,
            WorkspaceId::new_v7(),
        )
        .await;
        if row.gate == GateMode::Exempt {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::StrategyRequired);
        }
    }
    assert_eq!(jt_mcp::registry().len(), 153);
    let tables = jt_archtest::tenant_tables();
    let mut all_tables = BTreeSet::new();
    for (_, sql) in jt_archtest::up_migrations() {
        let lower = sql.to_ascii_lowercase();
        for part in lower.split("create table").skip(1) {
            let part = part
                .trim_start()
                .strip_prefix("if not exists")
                .unwrap_or(part)
                .trim_start();
            let name = part
                .split(|c: char| c.is_whitespace() || c == '(')
                .next()
                .unwrap();
            all_tables.insert(name.to_owned());
        }
    }
    // 67 through M4, the four call tables of 0015_voice_calls, the bridge's event notes of
    // 0016_voice_bridge, the device commands and device files of 0017_device_bridge, the
    // materials library's seven of 0021_studio_materials, and the planned posts, package requests
    // and posting policy of 0022_studio_posts.
    assert_eq!(all_tables.len(), 84);

    // All twenty-four Studio tables are tenant-scoped: fourteen of 0009_studio, seven of
    // 0021_studio_materials, three of 0022_studio_posts.
    assert_eq!(
        set(tables
            .iter()
            .filter(|t| t.starts_with("studio_"))
            .map(String::as_str)),
        set([
            "studio_arms",
            "studio_slots",
            "studio_pieces",
            "studio_files",
            "studio_publications",
            "studio_publish_attempts",
            "studio_measurements",
            "studio_learning_applications",
            "studio_trends",
            "studio_adset_bindings",
            "studio_budget_moves",
            "studio_spend_reservations",
            "studio_control",
            "studio_request_keys",
            "studio_olays",
            "studio_materials",
            "studio_piece_materials",
            "studio_calendar_entries",
            "studio_shoot_requests",
            "studio_material_policy",
            "studio_material_releases",
            "studio_package_requests",
            "studio_posts",
            "studio_posting_policy"
        ])
    );
}

fn syntax(path: &str) -> syn::File {
    syn::parse_file(&fs::read_to_string(workspace_dir().join(path)).unwrap()).unwrap()
}
fn functions(file: &syn::File) -> Vec<&syn::ItemFn> {
    file.items
        .iter()
        .filter_map(|i| {
            if let syn::Item::Fn(f) = i {
                Some(f)
            } else {
                None
            }
        })
        .collect()
}
#[derive(Default)]
struct Calls {
    names: Vec<String>,
}
impl<'ast> Visit<'ast> for Calls {
    fn visit_expr_call(&mut self, e: &'ast syn::ExprCall) {
        if let syn::Expr::Path(p) = e.func.as_ref() {
            self.names
                .push(p.path.segments.last().unwrap().ident.to_string());
        }
        syn::visit::visit_expr_call(self, e);
    }
    fn visit_expr_method_call(&mut self, e: &'ast syn::ExprMethodCall) {
        self.names.push(e.method.to_string());
        syn::visit::visit_expr_method_call(self, e);
    }
}
fn calls(f: &syn::ItemFn) -> Vec<String> {
    let mut c = Calls::default();
    c.visit_block(&f.block);
    c.names
}

#[test]
fn all_studio_rows_have_handler_tool_and_schema_parity() {
    let http = syntax("crates/adapters/jt_panel_http/src/routes/studio.rs");
    let mcp = syntax("crates/adapters/jt_mcp/src/tools/studio.rs");
    let registry = jt_mcp::registry();
    for action in ACTIONS {
        let row = CATALOG
            .iter()
            .find(|r| r.id == format!("studio.{action}"))
            .unwrap();
        assert!(jt_panel_http::ROUTES.contains(&row.panel_route.unwrap()));
        let tool = registry
            .iter()
            .find(|t| Some(t.name) == row.mcp_tool)
            .unwrap();
        let expected = jt_app::usecases::studio::schema::input(action);
        assert_eq!(tool.input_schema.as_value(), &expected);
        assert_eq!(expected["additionalProperties"], false);
        assert_eq!(
            tool.permission,
            if ["brake", "policy_set", "approve", "budget_move"].contains(action) {
                Permission::StudioManage
            } else {
                Permission::StudioWork
            }
        );
        // Parse both real implementations: a route-table entry alone is insufficient.
        // The same application function must be called by each actual handler.
        for file in [&http, &mcp] {
            let handlers = functions(file);
            let handler = handlers.iter().find(|f| f.sig.ident == *action).unwrap();
            assert!(
                calls(handler).iter().any(|n| n == action),
                "missing service dispatch: {action}"
            );
        }
    }
    // The panel's own rows: a route whose handler calls the service, and no tool at all.
    for action in PANEL_ONLY {
        let row = CATALOG
            .iter()
            .find(|r| r.id == format!("studio.{action}"))
            .unwrap();
        assert!(jt_panel_http::ROUTES.contains(&row.panel_route.unwrap()));
        let handlers = functions(&http);
        let handler = handlers.iter().find(|f| f.sig.ident == *action).unwrap();
        assert!(
            calls(handler).iter().any(|n| n == action),
            "missing service dispatch: {action}"
        );
        assert!(functions(&mcp).iter().all(|f| f.sig.ident != *action));
        assert!(registry.iter().all(|t| t.use_case != row.id));
    }
}
fn write_args(w: &scenarios::world::World) -> Vec<(&'static str, Value)> {
    let id = w.f.slot.id;
    let h = w.f.arm.key.hypothesis_id;
    vec![
        (
            "brake",
            json!({"engaged":true,"lane":null,"expected_revision":0}),
        ),
        (
            "policy_set",
            json!({"lane":"organic","requires_human_approval":false,"expected_revision":0}),
        ),
        (
            "approve",
            json!({"target":{"slot":id},"expected_revision":1}),
        ),
        (
            "slot_cancel",
            json!({"slot_id":id,"expected_revision":1,"reason":"test"}),
        ),
        (
            "trend_record",
            json!({"hypothesis_id":h,"channel":"x","summary":"observed","source_url":null,"observed_at":"2026-01-01T00:00:00Z","request_key":"trend"}),
        ),
        (
            "hypothesis_propose",
            json!({"title":"new","segment_key":"all","angle":"help","channel":"x","metric":"reply","prior_confidence":0.5,"cadence":{}}),
        ),
        (
            "file_upload",
            json!({"filename":"a.png","mime":"image/png","request_key":"file","content":{"kind":"bytes_base64","data":"iVBORw0KGgpzbW9rZQ=="}}),
        ),
        (
            "piece_submit",
            json!({"slot_id":id,"expected_revision":1,"request_key":"piece","text":"test","media":[],"adaptations":{},"subject":{"kind":"generic"}}),
        ),
        (
            "judgment_record",
            json!({"hypothesis_id":h,"evidence_ids":[jt_studio::MeasurementId::new_v7()],"text":"observed","request_key":"judgment"}),
        ),
        (
            "adset_bind",
            json!({"hypothesis_id":h,"arm_id":w.f.arm.id,"capability_id":w.f.slot.capability_id,"adset_id":"external","request_key":"bind"}),
        ),
        (
            "budget_move",
            json!({"binding_id":jt_studio::AdSetBindingId::new_v7(),"daily_budget_minor":1,"currency":"TRY","request_key":"budget"}),
        ),
        (
            "olay_create",
            json!({"request_key":"olay","kind":"workshop","title":"Atölye","starts_on":"2026-11-16","ends_on":"2026-11-16"}),
        ),
        (
            "olay_update",
            json!({"olay_id":w.material().olay_id(),"expected_revision":1,"title":"Atölye"}),
        ),
        (
            "material_add",
            json!({"request_key":"material","file_id":w.material().file_id,"origin":{"kind":"real"},"genel":true}),
        ),
        (
            "material_tag",
            json!({"material_id":w.material().id,"expected_revision":1,"doors":[]}),
        ),
        (
            "shoot_request",
            json!({"request_key":"shoot","text":"Ürün fotoğrafı yükle"}),
        ),
        (
            "shoot_resolve",
            json!({"request_id":jt_studio::ShootRequestId::new_v7(),"status":"done"}),
        ),
    ]
}
#[tokio::test]
async fn every_studio_write_reaches_shared_execution_gate() {
    let registry = jt_mcp::registry();
    for inactive in [false, true] {
        let w = scenarios::world::world().await;
        if inactive {
            let mut r = w.uow.platform().await.unwrap();
            r.workspace_set_status(
                w.f.ws,
                WorkspaceStatus::Suspended,
                "test status transition",
                &jt_ledger::Actor::System {
                    component: "test".into(),
                },
            )
            .await
            .unwrap();
            r.commit().await.unwrap();
        } else {
            w.archive().await;
        }
        let before = w.uow.snapshot();
        let args = write_args(&w);
        let actual = set(args.iter().map(|(a, _)| *a));
        let expected = set(registry
            .iter()
            .filter(|t| t.use_case.starts_with("studio.") && t.risk != Risk::Read)
            .map(|t| t.use_case.strip_prefix("studio.").unwrap()));
        assert_eq!(actual, expected, "exercise every write, including new rows");
        for (action, args) in args {
            // An exempt write runs without a strategy: only the status check refuses it.
            if !inactive && EXEMPT.contains(&action) {
                continue;
            }
            let tool = registry
                .iter()
                .find(|t| t.use_case == format!("studio.{action}"))
                .unwrap();
            // Call the dispatcher directly: deliberately bypass the MCP middleware gate.
            let e = (tool.run)(&w.d, &w.ctx, args).await.unwrap_err();
            assert_eq!(
                e.code,
                if inactive {
                    ErrorCode::WorkspaceInactive
                } else {
                    ErrorCode::StrategyRequired
                },
                "{action}: {e:?}"
            );
        }
        // The panel-only write, the TikTok posting screen's publish button, meets the same gate.
        let e = tiktok::tiktok_post(
            &w.d,
            &w.ctx,
            tiktok::TiktokPostInput {
                slot_id: w.f.slot.id,
                expected_revision: 1,
                post: serde_json::from_value(json!({
                    "title": "test",
                    "privacy_level": "SELF_ONLY",
                    "allow_comment": false,
                    "allow_duet": false,
                    "allow_stitch": false,
                    "disclose_commercial": false,
                    "your_brand": false,
                    "branded_content": false,
                }))
                .unwrap(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            e.code,
            if inactive {
                ErrorCode::WorkspaceInactive
            } else {
                ErrorCode::StrategyRequired
            },
            "tiktok_post: {e:?}"
        );
        // So does releasing a slot's caption findings, a human's decision on the slot.
        let e = jt_app::usecases::studio::materials::material_check_release(
            &w.d,
            &w.ctx,
            serde_json::from_value(json!({
                "slot_id": w.f.slot.id, "expected_revision": 1, "digest": "0".repeat(64),
            }))
            .unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            e.code,
            if inactive {
                ErrorCode::WorkspaceInactive
            } else {
                ErrorCode::StrategyRequired
            },
            "material_check_release: {e:?}"
        );
        // The library's panel-only writes, a human's decisions, meet the status check alone.
        if inactive {
            use jt_app::usecases::studio::library;
            let m = w.material();
            let at = |extra: Value| {
                let mut v = json!({"material_id":m.id,"expected_revision":1});
                v.as_object_mut()
                    .unwrap()
                    .extend(extra.as_object().unwrap().clone());
                v
            };
            fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
                serde_json::from_value(v).unwrap()
            }
            let refusals = [
                library::olay_confirm(
                    &w.d,
                    &w.ctx,
                    parse(json!({"olay_id":m.olay_id(),"expected_revision":1})),
                )
                .await
                .map(|_| ()),
                library::material_permission(
                    &w.d,
                    &w.ctx,
                    parse(at(json!({"permission":"shareable"}))),
                )
                .await
                .map(|_| ()),
                library::material_free(&w.d, &w.ctx, parse(at(json!({"free":true}))))
                    .await
                    .map(|_| ()),
                library::material_bind(
                    &w.d,
                    &w.ctx,
                    parse(at(json!({"binding":{"kind":"genel"}}))),
                )
                .await
                .map(|_| ()),
                library::material_delete(&w.d, &w.ctx, parse(at(json!({"confirm":true}))))
                    .await
                    .map(|_| ()),
                library::calendar_set(
                    &w.d,
                    &w.ctx,
                    parse(json!({"key":"yilbasi","year":2026,"name":"Yılbaşı","kind":"season","enabled":false})),
                )
                .await
                .map(|_| ()),
                library::material_policy_set(&w.d, &w.ctx, Default::default())
                    .await
                    .map(|_| ()),
            ];
            for e in refusals {
                assert_eq!(e.unwrap_err().code, ErrorCode::WorkspaceInactive);
            }
        }
        let after = w.uow.snapshot();
        assert_eq!(after.ledger.len(), before.ledger.len());
        assert_eq!(after.studio.slots, before.studio.slots);
        assert!(after.studio.approvals.is_empty());
        assert!(w.ads.calls().is_empty());
    }
}
#[tokio::test]
async fn no_publication_or_budget_move_without_chain() {
    let w = scenarios::world::world().await;
    let (b, m) = w.paid().await;
    for input in [
        w.execution(),
        jt_app::usecases::studio::chain::ExecutionInput {
            chain: m.chain,
            capability_id: b.capability_id,
            target: jt_app::ports::studio::ApprovalTarget::BudgetMove(m.id),
            expected_revision: 1,
        },
    ] {
        for field in 0..4 {
            let mut forged = input.clone();
            match field {
                0 => forged.chain.workspace_id = WorkspaceId::new_v7(),
                1 => forged.chain.born_version_id = jt_strategy::StrategyVersionId::new_v7(),
                2 => forged.chain.hypothesis_id = jt_strategy::HypothesisId::new_v7(),
                _ => forged.chain.arm_id = jt_studio::ArmId::new_v7(),
            }
            assert!(
                dispatch_execution::<(), _, _>(&w.d, forged, |_| async {
                    panic!("forged chain reached provider")
                })
                .await
                .is_err()
            );
        }
    }
}
#[tokio::test]
async fn studio_execution_jobs_enforce_status_strategy_and_brake() {
    for blocked in ["status", "strategy", "brake"] {
        let (w, x) = scenarios::publishing_world().await;
        w.paid().await;
        match blocked {
            "status" => {
                let mut r = w.uow.platform().await.unwrap();
                r.workspace_set_status(
                    w.f.ws,
                    WorkspaceStatus::Suspended,
                    "test status transition",
                    &jt_ledger::Actor::System {
                        component: "test".into(),
                    },
                )
                .await
                .unwrap();
                r.commit().await.unwrap();
            }
            "strategy" => w.archive().await,
            _ => {
                w.brake(true, None, 0).await;
            }
        }
        let before = w.uow.snapshot().studio.slots.len();
        for job in [Job::StudioPlan, Job::StudioPublish, Job::StudioControl] {
            job.run(&w.d, FIXED_NOW).await;
        }
        assert_eq!(scenarios::sends(&x), 0, "{blocked}");
        assert!(
            w.ads.calls().iter().all(|c| !matches!(
                c,
                ConnectorCall::SetDailyBudget { .. }
                    | ConnectorCall::SetAdStatus {
                        status: jt_app::ports::connectors::AdStatus::Active,
                        ..
                    }
            )),
            "{blocked}"
        );
        assert_eq!(w.uow.snapshot().studio.slots.len(), before);
    }
    // Positive control: default policy permits publication, without human consent (K8).
    let (w, x) = scenarios::publishing_world().await;
    x.push_publish(Ok(scenarios::receipt()));
    assert_eq!(Job::StudioPublish.run(&w.d, FIXED_NOW).await.changed, 1);
    assert!(w.uow.snapshot().studio.approvals.is_empty());
}
#[tokio::test]
async fn studio_historical_jobs_use_evidence_authorization() {
    scenarios::historical_jobs().await;
}
#[tokio::test]
async fn studio_cleanup_job_keeps_evidence_after_archive() {
    scenarios::cleanup_after_archive().await;
}

#[test]
fn studio_has_no_ai_media_or_trend_provider() {
    // Positive dependency allowlist: an unknown SDK fails, regardless of its marketing name.
    assert_eq!(
        direct_deps("jt_studio"),
        set([
            "jt_strategy",
            "jt_capability",
            "jt_tenancy",
            "jt_ledger",
            "serde",
            "thiserror",
            "time",
            "uuid",
            "url"
        ])
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    let connector = syntax("crates/jt_app/src/ports/connectors.rs");
    let traits: BTreeSet<_> = connector
        .items
        .iter()
        .filter_map(|i| {
            if let syn::Item::Trait(t) = i {
                Some(t.ident.to_string())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        traits,
        [
            "Connector",
            "Publisher",
            "PlatformAppConfig",
            "SmsSender",
            "MessagingSender",
            "MailSender",
            "MailboxPoller",
            "DeliveryReports",
            "Telephony",
            "ConsentSync",
            "InsightsReader",
            "AdBudgetWriter",
            "LeadGenFetcher",
            "OAuthProvider",
            "ConnectorRegistry"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    for (file, source) in rust_sources_in(&workspace_dir().join("crates/jt_app"))
        .into_iter()
        .filter(|(p, _)| p.to_string_lossy().contains("/usecases/studio/"))
    {
        let ast = syn::parse_file(&source).unwrap();
        for f in functions(&ast) {
            for call in calls(f) {
                assert!(
                    ![
                        "fetch_lead",
                        "commissions",
                        "installations",
                        "generate",
                        "scrape_trends"
                    ]
                    .contains(&call.as_str()),
                    "{}: {call}",
                    file.display()
                );
            }
        }
    }
}
#[test]
fn no_paid_creation_api() {
    let ast = syntax("crates/jt_app/src/ports/connectors.rs");
    let ad = ast
        .items
        .iter()
        .find_map(|i| {
            if let syn::Item::Trait(t) = i {
                (t.ident == "AdBudgetWriter").then_some(t)
            } else {
                None
            }
        })
        .unwrap();
    let methods: BTreeSet<_> = ad
        .items
        .iter()
        .filter_map(|i| {
            if let syn::TraitItem::Fn(f) = i {
                Some(f.sig.ident.to_string())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        methods,
        [
            "list_adsets",
            "set_daily_budget",
            "insights",
            "set_status",
            "account_context",
            "adset_insights",
            "resolve_adset"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    // Product catalog's exhaustive 41-name assertion above precludes creation/commission/setup tools.
}
#[tokio::test]
async fn only_learning_updates_derived_confidence() {
    let mut writers = BTreeSet::new();
    for (file, source) in rust_sources_in(&workspace_dir().join("crates/jt_app"))
        .into_iter()
        .filter(|(p, _)| p.to_string_lossy().contains("/usecases/"))
    {
        let ast = syn::parse_file(&source).unwrap();
        for f in functions(&ast) {
            for call in calls(f) {
                if ["apply_learning", "set_derived_confidence"].contains(&call.as_str()) {
                    writers.insert((
                        file.strip_prefix(workspace_dir()).unwrap().to_path_buf(),
                        f.sig.ident.to_string(),
                        call,
                    ));
                }
            }
        }
    }
    assert_eq!(
        writers,
        BTreeSet::from([(
            "crates/jt_app/src/usecases/studio/measure.rs".into(),
            "record".into(),
            "apply_learning".into()
        )])
    );
    let (mut w, x) = scenarios::publishing_world().await;
    x.push_publish(Ok(scenarios::receipt()));
    publish::publish_due(&w.d, w.f.ws).await.unwrap();
    w.d.clock = Arc::new(jt_testkit::fakes::FixedClock(
        FIXED_NOW + time::Duration::days(1),
    ));
    scenarios::metrics(&x);
    jt_app::usecases::studio::measure::measure_due(&w.d, w.f.ws)
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut h = r.hypotheses().list(w.current).await.unwrap().remove(0);
    assert_eq!(h.derived_confidence, Some(0.4));
    h.derived_confidence = Some(0.99);
    h.prior_confidence = 0.8;
    r.hypotheses().upsert(w.current, h).await.unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let h = r.hypotheses().list(w.current).await.unwrap().remove(0);
    assert_eq!(h.derived_confidence, Some(0.4));
    assert_eq!(h.prior_confidence, 0.8);
}
#[tokio::test]
async fn connector_spend_cannot_bypass_hard_caps() {
    let (w, x) = scenarios::publishing_world().await;
    let (b, _) = w.paid().await;
    let error = ads::budget_move(
        &w.d,
        &w.ctx,
        ads::BudgetMoveInput {
            binding_id: b.id,
            daily_budget_minor: 100001,
            currency: "TRY".into(),
            request_key: "over-cap".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::BudgetCap);
    assert!(
        w.ads
            .calls()
            .iter()
            .all(|c| !matches!(c, ConnectorCall::SetDailyBudget { .. }))
    );
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let mut c = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.policy.spend_cap_minor = Some(0);
    r.capabilities().update(c).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        publish::publish_due(&w.d, w.f.ws)
            .await
            .unwrap_err()
            .details["reason"],
        "unknown_unit_price"
    );
    assert_eq!(scenarios::sends(&x), 0);
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(&w.uow).await;
}

// Supporting structural rule: every production connector write site has an explicitly audited
// owner and a reservation path. Runtime cap/refusal/concurrency tests above check behavior.
fn spend_sites(source: &str) -> BTreeSet<(String, String)> {
    let ast = syn::parse_file(source).unwrap();
    let mut sites = BTreeSet::new();
    for f in functions(&ast) {
        for name in calls(f) {
            if ["publish", "set_daily_budget", "send", "send_text"].contains(&name.as_str()) {
                sites.insert((f.sig.ident.to_string(), name));
            }
        }
    }
    sites
}
#[test]
fn all_connector_write_sites_have_reservation_paths() {
    let mut found = BTreeSet::new();
    for (file, source) in rust_sources_in(&workspace_dir().join("crates/jt_app")) {
        for (owner, operation) in spend_sites(&source) {
            found.insert((
                file.strip_prefix(workspace_dir())
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
                owner,
                operation,
            ));
        }
    }
    let mut status_sites = BTreeSet::new();
    for (file, source) in rust_sources_in(&workspace_dir().join("crates/jt_app"))
        .into_iter()
        .filter(|(p, _)| p.to_string_lossy().contains("/usecases/studio/"))
    {
        let ast = syn::parse_file(&source).unwrap();
        for f in functions(&ast) {
            if calls(f).iter().any(|n| n == "set_status") {
                status_sites.insert((
                    file.file_name().unwrap().to_string_lossy().to_string(),
                    f.sig.ident.to_string(),
                ));
            }
        }
    }
    assert_eq!(
        status_sites,
        BTreeSet::from([("control.rs".into(), "reconcile_one".into())]),
        "ad activation is a spend path; only the reserved resume/safety-pause path may write status"
    );
    let expected = BTreeSet::from([
        (
            "crates/jt_app/src/usecases/studio/publish.rs".into(),
            "publish_due".into(),
            "publish".into(),
        ),
        (
            "crates/jt_app/src/usecases/studio/ads.rs".into(),
            "dispatch_move".into(),
            "set_daily_budget".into(),
        ),
        (
            "crates/jt_app/src/usecases/inbox/replies.rs".into(),
            "send_step".into(),
            "send".into(),
        ),
        (
            "crates/jt_app/src/usecases/inbox/replies.rs".into(),
            "send_step".into(),
            "send_text".into(),
        ),
    ]);
    assert_eq!(
        found, expected,
        "a new connector spend site needs a hard-cap proof"
    );
    for (file, function, required) in [
        ("studio/publish.rs", "publish_due", "reserve_metered"),
        ("studio/ads.rs", "dispatch_move", "reserve_connector_spend"),
        (
            "studio/control.rs",
            "reconcile_one",
            "reserve_connector_spend",
        ),
        ("inbox/replies.rs", "send_step", "claim"),
        ("inbox/replies.rs", "claim", "reserve_metered"),
    ] {
        let ast = syntax(&format!("crates/jt_app/src/usecases/{file}"));
        let funcs = functions(&ast);
        let f = funcs
            .iter()
            .find(|f| f.sig.ident == function)
            .unwrap_or_else(|| panic!("missing {file}::{function}"));
        assert!(
            calls(f).iter().any(|c| c == required),
            "{file}::{function} bypasses {required}"
        );
    }
}
#[test]
fn structural_spend_rule_detects_injected_helpers_and_ignores_comments() {
    assert!(
        spend_sites("// fn fake() { x.publish(); }\nfn safe() { let s = \"x.publish()\"; }")
            .is_empty()
    );
    let injected = spend_sites(
        "async fn helper(c: &Connector) { c.publish().await; c.set_daily_budget().await; }",
    );
    assert_eq!(
        injected,
        BTreeSet::from([
            ("helper".into(), "publish".into()),
            ("helper".into(), "set_daily_budget".into())
        ])
    );
}
