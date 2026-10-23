//! The two allowlist tiers and the host check that runs before any DNS lookup or socket.
//!
//! Hosts are compared in one canonical form: the host as `url` serialises it (lowercase ASCII,
//! IDNA labels as punycode, IPv4 dotted, IPv6 in brackets), optionally followed by `:<port>`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};

use jt_tenancy::WorkspaceId;
use url::{Host, Url};

use crate::client::EgressScope;
use crate::fixed_hosts::allow_plain_http;

/// One host a connector may reach: an entry of the fixed tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllowedHost {
    /// The connector that owns the host, matched against `EgressScope::Connector`.
    pub connector: &'static str,
    /// A hostname or IP literal (IPv6 in brackets), optionally with `:<port>`.
    pub host: &'static str,
}

/// Parses an allowlist entry (`host` or `host:port`) into its canonical form, or `None` when it
/// is not a valid host. An invalid entry is never stored, so it can never match anything.
pub(crate) fn canonical_entry(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let (host, port) = split_port(raw)?;
    let host = canonical_host(&Host::parse(host).ok()?);
    Some(match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Splits an optional `:<port>` suffix off an entry. IPv6 literals must be bracketed.
pub(crate) fn split_port(raw: &str) -> Option<(&str, Option<u16>)> {
    if raw.starts_with('[') {
        let end = raw.find(']')? + 1;
        let (host, rest) = raw.split_at(end);
        if rest.is_empty() {
            return Some((host, None));
        }
        return Some((host, Some(rest.strip_prefix(':')?.parse().ok()?)));
    }
    match raw.split_once(':') {
        Some((host, port)) => Some((host, Some(port.parse().ok()?))),
        None => Some((raw, None)),
    }
}

fn canonical_host<S: AsRef<str>>(host: &Host<S>) -> String {
    host.to_string().to_ascii_lowercase()
}

/// Whether `url` may be reached through `entries`: an entry without a port matches the host on
/// any port; an entry with a port matches only that port.
fn entries_match(entries: &HashSet<String>, host: &str, url: &Url) -> bool {
    if entries.contains(host) {
        return true;
    }
    url.port_or_known_default()
        .is_some_and(|port| entries.contains(&format!("{host}:{port}")))
}

/// Plain http to this machine (`localhost`, `127.0.0.1`, `[::1]`) is tolerated only in a test
/// build: this crate's own unit tests, or another crate's tests through the `test-loopback`
/// feature. A production build compiles the twin below, so its only plain-http path is the
/// provider exception ([`allow_plain_http`]).
#[cfg(any(test, feature = "test-loopback"))]
fn plain_http_allowed(host: &Host<&str>) -> bool {
    is_loopback(host)
}

#[cfg(not(any(test, feature = "test-loopback")))]
fn plain_http_allowed(_host: &Host<&str>) -> bool {
    false
}

/// Whether `raw` is an entry for this machine: `localhost`, `127.0.0.1` or `[::1]`, with or
/// without a port. Only a test build lets such an entry into a tier.
#[cfg(any(test, feature = "test-loopback"))]
pub(crate) fn is_loopback_entry(raw: &str) -> bool {
    canonical_entry(raw).is_some_and(|entry| {
        split_port(&entry)
            .is_some_and(|(host, _)| matches!(host, "localhost" | "127.0.0.1" | "[::1]"))
    })
}

/// Whether `host` names this machine: `localhost` or the loopback literals `127.0.0.1` and
/// `[::1]`.
#[cfg(any(test, feature = "test-loopback"))]
fn is_loopback(host: &Host<&str>) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    }
}

/// Both tiers. Cheap to clone; clones share the tenant tier.
#[derive(Clone, Debug)]
pub(crate) struct Allowlist {
    fixed: Arc<HashMap<&'static str, HashSet<String>>>,
    tenant: Arc<RwLock<HashMap<WorkspaceId, HashSet<String>>>>,
}

impl Allowlist {
    /// Builds the fixed tier from `fixed`.
    ///
    /// # Panics
    /// When an entry is not a valid host: the fixed tier is code, so a bad entry is a bug that
    /// must stop the process at startup rather than silently allow or refuse a provider.
    pub(crate) fn new(fixed: &'static [AllowedHost]) -> Self {
        let mut by_connector: HashMap<&'static str, HashSet<String>> = HashMap::new();
        for entry in fixed {
            let host = canonical_entry(entry.host).unwrap_or_else(|| {
                panic!(
                    "fixed egress host {:?} of connector {:?} is not a valid host",
                    entry.host, entry.connector
                )
            });
            by_connector
                .entry(entry.connector)
                .or_default()
                .insert(host);
        }
        Allowlist {
            fixed: Arc::new(by_connector),
            tenant: Arc::default(),
        }
    }

    /// Adds `host` to the workspace's tenant tier. Returns false (and stores nothing) when
    /// `host` is not a valid host.
    pub(crate) fn allow_tenant(&self, ws: WorkspaceId, host: &str) -> bool {
        let Some(entry) = canonical_entry(host) else {
            return false;
        };
        self.tenant
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(ws)
            .or_default()
            .insert(entry);
        true
    }

    /// Adds test hosts (`(connector, host)`, each `localhost`, `127.0.0.1` or `[::1]`, with or
    /// without a port) to the fixed tier.
    ///
    /// # Panics
    /// When a host is not one of those: the hook exists for in-process mocks only.
    #[cfg(any(test, feature = "test-loopback"))]
    pub(crate) fn add_test_hosts<S: AsRef<str>>(
        &mut self,
        extra: impl IntoIterator<Item = (&'static str, S)>,
    ) {
        let fixed = Arc::make_mut(&mut self.fixed);
        for (connector, raw) in extra {
            let raw = raw.as_ref();
            let entry = canonical_entry(raw)
                .filter(|_| is_loopback_entry(raw))
                .unwrap_or_else(|| {
                    panic!(
                        "test egress host {raw:?} of connector {connector:?} is not a loopback host"
                    )
                });
            fixed.entry(connector).or_default().insert(entry);
        }
    }

    /// Replaces the workspace's tenant tier with the valid hosts of `hosts` (invalid ones are
    /// dropped, so they can never allow anything) and returns how many distinct hosts it now
    /// holds. Nothing at all removes the workspace's tier.
    pub(crate) fn replace_tenant(&self, ws: WorkspaceId, hosts: &[String]) -> usize {
        let entries: HashSet<String> = hosts.iter().filter_map(|h| canonical_entry(h)).collect();
        let count = entries.len();
        let mut tenant = self.tenant.write().unwrap_or_else(PoisonError::into_inner);
        if entries.is_empty() {
            tenant.remove(&ws);
        } else {
            tenant.insert(ws, entries);
        }
        count
    }

    /// Removes `host` from the workspace's tenant tier; a no-op for anything not present.
    pub(crate) fn revoke_tenant(&self, ws: WorkspaceId, host: &str) {
        let Some(entry) = canonical_entry(host) else {
            return;
        };
        let mut tenant = self.tenant.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(hosts) = tenant.get_mut(&ws) {
            hosts.remove(&entry);
            if hosts.is_empty() {
                tenant.remove(&ws);
            }
        }
    }

    /// Checks `url` against the tier `scope` selects. On refusal, returns the host to report
    /// (empty when the URL has none). Pure: no DNS lookup, no socket.
    ///
    /// Only `https` passes, but for plain `http` to a provider exception ([`allow_plain_http`])
    /// and, in a test build, to this machine.
    pub(crate) fn check(&self, scope: EgressScope, url: &Url) -> Result<(), String> {
        let refused = || url.host_str().unwrap_or_default().to_owned();
        let Some(parsed) = url.host() else {
            return Err(refused());
        };
        let host = canonical_host(&parsed);
        let scheme_ok = match url.scheme() {
            "https" => true,
            "http" => {
                plain_http_allowed(&parsed)
                    || url
                        .port_or_known_default()
                        .is_some_and(|port| allow_plain_http(&scope, &host, port))
            }
            _ => false,
        };
        if !scheme_ok {
            return Err(refused());
        }
        let allowed = match scope {
            EgressScope::Connector(name) => self
                .fixed
                .get(name)
                .is_some_and(|entries| entries_match(entries, &host, url)),
            EgressScope::Tenant(ws) => self
                .tenant
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&ws)
                .is_some_and(|entries| entries_match(entries, &host, url)),
        };
        if allowed { Ok(()) } else { Err(refused()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FIXED_HOSTS;

    #[test]
    fn entries_are_canonicalised() {
        assert_eq!(
            canonical_entry("Mail.Example.COM").unwrap(),
            "mail.example.com"
        );
        assert_eq!(
            canonical_entry(" smtp.example.com ").unwrap(),
            "smtp.example.com"
        );
        assert_eq!(canonical_entry("bücher.de").unwrap(), "xn--bcher-kva.de");
        assert_eq!(
            canonical_entry("smtp.example.com:465").unwrap(),
            "smtp.example.com:465"
        );
        assert_eq!(canonical_entry("127.0.0.1").unwrap(), "127.0.0.1");
        assert_eq!(canonical_entry("[::1]").unwrap(), "[::1]");
        assert_eq!(canonical_entry("[0:0::1]:8443").unwrap(), "[::1]:8443");
    }

    #[test]
    fn invalid_entries_are_rejected() {
        for raw in [
            "",
            "   ",
            "not a host",
            "evil.example/path",
            "user@evil.example",
            "host:",
            "host:http",
            "host:65536",
            "::1",
            "[::1",
            "[::1]8080",
            "a:1:2",
        ] {
            assert_eq!(canonical_entry(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn fixed_hosts_table_is_well_formed() {
        for entry in FIXED_HOSTS {
            assert!(!entry.connector.is_empty(), "{entry:?}");
            assert!(canonical_entry(entry.host).is_some(), "{entry:?}");
        }
        // Building the fixed tier panics on a bad entry; it must not for the real table.
        Allowlist::new(FIXED_HOSTS);
    }

    #[test]
    #[should_panic(expected = "is not a valid host")]
    fn bad_fixed_entry_panics_at_startup() {
        Allowlist::new(&[AllowedHost {
            connector: "meta",
            host: "graph.facebook.com/v1",
        }]);
    }

    #[test]
    fn plain_http_is_tolerated_only_for_loopback_literals_in_tests() {
        for (url, ok) in [
            ("http://localhost/", true),
            ("http://127.0.0.1/", true),
            ("http://[::1]/", true),
            ("http://127.0.0.2/", false),
            ("http://localhost.example.com/", false),
            ("http://10.0.0.1/", false),
            ("http://example.com/", false),
        ] {
            let url = Url::parse(url).unwrap();
            assert_eq!(plain_http_allowed(&url.host().unwrap()), ok, "{url}");
        }
    }
}
