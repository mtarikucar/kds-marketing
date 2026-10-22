//! The egress client: checks the allowlist, then hands the request to the one reqwest client.

use std::time::Duration;

use jt_app::error::AppError;
use jt_tenancy::WorkspaceId;
use reqwest::redirect::Policy;

use crate::allowlist::{AllowedHost, Allowlist};

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
#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    /// The URL's host is not allowed for the scope, or its scheme is not (only `https` is).
    /// Nothing was resolved or connected.
    #[error("outbound host {host:?} is not allowed")]
    HostNotAllowed { host: String },
    /// The request was allowed but failed in transit (DNS, connect, TLS, timeout, body).
    #[error("outbound transport failed")]
    Transport(#[source] reqwest::Error),
}

impl From<EgressError> for AppError {
    /// A refusal is `HOST_NOT_ALLOWED`; a transport failure is `INTERNAL`, worded without the URL
    /// so a query-string secret can never reach a client.
    fn from(err: EgressError) -> Self {
        match err {
            EgressError::HostNotAllowed { host } => AppError::host_not_allowed(host),
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

/// The only HTTP client in the system. Every outbound request goes through `send`, which checks
/// the URL against the scope's allowlist tier before any DNS lookup or socket.
///
/// Requests are built with `Request::new` (re-exported at the crate root); there is deliberately
/// no way to obtain the underlying `reqwest::Client` or a `RequestBuilder`, whose own `send`
/// would skip the allowlist. Cheap to clone; clones share the tenant tier.
#[derive(Clone, Debug)]
pub struct Egress {
    client: reqwest::Client,
    allowlist: Allowlist,
}

impl Egress {
    /// Builds the client with `fixed` as the fixed tier (production passes `FIXED_HOSTS`) and an
    /// empty tenant tier.
    ///
    /// Redirects are never followed, so a redirect cannot escape the allowlist: a 3xx comes back
    /// as a normal response. Proxy settings from the environment are ignored.
    ///
    /// # Panics
    /// When a fixed entry is not a valid host, or the TLS backend cannot be initialised.
    pub fn new(fixed: &'static [AllowedHost]) -> Egress {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .user_agent(USER_AGENT)
            .no_proxy()
            .build()
            .expect("the egress HTTP client must build");
        Egress {
            client,
            allowlist: Allowlist::new(fixed),
        }
    }

    /// Adds `host` (`host` or `host:port`, IPv6 in brackets) to the workspace's tenant tier. A
    /// value that is not a valid host is ignored, so it can never allow anything.
    pub fn allow_tenant_host(&self, ws: WorkspaceId, host: &str) {
        if !self.allowlist.allow_tenant(ws, host) {
            tracing::warn!(workspace_id = %ws, host, "ignored an invalid tenant egress host");
        }
    }

    /// Removes `host` from the workspace's tenant tier; a no-op when it is not there.
    pub fn revoke_tenant_host(&self, ws: WorkspaceId, host: &str) {
        self.allowlist.revoke_tenant(ws, host);
    }

    /// Whether `url` passes the allowlist for `scope`, without sending anything.
    #[cfg(test)]
    pub(crate) fn permits(&self, scope: EgressScope, url: &reqwest::Url) -> bool {
        self.allowlist.check(scope, url).is_ok()
    }

    /// Sends `req` if its URL is allowed for `scope`; otherwise returns `HostNotAllowed` without
    /// resolving or connecting anything.
    pub async fn send(
        &self,
        scope: EgressScope,
        req: reqwest::Request,
    ) -> Result<reqwest::Response, EgressError> {
        if let Err(host) = self.allowlist.check(scope, req.url()) {
            tracing::warn!(?scope, host, "refused an outbound request");
            return Err(EgressError::HostNotAllowed { host });
        }
        self.client
            .execute(req)
            .await
            .map_err(EgressError::Transport)
    }
}
