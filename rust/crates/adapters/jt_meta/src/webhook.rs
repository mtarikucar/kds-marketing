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
//! | `whatsapp_business_account`, `account_update` changes | the WhatsApp Business Account: `value.waba_info.waba_id`, else the entry's `id` | `whatsapp_business_account` (the `whatsapp_cloud` capabilities whose asset names that account) |
//! | `page` | each entry's `id` (the page) | `page` (`facebook_page`, `messenger`) |
//! | `instagram` | each entry's `id` (the Instagram account) | `instagram` (`instagram`, `instagram_dm`) |
//!
//! **Where an event came from.** One body may batch items of several accounts, which may belong
//! to several workspaces. Each event names its [`Origin`] in the body: its entry, and for a
//! WhatsApp entry (whose changes each name a number of their own) its change. What a workspace
//! keeps of the body is cut along these ([`scoped_body`]): only the entries (and changes) its own
//! events came from, so no workspace keeps another's items or an item no workspace took.
//!
//! **Events**, by family, with their `external_id` (unique per provider: the dedupe key) and
//! their `payload` (the provider's item as sent, under a key naming its family):
//!
//! | Family | Kind | `external_id` | `payload` |
//! |---|---|---|---|
//! | WhatsApp `messages[]` (text, button, interactive, a click-to-WhatsApp referral, …) | `Message` | the `wamid` | `{message, contact}` (the sender's `contacts[]` entry, or `null`) |
//! | WhatsApp `statuses[]` | `Status` | `<wamid>:<status>` | `{status}` |
//! | WhatsApp `smb_message_echoes`: `message_echoes[]` (what the business sent from the WhatsApp Business app) | `MessageEcho` | the `wamid` | `{echo}` |
//! | WhatsApp `history`: each `history[].threads[].messages[]` | `History` | `history:<wamid>` | `{history_message, thread, business_number}` (the thread's id is the customer's number; the business's number is the change's `display_phone_number`) |
//! | WhatsApp `history`: each `history[]` chunk's `metadata` | `History` | `history-chunk:<number>:<phase>:<chunk_order>` | `{history_chunk, messages}` (how many of its messages became events) |
//! | WhatsApp `history`: each `history[].errors[]` (the business declined to share) | `History` | `history-error:<number>:<code>` | `{history_error}` |
//! | WhatsApp `smb_app_state_sync`: each `state_sync[]` of `type: contact` | `ContactSync` | `contact-sync:<number>:<contact's phone>:<action>:<timestamp>` | `{state_sync}` |
//! | WhatsApp `account_update` naming an `event` | `AccountUpdate` | `account-update:<account>:<event>:<entry's time>` | `{account_update}` (the change's `value`) |
//! | Messenger / Instagram `messaging[].message` | `Message`, or `MessageEcho` when `is_echo` | the `mid` | `{messaging}` |
//! | Messenger / Instagram `messaging[].postback` | `Message` | its `mid`, else `postback:<sender>:<timestamp>` | `{messaging}` |
//! | Messenger / Instagram `messaging[].delivery.mids[]` | `Status` | `<mid>:delivered` | `{mid, watermark, sender, recipient}` |
//! | Page `changes[field = leadgen]` | `LeadGen` | `leadgen:<leadgen_id>` | `{leadgen}` (the change's `value`) |
//! | Page `changes[field = feed]` about a comment (`value.item = comment`), `verb` `add`, `edit`/`edited`, `remove`/`delete` | `Comment` | `comment:<comment_id>:open`, `comment:<comment_id>:edited:<entry's time>`, `comment:<comment_id>:removed` ([`comment_event_id`]) | `{public, provider_item}`: the comment's [`PublicEnvelope`] (`open`, `edited`, `removed`) and the change's `value` |
//! | Instagram `changes[field = comments]` and `changes[field = live_comments]` (`live`) | `Comment` | `comment:<id>:open` | `{public, provider_item}`, as above |
//!
//! A comment's envelope: its author ours when `from.id` is the entry's id (the Page's, the
//! Instagram account's); a reply's parent and root the comment it answers (a Page's top-level
//! comment names its post as its `parent_id`); its post (the Page's `post_id`, the Instagram
//! `media.id`) its subject; its time the change's `created_time`, else (always for Instagram,
//! whose change carries none) the entry's. The fields are those of Meta's references
//! <https://developers.facebook.com/docs/graph-api/webhooks/reference/page/> (`feed`) and
//! <https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram/> (`comments`,
//! `live_comments`).
//!
//! The WhatsApp Business app's fields (`smb_message_echoes`, `history`, `smb_app_state_sync`) and
//! `account_update` are those of a number onboarded beside the app, as Meta's page
//! <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>
//! shows them. A history message keeps its `wamid` inside its payload, but is keyed apart from a
//! live message of the same `wamid`: the inbox files a message once per `wamid` whichever came
//! first.
//!
//! Anything else in a known object (read watermarks, reactions, standby messages, other change
//! fields, other WhatsApp fields, the media of a history placeholder sent after it under
//! `history`'s `value.messages[]`: the inbox keeps no media; a `feed` change about anything but a
//! comment, such as a post, a visitor's post, a reaction or a share; a comment hidden, unhidden or
//! blocked, which the business did and records where it did it; Instagram's `mentions`) is left
//! out, and so is an item missing its id. `occurred_at` comes from the item's own time (WhatsApp's seconds, Messenger's
//! milliseconds, a lead's `created_time`, an `account_update` entry's `time`), when it has one.

pub use jt_app::ports::connectors::InboundEventDraft;
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, PublicEnvelope, PublicKind, SubjectKind,
};
use std::collections::BTreeSet;

use jt_connector::{EventKind, meta_signature_ok};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

/// The `kind_hint` of a Facebook Page's events.
pub const KIND_HINT_PAGE: &str = "page";
/// The `kind_hint` of an Instagram account's events.
pub const KIND_HINT_INSTAGRAM: &str = "instagram";
/// The `kind_hint` of a WhatsApp number's events.
pub const KIND_HINT_WHATSAPP: &str = "whatsapp_cloud";
/// The `kind_hint` of a WhatsApp Business Account's own events (`account_update`): their account
/// is the business account, which a `whatsapp_cloud` capability names in its asset
/// (`connector_public.asset.waba_id`), not as its external id (the number).
pub const KIND_HINT_WHATSAPP_ACCOUNT: &str = "whatsapp_business_account";

/// The capability kinds that may hold the account of an event whose `kind_hint` is `hint` (see
/// the module docs): the kinds the webhook use case looks the account up under. An unknown hint
/// names none, so its events route nowhere.
pub fn kinds_of_hint(hint: &str) -> &'static [&'static str] {
    match hint {
        KIND_HINT_WHATSAPP | KIND_HINT_WHATSAPP_ACCOUNT => &["whatsapp_cloud"],
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
    /// The provider's id of the account: a page, an Instagram account, a WhatsApp number, or
    /// (for [`KIND_HINT_WHATSAPP_ACCOUNT`]) a WhatsApp Business Account.
    pub external_account_id: String,
    /// Which kinds of capability may hold the account: [`KIND_HINT_PAGE`],
    /// [`KIND_HINT_INSTAGRAM`], [`KIND_HINT_WHATSAPP`] or [`KIND_HINT_WHATSAPP_ACCOUNT`].
    pub kind_hint: &'static str,
    /// Where in the body it came from (see the module docs).
    pub origin: Origin,
    /// The event; its `payload` is the provider's item under a key naming its family (see the
    /// module docs).
    pub event: InboundEventDraft,
}

/// Where in a webhook body an event came from: the index of its entry in `entry[]` and, for an
/// event routed by its change (WhatsApp: each change names its number), the index of that change
/// in the entry's `changes[]`. Every event of one origin is of one account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Origin {
    pub entry: usize,
    /// `None` when the whole entry is one account's (a Page, an Instagram account).
    pub change: Option<usize>,
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
    for (index, entry) in entries.into_iter().enumerate() {
        if hint == KIND_HINT_WHATSAPP {
            whatsapp_entry(index, entry, &mut out);
        } else {
            messaging_entry(index, entry, hint, &mut out);
        }
    }
    Ok(out)
}

/// What a workspace keeps of the webhook body `raw` beside the events it stores from it, given
/// their origins `keep` (see the module docs): `raw` itself, byte for byte, when they are all of
/// it (every entry whole, or every one of its changes); else a body of the same `object` holding
/// only those entries, of a WhatsApp entry only those changes, in their order, serialised again
/// (derived: Meta's signature covered the original, not this); `None` when they name nothing of
/// it, or `raw` is not a webhook body. Nothing else of the body is kept: an entry or a change no
/// event of `keep` came from (another workspace's, an account no workspace holds, an item no
/// event is made of) is left out.
pub fn scoped_body(raw: &[u8], keep: &BTreeSet<Origin>) -> Option<Vec<u8>> {
    let body: Value = serde_json::from_slice(raw).ok()?;
    let object = body.get("object")?;
    let entries = body.get("entry")?.as_array()?;
    let mut whole = true;
    let mut kept = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let wanted = |change: Option<usize>| {
            keep.contains(&Origin {
                entry: index,
                change,
            })
        };
        if wanted(None) {
            kept.push(entry.clone());
            continue;
        }
        let changes = entry.get("changes").and_then(Value::as_array);
        let chosen: Vec<Value> = changes
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(change, _)| wanted(Some(*change)))
            .map(|(_, change)| change.clone())
            .collect();
        whole &= changes.is_some_and(|all| !all.is_empty() && chosen.len() == all.len());
        if chosen.is_empty() {
            continue;
        }
        let mut scoped = entry.clone();
        if let Value::Object(fields) = &mut scoped {
            fields.insert("changes".to_owned(), Value::Array(chosen));
        }
        kept.push(scoped);
    }
    if kept.is_empty() {
        return None;
    }
    if whole {
        return Some(raw.to_vec());
    }
    serde_json::to_vec(&json!({ "object": object, "entry": kept })).ok()
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

/// The events of entry `index`, a WhatsApp one: per change, routed by its number (an
/// `account_update`, by its business account).
fn whatsapp_entry(index: usize, mut entry: Value, out: &mut Vec<ParsedEvent>) {
    let entry_id = id(&entry["id"]);
    let entry_time = take(&mut entry, "time");
    for (change_index, mut change) in take_array(&mut entry, "changes").into_iter().enumerate() {
        let origin = Origin {
            entry: index,
            change: Some(change_index),
        };
        let field = change["field"].as_str().unwrap_or_default().to_owned();
        let mut value = take(&mut change, "value");
        if field == "account_update" {
            if let Some(event) = account_update(origin, entry_id.as_deref(), &entry_time, value) {
                out.push(event);
            }
            continue;
        }
        let Some(number) = id(&value["metadata"]["phone_number_id"]) else {
            continue;
        };
        let mut push = |external_id: String, kind: EventKind, payload: Value, occurred_at| {
            out.push(ParsedEvent {
                external_account_id: number.clone(),
                kind_hint: KIND_HINT_WHATSAPP,
                origin,
                event: InboundEventDraft {
                    external_id,
                    kind,
                    payload,
                    occurred_at,
                },
            });
        };
        match field.as_str() {
            "messages" => messages(&mut value, &mut push),
            "smb_message_echoes" => {
                for echo in take_array(&mut value, "message_echoes") {
                    let Some(wamid) = id(&echo["id"]) else {
                        continue;
                    };
                    let at = from_seconds(&echo["timestamp"]);
                    push(wamid, EventKind::MessageEcho, object([("echo", echo)]), at);
                }
            }
            "history" => history(&number, &mut value, &mut push),
            "smb_app_state_sync" => {
                for item in take_array(&mut value, "state_sync") {
                    if item["type"] != "contact" {
                        continue;
                    }
                    let (Some(phone), Some(action)) = (
                        id(&item["contact"]["phone_number"]),
                        item["action"].as_str().filter(|a| !a.is_empty()),
                    ) else {
                        continue;
                    };
                    let stamp = id(&item["metadata"]["timestamp"]).unwrap_or_default();
                    let external_id = format!("contact-sync:{number}:{phone}:{action}:{stamp}");
                    let at = from_seconds(&item["metadata"]["timestamp"]);
                    push(
                        external_id,
                        EventKind::ContactSync,
                        object([("state_sync", item)]),
                        at,
                    );
                }
            }
            _ => {}
        }
    }
}

/// How a WhatsApp change's events are pushed: their id, kind, payload and time.
type Push<'a> = dyn FnMut(String, EventKind, Value, Option<OffsetDateTime>) + 'a;

/// The `messages` and `statuses` of a `messages` change.
fn messages(value: &mut Value, push: &mut Push<'_>) {
    let contacts = take_array(value, "contacts");
    for message in take_array(value, "messages") {
        let Some(wamid) = id(&message["id"]) else {
            continue;
        };
        let contact = contacts
            .iter()
            .find(|c| c["wa_id"] == message["from"])
            .cloned()
            .unwrap_or(Value::Null);
        let occurred_at = from_seconds(&message["timestamp"]);
        push(
            wamid,
            EventKind::Message,
            object([("message", message), ("contact", contact)]),
            occurred_at,
        );
    }
    for status in take_array(value, "statuses") {
        let (Some(wamid), Some(state)) = (id(&status["id"]), status["status"].as_str()) else {
            continue;
        };
        let external_id = format!("{wamid}:{state}");
        let occurred_at = from_seconds(&status["timestamp"]);
        push(
            external_id,
            EventKind::Status,
            object([("status", status)]),
            occurred_at,
        );
    }
}

/// The items of a `history` change of `number`: each chunk's refusals, its messages, then the
/// chunk's progress. The media of a placeholder (`value.messages[]`) is left out.
fn history(number: &str, value: &mut Value, push: &mut Push<'_>) {
    let business = value["metadata"]["display_phone_number"].clone();
    for mut chunk in take_array(value, "history") {
        for error in take_array(&mut chunk, "errors") {
            let code = id(&error["code"]).unwrap_or_default();
            push(
                format!("history-error:{number}:{code}"),
                EventKind::History,
                object([("history_error", error)]),
                None,
            );
        }
        let mut filed = 0u64;
        for mut thread in take_array(&mut chunk, "threads") {
            let customer = thread["id"].clone();
            for message in take_array(&mut thread, "messages") {
                let Some(wamid) = id(&message["id"]) else {
                    continue;
                };
                filed += 1;
                let at = from_seconds(&message["timestamp"]);
                push(
                    format!("history:{wamid}"),
                    EventKind::History,
                    object([
                        ("history_message", message),
                        ("thread", customer.clone()),
                        ("business_number", business.clone()),
                    ]),
                    at,
                );
            }
        }
        let metadata = take(&mut chunk, "metadata");
        let (Some(phase), Some(order)) = (id(&metadata["phase"]), id(&metadata["chunk_order"]))
        else {
            continue;
        };
        push(
            format!("history-chunk:{number}:{phase}:{order}"),
            EventKind::History,
            object([("history_chunk", metadata), ("messages", json!(filed))]),
            None,
        );
    }
}

/// The event of an `account_update` change naming an `event`, routed by its business account
/// (`value.waba_info.waba_id`, else the entry's `id`) and keyed by the account, the event and the
/// entry's `time`; `None` for a change naming no event or no account.
fn account_update(
    origin: Origin,
    entry_id: Option<&str>,
    entry_time: &Value,
    value: Value,
) -> Option<ParsedEvent> {
    let event = value["event"].as_str().filter(|e| !e.is_empty())?;
    let account = id(&value["waba_info"]["waba_id"]).or_else(|| entry_id.map(str::to_owned))?;
    let stamp = id(entry_time).unwrap_or_default();
    let external_id = format!("account-update:{account}:{event}:{stamp}");
    Some(ParsedEvent {
        external_account_id: account,
        kind_hint: KIND_HINT_WHATSAPP_ACCOUNT,
        origin,
        event: InboundEventDraft {
            external_id,
            kind: EventKind::AccountUpdate,
            payload: object([("account_update", value)]),
            occurred_at: from_seconds(entry_time),
        },
    })
}

/// The events of entry `index`, a Page or Instagram one, routed by the entry's id.
fn messaging_entry(index: usize, mut entry: Value, hint: &'static str, out: &mut Vec<ParsedEvent>) {
    let Some(account) = id(&entry["id"]) else {
        return;
    };
    let origin = Origin {
        entry: index,
        change: None,
    };
    let mut push = |external_id: String, kind: EventKind, payload: Value, at| {
        out.push(ParsedEvent {
            external_account_id: account.clone(),
            kind_hint: hint,
            origin,
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
    let entry_time = take(&mut entry, "time");
    for mut change in take_array(&mut entry, "changes") {
        let field = change["field"].as_str().unwrap_or_default().to_owned();
        let value = take(&mut change, "value");
        let comment = match (hint, field.as_str()) {
            (KIND_HINT_PAGE, "feed") => feed_comment(&account, &entry_time, value),
            (KIND_HINT_INSTAGRAM, "comments") => {
                instagram_comment(&account, &entry_time, value, false)
            }
            (KIND_HINT_INSTAGRAM, "live_comments") => {
                instagram_comment(&account, &entry_time, value, true)
            }
            (_, "leadgen") => {
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
                continue;
            }
            _ => continue,
        };
        if let Some(draft) = comment {
            push(
                draft.external_id,
                draft.kind,
                draft.payload,
                draft.occurred_at,
            );
        }
    }
}

/// The dedupe key of a comment's event in state `status` (see the module docs): `comment:<id>:
/// <status>`, an edit's also naming `stamp`, the time of that revision (the entry's), so each
/// revision is an event of its own. A poller keys what it finds the same way, so a comment seen
/// by both is stored once.
pub fn comment_event_id(comment_id: &str, status: EnvelopeStatus, stamp: Option<&str>) -> String {
    let state = serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    match status {
        EnvelopeStatus::Edited => {
            format!("comment:{comment_id}:{state}:{}", stamp.unwrap_or_default())
        }
        _ => format!("comment:{comment_id}:{state}"),
    }
}

/// Who wrote a comment, from its `from` (`name_key`: Facebook's `name`, Instagram's
/// `username`): ours when its id is the account's own.
fn comment_author(from: &Value, name_key: &str, account: &str) -> EnvelopeAuthor {
    let author_id = id(&from["id"]);
    EnvelopeAuthor {
        is_self: author_id.as_deref() == Some(account),
        id: author_id,
        name: from[name_key]
            .as_str()
            .filter(|n| !n.trim().is_empty())
            .map(str::to_owned),
    }
}

/// The event of a Page's `feed` change about a comment (`item: comment`) of a verb the inbox
/// follows (`add`, `edit`/`edited`, `remove`/`delete`); `None` for any other item or verb (posts,
/// visitor posts, reactions, shares; a hide, unhide or block: what the business does to a comment
/// is recorded where it does it), or a comment without its id or any time.
fn feed_comment(account: &str, entry_time: &Value, value: Value) -> Option<InboundEventDraft> {
    if value["item"] != "comment" {
        return None;
    }
    let status = match value["verb"].as_str()? {
        "add" => EnvelopeStatus::Open,
        "edit" | "edited" => EnvelopeStatus::Edited,
        "remove" | "delete" => EnvelopeStatus::Removed,
        _ => return None,
    };
    let comment_id = id(&value["comment_id"])?;
    let created_at = from_seconds(&value["created_time"]).or_else(|| from_seconds(entry_time))?;
    let post_id = id(&value["post_id"]);
    // A top-level comment's `parent_id` is its post; a reply's, the comment it answers, which is
    // taken as its thread's root.
    let parent = id(&value["parent_id"]).filter(|parent| Some(parent) != post_id.as_ref());
    let subject = post_id.map(|post| EnvelopeSubject {
        kind: SubjectKind::Post,
        external_id: post,
        title: String::new(),
        url: value["post"]["permalink_url"].as_str().map(str::to_owned),
        image_url: None,
        facts: match value["post"]["status_type"].as_str() {
            Some(status_type) => json!({ "status_type": status_type }),
            None => Value::Null,
        },
    });
    let envelope = PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: account.to_owned(),
        root_external_id: parent.clone().unwrap_or_else(|| comment_id.clone()),
        parent_external_id: parent,
        external_id: comment_id.clone(),
        status,
        author: comment_author(&value["from"], "name", account),
        text: value["message"].as_str().unwrap_or_default().to_owned(),
        created_at,
        deadline: None,
        live: false,
        subject,
        answer: None,
        rejection: None,
    };
    let occurred_at = match status {
        EnvelopeStatus::Open => Some(created_at),
        _ => from_seconds(entry_time).or(Some(created_at)),
    };
    Some(InboundEventDraft {
        external_id: comment_event_id(&comment_id, status, id(entry_time).as_deref()),
        kind: EventKind::Comment,
        payload: envelope.into_payload(value),
        occurred_at,
    })
}

/// The event of an Instagram account's `comments` or `live_comments` change (`live`): a new
/// comment on its media. Instagram's change carries no time of its own: the entry's is used, and
/// a change without one is left out, as is one without its id.
fn instagram_comment(
    account: &str,
    entry_time: &Value,
    value: Value,
    live: bool,
) -> Option<InboundEventDraft> {
    let comment_id = id(&value["id"])?;
    let created_at = from_seconds(entry_time)?;
    // Replies are one level deep ("replies to a reply will be added to the top-level comment",
    // the reference of `/{ig-comment-id}/replies`): a reply's parent is its thread's root.
    let parent = id(&value["parent_id"]);
    let subject = id(&value["media"]["id"]).map(|media| EnvelopeSubject {
        kind: SubjectKind::Post,
        external_id: media,
        title: String::new(),
        url: None,
        image_url: None,
        facts: match value["media"]["media_product_type"].as_str() {
            Some(product) => json!({ "media_product_type": product }),
            None => Value::Null,
        },
    });
    let envelope = PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: account.to_owned(),
        root_external_id: parent.clone().unwrap_or_else(|| comment_id.clone()),
        parent_external_id: parent,
        external_id: comment_id.clone(),
        status: EnvelopeStatus::Open,
        author: comment_author(&value["from"], "username", account),
        text: value["text"].as_str().unwrap_or_default().to_owned(),
        created_at,
        deadline: None,
        live,
        subject,
        answer: None,
        rejection: None,
    };
    Some(InboundEventDraft {
        external_id: comment_event_id(&comment_id, EnvelopeStatus::Open, None),
        kind: EventKind::Comment,
        payload: envelope.into_payload(value),
        occurred_at: Some(created_at),
    })
}
