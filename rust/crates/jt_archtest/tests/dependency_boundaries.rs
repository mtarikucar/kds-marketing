use jt_archtest::direct_deps;

// `jt_tenancy` is itself a pure domain crate; `jt_ledger` uses its ids.
const DOMAIN_ALLOW: &[&str] = &[
    "serde",
    "serde_json",
    "uuid",
    "time",
    "thiserror",
    "jt_tenancy",
];

#[test]
fn domain_crates_depend_only_on_pure_crates() {
    for c in ["jt_tenancy", "jt_ledger"] {
        for d in direct_deps(c) {
            assert!(DOMAIN_ALLOW.contains(&d.as_str()), "{c} depends on {d}");
        }
    }
}

#[test]
fn app_depends_on_no_adapter() {
    for d in direct_deps("jt_app") {
        assert!(
            !d.starts_with("jt_") || ["jt_tenancy", "jt_ledger"].contains(&d.as_str()),
            "jt_app depends on {d}"
        );
    }
}

#[test]
fn only_outbound_uses_reqwest_and_only_pg_uses_sqlx() {
    for c in [
        "jt_tenancy",
        "jt_ledger",
        "jt_app",
        "jt_panel_http",
        "jt_mcp",
        "jt_testkit",
        "jeeta",
    ] {
        let deps = direct_deps(c);
        assert!(!deps.contains("reqwest"), "{c} must not depend on reqwest");
        if c != "jt_testkit" && c != "jeeta" {
            assert!(!deps.contains("sqlx"), "{c} must not depend on sqlx");
        }
    }
}
