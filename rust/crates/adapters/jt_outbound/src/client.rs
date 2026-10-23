//! The egress client: checks the allowlist, then hands the request to the one reqwest client,
//! whose resolver is the DNS guard.

use std::error::Error as _;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use jt_app::error::AppError;
use jt_tenancy::WorkspaceId;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use reqwest::{Body, Method, Url, multipart};
use serde::Serialize;
use serde_json::json;

use crate::allowlist::{AllowedHost, Allowlist};
use crate::dns_guard::PublicResolver;
use crate::public_host::{HostError, validate_public_host};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
const USER_AGENT: &str = "jeeta/0.1";

/// Whose allowlist a request is checked against. The scope decides the tier: there is no
/// cross-tier access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressScope {
    /// A connector, which may reach only the fixed-tier hosts carrying its name.
    Connector(&'static str),
    /// A workspace, which may reach only the hosts it declared in its tenant tier.
    Tenant(WorkspaceId),
}

/// Why an outbound request did not produce a response.
///
/// No variant carries the request's URL: a query string may hold a credential.
#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    /// The URL's host is not allowed for the scope, or its scheme is not (only `https` is, but
    /// for the provider exception and in test builds). Nothing was resolved or connected.
    #[error("outbound host {host:?} is not allowed")]
    HostNotAllowed { host: String },
    /// The host is allowed, but the DNS guard refused it: it resolves to no public address (or
    /// its name is one only a private network resolves). Nothing was connected.
    #[error("outbound host {host:?} resolves to no public address")]
    NotPublic { host: String },
    /// The request could not be built (an invalid header, a body that does not serialise).
    /// Nothing was checked or sent.
    #[error("outbound request could not be built")]
    Build(#[source] reqwest::Error),
    /// A raw socket could not resolve/connect within its deadline. No provider text is kept.
    #[error("outbound socket failed")]
    Socket,

    /// The request was allowed but failed in transit (DNS, connect, TLS, timeout, body).
    #[error("outbound transport failed")]
    Transport(#[source] reqwest::Error),
}

impl From<EgressError> for AppError {
    /// A refusal is `HOST_NOT_ALLOWED` (a DNS-guard refusal with `details.reason =
    /// "no_public_address"`); a build or transport failure is `INTERNAL`, worded without the URL
    /// so a query-string secret can never reach a client.
    fn from(err: EgressError) -> Self {
        match err {
            EgressError::HostNotAllowed { host } => AppError::host_not_allowed(host),
            EgressError::NotPublic { host } => {
                let mut err = AppError::host_not_allowed(host);
                err.details["reason"] = json!("no_public_address");
                err
            }
            EgressError::Socket => AppError::internal("outbound socket failed"),
            EgressError::Build(_) => AppError::internal("outbound request could not be built"),
            EgressError::Transport(err) => {
                let what = if err.is_timeout() {
                    "timed out"
                } else if err.is_connect() {
                    "could not connect"
                } else {
                    "failed"
                };
                AppError::internal(format!("outbound request {what}"))
            }
        }
    }
}

/// The only HTTP client in the system. Every outbound request goes through [`Egress::send`] or
/// [`Prepared::send`], which check the URL against the scope's allowlist tier before any DNS
/// lookup or socket; the names the client then looks up go through the DNS guard
/// ([`crate::resolve_public`]).
///
/// Requests are built with [`Egress::prepare`] or `Request::new` (re-exported at the crate root);
/// there is deliberately no way to obtain the underlying `reqwest::Client` or a
/// `RequestBuilder`, whose own `send` would skip the allowlist. Cheap to clone; clones share the
/// tenant tier.
///
/// **A response carries the request's URL.** [`EgressError`] never does, but the `Response` a
/// send returns does: `Response::url()`, and the error of `Response::error_for_status()`, hold
/// the full URL, query string included, and a provider such as NetGSM takes its credentials in
/// the query string. A connector maps the status itself and never logs, stores or returns
/// either of them raw; text that may hold a URL goes through `jt_connector::redact_reason`
/// first.
#[derive(Clone, Debug)]
pub struct Egress {
    client: reqwest::Client,
    allowlist: Allowlist,
    pub(crate) resolver: PublicResolver,
}

impl Egress {
    /// Builds the client with `fixed` as the fixed tier (production passes `FIXED_HOSTS`), an
    /// empty tenant tier and the DNS guard over the system resolver.
    ///
    /// Redirects are never followed, so a redirect cannot escape the allowlist: a 3xx comes back
    /// as a normal response. Proxy settings from the environment are ignored.
    ///
    /// # Panics
    /// When a fixed entry is not a valid host, or the TLS backend cannot be initialised.
    pub fn new(fixed: &'static [AllowedHost]) -> Egress {
        Egress::build(fixed, PublicResolver::system())
    }

    /// [`Egress::new`] with a scripted DNS guard lookup.
    #[cfg(test)]
    pub(crate) fn with_lookup(
        fixed: &'static [AllowedHost],
        lookup: crate::dns_guard::Lookup,
    ) -> Egress {
        Egress::build(fixed, PublicResolver::with_lookup(lookup))
    }

    /// Scripted resolution for deterministic socket security tests. Answers still pass the
    /// production address filter; this cannot grant access to private answers.
    #[cfg(feature = "test-loopback")]
    pub fn with_test_lookup(
        fixed: &'static [AllowedHost],
        lookup: crate::dns_guard::Lookup,
    ) -> Egress {
        Egress::build(fixed, PublicResolver::with_lookup(lookup))
    }

    fn build(fixed: &'static [AllowedHost], resolver: PublicResolver) -> Egress {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .user_agent(USER_AGENT)
            .no_proxy()
            .dns_resolver(Arc::new(resolver))
            .build()
            .expect("the egress HTTP client must build");
        Egress {
            client,
            allowlist: Allowlist::new(fixed),
            resolver,
        }
    }

    /// Adds test hosts to the fixed tier: each `(connector, host)` lets that connector's scope
    /// reach `host` (`127.0.0.1`, `[::1]` or `localhost`, usually with the port of an
    /// in-process mock), over plain http too. For other crates' tests, through the
    /// `test-loopback` feature; a production build has no such method.
    ///
    /// # Panics
    /// When a host is not one of those three, with or without a port.
    #[cfg(any(test, feature = "test-loopback"))]
    pub fn with_test_hosts<S: AsRef<str>>(
        mut self,
        extra: impl IntoIterator<Item = (&'static str, S)>,
    ) -> Egress {
        self.allowlist.add_test_hosts(extra);
        self
    }

    /// Adds `host` (`host` or `host:port`, IPv6 in brackets) to the workspace's tenant tier when
    /// it is on the public internet ([`validate_public_host`]). Anything else (a private,
    /// loopback or other non-public IP literal, a name only a private network resolves, a value
    /// that is not a host) is ignored with a warning, so it can never allow anything: an IP
    /// literal never reaches the DNS guard, so this is the check that keeps it out. A test build
    /// also lets in `localhost`, `127.0.0.1` and `[::1]`, for in-process test servers.
    pub fn allow_tenant_host(&self, ws: WorkspaceId, host: &str) {
        if !loopback_tolerated(host)
            && let Err(e) = validate_public_host(host)
        {
            tracing::warn!(
                workspace_id = %ws,
                host,
                reason = e.key(),
                "ignored a tenant egress host that is not public"
            );
            return;
        }
        if !self.allowlist.allow_tenant(ws, host) {
            tracing::warn!(workspace_id = %ws, host, "ignored an invalid tenant egress host");
        }
    }

    /// Removes `host` from the workspace's tenant tier; a no-op when it is not there.
    pub fn revoke_tenant_host(&self, ws: WorkspaceId, host: &str) {
        self.allowlist.revoke_tenant(ws, host);
    }

    /// Replaces the workspace's tenant tier with `hosts` (not checked for being public: callers
    /// check first) and returns how many distinct valid hosts it now holds.
    pub(crate) fn replace_tenant_hosts(&self, ws: WorkspaceId, hosts: &[String]) -> usize {
        self.allowlist.replace_tenant(ws, hosts)
    }

    /// Whether `url` passes the allowlist for `scope`, without sending anything (no DNS lookup
    /// either): what the start-up rebuild of the tenant tier left in it can be checked.
    pub fn permits(&self, scope: EgressScope, url: &Url) -> bool {
        self.allowlist.check(scope, url).is_ok()
    }

    /// Starts a request to `url`, to be finished with the [`Prepared`] builder and sent only
    /// through [`Prepared::send`].
    pub fn prepare(&self, method: Method, url: Url) -> Prepared {
        Prepared {
            egress: self.clone(),
            builder: self.client.request(method, url),
        }
    }

    /// Sends `req` if its URL is allowed for `scope`; otherwise returns `HostNotAllowed` without
    /// resolving or connecting anything. A name the DNS guard refuses is `NotPublic`, also
    /// without a socket.
    ///
    /// The `Response`'s `url()` and its `error_for_status()` error carry the request URL with its
    /// query string: never log them raw (see [`Egress`]).
    pub async fn send(
        &self,
        scope: EgressScope,
        req: reqwest::Request,
    ) -> Result<reqwest::Response, EgressError> {
        if let Err(host) = self.allowlist.check(scope, req.url()) {
            tracing::warn!(?scope, host, "refused an outbound request");
            return Err(EgressError::HostNotAllowed { host });
        }
        let host = req.url().host_str().unwrap_or_default().to_owned();
        self.client.execute(req).await.map_err(|err| {
            if refused_by_dns_guard(&err) {
                EgressError::NotPublic { host }
            } else {
                EgressError::Transport(err.without_url())
            }
        })
    }
}

/// Whether `host` is an entry for this machine that a test build lets into the tenant tier.
#[cfg(any(test, feature = "test-loopback"))]
fn loopback_tolerated(host: &str) -> bool {
    crate::allowlist::is_loopback_entry(host)
}

#[cfg(not(any(test, feature = "test-loopback")))]
fn loopback_tolerated(_host: &str) -> bool {
    false
}

/// Whether `err` comes from a DNS guard refusal: a [`HostError`] other than `Unresolvable` (a
/// name that does not resolve is a transport failure like any other) in its source chain.
fn refused_by_dns_guard(err: &reqwest::Error) -> bool {
    let mut source = err.source();
    while let Some(cause) = source {
        if let Some(host_err) = cause.downcast_ref::<HostError>() {
            return !matches!(host_err, HostError::Unresolvable(_));
        }
        source = cause.source();
    }
    false
}

/// A request being built for [`Egress`], from [`Egress::prepare`]. It owns what it needs, so it
/// can be built in steps and moved across tasks; its one way out is [`Prepared::send`], which
/// checks the allowlist exactly as [`Egress::send`] does.
///
/// A step that cannot be applied (an invalid header, a body that does not serialise) is reported
/// by `send` as [`EgressError::Build`], and nothing is sent.
#[must_use = "a prepared request does nothing until it is sent"]
pub struct Prepared {
    egress: Egress,
    builder: reqwest::RequestBuilder,
}

impl fmt::Debug for Prepared {
    /// Shows nothing of the request: its URL or headers may carry a credential.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Prepared").finish_non_exhaustive()
    }
}

impl Prepared {
    fn map(self, step: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder) -> Self {
        Prepared {
            egress: self.egress,
            builder: step(self.builder),
        }
    }

    /// Adds a header (a name and a value, e.g. `header::AUTHORIZATION` or `"x-hub-signature"`).
    pub fn header<K, V>(self, name: K, value: V) -> Prepared
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.map(|b| b.header(name, value))
    }

    /// Appends `query` (e.g. `&[("fields", "id,name")]`) to the URL's query string, encoded.
    pub fn query<T: Serialize + ?Sized>(self, query: &T) -> Prepared {
        self.map(|b| b.query(query))
    }

    /// Sets a JSON body, with `Content-Type: application/json`.
    pub fn json<T: Serialize + ?Sized>(self, json: &T) -> Prepared {
        self.map(|b| b.json(json))
    }

    /// Sets a form body, with `Content-Type: application/x-www-form-urlencoded`.
    pub fn form<T: Serialize + ?Sized>(self, form: &T) -> Prepared {
        self.map(|b| b.form(form))
    }

    /// Sets a `multipart/form-data` body (for file uploads).
    pub fn multipart(self, form: multipart::Form) -> Prepared {
        self.map(|b| b.multipart(form))
    }

    /// Sets a raw body (e.g. the bytes of a media upload).
    pub fn body<B: Into<Body>>(self, body: B) -> Prepared {
        self.map(|b| b.body(body))
    }

    /// Sets HTTP basic authentication; the header is marked sensitive.
    pub fn basic_auth<U: fmt::Display, P: fmt::Display>(
        self,
        username: U,
        password: Option<P>,
    ) -> Prepared {
        self.map(|b| b.basic_auth(username, password))
    }

    /// Sets `Authorization: Bearer <token>`; the header is marked sensitive.
    pub fn bearer<T: fmt::Display>(self, token: T) -> Prepared {
        self.map(|b| b.bearer_auth(token))
    }

    /// Bounds this request (connect to end of body) by `timeout` instead of the client's 60 s.
    pub fn timeout(self, timeout: Duration) -> Prepared {
        self.map(|b| b.timeout(timeout))
    }

    /// Builds the request and sends it as [`Egress::send`] does: refused (`HostNotAllowed`)
    /// without resolving or connecting anything when the final URL is not allowed for `scope`.
    ///
    /// The `Response`'s `url()` and its `error_for_status()` error carry the request URL with its
    /// query string, credentials included: map the status yourself and never log them raw (use
    /// `jt_connector::redact_reason` on any text that may hold one; see [`Egress`]).
    pub async fn send(self, scope: EgressScope) -> Result<reqwest::Response, EgressError> {
        let req = self
            .builder
            .build()
            .map_err(|err| EgressError::Build(err.without_url()))?;
        self.egress.send(scope, req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reaches(egress: &Egress, ws: WorkspaceId, url: &str) -> bool {
        egress.permits(EgressScope::Tenant(ws), &Url::parse(url).unwrap())
    }

    #[test]
    fn allow_tenant_host_refuses_private_literals() {
        let egress = Egress::new(&[]);
        let ws = WorkspaceId::new_v7();
        for host in [
            "10.0.0.5",
            "10.0.0.5:993",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "127.0.0.2",
            "224.0.0.1",
            "[fd00::1]",
            "[fe80::1]",
            "[::ffff:10.0.0.1]",
            "[64:ff9b::10.0.0.1]",
            "nas.lan",
            "intranet",
            "printer.local",
        ] {
            egress.allow_tenant_host(ws, host);
            assert!(
                !reaches(&egress, ws, &format!("https://{host}/")),
                "{host} must not enter the tenant tier"
            );
        }
        // A value that is not a host is ignored as before.
        egress.allow_tenant_host(ws, "not a host");

        // Public hosts still enter.
        for host in [
            "imap.example.com:993",
            "93.184.216.34",
            "[2606:4700:4700::1111]",
        ] {
            egress.allow_tenant_host(ws, host);
            assert!(reaches(&egress, ws, &format!("https://{host}/")), "{host}");
        }
        // This test build lets this machine in, for the in-process test servers.
        egress.allow_tenant_host(ws, "127.0.0.1");
        assert!(reaches(&egress, ws, "http://127.0.0.1/"));
    }

    // This crate's own test build carries the test-only loopback paths.
    const _: () = assert!(crate::TEST_LOOPBACK_ENABLED);
}
