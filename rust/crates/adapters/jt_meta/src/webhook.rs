//! Meta's webhook bodies, parsed into inbound events. Pure: no I/O, no clock.
//!
//! The signature is checked before anything is parsed ([`verify_and_parse`], with
//! [`jt_connector::meta_signature_ok`]: `X-Hub-Signature-256` over the raw body under the app
//! secret, compared in constant time).
//!
//! **Routing.** Each event names the account it arrived for ([`ParsedEvent::external_account_id`])
//! and which kinds of capability may hold that account ([`ParsedEvent::kind_hint`]); the webhook
//! use case finds the capability by `(meta, account)`:
//!
//! | `object` | account | `kind_hint` |
//! |---|---|---|
//! | `whatsapp_business_account` | each change's `value.metadata.phone_number_id` | `whatsapp_cloud` |
//! | `page` | each entry's `id` (the page) | `page` (`facebook_page`, `messenger`) |
//! | `instagram` | each entry's `id` (the Instagram account) | `instagram` (`instagram`, `instagram_dm`) |
//!
//! **Events**, by family, with their `external_id` (unique per provider: the dedupe key) and
//! their `payload` (the provider's item as sent, under a key naming its family):
//!
//! | Family | Kind | `external_id` | `payload` |
//! |---|---|---|---|
//! | WhatsApp `messages[]` (text, button, interactive, a click-to-WhatsApp referral, …) | `Message` | the `wamid` | `{message, contact}` (the sender's `contacts[]` entry, or `null`) |
//! | WhatsApp `statuses[]` | `Status` | `<wamid>:<status>` | `{status}` |
//! | Messenger / Instagram `messaging[].message` | `Message`, or `MessageEcho` when `is_echo` | the `mid` | `{messaging}` |
//! | Messenger / Instagram `messaging[].postback` | `Message` | its `mid`, else `postback:<sender>:<timestamp>` | `{messaging}` |
//! | Messenger / Instagram `messaging[].delivery.mids[]` | `Status` | `<mid>:delivered` | `{mid, watermark, sender, recipient}` |
//! | Page `changes[field = leadgen]` | `LeadGen` | `leadgen:<leadgen_id>` | `{leadgen}` (the change's `value`) |
//!
//! Anything else in a known object (read watermarks, reactions, standby messages, other change
//! fields, other WhatsApp fields) is left out, and so is an item missing its id. `occurred_at`
//! comes from the item's own time (WhatsApp's seconds, Messenger's milliseconds, a lead's
//! `created_time`), when it has one.

pub use jt_app::ports::connectors::InboundEventDraft;
use jt_connector::{EventKind, meta_signature_ok};
use serde_json::{Map, Value};
use time::OffsetDateTime;

/// The `kind_hint` of a Facebook Page's events.
pub const KIND_HINT_PAGE: &str = "page";
/// The `kind_hint` of an Instagram account's events.
pub const KIND_HINT_INSTAGRAM: &str = "instagram";
/// The `kind_hint` of a WhatsApp number's events.
pub const KIND_HINT_WHATSAPP: &str = "whatsapp_cloud";

/// The capability kinds that may hold the account of an event whose `kind_hint` is `hint` (see
/// the module docs): the kinds the webhook use case looks the account up under. An unknown hint
/// names none, so its events route nowhere.
pub fn kinds_of_hint(hint: &str) -> &'static [&'static str] {
    match hint {
        KIND_HINT_WHATSAPP => &["whatsapp_cloud"],
        KIND_HINT_PAGE => &["facebook_page", "messenger"],
        KIND_HINT_INSTAGRAM => &["instagram", "instagram_dm"],
        _ => &[],
    }
}

/// The longest unknown object name repeated in a [`ParseError`].
const MAX_OBJECT_CHARS: usize = 64;

/// One event of a webhook body and the account it arrived for.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedEvent {
    /// The provider's id of the account: a page, an Instagram account or a WhatsApp number.
    pub external_account_id: String,
    /// Which kinds of capability may hold the account: [`KIND_HINT_PAGE`],
    /// [`KIND_HINT_INSTAGRAM`] or [`KIND_HINT_WHATSAPP`].
    pub kind_hint: &'static str,
    /// The event; its `payload` is the provider's item under a key naming its family (see the
    /// module docs).
    pub event: InboundEventDraft,
}

/// Why a body could not be parsed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("the webhook body is not JSON")]
    NotJson,
    #[error("the webhook body has no `object`")]
    NoObject,
    #[error("the webhook body is about an unknown object {0:?}")]
    UnknownObject(String),
    #[error("the webhook body has no `entry` list")]
    NoEntries,
}

/// Why a webhook was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    /// The signature header does not sign the body under the app secret (or is malformed, or
    /// the secret is empty). Nothing was parsed.
    #[error("the webhook signature does not match the body")]
    BadSignature,
    #[error(transparent)]
    Parse(#[from] ParseError),
}

/// The events of `raw` once its `X-Hub-Signature-256` value `header` is checked under
/// `app_secret`; [`WebhookError::BadSignature`] (before any parsing) when it does not sign it.
pub fn verify_and_parse(
    app_secret: &[u8],
    raw: &[u8],
    header: &str,
) -> Result<Vec<ParsedEvent>, WebhookError> {
    if !meta_signature_ok(app_secret, raw, header) {
        return Err(WebhookError::BadSignature);
    }
    Ok(parse(raw)?)
}

/// The events of the webhook body `raw` (see the module docs). Call it only on a verified body
/// ([`verify_and_parse`]). The body is parsed once and each item moved out of it into its event,
/// so the memory used grows with the body, never with the body times its events.
pub fn parse(raw: &[u8]) -> Result<Vec<ParsedEvent>, ParseError> {
    let mut body: Value = serde_json::from_slice(raw).map_err(|_| ParseError::NotJson)?;
    let object = body["object"]
        .as_str()
        .ok_or(ParseError::NoObject)?
        .to_owned();
    let Some(Value::Array(entries)) = body.get_mut("entry").map(Value::take) else {
        return Err(ParseError::NoEntries);
    };
    let hint = match object.as_str() {
        "whatsapp_business_account" => KIND_HINT_WHATSAPP,
        "page" => KIND_HINT_PAGE,
        "instagram" => KIND_HINT_INSTAGRAM,
        other => {
            return Err(ParseError::UnknownObject(
                other.chars().take(MAX_OBJECT_CHARS).collect(),
            ));
        }
    };
    let mut out = Vec::new();
    for entry in entries {
        if hint == KIND_HINT_WHATSAPP {
            whatsapp_entry(entry, &mut out);
        } else {
            messaging_entry(entry, hint, &mut out);
        }
    }
    Ok(out)
}

/// A non-empty string, or an integer as text.
fn id(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Number(n) if n.is_u64() || n.is_i64() => Some(n.to_string()),
        _ => None,
    }
}

/// A Unix time in seconds (a number or a string of one).
fn from_seconds(value: &Value) -> Option<OffsetDateTime> {
    let seconds = match value {
        Value::Number(n) => n.as_i64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    OffsetDateTime::from_unix_timestamp(seconds).ok()
}

/// A Unix time in milliseconds.
fn from_millis(value: &Value) -> Option<OffsetDateTime> {
    let millis = value.as_i64()?;
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
}

/// The array under `key` of `value`, moved out of it (empty when there is none).
fn take_array(value: &mut Value, key: &str) -> Vec<Value> {
    match value.get_mut(key).map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// The value under `key` of `value`, moved out of it (`null` when there is none).
fn take(value: &mut Value, key: &str) -> Value {
    value.get_mut(key).map(Value::take).unwrap_or(Value::Null)
}

/// An object of `fields`, each value moved in.
fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<Map<String, Value>>(),
    )
}

/// The events of one WhatsApp entry: per `messages` change, routed by its number.
fn whatsapp_entry(mut entry: Value, out: &mut Vec<ParsedEvent>) {
    for mut change in take_array(&mut entry, "changes") {
        if change["field"] != "messages" {
            continue;
        }
        let mut value = take(&mut change, "value");
        let Some(number) = id(&value["metadata"]["phone_number_id"]) else {
            continue;
        };
        let contacts = take_array(&mut value, "contacts");
        for message in take_array(&mut value, "messages") {
            let Some(wamid) = id(&message["id"]) else {
                continue;
            };
            let contact = contacts
                .iter()
                .find(|c| c["wa_id"] == message["from"])
                .cloned()
                .unwrap_or(Value::Null);
            let occurred_at = from_seconds(&message["timestamp"]);
            out.push(ParsedEvent {
                external_account_id: number.clone(),
                kind_hint: KIND_HINT_WHATSAPP,
                event: InboundEventDraft {
                    external_id: wamid,
                    kind: EventKind::Message,
                    payload: object([("message", message), ("contact", contact)]),
                    occurred_at,
                },
            });
        }
        for status in take_array(&mut value, "statuses") {
            let (Some(wamid), Some(state)) = (id(&status["id"]), status["status"].as_str()) else {
                continue;
            };
            let external_id = format!("{wamid}:{state}");
            let occurred_at = from_seconds(&status["timestamp"]);
            out.push(ParsedEvent {
                external_account_id: number.clone(),
                kind_hint: KIND_HINT_WHATSAPP,
                event: InboundEventDraft {
                    external_id,
                    kind: EventKind::Status,
                    payload: object([("status", status)]),
                    occurred_at,
                },
            });
        }
    }
}

/// The events of one Page or Instagram entry, routed by the entry's id.
fn messaging_entry(mut entry: Value, hint: &'static str, out: &mut Vec<ParsedEvent>) {
    let Some(account) = id(&entry["id"]) else {
        return;
    };
    let mut push = |external_id: String, kind: EventKind, payload: Value, at| {
        out.push(ParsedEvent {
            external_account_id: account.clone(),
            kind_hint: hint,
            event: InboundEventDraft {
                external_id,
                kind,
                payload,
                occurred_at: at,
            },
        });
    };
    for event in take_array(&mut entry, "messaging") {
        let at = from_millis(&event["timestamp"]);
        if event["message"].is_object() {
            let Some(mid) = id(&event["message"]["mid"]) else {
                continue;
            };
            let kind = if event["message"]["is_echo"] == true {
                EventKind::MessageEcho
            } else {
                EventKind::Message
            };
            push(mid, kind, object([("messaging", event)]), at);
        } else if event["postback"].is_object() {
            let external_id = id(&event["postback"]["mid"]).or_else(|| {
                let sender = id(&event["sender"]["id"])?;
                let timestamp = id(&event["timestamp"])?;
                Some(format!("postback:{sender}:{timestamp}"))
            });
            let Some(external_id) = external_id else {
                continue;
            };
            push(
                external_id,
                EventKind::Message,
                object([("messaging", event)]),
                at,
            );
        } else if event["delivery"].is_object() {
            // One small event per message delivered: the item itself is not copied per mid.
            let watermark = &event["delivery"]["watermark"];
            for mid in event["delivery"]["mids"].as_array().into_iter().flatten() {
                let Some(mid) = id(mid) else {
                    continue;
                };
                let payload = object([
                    ("mid", Value::String(mid.clone())),
                    ("watermark", watermark.clone()),
                    ("sender", event["sender"].clone()),
                    ("recipient", event["recipient"].clone()),
                ]);
                push(format!("{mid}:delivered"), EventKind::Status, payload, at);
            }
        }
    }
    for mut change in take_array(&mut entry, "changes") {
        if change["field"] != "leadgen" {
            continue;
        }
        let value = take(&mut change, "value");
        let Some(leadgen) = id(&value["leadgen_id"]) else {
            continue;
        };
        let at = from_seconds(&value["created_time"]);
        push(
            format!("leadgen:{leadgen}"),
            EventKind::LeadGen,
            object([("leadgen", value)]),
            at,
        );
    }
}
