//! The resolution-time half of the egress guard (the DNS guard).
//!
//! The allowlist judges a URL's host by its text before anything is looked up; this guard judges
//! the addresses the host's name resolves to, when the client connects. [`resolve_public`] looks
//! the name up through the system resolver and keeps only the addresses
//! [`validate_public_address`] accepts: an address in none of the blocks
//! [`crate::validate_public_host`] refuses. That function's documentation is the one list of
//! those blocks (the same code judges both). When no address is left, or the name does not
//! resolve, resolution fails: the request fails before any socket is opened (fail closed).
//!
//! The guard is installed as the egress client's resolver ([`PublicResolver`]), so it covers every
//! name the client looks up, the fixed tier's provider hosts included: a provider host is trusted
//! by name but still refused when it resolves into private space. A URL whose host is an IP
//! literal is never looked up; the allowlist alone judges it (and lets a loopback literal through
//! only in a test build).
//!
//! **One shared check.** Sockets the HTTP client does not open (the mail connector's SMTP and
//! IMAP connections, M2) must resolve their host through [`resolve_public`] too and connect only
//! to the addresses it returns, rather than copy the check.

use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::Host;

use crate::public_host::{HostError, check_public_name, validate_public_address};

/// What a lookup returns: every address of a name, or why there are none.
pub(crate) type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send>>;

/// How a name is looked up: the system resolver, or a scripted answer in this crate's tests.
pub(crate) type Lookup = fn(String, u16) -> LookupFuture;

/// The system resolver (`getaddrinfo`, on a blocking thread).
fn system_lookup(name: String, port: u16) -> LookupFuture {
    Box::pin(async move {
        Ok(tokio::net::lookup_host((name.as_str(), port))
            .await?
            .collect())
    })
}

/// The public addresses of `host`, each with `port`, for connecting to it.
///
/// `host` is a host name or an IP literal (IPv6 in brackets), without a port; surrounding
/// whitespace is ignored. A literal is judged by [`validate_public_address`] and returned as is,
/// without a lookup. A name is first judged by its text (as [`crate::validate_public_host`] does:
/// `localhost`, single labels and private suffixes are refused without a lookup), then looked up
/// through the system resolver; the addresses [`validate_public_address`] refuses are dropped, in
/// the resolver's order otherwise.
///
/// Refused: `Empty` and `Invalid` (a port included), the name refusals of
/// [`crate::validate_public_host`], `NonPublicAddress` for a literal, `Unresolvable` when the
/// lookup fails, and `NoPublicAddress` when it gives no public address.
///
/// In a test build (this crate's tests, or the `test-loopback` feature) the name `localhost` is
/// let through to its loopback addresses, so a test server on this machine can be named.
///
/// **No timeout of its own.** The egress client bounds its own lookups with its connect and
/// total timeouts; any other caller (M2's SMTP and IMAP sockets) wraps this call in
/// `tokio::time::timeout`, or a slow resolver holds it indefinitely.
pub async fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, HostError> {
    resolve_public_with(system_lookup, host, port).await
}

/// [`resolve_public`] over `lookup`.
pub(crate) async fn resolve_public_with(
    lookup: Lookup,
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, HostError> {
    let raw = host.trim();
    if raw.is_empty() {
        return Err(HostError::Empty);
    }
    let domain = match Host::parse(raw).map_err(|_| HostError::Invalid(raw.to_owned()))? {
        Host::Ipv4(ip) => return literal(IpAddr::V4(ip), port),
        Host::Ipv6(ip) => return literal(IpAddr::V6(ip), port),
        Host::Domain(domain) => domain,
    };
    let loopback = loopback_name(&domain);
    if !loopback {
        check_public_name(raw, &domain)?;
    }
    let answers = lookup(domain, port)
        .await
        .map_err(|_| HostError::Unresolvable(raw.to_owned()))?;
    let public: Vec<SocketAddr> = answers
        .into_iter()
        .filter(|addr| {
            validate_public_address(addr.ip()).is_ok() || (loopback && addr.ip().is_loopback())
        })
        .collect();
    if public.is_empty() {
        Err(HostError::NoPublicAddress(raw.to_owned()))
    } else {
        Ok(public)
    }
}

fn literal(ip: IpAddr, port: u16) -> Result<Vec<SocketAddr>, HostError> {
    validate_public_address(ip)?;
    Ok(vec![SocketAddr::new(ip, port)])
}

/// Whether `domain` (lowercase, as the URL parser gives it) is a name a test build lets resolve
/// to this machine: `localhost`, in this crate's tests or with the `test-loopback` feature.
#[cfg(any(test, feature = "test-loopback"))]
fn loopback_name(domain: &str) -> bool {
    domain == "localhost"
}

#[cfg(not(any(test, feature = "test-loopback")))]
fn loopback_name(_domain: &str) -> bool {
    false
}

/// The egress client's resolver: [`resolve_public`] for every name the client looks up. A
/// refusal fails the request before any socket opens; its [`HostError`] travels in the error's
/// source chain, where [`crate::Egress`] finds it.
#[derive(Clone, Copy)]
pub(crate) struct PublicResolver {
    lookup: Lookup,
}

impl PublicResolver {
    /// Through the system resolver.
    pub(crate) fn system() -> PublicResolver {
        PublicResolver {
            lookup: system_lookup,
        }
    }

    /// Through `lookup` (scripted answers in tests).
    #[cfg(test)]
    pub(crate) fn with_lookup(lookup: Lookup) -> PublicResolver {
        PublicResolver { lookup }
    }
}

impl Resolve for PublicResolver {
    /// The port is the URL's, which the client sets on each address; the lookup is asked for 0.
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = self.lookup;
        let name = name.as_str().to_owned();
        Box::pin(async move {
            match resolve_public_with(lookup, &name, 0).await {
                Ok(addrs) => Ok(Box::new(addrs.into_iter()) as Addrs),
                Err(err) => {
                    if !matches!(err, HostError::Unresolvable(_)) {
                        tracing::warn!(
                            host = name.as_str(),
                            reason = err.key(),
                            "the egress dns guard refused a host"
                        );
                    }
                    Err(err.into())
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::net::SocketAddr;
    use std::time::Duration;

    use jt_app::error::{AppError, ErrorCode};
    use jt_tenancy::WorkspaceId;
    use tokio::net::TcpListener;

    use super::*;
    use crate::{
        Egress, EgressError, EgressScope, FIXED_HOSTS, HostError, Method, Request, Url,
        validate_public_address,
    };

    /// A scripted resolver: each name answers with fixed addresses; any other name does not
    /// resolve.
    fn answers(name: String, port: u16) -> LookupFuture {
        Box::pin(async move {
            let ips: &[&str] = match name.as_str() {
                "public.example" => &["10.0.0.1"],
                "loopback.example" => &["127.0.0.1"],
                "metadata.example" => &["169.254.169.254", "fd00:ec2::254"],
                "mixed.example" => &[
                    "10.0.0.1",
                    "93.184.216.34",
                    "fd00::1",
                    "2606:4700:4700::1111",
                    "100.64.0.1",
                    "::ffff:192.168.0.1",
                ],
                "localhost" => &["127.0.0.1", "::1", "10.0.0.1"],
                "graph.facebook.com" => &["192.168.1.1"],
                _ => return Err(io::Error::new(io::ErrorKind::NotFound, "no such host")),
            };
            Ok(ips
                .iter()
                .map(|ip| SocketAddr::new(ip.parse().unwrap(), port))
                .collect())
        })
    }

    /// A resolver that must never be asked.
    fn no_lookup(name: String, _port: u16) -> LookupFuture {
        panic!("{name:?} must be judged without a lookup")
    }

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter().map(|a| a.parse().unwrap()).collect()
    }

    async fn send_refused_as_not_public(egress: &Egress, scope: EgressScope, url: &str) {
        let url = Url::parse(url).unwrap();
        let host = url.host_str().unwrap().to_owned();
        match egress.send(scope, Request::new(Method::GET, url)).await {
            Err(EgressError::NotPublic { host: refused }) => assert_eq!(refused, host),
            other => panic!("expected NotPublic({host}), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dns_guard_refuses_a_public_name_resolving_to_private_space() {
        // The filter itself: the name passes every check on its text, its answer does not.
        for name in ["public.example", "loopback.example", "metadata.example"] {
            assert_eq!(
                resolve_public_with(answers, name, 443).await,
                Err(HostError::NoPublicAddress(name.into())),
                "{name}"
            );
        }

        // Through the egress client: the host is on the workspace's tier, yet no socket opens.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let egress = Egress::with_lookup(&[], answers);
        let ws = WorkspaceId::new_v7();
        for host in ["public.example", "loopback.example", "metadata.example"] {
            egress.allow_tenant_host(ws, host);
            send_refused_as_not_public(
                &egress,
                EgressScope::Tenant(ws),
                &format!("https://{host}:{port}/"),
            )
            .await;
        }
        let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
        assert!(accepted.is_err(), "a refused answer must not be connected");
    }

    #[tokio::test]
    async fn dns_guard_applies_to_fixed_provider_hosts_too() {
        let egress = Egress::with_lookup(FIXED_HOSTS, answers);
        send_refused_as_not_public(
            &egress,
            EgressScope::Connector("meta"),
            "https://graph.facebook.com/v21.0/me",
        )
        .await;
    }

    #[tokio::test]
    async fn dns_guard_keeps_only_the_public_answers() {
        assert_eq!(
            resolve_public_with(answers, "mixed.example", 993).await,
            Ok(addrs(&["93.184.216.34:993", "[2606:4700:4700::1111]:993"]))
        );
    }

    #[tokio::test]
    async fn a_name_that_does_not_resolve_fails_closed() {
        assert_eq!(
            resolve_public_with(answers, "nx.example", 443).await,
            Err(HostError::Unresolvable("nx.example".into()))
        );
        // Through the client it stays a transport failure: nothing was refused, nothing reached.
        let egress = Egress::with_lookup(&[], answers);
        let ws = WorkspaceId::new_v7();
        egress.allow_tenant_host(ws, "nx.example");
        let err = egress
            .send(
                EgressScope::Tenant(ws),
                Request::new(Method::GET, Url::parse("https://nx.example/").unwrap()),
            )
            .await
            .expect_err("nothing resolves");
        assert!(matches!(err, EgressError::Transport(_)), "{err:?}");
    }

    #[tokio::test]
    async fn literals_and_names_are_judged_before_any_lookup() {
        for (host, expected) in [
            ("8.8.8.8", Ok(addrs(&["8.8.8.8:25"]))),
            (
                "[2606:4700:4700::1111]",
                Ok(addrs(&["[2606:4700:4700::1111]:25"])),
            ),
            (
                "10.0.0.1",
                Err(HostError::NonPublicAddress("10.0.0.1".parse().unwrap())),
            ),
            (
                "127.0.0.1",
                Err(HostError::NonPublicAddress("127.0.0.1".parse().unwrap())),
            ),
            (
                "[::1]",
                Err(HostError::NonPublicAddress("::1".parse().unwrap())),
            ),
            (
                "[::ffff:10.0.0.1]",
                Err(HostError::NonPublicAddress(
                    "::ffff:10.0.0.1".parse().unwrap(),
                )),
            ),
            ("intranet", Err(HostError::SingleLabel("intranet".into()))),
            (
                "printer.local",
                Err(HostError::PrivateSuffix("printer.local".into(), "local")),
            ),
            ("", Err(HostError::Empty)),
            (
                "smtp.example.com:25",
                Err(HostError::Invalid("smtp.example.com:25".into())),
            ),
            ("::1", Err(HostError::Invalid("::1".into()))),
            ("not a host", Err(HostError::Invalid("not a host".into()))),
        ] {
            assert_eq!(
                resolve_public_with(no_lookup, host, 25).await,
                expected,
                "{host:?}"
            );
        }
    }

    #[tokio::test]
    async fn localhost_reaches_loopback_only_in_test_builds() {
        // This build tolerates `localhost` (see `loopback_name`), and then only its loopback
        // answers; a production build refuses the name before looking it up.
        assert_eq!(
            resolve_public_with(answers, "localhost", 8080).await,
            Ok(addrs(&["127.0.0.1:8080", "[::1]:8080"]))
        );
        assert_eq!(
            resolve_public_with(answers, "LOCALHOST", 8080).await,
            Ok(addrs(&["127.0.0.1:8080", "[::1]:8080"]))
        );
    }

    #[test]
    fn public_addresses_are_judged_like_public_hosts() {
        for ip in [
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert_eq!(validate_public_address(ip.parse().unwrap()), Ok(()), "{ip}");
        }
        for ip in [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "192.0.2.1",
            "::",
            "::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::7f00:1",
        ] {
            let addr = ip.parse().unwrap();
            assert_eq!(
                validate_public_address(addr),
                Err(HostError::NonPublicAddress(addr)),
                "{ip}"
            );
        }
    }

    #[test]
    fn a_guard_refusal_is_host_not_allowed() {
        let err: AppError = EgressError::NotPublic {
            host: "public.example".into(),
        }
        .into();
        assert_eq!(err.code, ErrorCode::HostNotAllowed);
        assert_eq!(err.details["host"], "public.example");
        assert_eq!(err.details["reason"], "no_public_address");
    }
}
