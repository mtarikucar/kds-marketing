//! Netsantral, NetGSM's cloud PBX: placing calls (`originate`, `linkup`), ending them (`hangup`),
//! the queue statistics the probe reads (`queuestats`), and the call records
//! (`/netsantral/report` on the API host).
//!
//! The PBX verbs are `GET {pbx}/{username}/{verb}?username&password&…` over plain http (the
//! provider serves them no other way, see `jt_outbound`), so their URL holds the password and is
//! never logged or quoted. Placing a call:
//!
//! | `public["call_mode"]` | Verb | Rings first | Parameters |
//! |---|---|---|---|
//! | absent or `"originate"` | `originate` | the extension `from_ext` | `customer_num`, `internal_num`, `pbxnum` |
//! | `"linkup"` | `linkup` | the rep's own phone `from_ext` (no extension or softphone needed) | `caller`, `called` |
//!
//! both with `trunk` (the credential's; required), `ring_timeout=30`, `wait_response=0`,
//! `originate_order=if` and a fresh `crm_id`, which is the receipt's provider id: with
//! `wait_response=0` NetGSM answers no call id, and its call events carry the `crm_id`. The
//! `caller_record=1` and `called_record=1` flags are passed only when `public["recording_allowed"]`
//! is the boolean `true` (the workspace's recording policy); otherwise calls are not recorded.
//!
//! Placing a call and hanging up are actions: sent once, never retried by the adapter (a second
//! `originate` would ring the customer twice). `queuestats` and the call records are reads,
//! retried when no answer arrived. `hangup` takes the PBX's own call id (`unique_id`, from the call
//! events), never the `crm_id` a placed call's receipt carries: an id shaped like a `crm_id` (32
//! hex digits) is refused.
//!
//! An answer is a JSON object (`{status, message, code?}`, an error naming `"Error"`, a success
//! code `00` accepted) or, on a 2xx answer, plain text led by a code (`00`–`02` accepted); a
//! failure with a code maps by the crate's table, the answer "Kullanici dogrulanamadi" (user not
//! verified) is `Auth`, any other failure `Permanent`. A non-2xx answer in plain text is read by
//! its HTTP status (a proxy's `502 Bad Gateway` is `Transient`).
//!
//! Call records keep no recording link's query string (it carries the provider's token), in the
//! normalised fields and in the `raw` copy alike (see [`crate::webhook`]).

use jt_app::ports::connectors::{InboundEventDraft, SendReceipt};
use jt_connector::{ConnectorError, Credential, EventKind};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::NetgsmConnector;
use crate::client::{
    AUTH_HINT, Answer, Auth, Body, Retry, code_error, is_success, quoted, status_error, unreadable,
};
use crate::credential::PbxCred;
use crate::json::{pick, pick_number};
use crate::sms::phone_digits;
use crate::tr_time::{fmt_tr, parse_tr};
use crate::webhook;

/// How long the first leg rings, in seconds.
const RING_TIMEOUT: &str = "30";

/// The longest extension taken, in digits.
const MAX_EXTENSION_DIGITS: usize = 16;

/// How a call is placed (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallMode {
    Originate,
    Linkup,
}

impl CallMode {
    fn of(public: &Value) -> Result<CallMode, ConnectorError> {
        match &public["call_mode"] {
            Value::Null => Ok(CallMode::Originate),
            Value::String(mode) if mode == "originate" => Ok(CallMode::Originate),
            Value::String(mode) if mode == "linkup" => Ok(CallMode::Linkup),
            _ => Err(ConnectorError::permanent(
                "call_mode is neither originate nor linkup",
            )),
        }
    }
}

/// Whether the workspace's policy lets calls be recorded: `public["recording_allowed"]` is the
/// boolean `true`, nothing else.
fn recording_allowed(public: &Value) -> bool {
    public["recording_allowed"] == Value::Bool(true)
}

/// `ext` when it is an extension: 1 to 16 ASCII digits.
fn extension(ext: &str) -> Result<&str, ConnectorError> {
    let ext = ext.trim();
    let valid = !ext.is_empty()
        && ext.len() <= MAX_EXTENSION_DIGITS
        && ext.bytes().all(|b| b.is_ascii_digit());
    if valid {
        Ok(ext)
    } else {
        Err(ConnectorError::permanent("not a PBX extension"))
    }
}

/// A call's PBX id without the `sip<digits>-` prefix some deliveries carry.
pub(crate) fn bare_unique_id(id: &str) -> &str {
    let id = id.trim();
    if let Some(rest) = id
        .get(..3)
        .filter(|p| p.eq_ignore_ascii_case("sip"))
        .map(|_| &id[3..])
    {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest.as_bytes().get(digits) == Some(&b'-') {
            return &rest[digits + 1..];
        }
    }
    id
}

/// Places a call (see the module docs); the receipt's provider id is the call's `crm_id`.
pub(crate) async fn click_to_call(
    connector: &NetgsmConnector,
    cred: &Credential,
    public: &Value,
    from: &str,
    to: &str,
) -> Result<SendReceipt, ConnectorError> {
    let pbx = PbxCred::of(cred, "place calls")?;
    let mode = CallMode::of(public)?;
    let trunk = pbx
        .trunk
        .map(|t| phone_digits(t, "trunk"))
        .transpose()?
        .ok_or_else(|| ConnectorError::permanent("the PBX trunk is not set"))?;
    let called = phone_digits(to, "number to call")?;
    let crm_id = Uuid::now_v7().simple().to_string();
    let mut query: Vec<(&str, String)> = vec![
        ("username", pbx.username.to_owned()),
        ("password", pbx.password.to_owned()),
    ];
    let verb = match mode {
        CallMode::Originate => {
            query.push(("customer_num", called));
            query.push(("pbxnum", pbx.pbxnum.unwrap_or_default().trim().to_owned()));
            query.push(("internal_num", extension(from)?.to_owned()));
            "originate"
        }
        CallMode::Linkup => {
            query.push(("caller", phone_digits(from, "rep's number")?));
            query.push(("called", called));
            "linkup"
        }
    };
    query.push(("ring_timeout", RING_TIMEOUT.to_owned()));
    query.push(("crm_id", crm_id.clone()));
    query.push(("wait_response", "0".to_owned()));
    query.push(("originate_order", "if".to_owned()));
    query.push(("trunk", trunk));
    if recording_allowed(public) {
        query.push(("caller_record", "1".to_owned()));
        query.push(("called_record", "1".to_owned()));
    }
    pbx_call(connector, &pbx, verb, &query, Retry::Never).await?;
    Ok(SendReceipt {
        provider_id: crm_id,
        cost_minor: None,
    })
}

/// Ends the live call whose PBX id is `call_id` (the `unique_id` of its call events).
pub(crate) async fn hangup(
    connector: &NetgsmConnector,
    cred: &Credential,
    call_id: &str,
) -> Result<(), ConnectorError> {
    let pbx = PbxCred::of(cred, "end calls")?;
    let unique_id = bare_unique_id(call_id);
    if unique_id.is_empty() {
        return Err(ConnectorError::permanent("no call id to hang up"));
    }
    if looks_like_crm_id(unique_id) {
        return Err(ConnectorError::permanent(
            "hangup takes the PBX's call id from the call events, not the crm_id of the receipt",
        ));
    }
    let query = [
        ("username", pbx.username.to_owned()),
        ("password", pbx.password.to_owned()),
        ("unique_id", unique_id.to_owned()),
    ];
    pbx_call(connector, &pbx, "hangup", &query, Retry::Never).await?;
    Ok(())
}

/// Whether `id` has the shape of a `crm_id` this adapter generates: 32 hex digits.
fn looks_like_crm_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The queue statistics of the PBX account behind `pbx`: the probe's cheap authenticated call.
pub(crate) async fn queuestats(
    connector: &NetgsmConnector,
    pbx: &PbxCred<'_>,
) -> Result<(), ConnectorError> {
    let query = [
        ("username", pbx.username.to_owned()),
        ("password", pbx.password.to_owned()),
    ];
    pbx_call(connector, pbx, "queuestats", &query, Retry::Reads).await?;
    Ok(())
}

/// Sends `verb` with `query` to the PBX of `pbx` and reads its answer (see the module docs).
async fn pbx_call(
    connector: &NetgsmConnector,
    pbx: &PbxCred<'_>,
    verb: &str,
    query: &[(&str, String)],
    retry: Retry,
) -> Result<(), ConnectorError> {
    let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let url = connector.pbx_url(&[pbx.username, verb], &pairs);
    let answer = connector
        .call(Method::GET, url, Auth::InRequest, &Body::Empty, retry)
        .await?;
    santral_outcome(&answer, verb, pbx.password)
}

/// Whether provider text says the user could not be verified ("Kullanici dogrulanamadi").
fn unverified_user(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("dogrulanamad") || lower.contains("doğrulanamad")
}

/// The error a failed Netsantral object `object` maps to: its code by the table, an unverified
/// user `Auth`, anything else `Permanent` quoting its message (scrubbed of `secret`).
fn santral_failure(object: &Value, what: &str, secret: &str, answer: &Answer) -> ConnectorError {
    if let Some(code) = pick(object, &["code"]).filter(|c| !is_success(c)) {
        return code_error(&code, answer.retry_after);
    }
    let message = pick(object, &["message", "error", "status"]).unwrap_or_default();
    if unverified_user(&message) {
        return ConnectorError::auth(AUTH_HINT);
    }
    ConnectorError::permanent(format!(
        "Netsantral refused {what}: {}",
        quoted(&message, secret)
    ))
}

/// Whether a Netsantral object reports a failure: a status code other than success, or a status
/// naming an error.
fn is_failure(object: &Value) -> bool {
    let coded = pick(object, &["code"]).is_some_and(|c| !is_success(&c));
    let status = object["status"].as_str().unwrap_or_default().to_lowercase();
    coded || ["error", "fail", "hata"].iter().any(|w| status.contains(w))
}

/// Reads the answer of `verb` (see the module docs).
fn santral_outcome(answer: &Answer, verb: &str, secret: &str) -> Result<(), ConnectorError> {
    let what = format!("the {verb}");
    if let Some(json) = &answer.json {
        let object = match json {
            Value::Array(items) => items.first().unwrap_or(&Value::Null),
            other => other,
        };
        if is_failure(object) {
            return Err(santral_failure(object, &what, secret, answer));
        }
        if let Some(e) = status_error(answer) {
            return Err(e);
        }
        if !answer.status.is_success() {
            return Err(unreadable(answer, &what));
        }
        if verb == "queuestats" || accepted(object, verb) {
            return Ok(());
        }
        return Err(ConnectorError::permanent(format!(
            "Netsantral did not accept {what}"
        )));
    }
    if let Some(e) = status_error(answer) {
        return Err(e);
    }
    if !answer.status.is_success() {
        return Err(unreadable(answer, &what));
    }
    let first = answer.text.split_whitespace().next().unwrap_or_default();
    if matches!(first, "00" | "01" | "02") {
        return Ok(());
    }
    if (2..=3).contains(&first.len()) && first.bytes().all(|b| b.is_ascii_digit()) {
        return Err(code_error(first, answer.retry_after));
    }
    if unverified_user(&answer.text) {
        return Err(ConnectorError::auth(AUTH_HINT));
    }
    Err(unreadable(answer, &what))
}

/// Whether a Netsantral object accepts `verb`: a success code, a call id, a queued or successful
/// status or message, or the verb echoed back as `response`.
fn accepted(object: &Value, verb: &str) -> bool {
    let status = object["status"].as_str().unwrap_or_default().to_lowercase();
    let message = object["message"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    let response = object["response"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    pick(object, &["code"]).is_some_and(|c| is_success(&c))
        || pick(object, &["unique_id", "uniqueid", "callid"]).is_some()
        || ["success", "queued", "accepted"]
            .iter()
            .any(|w| status.contains(w))
        || matches!(status.as_str(), "ok" | "00" | "01" | "02")
        || message.trim() == "success"
        || response == verb
}

impl NetgsmConnector {
    /// The call records of the PBX account behind `cred` from `from` to `to`
    /// (`POST /netsantral/report {usercode, password, startdate, stopdate}`, the dates in
    /// Turkish time), as call events with the ids the callback gives a call's `cdr` event
    /// (`netgsm-call:<unique id>:cdr`), so a poll never duplicates a push. The credentials travel
    /// in the body (NetGSM's form for this call). NetGSM serves it only to the account's allowed
    /// IP addresses.
    pub async fn call_records(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        let pbx = PbxCred::of(cred, "read call records")?;
        if to < from {
            return Err(ConnectorError::permanent(
                "the call-record window ends before it starts",
            ));
        }
        let body = Body::Json(json!({
            "usercode": pbx.username,
            "password": pbx.password,
            "startdate": fmt_tr(from),
            "stopdate": fmt_tr(to),
        }));
        let answer = self
            .call(
                Method::POST,
                self.api_url(&["netsantral", "report"], &[]),
                Auth::InRequest,
                &body,
                Retry::Reads,
            )
            .await?;
        let what = "the call records";
        let Some(json) = &answer.json else {
            if let Some(code) = answer.code().filter(|c| !is_success(c)) {
                return Err(code_error(&code, answer.retry_after));
            }
            return Err(status_error(&answer).unwrap_or_else(|| unreadable(&answer, what)));
        };
        let records: Vec<&Value> = match json {
            Value::Array(items) => items.iter().collect(),
            Value::Object(object) => {
                if let Some(Value::Array(items)) = object.get("data").or(object.get("values")) {
                    items.iter().collect()
                } else if is_failure(json) || object.contains_key("error") {
                    return Err(santral_failure(json, what, pbx.password, &answer));
                } else {
                    object.values().filter(|v| v.is_object()).collect()
                }
            }
            _ => Vec::new(),
        };
        if let Some(e) = status_error(&answer) {
            return Err(e);
        }
        Ok(records
            .into_iter()
            .cloned()
            .filter_map(call_record)
            .collect())
    }
}

/// One call record as a `cdr` call event, its recording links without their query strings;
/// `None` for an item with neither a call id nor a destination.
fn call_record(mut record: Value) -> Option<InboundEventDraft> {
    webhook::scrub_recordings(&mut record);
    let record = &record;
    let fields = if record["values"].is_object() {
        &record["values"]
    } else {
        record
    };
    let id_keys = ["uniqueid", "unique_id", "id"];
    let unique_id = pick(record, &id_keys)
        .or_else(|| pick(fields, &id_keys))
        .map(|id| bare_unique_id(&id).to_owned());
    let destination = pick(
        fields,
        &["destination", "called", "callee", "dest", "aranan", "to"],
    );
    if unique_id.is_none() && destination.is_none() {
        return None;
    }
    let id_part = unique_id
        .clone()
        .unwrap_or_else(|| format!("digest-{}", webhook::digest(record)));
    let duration = pick_number(fields, &["duration", "billsec", "sure", "talktime"]);
    let date = pick(fields, &["date", "tarih", "datetime", "calldate", "start"]);
    Some(InboundEventDraft {
        external_id: format!("netgsm-call:{id_part}:cdr"),
        kind: EventKind::CallEvent,
        payload: json!({
            "scenario": "cdr",
            "unique_id": unique_id,
            "source": pick(fields, &["source", "caller", "src", "arayan", "from"]),
            "destination": destination,
            "direction": pick(fields, &["direction", "yon", "type"]).map(|d| d.to_lowercase()),
            "duration_sec": duration,
            "recording": pick(fields, &["recording", "kayit", "record", "recordingurl"]),
            "raw": record,
        }),
        occurred_at: date.as_deref().and_then(parse_tr),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sip_prefixes_are_dropped_from_call_ids() {
        assert_eq!(bare_unique_id("sip3-1700000000.9"), "1700000000.9");
        assert_eq!(bare_unique_id("SIP12-abc"), "abc");
        assert_eq!(bare_unique_id(" 1700000000.9 "), "1700000000.9");
        assert_eq!(bare_unique_id("sip-1"), "sip-1");
        assert_eq!(bare_unique_id("sipx-1"), "sipx-1");
        assert_eq!(bare_unique_id("si"), "si");
        assert_eq!(bare_unique_id("ş"), "ş");
    }

    #[test]
    fn recording_needs_the_boolean_true() {
        assert!(recording_allowed(&json!({ "recording_allowed": true })));
        for no in [
            json!({}),
            json!({ "recording_allowed": "true" }),
            json!(null),
        ] {
            assert!(!recording_allowed(&no), "{no}");
        }
    }

    #[test]
    fn crm_ids_are_told_from_pbx_call_ids() {
        assert!(looks_like_crm_id(&Uuid::now_v7().simple().to_string()));
        assert!(!looks_like_crm_id("1700000000.9"));
        assert!(!looks_like_crm_id(&"z".repeat(32)));
    }

    #[test]
    fn modes_and_extensions_are_checked() {
        assert_eq!(CallMode::of(&json!({})).unwrap(), CallMode::Originate);
        assert_eq!(
            CallMode::of(&json!({ "call_mode": "linkup" })).unwrap(),
            CallMode::Linkup
        );
        assert!(CallMode::of(&json!({ "call_mode": 1 })).is_err());
        assert_eq!(extension(" 101 ").unwrap(), "101");
        for bad in ["", "10a", "1/0", &"1".repeat(17)] {
            assert!(extension(bad).is_err(), "{bad}");
        }
    }
}
