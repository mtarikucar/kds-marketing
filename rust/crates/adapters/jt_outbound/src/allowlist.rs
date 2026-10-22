//! The two allowlist tiers and the host check that runs before any DNS lookup or socket.
//!
//! Hosts are compared in one canonical form: the host as `url` serialises it (lowercase ASCII,
//! IDNA labels as punycode, IPv4 dotted, IPv6 in brackets), optionally followed by `:<port>`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};

use jt_tenancy::WorkspaceId;
use url::{Host, Url};

use crate::client::EgressScope;

/// One host a connector may reach: an entry of the fixed tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllowedHost {
    /// The connector that owns the host, matched against `EgressScope::Connector`.
    pub connector: &'static str,
    /// A hostname or IP literal (IPv6 in brackets), optionally with `:<port>`.
    pub host: &'static str,
}

/// The fixed tier: the provider hosts each connector may reach (spec §4.3, "sabit katman").
///
/// Empty in M0, because no connector exists yet. M1 fills it per connector, for example
/// `AllowedHost { connector: "meta", host: "graph.facebook.com" }`. A connector scope reaches only
/// the entries carrying its own name.
pub const FIXED_HOSTS: &[AllowedHost] = &[];

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
fn split_port(raw: &str) -> Option<(&str, Option<u16>)> {
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

/// Plain http is tolerated only for loopback literals, and only in this crate's own unit-test
/// build. A production build compiles the `cfg(not(test))` twin, so it has no code path that
/// accepts plain http.
#[cfg(test)]
fn plain_http_allowed(host: &Host<&str>) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    }
}

#[cfg(not(test))]
fn plain_http_allowed(_host: &Host<&str>) -> bool {
    false
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
    pub(crate) fn check(&self, scope: EgressScope, url: &Url) -> Result<(), String> {
        let refused = || url.host_str().unwrap_or_default().to_owned();
        let Some(host) = url.host() else {
            return Err(refused());
        };
        let scheme_ok = match url.scheme() {
            "https" => true,
            "http" => plain_http_allowed(&host),
            _ => false,
        };
        if !scheme_ok {
            return Err(refused());
        }
        let host = canonical_host(&host);
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
