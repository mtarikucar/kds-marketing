//! Ratified M3 baseline plus the explicit M4 amendment, independent of the live catalog.
use std::collections::{BTreeMap, BTreeSet};

use jt_app::catalog::{CATALOG, StatusExemption};
use jt_archtest::workspace_dir;
use serde_json::{Value, json};
use syn::visit::Visit;

const ADDED: [&str; 11] = [
    "billing.status",
    "billing.report_payment",
    "billing.activate",
    "platform.payments.list",
    "platform.billing.confirm",
    "platform.billing.reissue",
    "platform.billing.revoke_activation",
    "platform.workspaces.suspend",
    "platform.workspaces.resume",
    "ops.health",
    "platform.operators.reset_password",
];

/// Rows added after the M4 amendment, each with its MCP tool (cleanup-and-voice plan; the
/// device bridge's agent tools, D1-T6; the comment and marketplace question rows, F7; the prospect
/// pool, leads L1-T6; the playbook and the research tasks, leads L2; promotion, distribution and
/// the recipient kind, leads L3; the materials library's twins; olay-driven publishing's; the
/// pool's report, leads L4-T6).
const POST_M4_ADDED: [(&str, &str); 64] = [
    ("connector.set_pbx_policy", "jeeta.connector.set_pbx_policy"),
    ("calls.policy_get", "jeeta.calls.policy_get"),
    ("calls.policy_set", "jeeta.calls.policy_set"),
    ("calls.place", "jeeta.calls.place"),
    ("calls.get", "jeeta.calls.get"),
    ("calls.list", "jeeta.calls.list"),
    ("calls.end", "jeeta.calls.end"),
    ("calls.listen", "jeeta.calls.listen"),
    ("calls.say", "jeeta.calls.say"),
    ("calls.transfer", "jeeta.calls.transfer"),
    ("devices.list", "jeeta.devices.list"),
    ("devices.observe", "jeeta.devices.observe"),
    ("devices.act", "jeeta.devices.act"),
    ("devices.command_get", "jeeta.devices.command_get"),
    ("devices.commands", "jeeta.devices.commands"),
    ("prospects.playbook", "jeeta.prospects.playbook"),
    ("prospects.check", "jeeta.prospects.check"),
    ("prospects.create", "jeeta.prospects.create"),
    ("prospects.update", "jeeta.prospects.update"),
    ("prospects.list", "jeeta.prospects.list"),
    ("prospects.get", "jeeta.prospects.get"),
    ("prospects.score", "jeeta.prospects.score"),
    ("prospects.decide", "jeeta.prospects.decide"),
    ("prospects.do_not_contact", "jeeta.prospects.do_not_contact"),
    ("prospects.dnc_lift", "jeeta.prospects.dnc_lift"),
    ("prospects.erase", "jeeta.prospects.erase"),
    ("prospects.settings_get", "jeeta.prospects.settings_get"),
    ("prospects.settings_set", "jeeta.prospects.settings_set"),
    ("research.tasks_list", "jeeta.research.tasks_list"),
    ("research.tasks_get", "jeeta.research.tasks_get"),
    ("research.tasks_create", "jeeta.research.tasks_create"),
    ("research.tasks_claim", "jeeta.research.tasks_claim"),
    ("research.tasks_close", "jeeta.research.tasks_close"),
    ("prospects.promote", "jeeta.prospects.promote"),
    ("distribution.get", "jeeta.distribution.get"),
    ("distribution.rules_set", "jeeta.distribution.rules_set"),
    ("distribution.rep_set", "jeeta.distribution.rep_set"),
    (
        "distribution.assignments_list",
        "jeeta.distribution.assignments_list",
    ),
    ("distribution.backfill", "jeeta.distribution.backfill"),
    ("inbox.people.set_kind", "jeeta.inbox.people_set_kind"),
    ("inbox.public.hide", "jeeta.inbox.public_hide"),
    ("inbox.public.delete", "jeeta.inbox.public_delete"),
    (
        "inbox.public.mark_handled",
        "jeeta.inbox.public_mark_handled",
    ),
    ("inbox.public.report", "jeeta.inbox.public_report"),
    ("inbox.public.approve", "jeeta.inbox.public_approve"),
    ("inbox.public.discard", "jeeta.inbox.public_discard"),
    // The Growth Studio materials library (spec 2026-11-03 §5.2).
    ("studio.olays_list", "jeeta.studio.olays_list"),
    ("studio.olay_get", "jeeta.studio.olay_get"),
    ("studio.olay_create", "jeeta.studio.olay_create"),
    ("studio.olay_update", "jeeta.studio.olay_update"),
    ("studio.materials_list", "jeeta.studio.materials_list"),
    ("studio.material_get", "jeeta.studio.material_get"),
    ("studio.material_add", "jeeta.studio.material_add"),
    ("studio.material_tag", "jeeta.studio.material_tag"),
    ("studio.slot_materials", "jeeta.studio.slot_materials"),
    ("studio.calendar_list", "jeeta.studio.calendar_list"),
    ("studio.shoot_list", "jeeta.studio.shoot_list"),
    ("studio.shoot_request", "jeeta.studio.shoot_request"),
    ("studio.shoot_resolve", "jeeta.studio.shoot_resolve"),
    // Olay-driven publishing (spec 2026-11-03 §14.3).
    ("studio.post_requests", "jeeta.studio.post_requests"),
    ("studio.posts_propose", "jeeta.studio.posts_propose"),
    ("studio.posts_list", "jeeta.studio.posts_list"),
    ("studio.weekly_summary", "jeeta.studio.weekly_summary"),
    // The pool's report (leads L4-T6).
    ("prospects.report", "jeeta.prospects.report"),
];

/// Panel-only rows added after the M4 amendment: the TikTok posting screen, which only a human
/// passes (TikTok's Content Sharing Guidelines), so no MCP tool, and its published post's
/// counters; and the voice and device bridges' own surfaces, each served to its bridge's key,
/// never as an MCP tool; and the materials library's human decisions (spec 2026-11-03 D4),
/// releasing a slot's caption findings among them (§7), and the posting policy (§14.3).
const POST_M4_PANEL_ONLY: [&str; 19] = [
    "studio.tiktok_posting",
    "studio.tiktok_post",
    "studio.tiktok_metrics",
    "calls.bridge.register",
    "calls.bridge.commands",
    "calls.bridge.events",
    "devices.bridge.register",
    "devices.bridge.commands",
    "devices.bridge.results",
    "devices.bridge.files",
    "studio.olay_confirm",
    "studio.material_permission",
    "studio.material_free",
    "studio.material_bind",
    "studio.material_delete",
    "studio.calendar_set",
    "studio.material_policy_set",
    "studio.material_check_release",
    "studio.posting_policy_set",
];

fn baseline(key: &str) -> BTreeSet<String> {
    let baseline: Value = serde_json::from_str(include_str!("fixtures/m3_surface.json")).unwrap();
    baseline[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect()
}

#[derive(Default)]
struct Routes(BTreeMap<String, (String, String, syn::Path)>);
fn literal(expr: &syn::Expr) -> String {
    let syn::Expr::Lit(syn::ExprLit {
        lit: syn::Lit::Str(s),
        ..
    }) = expr
    else {
        panic!("route argument must be literal")
    };
    s.value()
}
impl<'ast> Visit<'ast> for Routes {
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac.path.is_ident("vec") {
            use syn::parse::Parser;
            let entries =
                syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated
                    .parse2(mac.tokens.clone())
                    .unwrap();
            for expr in &entries {
                self.visit_expr(expr);
            }
        }
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(p) = &*call.func
            && p.path.is_ident("api_route")
        {
            let args: Vec<_> = call.args.iter().collect();
            let syn::Expr::Path(handler) = args[3] else {
                panic!("named handler")
            };
            assert!(
                self.0
                    .insert(
                        literal(args[2]),
                        (
                            literal(args[0]),
                            format!("/api{}", literal(args[1])),
                            handler.path.clone()
                        )
                    )
                    .is_none()
            );
        }
        syn::visit::visit_expr_call(self, call);
    }
}
fn source(path: &str) -> syn::File {
    syn::parse_file(&std::fs::read_to_string(workspace_dir().join(path)).unwrap()).unwrap()
}

#[derive(Default)]
struct Calls(BTreeSet<String>);
impl<'ast> Visit<'ast> for Calls {
    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(path) = &*call.func {
            self.0.insert(
                path.path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::"),
            );
        }
        syn::visit::visit_expr_call(self, call);
    }
}

fn handler_calls(file: &syn::File, name: &str) -> BTreeSet<String> {
    let function = file
        .items
        .iter()
        .find_map(|item| match item {
            syn::Item::Fn(f) if f.sig.ident == name => Some(f),
            _ => None,
        })
        .expect("implemented handler");
    let mut calls = Calls::default();
    calls.visit_block(&function.block);
    calls.0
}

#[test]
fn catalog_and_handlers_match_ratified_m4_surface_set() {
    let mut expected = baseline("rows");
    assert_eq!(expected.len(), 134);
    assert!(expected.remove("platform.workspaces.set_status"));
    for id in ADDED {
        assert!(expected.insert(id.into()));
    }
    for (id, _) in POST_M4_ADDED {
        assert!(expected.insert(id.into()));
    }
    for id in POST_M4_PANEL_ONLY {
        assert!(expected.insert(id.into()));
        let row = jt_app::catalog::find(id).unwrap();
        assert!(row.panel_only && row.mcp_tool.is_none(), "{id}");
    }
    assert_eq!(
        CATALOG.len(),
        144 + POST_M4_ADDED.len() + POST_M4_PANEL_ONLY.len()
    );
    assert_eq!(
        CATALOG
            .iter()
            .map(|r| r.id.to_owned())
            .collect::<BTreeSet<_>>(),
        expected
    );
    let mut tools = baseline("tools");
    assert_eq!(tools.len(), 124);
    assert!(tools.insert("jeeta.billing.report_payment".into()));
    for (_, tool) in POST_M4_ADDED {
        assert!(tools.insert(tool.into()));
    }
    let registry = jt_mcp::registry();
    assert_eq!(registry.len(), 125 + POST_M4_ADDED.len());
    assert_eq!(
        registry
            .iter()
            .map(|t| t.name.to_owned())
            .collect::<BTreeSet<_>>(),
        tools
    );
    assert_eq!(
        CATALOG
            .iter()
            .filter_map(|r| r.mcp_tool.map(str::to_owned))
            .collect::<BTreeSet<_>>(),
        tools
    );
    assert!(jt_mcp::NOT_YET_DEFINED.is_empty());
    let mut routes = Routes::default();
    routes.visit_file(&source("crates/adapters/jt_panel_http/src/routes/mod.rs"));
    assert_eq!(
        routes.0.keys().cloned().collect::<BTreeSet<_>>(),
        CATALOG
            .iter()
            .filter(|r| r.panel_route.is_some())
            .map(|r| r.id.to_owned())
            .collect()
    );
    for row in CATALOG {
        if let Some((method, path)) = row.panel_route {
            let (actual_method, actual_path, handler) = &routes.0[row.id];
            assert_eq!(
                (actual_method.as_str(), actual_path.as_str()),
                (method, path),
                "{}",
                row.id
            );
            assert!(jt_panel_http::ROUTES.contains(&(method, path)));
            let module = &handler.segments[0].ident;
            let function = &handler.segments.last().unwrap().ident;
            let file = source(&format!(
                "crates/adapters/jt_panel_http/src/routes/{module}.rs"
            ));
            assert!(
                file.items
                    .iter()
                    .any(|i| matches!(i, syn::Item::Fn(f) if f.sig.ident == *function)),
                "missing handler for {}",
                row.id
            );
        }
    }
    for path in ["/healthz", "/readyz", "/metrics"] {
        assert!(
            CATALOG
                .iter()
                .all(|r| r.panel_route.is_none_or(|(_, p)| p != path))
        );
    }
    // Check actual M4 handler dispatches, not just the advertised route table.
    for id in ADDED {
        let row = jt_app::catalog::find(id).unwrap();
        assert_eq!(row.gate, jt_app::catalog::GateMode::Exempt, "{id}");
        assert_eq!(row.panel_only, id != "billing.report_payment", "{id}");
        assert!(!row.mcp_only, "{id}");
        assert_eq!(
            row.risk,
            if ["billing.status", "platform.payments.list", "ops.health"].contains(&id) {
                jt_app::catalog::Risk::Read
            } else {
                jt_app::catalog::Risk::Write
            },
            "{id}"
        );
        let handler = &routes.0[id].2;
        let module = handler.segments[0].ident.to_string();
        let name = handler.segments.last().unwrap().ident.to_string();
        let expected = match id {
            "billing.status" => "billing::status",
            "billing.report_payment" => "billing::report_payment",
            "billing.activate" => "billing::activate",
            "platform.payments.list" => "platform_payments::list",
            "platform.billing.confirm" => "platform_payments::confirm",
            "platform.billing.reissue" => "platform_payments::reissue",
            "platform.billing.revoke_activation" => "platform_payments::revoke_activation",
            "platform.workspaces.suspend" => "platform::suspend",
            "platform.workspaces.resume" => "platform::resume",
            "platform.operators.reset_password" => "platform::reset_password",
            "ops.health" => "ops::health",
            _ => unreachable!("unratified M4 row"),
        };
        assert_eq!(format!("{module}::{name}"), expected, "{id}");
        let file = source(&format!(
            "crates/adapters/jt_panel_http/src/routes/{module}.rs"
        ));
        assert!(
            handler_calls(&file, &name).contains(expected),
            "{id} must call its application service"
        );
    }
    assert!(
        handler_calls(
            &source("crates/adapters/jt_mcp/src/tools/billing.rs"),
            "report"
        )
        .contains("billing::report_payment")
    );
}

#[test]
fn billing_source_and_debug_never_expose_secret_canaries() {
    // Keep secret-bearing ingress outside tracing, including future instrumentation attributes.
    struct NoSecretTracing;
    impl<'ast> Visit<'ast> for NoSecretTracing {
        fn visit_macro(&mut self, mac: &'ast syn::Macro) {
            if mac
                .path
                .segments
                .first()
                .is_some_and(|s| s.ident == "tracing")
            {
                panic!("billing ingress must use the centralized redacted operational logger");
            }
            syn::visit::visit_macro(self, mac);
        }
        fn visit_attribute(&mut self, attr: &'ast syn::Attribute) {
            assert!(
                !attr.path().segments.iter().any(|s| s.ident == "instrument"),
                "automatic argument tracing can expose billing secrets"
            );
            syn::visit::visit_attribute(self, attr);
        }
    }
    for path in [
        "crates/jt_app/src/usecases/billing/payments.rs",
        "crates/jt_app/src/usecases/billing/codes.rs",
        "crates/jt_app/src/usecases/platform_payments.rs",
        "crates/adapters/jt_panel_http/src/routes/billing.rs",
        "crates/adapters/jt_panel_http/src/routes/platform_payments.rs",
        "crates/adapters/jt_mcp/src/tools/billing.rs",
    ] {
        NoSecretTracing.visit_file(&source(path));
    }
    let input = jt_app::usecases::billing::ReportPaymentInput {
        reference: "CANARY_PAYMENT".into(),
        amount_minor: 123,
        paid_at: jt_testkit::fakes::FIXED_NOW,
        request_key: "CANARY_REQUEST".into(),
    };
    let code = jt_app::usecases::billing::ActivateInput {
        code: "CANARY_CODE".into(),
    };
    assert!(!format!("{input:?} {code:?}").contains("CANARY"));
    // Reuse the ledger's redaction contract used by operational canary coverage.
    let payload = jt_ledger::REDACTED_KEYS
        .iter()
        .map(|key| (key.to_string(), json!("CANARY_SECRET")))
        .collect::<serde_json::Map<_, _>>();
    let entry = jt_ledger::LedgerEntry::new(
        jt_tenancy::WorkspaceId::new_v7(),
        jt_ledger::Actor::System {
            component: "source-check".into(),
        },
        jt_ledger::Action::new("canary.check").unwrap(),
        Value::Object(payload),
        jt_testkit::fakes::FIXED_NOW,
    );
    assert!(
        !serde_json::to_string(&entry.redacted())
            .unwrap()
            .contains("CANARY")
    );
}

#[test]
fn platform_and_ops_have_no_mcp_tools() {
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|r| r.id.starts_with("platform.") || r.id.starts_with("ops."))
        .collect();
    assert_eq!(rows.len(), 10);
    for row in rows {
        assert!(row.panel_only && row.mcp_tool.is_none(), "{}", row.id);
    }
    assert!(
        jt_mcp::registry()
            .iter()
            .all(|t| !t.name.starts_with("jeeta.platform.") && !t.name.starts_with("jeeta.ops."))
    );
}

#[test]
fn only_named_billing_rows_bypass_pending_status() {
    use StatusExemption::{Always, Never, PendingPayment};
    let expected = BTreeMap::from([
        ("billing.status", Always),
        ("billing.report_payment", PendingPayment),
        ("billing.activate", PendingPayment),
    ]);
    assert_eq!(
        CATALOG
            .iter()
            .filter(|r| r.id.starts_with("billing."))
            .map(|r| (r.id, r.status_exemption))
            .collect::<BTreeMap<_, _>>(),
        expected
    );
    for row in CATALOG {
        let exemption = if let Some(value) = expected.get(row.id) {
            *value
        } else if ["auth.", "workspace.", "platform."]
            .iter()
            .any(|p| row.id.starts_with(p))
            || ["ops.health", "prospects.do_not_contact", "prospects.erase"].contains(&row.id)
        {
            Always
        } else if ["strategy.", "work."].iter().any(|p| row.id.starts_with(p)) {
            PendingPayment
        } else {
            Never
        };
        assert_eq!(row.status_exemption, exemption, "{}", row.id);
    }
    for id in ["billing.credit", "billing.subscription", "billing.future"] {
        assert_eq!(jt_app::catalog::status_exemption(id), Never);
    }
}

#[test]
fn payment_does_not_add_credit_or_subscription_dependency() {
    let excluded = [
        "credit",
        "credits",
        "subscription",
        "subscriptions",
        "quota",
        "package",
        "packages",
        "topup",
        "coupon",
        "trial",
        "reseller",
    ];
    for row in CATALOG {
        for name in std::iter::once(row.id).chain(row.mcp_tool) {
            assert!(
                !name
                    .split(['.', '_', '-'])
                    .any(|word| excluded.contains(&word)),
                "excluded concept: {name}"
            );
        }
    }
    // Cargo.lock includes the entire resolved graph, including transitive payment SDKs.
    let lock = std::fs::read_to_string(workspace_dir().join("Cargo.lock")).unwrap();
    let names: Vec<_> = lock
        .lines()
        .filter_map(|l| {
            l.strip_prefix("name = \"")
                .and_then(|s| s.strip_suffix('"'))
        })
        .collect();
    assert!(!names.is_empty());
    for name in names {
        assert!(
            !name.split(['-', '_']).any(|word| excluded.contains(&word)
                || [
                    "stripe",
                    "paypal",
                    "adyen",
                    "braintree",
                    "iyzico",
                    "paytr",
                    "paddle",
                    "chargebee"
                ]
                .contains(&word)),
            "excluded dependency: {name}"
        );
    }
}

#[tokio::test]
async fn m4_surface_schema_and_effect_parity() {
    use axum::http::Method;
    use jt_testkit::panel::{Panel, ok_json, workspace_of};
    let registry = jt_mcp::registry();
    let tool = registry
        .iter()
        .find(|t| t.name == "jeeta.billing.report_payment")
        .unwrap();
    assert_eq!(tool.permission, jt_tenancy::Permission::TeamManage);
    assert_eq!(tool.risk, jt_app::catalog::Risk::Write);
    let schema = tool.input_schema.as_value();
    let fields = BTreeSet::from(["reference", "amount_minor", "paid_at", "request_key"]);
    assert_eq!(
        schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        fields
    );
    assert_eq!(
        schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        fields
    );
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["paid_at"]["format"], "date-time");
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("parity@product.test", "Parity").await;
    let principal = jt_app::usecases::auth::resolve_session(
        &p.deps,
        owner.strip_prefix("jt_session=").unwrap(),
    )
    .await
    .unwrap();
    let ctx =
        jt_app::usecases::auth::ctx_for(&principal, workspace_of(&me), p.deps.clock.now()).unwrap();
    let status = ok_json(p.get("/api/billing", &owner).await).await;
    let input = json!({"reference":status["payment_reference"],"amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"parity"});
    let panel = ok_json(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&owner),
            Some(input.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(
        (tool.run)(&p.deps, &ctx, input.clone()).await.unwrap(),
        panel
    );
    let mut other = input.clone();
    other["request_key"] = json!("mcp-first");
    let mcp = (tool.run)(&p.deps, &ctx, other.clone()).await.unwrap();
    assert_eq!(
        ok_json(
            p.send(
                Method::POST,
                "/api/billing/payments",
                Some(&owner),
                Some(other)
            )
            .await
        )
        .await,
        mcp
    );
    let after = ok_json(p.get("/api/billing", &owner).await).await;
    assert_eq!(after["workspace_status"], "pending_payment");
    assert!(after["entitlement"].is_null());
    let mut r = p.deps.uow.tenant(ctx.workspace_id).await.unwrap();
    let events = r
        .ledger()
        .list(jt_app::ports::LedgerFilter {
            action_prefix: None,
            actor_kind: None,
            agent_connection_id: None,
            limit: 200,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.entry.action.as_str() == "billing.payment_reported")
            .count(),
        2
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains(status["payment_reference"].as_str().unwrap())
    );
}
