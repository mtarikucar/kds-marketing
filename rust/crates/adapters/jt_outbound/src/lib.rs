//! Outbound adapter: the single HTTP egress client, guarded by a hostname allowlist and a DNS
//! guard.
//!
//! Every outbound HTTP request in the system goes through [`Egress::send`] or
//! [`Prepared::send`] (spec §4.3). The URL's host is checked before any DNS lookup or socket
//! against one of two tiers, chosen by the request's [`EgressScope`]:
//! - the fixed tier ([`FIXED_HOSTS`]): provider hosts per connector, part of the code;
//! - the tenant tier: hosts a workspace declared in its capability records, managed at runtime
//!   with [`Egress::allow_tenant_host`] and [`Egress::revoke_tenant_host`]. Use cases reach it
//!   through [`EgressTenantHosts`], `jt_app`'s `TenantHostRegistry`, which lets in only hosts on
//!   the public internet ([`validate_public_host`]). The tier lives in memory;
//!   [`rebuild_tenant_hosts`] fills it from the capability records at start-up.
//!
//! Then, when the client connects, the DNS guard ([`resolve_public`], the client's resolver)
//! drops every address a name resolves to that is not public ([`validate_public_address`]) and
//! fails the request when none is left, for both tiers: a public name pointed at a private
//! network is never reached. Sockets opened outside this client (SMTP and IMAP, M2) resolve
//! through [`resolve_public`] too.
//!
//! Only `https` is accepted, but for one provider limitation: NetGSM's Netsantral click-to-call
//! endpoint, plain `http` on `crmsntrl.netgsm.com.tr:9111`, under the `netgsm` connector's scope
//! only ([`PLAIN_HTTP_EXCEPTIONS`], [`allow_plain_http`]). Redirects are never followed.
//!
//! Callers build a request with [`Egress::prepare`] (or `Request::new(method, url)`) and the
//! re-exported types below, so a connector crate never names `reqwest` itself;
//! `reqwest::Client` and `reqwest::RequestBuilder` are deliberately not reachable.
//!
//! # The `test-loopback` feature
//!
//! For the tests of other crates (a provider adapter against an in-process mock on 127.0.0.1),
//! the feature tolerates plain http to this machine (`127.0.0.1`, `[::1]`, `localhost`), lets the
//! DNS guard resolve `localhost` to its loopback addresses, and adds `Egress::with_test_hosts`,
//! which puts such a host on a connector's fixed tier. This crate's own tests get the same through
//! `cfg(test)`. Only `[dev-dependencies]` sections may enable it and `bin/jeeta` never does
//! (`jt_archtest` asserts both), so a production build has none of it.

mod allowlist;
mod client;
mod dns_guard;
mod fixed_hosts;
mod public_host;
mod tenant_rebuild;

pub use allowlist::AllowedHost;
pub use client::{Egress, EgressError, EgressScope, Prepared};
pub use dns_guard::resolve_public;
pub use fixed_hosts::{FIXED_HOSTS, PLAIN_HTTP_EXCEPTIONS, allow_plain_http};
pub use public_host::{
    EgressTenantHosts, HostError, PRIVATE_SUFFIXES, validate_public_address, validate_public_host,
};
pub use tenant_rebuild::{RebuildReport, rebuild_tenant_hosts};

pub use reqwest::{Body, Method, Request, Response, StatusCode, Url, header, multipart};

/// The egress tests run inside this crate's own test build, where `cfg(test)` tolerates plain
/// http to loopback literals (see `tests/egress.rs`).
#[cfg(test)]
#[path = "../tests/egress.rs"]
mod egress;
