//! Outbound adapter: the single HTTP egress client, guarded by a hostname allowlist.
//!
//! Every outbound HTTP request in the system goes through [`Egress::send`] (spec §4.3). The URL's
//! host is checked before any DNS lookup or socket against one of two tiers, chosen by the
//! request's [`EgressScope`]:
//! - the fixed tier ([`FIXED_HOSTS`]): provider hosts per connector, part of the code;
//! - the tenant tier: hosts a workspace declared in its capability records, managed at runtime
//!   with [`Egress::allow_tenant_host`] and [`Egress::revoke_tenant_host`]. Use cases reach it
//!   through [`EgressTenantHosts`], `jt_app`'s `TenantHostRegistry`, which lets in only hosts on
//!   the public internet ([`validate_public_host`]).
//!
//! Only `https` is accepted. Redirects are never followed.
//!
//! Callers build a [`Request`] with `Request::new(method, url)` and the re-exported types below;
//! `reqwest::Client` is deliberately not re-exported.

mod allowlist;
mod client;
mod public_host;

pub use allowlist::{AllowedHost, FIXED_HOSTS};
pub use client::{Egress, EgressError, EgressScope};
pub use public_host::{EgressTenantHosts, HostError, PRIVATE_SUFFIXES, validate_public_host};

pub use reqwest::{Body, Method, Request, Response, StatusCode, Url, header};

/// The egress tests run inside this crate's own test build, where `cfg(test)` tolerates plain
/// http to loopback literals (see `tests/egress.rs`).
#[cfg(test)]
#[path = "../tests/egress.rs"]
mod egress;
