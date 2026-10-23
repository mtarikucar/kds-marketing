use std::collections::BTreeSet;

use jt_archtest::{direct_deps, mentions_word, metadata, workspace_dir, workspace_packages};

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
        "jt_meta",
        "jt_netgsm",
        "jt_x",
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

// A provider adapter: the application core (its ports) and the domain crates it speaks, the
// egress client (its only way out), serialisation, time, ids and URLs, logging, async traits and
// error derives, the HMAC crates (Meta's `appsecret_proof`) and `tokio` (for timers: the pause
// between polls). No HTTP client of its own, no database, no web framework: every call goes
// through `jt_outbound::Egress` under the connector's scope. NetGSM uses `uuid` for the
// correlation id of the calls it places and `sha2` for the fallback ids of callback items.
// (A test-only mock server may use a web framework as a dev-dependency.)
const CONNECTOR_ADAPTER_ALLOW: &[&str] = &[
    "jt_app",
    "jt_connector",
    "jt_capability",
    "jt_tenancy",
    "jt_ledger",
    "jt_outbound",
    "serde",
    "serde_json",
    "time",
    "uuid",
    "url",
    "tracing",
    "async-trait",
    "thiserror",
    "hmac",
    "sha2",
    "base64",
    "tokio",
];

/// The provider adapter crates.
const CONNECTOR_ADAPTERS: &[&str] = &["jt_meta", "jt_netgsm", "jt_x"];

#[test]
fn connector_adapters_reach_out_only_through_the_egress_client() {
    for c in CONNECTOR_ADAPTERS {
        let deps = direct_deps(c);
        for d in &deps {
            assert!(
                CONNECTOR_ADAPTER_ALLOW.contains(&d.as_str()),
                "{c} depends on {d}, which is not on its allowlist"
            );
        }
        // Not vacuous: the egress client is how it reaches its provider.
        assert!(
            deps.contains("jt_outbound"),
            "{c} must call out through jt_outbound"
        );
    }
}

/// A provider adapter neither lists nor names an HTTP client crate, in its manifest or in any of
/// its sources (tests included), and its library sources open no socket of their own: no
/// `reqwest` type, and no `tokio::net` or `std::net` socket, can reach around the egress client.
#[test]
fn connector_adapters_never_name_an_http_client() {
    for c in CONNECTOR_ADAPTERS {
        let dir = workspace_dir().join("crates/adapters").join(c);
        let mut files = vec![dir.join("Cargo.toml")];
        let mut pending = vec![dir.join("src"), dir.join("tests")];
        while let Some(next) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for entry in entries {
                let path = entry.expect("a directory entry").path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    files.push(path);
                }
            }
        }
        assert!(files.len() > 1, "{c} has no sources to check");
        let src = dir.join("src");
        for file in files {
            let text = std::fs::read_to_string(&file).expect("a readable file");
            for client in ["reqwest", "hyper", "ureq", "isahc", "surf"] {
                assert!(
                    !mentions_word(&text, client),
                    "{} names {client}: an adapter reaches out only through jt_outbound",
                    file.display()
                );
            }
            // Nor a socket of its own (its tests may run a mock server on one).
            if file.starts_with(&src) {
                for socket in [
                    "tokio::net",
                    "std::net",
                    "TcpStream",
                    "UdpSocket",
                    "TcpListener",
                ] {
                    assert!(
                        !mentions_word(&text, socket),
                        "{} names {socket}: an adapter reaches out only through jt_outbound",
                        file.display()
                    );
                }
            }
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

/// `jt_outbound`'s `test-loopback` feature lets plain http reach loopback literals and adds test
/// hosts to the fixed tier: for the tests of other crates only. So `bin/jeeta` never enables it, in
/// any section of its manifest, and elsewhere only a `[dev-dependencies]` entry may (a normal or
/// build dependency, and a crate feature forwarding to it, would reach a production build). Read
/// from `cargo metadata`, which resolves workspace-inherited dependencies.
#[test]
fn test_loopback_feature_is_dev_only() {
    const FEATURE: &str = "test-loopback";
    let metadata = metadata();
    let packages = metadata["packages"]
        .as_array()
        .expect("`cargo metadata` has no `packages` array");
    let outbound = packages
        .iter()
        .find(|p| p["name"] == "jt_outbound")
        .expect("jt_outbound is a workspace package");
    // The feature exists, so the rule is not vacuous, and no default turns it on.
    assert!(
        outbound["features"].get(FEATURE).is_some(),
        "jt_outbound no longer declares `{FEATURE}`; update this rule"
    );
    let defaults = outbound["features"]["default"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        !defaults.iter().any(|f| f == FEATURE),
        "jt_outbound must not enable `{FEATURE}` by default"
    );

    for package in packages {
        let name = package["name"].as_str().expect("package has no `name`");
        let deps = package["dependencies"]
            .as_array()
            .expect("package has no `dependencies` array");
        // The keys under which this package names jt_outbound (its name, or a rename).
        let mut keys = BTreeSet::new();
        for dep in deps.iter().filter(|d| d["name"] == "jt_outbound") {
            keys.insert(dep["rename"].as_str().unwrap_or("jt_outbound").to_owned());
            let enables = dep["features"]
                .as_array()
                .is_some_and(|features| features.iter().any(|f| f == FEATURE));
            if !enables {
                continue;
            }
            assert_ne!(
                name, "jeeta",
                "bin/jeeta must never enable jt_outbound's `{FEATURE}`"
            );
            assert_eq!(
                dep["kind"], "dev",
                "{name} enables jt_outbound's `{FEATURE}` outside [dev-dependencies]"
            );
        }
        let features = package["features"]
            .as_object()
            .expect("package has no `features` object");
        for (feature, enables) in features {
            for entry in enables.as_array().into_iter().flatten() {
                let entry = entry.as_str().unwrap_or_default();
                let forwards = keys.iter().any(|key| {
                    entry == format!("{key}/{FEATURE}") || entry == format!("{key}?/{FEATURE}")
                });
                assert!(
                    !forwards,
                    "feature `{feature}` of {name} turns on jt_outbound's `{FEATURE}`"
                );
            }
        }
    }

    // And the binary's manifest does not name the feature at all.
    let manifest = std::fs::read_to_string(workspace_dir().join("bin/jeeta/Cargo.toml"))
        .expect("bin/jeeta/Cargo.toml is readable");
    assert!(
        !manifest.contains(FEATURE),
        "bin/jeeta/Cargo.toml mentions `{FEATURE}`"
    );
}
