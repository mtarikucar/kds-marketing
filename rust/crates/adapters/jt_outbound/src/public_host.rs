//! The public-host guard of the tenant tier, and the tier behind `jt_app`'s
//! [`TenantHostRegistry`] port.
//!
//! A workspace names the hosts its connectors reach (an IMAP server, a webhook target) in its
//! capability records. Before such a host enters the tenant tier, [`validate_public_host`] checks
//! that it is on the public internet: never this machine, a private network or a special-purpose
//! block, which a tenant could otherwise reach through the system (server-side request forgery).
//!
//! **Two checks, at two moments.** When a host is declared, [`validate_public_host`] reads its
//! text alone, with no DNS lookup: IP literals in every non-public block, and the name patterns
//! that only a private network resolves (`localhost`, single labels, [`PRIVATE_SUFFIXES`]). When
//! the egress client connects, the DNS guard ([`crate::resolve_public`], installed as the
//! client's resolver) checks the addresses the name resolves to with
//! [`validate_public_address`], the same blocks, and drops every one that is not public; with
//! none left the request fails before any socket opens. So a public name whose DNS answer is (or
//! later becomes, by rebinding) a private address is never reached, whichever tier allowed it.
//!
//! The tier lives in memory and starts empty at every start; [`crate::rebuild_tenant_hosts`]
//! fills it again from the capability records.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use jt_app::error::AppError;
use jt_app::ports::TenantHostRegistry;
use jt_tenancy::WorkspaceId;
use serde_json::json;
use url::Host;

use crate::allowlist::split_port;
use crate::client::Egress;

/// Name suffixes that never name a public host: mDNS (`.local`), the names that private networks
/// and home routers use (`.internal`, `.lan`, `.home`, `.localdomain`) and reverse-lookup and
/// infrastructure names (`.arpa`, `home.arpa` included).
pub const PRIVATE_SUFFIXES: &[&str] = &["local", "internal", "lan", "home", "localdomain", "arpa"];

/// Why a host may not enter the tenant tier.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    /// Nothing was given.
    #[error("the host is empty")]
    Empty,
    /// Not a host name or an IP literal, optionally with `:<port>` (IPv6 in brackets).
    #[error("{0:?} is not a host name or an IP address")]
    Invalid(String),
    /// `localhost` or a name under it: this machine.
    #[error("{0:?} names this machine")]
    Localhost(String),
    /// A name without a dot, which only a local network resolves.
    #[error("{0:?} is a single-label name, which only a local network resolves")]
    SingleLabel(String),
    /// A name under one of [`PRIVATE_SUFFIXES`].
    #[error("{0:?} is under .{1}, which names private or special-purpose hosts")]
    PrivateSuffix(String, &'static str),
    /// An IP literal outside the public address space (see [`validate_public_host`]).
    #[error("{0} is not a public address")]
    NonPublicAddress(IpAddr),
    /// The name did not resolve (the DNS guard, [`crate::resolve_public`]).
    #[error("{0:?} does not resolve")]
    Unresolvable(String),
    /// The name resolved, but only to addresses outside the public address space (the DNS guard,
    /// [`crate::resolve_public`]): a public-looking name pointed at a private network.
    #[error("{0:?} resolves to no public address")]
    NoPublicAddress(String),
}

impl HostError {
    /// The stable key of the reason, e.g. `"non_public_address"`.
    pub fn key(&self) -> &'static str {
        match self {
            HostError::Empty => "empty",
            HostError::Invalid(_) => "invalid",
            HostError::Localhost(_) => "localhost",
            HostError::SingleLabel(_) => "single_label",
            HostError::PrivateSuffix(..) => "private_suffix",
            HostError::NonPublicAddress(_) => "non_public_address",
            HostError::Unresolvable(_) => "unresolvable",
            HostError::NoPublicAddress(_) => "no_public_address",
        }
    }
}

/// `Ok` when `host` (`host` or `host:port`, an IPv6 literal in brackets, surrounding whitespace
/// ignored) names a host on the public internet. The host is read as a URL parser reads it, so
/// `127.1`, `0x7f000001` and `2130706433` are all `127.0.0.1`, and a name may end with a dot.
///
/// Refused:
/// - nothing at all (`Empty`), or text that is not a host (`Invalid`);
/// - `localhost` and names under it (`Localhost`);
/// - single-label names such as `intranet` (`SingleLabel`);
/// - names under [`PRIVATE_SUFFIXES`] (`PrivateSuffix`);
/// - IPv4 literals in `0.0.0.0/8` (this network, unspecified), `10.0.0.0/8`, `100.64.0.0/10`
///   (shared, CGNAT), `127.0.0.0/8` (loopback), `169.254.0.0/16` (link-local), `172.16.0.0/12`,
///   `192.0.0.0/24` (protocol assignments), `192.0.2.0/24`, `198.51.100.0/24` and
///   `203.0.113.0/24` (documentation), `192.168.0.0/16`, `198.18.0.0/15` (benchmarking), and
///   `224.0.0.0/3` (multicast, reserved, broadcast) (`NonPublicAddress`);
/// - IPv6 literals that are unspecified, loopback or IPv4-compatible (`::/96`), unique local
///   (`fc00::/7`), link-local (`fe80::/10`), site-local (`fec0::/10`), multicast (`ff00::/8`),
///   documentation (`2001:db8::/32`), discard (`100::/64`) or local-use NAT64 (`64:ff9b:1::/48`),
///   and the IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) forms
///   of a refused IPv4 address (`NonPublicAddress`).
pub fn validate_public_host(host: &str) -> Result<(), HostError> {
    let raw = host.trim();
    if raw.is_empty() {
        return Err(HostError::Empty);
    }
    let invalid = || HostError::Invalid(raw.to_owned());
    let (name, _port) = split_port(raw).ok_or_else(invalid)?;
    match Host::parse(name).map_err(|_| invalid())? {
        Host::Ipv4(ip) => validate_public_address(IpAddr::V4(ip)),
        Host::Ipv6(ip) => validate_public_address(IpAddr::V6(ip)),
        Host::Domain(domain) => check_public_name(raw, &domain),
    }
}

/// `Ok` when `ip` lies outside every block [`validate_public_host`] refuses, else
/// `NonPublicAddress(ip)`: the check the DNS guard runs on every address a name resolves to. An
/// IPv6 address that carries an IPv4 address (IPv4-mapped, NAT64, 6to4) is judged by that
/// address.
pub fn validate_public_address(ip: IpAddr) -> Result<(), HostError> {
    let public = match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    };
    if public {
        Ok(())
    } else {
        Err(HostError::NonPublicAddress(ip))
    }
}

/// `Ok` for a public domain name as the URL parser gives it (lowercase, IDNA labels in
/// punycode); a refusal names the host as given (`raw`).
pub(crate) fn check_public_name(raw: &str, domain: &str) -> Result<(), HostError> {
    public_name(domain).map_err(|e| match e {
        NameError::Invalid => HostError::Invalid(raw.to_owned()),
        NameError::Localhost => HostError::Localhost(raw.to_owned()),
        NameError::SingleLabel => HostError::SingleLabel(raw.to_owned()),
        NameError::PrivateSuffix(suffix) => HostError::PrivateSuffix(raw.to_owned(), suffix),
    })
}

/// Why a domain name is refused, before it is told in terms of the host given.
enum NameError {
    Invalid,
    Localhost,
    SingleLabel,
    PrivateSuffix(&'static str),
}

/// `Ok` for a public domain name, as the URL parser gives it (lowercase, IDNA labels in
/// punycode); one final dot is ignored.
fn public_name(domain: &str) -> Result<(), NameError> {
    let name = domain.strip_suffix('.').unwrap_or(domain);
    if name.is_empty() || name.split('.').any(str::is_empty) {
        return Err(NameError::Invalid);
    }
    if name == "localhost" || name.ends_with(".localhost") {
        return Err(NameError::Localhost);
    }
    if !name.contains('.') {
        return Err(NameError::SingleLabel);
    }
    match PRIVATE_SUFFIXES
        .iter()
        .find(|suffix| name.rsplit('.').next() == Some(**suffix))
    {
        Some(suffix) => Err(NameError::PrivateSuffix(suffix)),
        None => Ok(()),
    }
}

/// Whether `ip` lies outside every block [`validate_public_host`] refuses.
fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let special = a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224;
    !special
}

/// Whether `ip` lies outside every block [`validate_public_host`] refuses; an address that
/// carries an IPv4 address is judged by that address.
fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = embedded_v4(ip) {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    let special = s[..6] == [0; 6]
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1)
        || (s[0] == 0x100 && s[1..4] == [0; 3])
        || (s[0] == 0x2001 && s[1] == 0xdb8)
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xffc0) == 0xfec0
        || (s[0] & 0xff00) == 0xff00;
    !special
}

/// The IPv4 address an IPv6 address carries: IPv4-mapped (`::ffff:a.b.c.d`), NAT64
/// (`64:ff9b::a.b.c.d`) or 6to4 (`2002:aabb:ccdd::/48`).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let v4 = |hi: u16, lo: u16| {
        let [a, b] = hi.to_be_bytes();
        let [c, d] = lo.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    if let Some(mapped) = ip.to_ipv4_mapped() {
        Some(mapped)
    } else if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        Some(v4(s[6], s[7]))
    } else if s[0] == 0x2002 {
        Some(v4(s[1], s[2]))
    } else {
        None
    }
}

/// The tenant tier of the one [`Egress`] client, behind `jt_app`'s [`TenantHostRegistry`] port:
/// a host enters it only when [`validate_public_host`] accepts it. Cheap to clone; clones share
/// the tier.
#[derive(Clone, Debug)]
pub struct EgressTenantHosts {
    pub egress: Arc<Egress>,
}

impl EgressTenantHosts {
    pub fn new(egress: Arc<Egress>) -> EgressTenantHosts {
        EgressTenantHosts { egress }
    }
}

impl TenantHostRegistry for EgressTenantHosts {
    /// `VALIDATION` "host is not public", with the host in `details.host` and the
    /// [`HostError::key`] in `details.reason`, for whatever [`validate_public_host`] refuses.
    fn check(&self, host: &str) -> Result<(), AppError> {
        validate_public_host(host).map_err(|e| {
            AppError::validation(
                "host is not public",
                json!({ "host": host, "reason": e.key() }),
            )
        })
    }

    fn allow(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError> {
        self.check(host)?;
        self.egress.allow_tenant_host(ws, host);
        Ok(())
    }

    /// Removing a host is always safe, so it is not checked: a host that is not public was never
    /// allowed, and revoking it changes nothing.
    fn revoke(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError> {
        self.egress.revoke_tenant_host(ws, host);
        Ok(())
    }

    /// Never fails: a host [`validate_public_host`] refuses is skipped with a warning.
    fn rebuild_from(&self, ws: WorkspaceId, hosts: Vec<String>) -> Result<usize, AppError> {
        Ok(replace_with_public(&self.egress, ws, hosts))
    }
}

/// Replaces workspace `ws`'s tenant tier with the hosts of `hosts` that [`validate_public_host`]
/// accepts, logging a warning for each other one, and returns how many distinct hosts the tier
/// now holds.
pub(crate) fn replace_with_public(egress: &Egress, ws: WorkspaceId, hosts: Vec<String>) -> usize {
    let public: Vec<String> = hosts
        .into_iter()
        .filter(|host| match validate_public_host(host) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    workspace_id = %ws,
                    host = host.as_str(),
                    reason = e.key(),
                    "skipped a tenant egress host that is not public"
                );
                false
            }
        })
        .collect();
    egress.replace_tenant_hosts(ws, &public)
}

#[cfg(test)]
mod tests {
    use jt_app::error::ErrorCode;

    use super::*;
    use crate::{EgressScope, Url};

    fn reachable(egress: &Egress, ws: WorkspaceId, url: &str) -> bool {
        egress.permits(EgressScope::Tenant(ws), &Url::parse(url).unwrap())
    }

    #[test]
    fn only_public_hosts_enter_the_tenant_tier() {
        let egress = Arc::new(Egress::new(&[]));
        let hosts = EgressTenantHosts::new(Arc::clone(&egress));
        let (ws, other) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());

        hosts.allow(ws, "imap.example.com").unwrap();
        hosts.allow(ws, "imap.example.com").unwrap();
        assert!(reachable(&egress, ws, "https://imap.example.com/"));
        assert!(!reachable(&egress, other, "https://imap.example.com/"));

        for host in ["127.0.0.1", "localhost", "10.0.0.1:993", "[::1]", "nas.lan"] {
            assert_eq!(hosts.check(host).unwrap_err().code, ErrorCode::Validation);
            let err = hosts.allow(ws, host).unwrap_err();
            assert_eq!(err.code, ErrorCode::Validation, "{host}");
            assert_eq!(err.message, "host is not public");
            assert_eq!(err.details["host"], host);
            assert!(err.details["reason"].is_string());
        }
        // Nothing refused entered the tier.
        for url in [
            "https://127.0.0.1/",
            "https://localhost/",
            "https://10.0.0.1:993/",
        ] {
            assert!(!reachable(&egress, ws, url), "{url}");
        }
        assert!(hosts.check("imap.example.com").is_ok());
    }

    #[test]
    fn revoking_takes_a_host_away_and_never_refuses() {
        let egress = Arc::new(Egress::new(&[]));
        let hosts = EgressTenantHosts::new(Arc::clone(&egress));
        let ws = WorkspaceId::new_v7();
        hosts.allow(ws, "hooks.example.com").unwrap();
        hosts.revoke(ws, "hooks.example.com").unwrap();
        assert!(!reachable(&egress, ws, "https://hooks.example.com/"));
        // Nothing to take away: still fine.
        hosts.revoke(ws, "hooks.example.com").unwrap();
        hosts.revoke(ws, "127.0.0.1").unwrap();
        hosts.revoke(ws, "not a host").unwrap();
    }
}
