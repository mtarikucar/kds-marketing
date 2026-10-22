use std::collections::BTreeSet;

use jt_archtest::{direct_deps, workspace_packages};

// `jt_tenancy` and `jt_ledger` are themselves pure domain crates: `jt_ledger` uses the ids of
// `jt_tenancy`, `jt_strategy` uses both (the ids, and `Actor` for who wrote what),
// `jt_capability` uses both (the ids, and the ledger's list of secret key names), and
// `jt_connector` uses `jt_capability` (capability ids, kinds and statuses).
const DOMAIN_ALLOW: &[&str] = &[
    "serde",
    "serde_json",
    "uuid",
    "time",
    "thiserror",
    "jt_tenancy",
    "jt_ledger",
    "jt_capability",
];

// The connector domain computes webhook signatures, the OAuth state's MAC and the PKCE challenge
// itself (pure functions over bytes, no I/O), so it alone may also use the HMAC, SHA-256, base64
// and constant-time comparison crates. No cipher: sealing stays behind the `SecretBox` port.
const CONNECTOR_EXTRA_ALLOW: &[&str] = &["hmac", "sha2", "base64", "subtle"];

/// What the domain crate `krate` may depend on.
fn domain_allow(krate: &str) -> Vec<&'static str> {
    let mut allow = DOMAIN_ALLOW.to_vec();
    if krate == "jt_connector" {
        allow.extend_from_slice(CONNECTOR_EXTRA_ALLOW);
    }
    allow
}

#[test]
fn domain_crates_depend_only_on_pure_crates() {
    for c in [
        "jt_tenancy",
        "jt_ledger",
        "jt_strategy",
        "jt_capability",
        "jt_connector",
    ] {
        let allow = domain_allow(c);
        for d in direct_deps(c) {
            assert!(allow.contains(&d.as_str()), "{c} depends on {d}");
        }
    }
}

/// The crypto crates of the connector domain stay there: no other domain crate lists them.
#[test]
fn connector_crypto_crates_are_not_open_to_other_domain_crates() {
    for c in ["jt_tenancy", "jt_ledger", "jt_strategy", "jt_capability"] {
        for krate in CONNECTOR_EXTRA_ALLOW {
            assert!(
                !domain_allow(c).contains(krate),
                "{c} must not be allowed {krate}"
            );
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
    "jt_strategy",
    "jt_capability",
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
        "jt_capability",
        "jt_connector",
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
