use std::collections::BTreeSet;

use jt_archtest::{direct_deps, workspace_packages};

// `jt_tenancy` and `jt_ledger` are themselves pure domain crates: `jt_ledger` uses the ids of
// `jt_tenancy`, and `jt_strategy` uses both (the ids, and `Actor` for who wrote what).
const DOMAIN_ALLOW: &[&str] = &[
    "serde",
    "serde_json",
    "uuid",
    "time",
    "thiserror",
    "jt_tenancy",
    "jt_ledger",
];

#[test]
fn domain_crates_depend_only_on_pure_crates() {
    for c in ["jt_tenancy", "jt_ledger", "jt_strategy"] {
        for d in direct_deps(c) {
            assert!(DOMAIN_ALLOW.contains(&d.as_str()), "{c} depends on {d}");
        }
    }
}

// The application core: the domain crates, serialisation and time, and the pure-Rust crates
// behind `jt_app::std_impls` and token hashing, plus `tokio` only so `Argon2Hasher` can move its
// CPU-bound work onto a blocking thread, and `zeroize` for the plaintext the `SecretBox` port
// hands back. No adapter, database, HTTP or cipher crate.
const APP_ALLOW: &[&str] = &[
    "jt_tenancy",
    "jt_ledger",
    "serde",
    "serde_json",
    "uuid",
    "time",
    "thiserror",
    "async-trait",
    "argon2",
    "rand",
    "sha2",
    "base64",
    "tracing",
    "tokio",
    "zeroize",
];

#[test]
fn app_depends_on_no_adapter() {
    for d in direct_deps("jt_app") {
        assert!(
            APP_ALLOW.contains(&d.as_str()),
            "jt_app depends on {d}, which is not on its allowlist"
        );
    }
}

#[test]
fn only_outbound_uses_reqwest_and_only_pg_uses_sqlx() {
    for c in [
        "jt_tenancy",
        "jt_ledger",
        "jt_strategy",
        "jt_app",
        "jt_panel_http",
        "jt_mcp",
        "jt_seal",
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

/// The cipher and key-derivation crates live behind the `SecretBox` port: `jt_seal` is the one
/// crate that lists them, and it does list them (the rule is not vacuous).
#[test]
fn only_seal_uses_aes_gcm_and_hkdf() {
    for krate in ["aes-gcm", "hkdf"] {
        let users: BTreeSet<String> = workspace_packages()
            .into_iter()
            .filter(|p| direct_deps(p).contains(krate))
            .collect();
        assert_eq!(
            users,
            BTreeSet::from(["jt_seal".to_owned()]),
            "the crates depending on {krate}"
        );
    }
}
