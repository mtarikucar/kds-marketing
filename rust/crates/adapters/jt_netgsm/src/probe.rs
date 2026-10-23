//! Probes: one cheap authenticated read per kind, which names the account the credential itself
//! authenticates as (`facts.account_id`, see `jt_app::ports::connectors::Connector::probe`):
//!
//! | Kind | Credential | Calls | `account_id` | Other facts |
//! |---|---|---|---|---|
//! | `sms_line` | SMS | `POST /balance {stip: 3}`, then `GET /sms/rest/v2/msgheader` | the credential's sender name (`msgheader`), once NetGSM lists it among the account's approved names | `balance {credit, packages}`, `headers_approved: true` |
//! | `netgsm_pbx` | PBX | `GET {pbx}/{username}/queuestats` | the PBX user name the PBX accepted | none |
//!
//! A sender name NetGSM does not list (compared exactly) fails `Permission`
//! ("msgheader not approved"); refused credentials fail before the sender names are asked for.
//! The account is never taken from `public`. Without a NetGSM kind in `public["kind_key"]` the
//! probe fails `Permanent` ("kind_key missing") and calls nothing, and so does a credential that
//! is not the kind's.

use std::time::Instant;

use jt_connector::{ConnectorError, Credential, ProbeResult};
use serde_json::{Value, json};

use crate::NetgsmConnector;
use crate::credential::{PbxCred, SmsCred, kind_of, wrong_credential};
use crate::santral;

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &NetgsmConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = facts(connector, cred, public).await;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

/// The facts of a successful probe (see the module docs).
async fn facts(
    connector: &NetgsmConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    match (kind_of(public)?, cred) {
        ("sms_line", Credential::NetgsmSms { .. }) => {
            let sms = SmsCred::of(cred, "be probed")?;
            let balance = connector.balance_of(sms.usercode, sms.password).await?;
            let headers = connector.msgheaders_of(sms.usercode, sms.password).await?;
            let wanted = sms.msgheader.trim();
            if !headers.iter().any(|h| h.trim() == wanted) {
                return Err(ConnectorError::permission("msgheader not approved"));
            }
            Ok(json!({
                "account_id": sms.msgheader,
                "balance": balance.facts(),
                "headers_approved": true,
            }))
        }
        ("netgsm_pbx", Credential::NetgsmPbx { .. }) => {
            let pbx = PbxCred::of(cred, "be probed")?;
            santral::queuestats(connector, &pbx).await?;
            Ok(json!({ "account_id": pbx.username }))
        }
        (kind, other) => Err(wrong_credential(other, &format!("be probed as {kind}"))),
    }
}
