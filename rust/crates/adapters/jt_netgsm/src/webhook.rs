//! NetGSM's callback bodies, parsed into inbound events. Pure: no I/O, no clock.
//!
//! NetGSM signs nothing: each callback URL carries a token of its own, checked at the gate with
//! `jt_connector::netgsm_token_ok` before this parser is reached. The URL also names the purpose
//! ([`NetgsmPurpose`]), which decides how the body is read.
//!
//! A body is JSON, or failing that a form (`a=1&b=2`, read as one object of strings). Integers
//! too long for 64 bits keep every digit (read as their digits). Each purpose reads its items:
//!
//! | Purpose | Items | Kind | `external_id` | `payload` |
//! |---|---|---|---|---|
//! | `mo` (incoming SMS) | an object, an array, or `{messages: [...]}` / `{data: [...]}`; the first [`MAX_MO_ROWS`] | `Message` | `netgsm-mo:<gorevid>`, else `netgsm-mo-digest:<sha256>` | `{from, text, row}` |
//! | `events` (Netsantral) | an object or an array; scenario `Inbound_call`, `Answer`, `Hangup`, `cdr` (or `end`) | `CallEvent` | `netgsm-call:<unique_id>:<scenario>` | `{scenario, unique_id, crm_id, customer_num, internal_num, direction, status, duration_sec, recording, raw}` |
//! | `iys` | an array (or a lone object); status exactly `ONAY`/`RET`, type exactly `MESAJ`/`ARAMA`/`EPOSTA` | `Consent` | `netgsm-iys:<transactionid or submitid>`, else `netgsm-iys:digest-<sha256>` | `{recipient, channel, status, granted, source, transaction_id, raw}` |
//! | `voice-report` | an object or an array, with a `relationid` | `Status` | `netgsm-voice:<relationid>:<state>` | `{relation_id, state, duration_sec, push_button, record_link, raw}` |
//! | `autocall-report` | an object or an array, with a `JobID` | `Status` | `netgsm-autocall:<JobID>:<unique_id>` | `{job_id, called, unique_id, status, raw}` |
//!
//! Field names vary by account and firmware, so each field is read from its known spellings. An
//! incoming SMS without a sender, a call event of an unknown scenario, a consent change whose
//! status or type is not exactly (same case) one İYS gives (never coerced into consent), and a
//! report without its id are left out. An incoming SMS's `from` is the sender in international
//! form (`+905000000001`); an id NetGSM leaves out is a SHA-256 of what identifies the item, so a
//! redelivery gets the same one. A call's `unique_id` loses the `sip<n>-` prefix some deliveries
//! carry. `occurred_at` is the item's own time (Turkish local time), when it has one.
//!
//! **Recording links.** A recording's link carries the provider's access token in its query
//! string, so every value under a recording-like key (a key containing `record`, ending in `url`,
//! or NetGSM's `seskaydi`/`kayit`) loses its query string, fragment and any user name or
//! password, at any depth: in the normalised fields and in the `raw` copy alike.
//! (The gate keeps the raw body as received, for 30 days, apart from the events.)
//!
//! **Size.** Incoming SMS are read up to [`MAX_MO_ROWS`] per body, call events and voice and
//! auto-call reports up to [`MAX_ITEMS`]; the rest are left out. İYS changes are never cut (a
//! consent change is never dropped): their bound is the body size the gate accepts.
//!
//! Malformed input never panics: a body that is neither JSON nor a form is
//! [`ParseError::Unreadable`], JSON that holds no item (a number, a string) is
//! [`ParseError::NotRows`], and items that are not objects are skipped.

pub use jt_app::ports::connectors::InboundEventDraft;
pub use jt_connector::NetgsmPurpose;

use jt_connector::EventKind;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::json::{pick, pick_number, read};
use crate::santral::bare_unique_id;
use crate::tr_time::parse_tr;

/// The most incoming messages read from one body; the rest are left out.
pub const MAX_MO_ROWS: usize = 100;

/// The most call events, voice reports or auto-call reports read from one body; the rest are
/// left out. (İYS changes are never cut.)
pub const MAX_ITEMS: usize = 1_000;

/// Why a body could not be parsed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("the callback body is neither JSON nor a form")]
    Unreadable,
    #[error("the callback body holds no object or list of objects")]
    NotRows,
}

/// The events of the callback body `raw` for `purpose` (see the module docs). Call it only once
/// the URL's token is checked.
pub fn parse(purpose: NetgsmPurpose, raw: &[u8]) -> Result<Vec<InboundEventDraft>, ParseError> {
    let body = decode(raw)?;
    let items = items(purpose, body)?;
    let drafts = match purpose {
        NetgsmPurpose::Mo => items
            .into_iter()
            .take(MAX_MO_ROWS)
            .filter_map(mo_draft)
            .collect(),
        NetgsmPurpose::Events => items
            .into_iter()
            .take(MAX_ITEMS)
            .filter_map(call_event)
            .collect(),
        NetgsmPurpose::Iys => items.into_iter().filter_map(consent).collect(),
        NetgsmPurpose::VoiceReport => items
            .into_iter()
            .take(MAX_ITEMS)
            .filter_map(voice_report)
            .collect(),
        NetgsmPurpose::AutocallReport => items
            .into_iter()
            .take(MAX_ITEMS)
            .filter_map(autocall_report)
            .collect(),
    };
    Ok(drafts)
}

/// `raw` as JSON, else as a form with at least one named field.
fn decode(raw: &[u8]) -> Result<Value, ParseError> {
    let text = String::from_utf8_lossy(raw);
    let text = text.trim();
    if text.is_empty() {
        return Err(ParseError::Unreadable);
    }
    if let Some(json) = read(text) {
        return Ok(json);
    }
    if !text.contains('=') {
        return Err(ParseError::Unreadable);
    }
    let fields: Map<String, Value> = url::form_urlencoded::parse(text.as_bytes())
        .filter(|(key, _)| !key.trim().is_empty())
        .map(|(key, value)| (key.into_owned(), Value::String(value.into_owned())))
        .collect();
    if fields.is_empty() {
        Err(ParseError::Unreadable)
    } else {
        Ok(Value::Object(fields))
    }
}

/// The items of `body`: its elements when it is an array, the list under `messages` or `data`
/// for incoming SMS, else the body itself when it is an object. Non-objects are dropped.
fn items(purpose: NetgsmPurpose, body: Value) -> Result<Vec<Value>, ParseError> {
    let list = match body {
        Value::Array(items) => items,
        Value::Object(mut object) => {
            let wrapped = if purpose == NetgsmPurpose::Mo {
                ["messages", "data"]
                    .iter()
                    .find_map(|key| match object.remove(*key) {
                        Some(Value::Array(items)) => Some(items),
                        Some(other) => {
                            object.insert((*key).to_owned(), other);
                            None
                        }
                        None => None,
                    })
            } else {
                None
            };
            wrapped.unwrap_or_else(|| vec![Value::Object(object)])
        }
        _ => return Err(ParseError::NotRows),
    };
    Ok(list.into_iter().filter(Value::is_object).collect())
}

/// Whether the value under `key` may be a recording's link: the key contains `record` (also
/// `caller_record`, `called_record`, `record_link`, `recordingUrl`), ends in `url`, or is NetGSM's
/// Turkish `seskaydi` / `kayit` (any case).
fn names_recording(key: &str) -> bool {
    let key = key.to_lowercase();
    key.contains("record")
        || key.ends_with("url")
        || matches!(key.as_str(), "seskaydi" | "ses_kaydi" | "kayit" | "kayıt")
}

/// `text` without the query string, fragment, user name and password of the link it holds (a
/// link that does not parse loses everything from its first `?` or `#`); text that is no link
/// is kept.
fn without_query(text: &str) -> String {
    if let Ok(mut url) = url::Url::parse(text.trim())
        && url.has_host()
    {
        url.set_query(None);
        url.set_fragment(None);
        // A URL with a host can always drop its user name and password.
        let _ = url.set_username("");
        let _ = url.set_password(None);
        return url.into();
    }
    match text.find(['?', '#']) {
        Some(at) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

/// Takes the provider's tokens out of every recording link in `value`, at any depth: each string
/// under a recording-like key (see the module docs) loses its query string, fragment and user
/// name and password. Everything else is kept.
pub(crate) fn scrub_recordings(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, inner) in object.iter_mut() {
                match inner {
                    Value::String(text) if names_recording(key) => *text = without_query(text),
                    other => scrub_recordings(other),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_recordings),
        _ => {}
    }
}

/// Lowercase hex SHA-256 of `value`'s JSON text (its keys sorted, so the same item gives the same
/// digest).
pub(crate) fn digest(value: &Value) -> String {
    hex(&Sha256::digest(value.to_string().as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// A Turkish phone number in international form: `5000000001`, `05000000001` and
/// `905000000001` are `+905000000001`; any other number is its digits, after a `+` when it had
/// one. `None` without a digit.
fn international(number: &str) -> Option<String> {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let formed = match digits.len() {
        10 if digits.starts_with('5') => format!("+90{digits}"),
        11 if digits.starts_with("05") => format!("+9{digits}"),
        12 if digits.starts_with("905") => format!("+{digits}"),
        _ if number.trim_start().starts_with('+') => format!("+{digits}"),
        _ => digits,
    };
    Some(formed)
}

/// One incoming SMS (a callback row or an inbox row) as a `Message` event; `None` without a
/// sender. Shared with the inbox backup, so a poll and a push give a message the same id.
pub(crate) fn mo_draft(mut row: Value) -> Option<InboundEventDraft> {
    scrub_recordings(&mut row);
    let sender = pick(&row, &["ceptel", "msisdn", "no", "gsmno", "sender"])?;
    let from = international(&sender)?;
    let text = pick(&row, &["mesaj", "message", "msg", "text"]).unwrap_or_default();
    let date = pick(&row, &["tarih", "date"]);
    let external_id = match pick(&row, &["gorevid", "id"]) {
        Some(id) => format!("netgsm-mo:{id}"),
        None => {
            let key = json!([from, text, date]);
            format!("netgsm-mo-digest:{}", digest(&key))
        }
    };
    Some(InboundEventDraft {
        external_id,
        kind: EventKind::Message,
        occurred_at: date.as_deref().and_then(parse_tr),
        payload: json!({ "from": from, "text": text, "row": row }),
    })
}

/// A call event's scenario, normalised; `None` for one this parser does not know.
fn scenario(item: &Value) -> Option<&'static str> {
    let raw = pick(item, &["scenario", "durum", "event"])?;
    match raw.to_lowercase().as_str() {
        "inbound_call" => Some("inbound_call"),
        "answer" => Some("answer"),
        "hangup" => Some("hangup"),
        "cdr" | "end" => Some("cdr"),
        _ => None,
    }
}

/// One Netsantral event as a `CallEvent`; `None` for an unknown scenario.
fn call_event(mut item: Value) -> Option<InboundEventDraft> {
    scrub_recordings(&mut item);
    let scenario = scenario(&item)?;
    let unique_id = pick(&item, &["unique_id", "uniqueid", "uniqueId", "callid"])
        .map(|id| bare_unique_id(&id).to_owned())
        .filter(|id| !id.is_empty());
    let id_part = unique_id
        .clone()
        .unwrap_or_else(|| format!("digest-{}", digest(&item)));
    let direction = pick(&item, &["yon", "direction"]).and_then(|d| {
        let d = d.to_lowercase();
        if d.starts_with("in") {
            Some("inbound")
        } else if d.starts_with("out") {
            Some("outbound")
        } else {
            None
        }
    });
    let occurred_at = pick(&item, &["tarih", "date", "datetime"])
        .as_deref()
        .and_then(parse_tr);
    Some(InboundEventDraft {
        external_id: format!("netgsm-call:{id_part}:{scenario}"),
        kind: EventKind::CallEvent,
        occurred_at,
        payload: json!({
            "scenario": scenario,
            "unique_id": unique_id,
            "crm_id": pick(&item, &["crm_id"]),
            "customer_num": pick(&item, &["customer_num", "arayan", "caller"]),
            "internal_num": pick(&item, &["internal_num", "aranan", "dahili"]),
            "direction": direction,
            "status": pick(&item, &["sondurum", "status"]),
            "duration_sec": pick_number(&item, &["bilsec", "billsec", "duration"]),
            "recording": pick(&item, &["seskaydi", "recording"]),
            "raw": item,
        }),
    })
}

/// One İYS change as a `Consent` event; `None` unless its status and type are exactly (same
/// case) ones İYS gives.
fn consent(mut item: Value) -> Option<InboundEventDraft> {
    scrub_recordings(&mut item);
    let status = pick(&item, &["status", "durum"])?;
    let granted = match status.as_str() {
        "ONAY" => true,
        "RET" => false,
        _ => return None,
    };
    let channel = pick(&item, &["type"])?;
    if !crate::iys::CHANNELS.contains(&channel.as_str()) {
        return None;
    }
    let transaction_id = pick(&item, &["transactionid"]).or_else(|| pick(&item, &["submitid"]));
    let id_part = transaction_id
        .clone()
        .unwrap_or_else(|| format!("digest-{}", digest(&item)));
    let occurred_at = pick(&item, &["consentDate", "consentdate", "date"])
        .as_deref()
        .and_then(parse_tr);
    Some(InboundEventDraft {
        external_id: format!("netgsm-iys:{id_part}"),
        kind: EventKind::Consent,
        occurred_at,
        payload: json!({
            "recipient": pick(&item, &["recipient", "msisdn", "gsmnumber"]),
            "channel": channel,
            "status": status,
            "granted": granted,
            "source": pick(&item, &["source", "kaynak"]),
            "transaction_id": transaction_id,
            "raw": item,
        }),
    })
}

/// One voice-message report as a `Status`; `None` without a relation id.
fn voice_report(mut item: Value) -> Option<InboundEventDraft> {
    scrub_recordings(&mut item);
    let relation = pick(&item, &["relationid", "relationId", "RelationID"])?;
    let state = pick(&item, &["durum", "state", "status"]);
    let state_part = state
        .clone()
        .unwrap_or_else(|| format!("digest-{}", digest(&item)));
    Some(InboundEventDraft {
        external_id: format!("netgsm-voice:{relation}:{state_part}"),
        kind: EventKind::Status,
        occurred_at: None,
        payload: json!({
            "relation_id": relation,
            "state": state,
            "duration_sec": pick_number(&item, &["bilsec", "talksec", "duration", "sure"]),
            "push_button": pick(&item, &["push_button", "pushbutton", "pushButton", "tus"]),
            "record_link": pick(&item, &["record_link", "recordlink", "recordLink", "recordingUrl"]),
            "raw": item,
        }),
    })
}

/// One auto-call attempt report as a `Status`; `None` without a job id.
fn autocall_report(mut item: Value) -> Option<InboundEventDraft> {
    scrub_recordings(&mut item);
    let job = pick(&item, &["JobID", "jobid", "jobId", "listid", "listId"])?;
    let unique_id = pick(&item, &["unique_id", "uniqueid", "uniqueId"]);
    let attempt = unique_id
        .clone()
        .unwrap_or_else(|| format!("digest-{}", digest(&item)));
    Some(InboundEventDraft {
        external_id: format!("netgsm-autocall:{job}:{attempt}"),
        kind: EventKind::Status,
        occurred_at: None,
        payload: json!({
            "job_id": job,
            "called": pick(&item, &["called", "no", "number"]),
            "unique_id": unique_id,
            "status": pick(&item, &["status", "durum"]),
            "raw": item,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senders_take_international_form() {
        for (given, expected) in [
            ("5000000001", "+905000000001"),
            ("05000000001", "+905000000001"),
            ("905000000001", "+905000000001"),
            ("+90 500 000 00 01", "+905000000001"),
            ("+4915100000000", "+4915100000000"),
            ("4444", "4444"),
        ] {
            assert_eq!(international(given).as_deref(), Some(expected), "{given}");
        }
        assert_eq!(international("abc"), None);
    }

    #[test]
    fn recording_links_lose_their_tokens_at_any_depth() {
        let mut item = json!({
            "seskaydi": "https://dosya.example.invalid/k/1.wav?token=SECRET-1&x=1#t",
            "caller_record": "https://user:SECRET-2@dosya.example.invalid/a.wav?token=SECRET-3",
            "called_record": "1",
            "recordingUrl": "not a link?token=SECRET-4",
            "voice_url": "https://sesdosya.example.invalid/v.mp3?t=SECRET-5",
            "nested": [{ "record_link": "https://dosya.example.invalid/r?SECRET-6" }],
            "kaynak": "HS_WEB?not-a-link",
            "message": "kept?as=is",
        });
        scrub_recordings(&mut item);
        assert!(!item.to_string().contains("SECRET"), "{item}");
        assert_eq!(item["seskaydi"], "https://dosya.example.invalid/k/1.wav");
        assert_eq!(item["caller_record"], "https://dosya.example.invalid/a.wav");
        assert_eq!(item["called_record"], "1");
        assert_eq!(item["recordingUrl"], "not a link");
        assert_eq!(
            item["nested"][0]["record_link"],
            "https://dosya.example.invalid/r"
        );
        assert_eq!(item["kaynak"], "HS_WEB?not-a-link");
        assert_eq!(item["message"], "kept?as=is");
    }

    #[test]
    fn digests_are_hex_sha256() {
        // SHA-256 of the two bytes `{}`.
        assert_eq!(
            digest(&json!({})),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn wrapped_lists_that_are_not_lists_stay_fields() {
        let items = items(
            NetgsmPurpose::Mo,
            json!({ "messages": "x", "mesaj": "m", "ceptel": "905000000001" }),
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["messages"], "x");
    }
}
