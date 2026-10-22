use std::collections::BTreeSet;

use jt_archtest::{direct_deps, workspace_packages};

// What every domain crate may depend on: serialisation, ids, time, error derives, and the two
// foundational domain crates. `jt_ledger` uses the ids of `jt_tenancy`, `jt_strategy` uses both
// (the ids, and `Actor` for who wrote what), and `jt_capability` uses both (the ids, and the
// ledger's list of secret key names).
const DOMAIN_ALLOW: &[&str] = &[
    "serde",
    "serde_json",
    "uuid",
    "time",
    "thiserror",
    "jt_tenancy",
    "jt_ledger",
];

// The connector domain also uses `jt_capability` (capability ids, kinds, statuses and the
// secret-key predicate), and it computes webhook signatures, the OAuth state's MAC and the PKCE
// challenge itself (pure functions over bytes, no I/O), so it alone may use the HMAC, SHA-256,
// base64 and constant-time comparison crates. No cipher: sealing stays behind the `SecretBox`
// port.
const CONNECTOR_EXTRA_ALLOW: &[&str] = &["jt_capability", "hmac", "sha2", "base64", "subtle"];

/// Every domain crate, with what it may depend on beyond [`DOMAIN_ALLOW`].
const DOMAIN_CRATES: &[(&str, &[&str])] = &[
    ("jt_tenancy", &[]),
    ("jt_ledger", &[]),
    ("jt_strategy", &[]),
    ("jt_capability", &[]),
    ("jt_connector", CONNECTOR_EXTRA_ALLOW),
];

#[test]
fn domain_crates_depend_only_on_pure_crates() {
    for (c, extra) in DOMAIN_CRATES {
        for d in direct_deps(c) {
            assert!(
                DOMAIN_ALLOW.contains(&d.as_str()) || extra.contains(&d.as_str()),
                "{c} depends on {d}, which is not on its allowlist"
            );
        }
    }
}

/// Read from each domain crate's manifest: among the domain crates, exactly `jt_connector` lists
/// `jt_capability` and each of the crypto crates (so the rule is not vacuous either).
#[test]
fn only_the_connector_domain_uses_its_extra_crates() {
    for krate in CONNECTOR_EXTRA_ALLOW {
        let users: BTreeSet<&str> = DOMAIN_CRATES
            .iter()
            .map(|(c, _)| *c)
            .filter(|c| direct_deps(c).contains(*krate))
            .collect();
        assert_eq!(
            users,
            BTreeSet::from(["jt_connector"]),
            "the domain crates depending on {krate}"
        );
    }
}

// The application core: the domain crates, serialisation and time, and the pure-Rust crates
// behind `jt_app::std_impls` and token hashing, plus `tokio` only so `Argon2Hasher` can move its
// CPU-bound work onto a blocking thread, `zeroize` for the plaintext the `SecretBox` port hands
// back, and `url` (a parser, no I/O) for the addresses the connector ports carry. No adapter,
// database, HTTP or cipher crate.
const APP_ALLOW: &[&str] = &[
    "jt_tenancy",
    "jt_ledger",
    "jt_strategy",
    "jt_capability",
    "jt_connector",
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
    "url",
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
