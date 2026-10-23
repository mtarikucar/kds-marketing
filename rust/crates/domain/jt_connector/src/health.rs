//! Probe results and what they do to a capability's stored status (spec §6.4: a connector is
//! verified by the system's own trial call).

use jt_capability::StoredStatus;
use serde_json::{Map, Value};

use crate::error::ConnectorError;

/// The outcome of one probe: a cheap authenticated call to the provider. Build it with
/// [`ProbeResult::success`] or [`ProbeResult::failure`]; if `ok` and `error` ever disagree,
/// `ok` decides ([`status_after_probe`]).
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeResult {
    /// Whether the call succeeded.
    pub ok: bool,
    /// How long the call took.
    pub latency_ms: u32,
    /// Why it failed; `None` when it succeeded.
    pub error: Option<ConnectorError>,
    /// Non-secret facts the call returned (a page name, a balance, granted scopes). A success
    /// names, as a string in `account_id`, the identity the credential itself authenticates as;
    /// without it the capability is never verified. Screened for secret-looking keys before they
    /// are shown or stored. `{}` when none.
    pub facts: Value,
}

impl ProbeResult {
    /// A successful probe with the facts it returned.
    pub fn success(latency_ms: u32, facts: Value) -> ProbeResult {
        ProbeResult {
            ok: true,
            latency_ms,
            error: None,
            facts,
        }
    }

    /// A failed probe: no facts.
    pub fn failure(latency_ms: u32, error: ConnectorError) -> ProbeResult {
        ProbeResult {
            ok: false,
            latency_ms,
            error: Some(error),
            facts: Value::Object(Map::new()),
        }
    }
}

/// The stored status a capability gets after probe `r`, from `prev`:
///
/// - a `Retired` capability stays `Retired`, whatever the result;
/// - success makes it `Verified`;
/// - `Auth`, `Permission` and `Permanent` make it `Unreachable`, and so does a failure the
///   adapter did not explain (`ok == false` without an error);
/// - `Throttle` and `Transient` leave it as it was: the provider was busy, which says nothing
///   about the connection.
pub fn status_after_probe(prev: StoredStatus, r: &ProbeResult) -> StoredStatus {
    if prev == StoredStatus::Retired {
        return StoredStatus::Retired;
    }
    if r.ok {
        return StoredStatus::Verified;
    }
    match &r.error {
        Some(ConnectorError::Throttle { .. } | ConnectorError::Transient { .. }) => prev,
        Some(
            ConnectorError::Auth { .. }
            | ConnectorError::Permission { .. }
            | ConnectorError::Permanent { .. },
        )
        | None => StoredStatus::Unreachable,
    }
}
