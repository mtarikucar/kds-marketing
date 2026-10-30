//! TikTok's webhooks, read: the body of a delivery to `/hooks/tiktok`, once the webhook gate
//! (`jt_webhook`) checked its `TikTok-Signature` (`jt_connector::tiktok_signature_ok`). Pure: no
//! call, no clock.
//!
//! **The body** (<https://developers.tiktok.com/doc/webhooks-events>): one event per delivery, a
//! JSON object of `client_key` (the app's), `event` (its name), `create_time` (Unix seconds),
//! `user_openid` (the account's open id for the app: a `tiktok` capability's external id) and
//! `content`, the event's own fields as a serialized JSON string.
//!
//! **The events** this system acts on:
//!
//! | Event | `content` | Effect |
//! |---|---|---|
//! | `authorization.removed` (<https://developers.tiktok.com/doc/webhooks-events>) | `reason` (int: 0 unknown, 1 the user disconnected in TikTok, 2 the account was deleted, 3 its age changed, 4 it was banned, 5 the developer revoked it) | [`TiktokHookEffect::AuthorizationRemoved`] with the reason's key ([`AUTHORIZATION_REASONS`]) |
//! | `post.publish.failed`, `post.publish.complete`, `post.publish.inbox_delivered`, `post.publish.publicly_available` (<https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status>, "Content Posting webhooks") | `publish_id`, `publish_type`; `reason` (failed), `post_id` (publicly available) | [`TiktokHookEffect::PublishMoved`] with the publish id: the post's status is read at once |
//!
//! Every other event is [`TiktokHookEffect::Kept`]: stored for the agent to read, nothing done.
//! Among them `post.publish.no_longer_publicaly_available` (TikTok's spelling), a post no longer
//! public, which no status read reflects, and the Share Video API's `video.upload.failed` and
//! `video.publish.completed`, which name a `share_id` (that API is retired: its posts are
//! Content Posting's now, <https://developers.tiktok.com/bulletin/migration-notice-share-video-api>).
//! A post event without a publish id is kept too.
//!
//! **What is stored** ([`TiktokHook::draft`]): the event's name as its kind, its time, and under
//! `payload.tiktok` the name, `create_time` and the parsed `content` (an object; `null` when
//! absent or not one). Neither the client key nor the open id is kept in the payload: the event
//! is attached to the capability holding the account.
//!
//! **Identity** ([`TiktokHook::external_id`]). TikTok's events carry no id of their own and are
//! delivered at least once, so an event is named by what it says: the lowercase hex SHA-256 of
//! its name, open id, `create_time` and `content` (as sent), each followed by a unit separator.
//! A redelivery says the same and is stored once.

use jt_app::ports::connectors::InboundEventDraft;
use jt_app::usecases::webhook::{TiktokHookEffect, TiktokHookEvent};
use jt_connector::EventKind;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// The event whose effect is [`TiktokHookEffect::AuthorizationRemoved`].
pub const AUTHORIZATION_REMOVED: &str = "authorization.removed";

/// The Content Posting events whose effect is [`TiktokHookEffect::PublishMoved`]: a post failed,
/// was posted (or, for a draft, posted by its creator from it), reached the creator's inbox, or
/// became public.
pub const PUBLISH_MOVED: &[&str] = &[
    "post.publish.failed",
    "post.publish.complete",
    "post.publish.inbox_delivered",
    "post.publish.publicly_available",
];

/// `authorization.removed`'s `reason` codes, by their keys
/// (<https://developers.tiktok.com/doc/webhooks-events>); any other code, or none, is `unknown`.
pub const AUTHORIZATION_REASONS: &[(i64, &str)] = &[
    (0, "unknown"),
    (1, "user_disconnected"),
    (2, "account_deleted"),
    (3, "age_changed"),
    (4, "account_banned"),
    (5, "developer_revoked"),
];

/// The longest text field taken (an event name, an open id, a publish id), in characters.
const MAX_FIELD_CHARS: usize = 256;

/// Why a signed body is not a TikTok webhook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    /// Not a JSON object.
    NotJson,
    /// No event name.
    NoEvent,
}

/// One TikTok webhook, read (see the module docs).
#[derive(Clone, Debug, PartialEq)]
pub struct TiktokHook {
    /// The app it was sent for (`client_key`); empty when the body names none.
    pub client_key: String,
    /// The event's name.
    pub event: String,
    /// When it happened (`create_time`), when the body says.
    pub create_time: Option<OffsetDateTime>,
    /// The account's open id (`user_openid`); empty when the body names none.
    pub open_id: String,
    /// The event's fields: `content` parsed (an object), else `null`.
    pub content: Value,
    /// The event's identity (see the module docs).
    pub external_id: String,
}

/// `value` as text: a string, or an integer written in decimal; `None` otherwise.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_owned()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// `value` as a field: text of at most [`MAX_FIELD_CHARS`] characters, none of them control.
fn field(value: &Value) -> Option<String> {
    text_of(value).filter(|s| {
        !s.is_empty() && s.chars().count() <= MAX_FIELD_CHARS && !s.chars().any(char::is_control)
    })
}

/// Lowercase hex of `bytes`.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads the body `raw` of a delivery (see the module docs).
pub fn parse(raw: &[u8]) -> Result<TiktokHook, ParseError> {
    let body: Value = serde_json::from_slice(raw).map_err(|_| ParseError::NotJson)?;
    let Value::Object(body) = body else {
        return Err(ParseError::NotJson);
    };
    let event = body
        .get("event")
        .and_then(field)
        .ok_or(ParseError::NoEvent)?;
    let client_key = body.get("client_key").and_then(field).unwrap_or_default();
    let open_id = body.get("user_openid").and_then(field).unwrap_or_default();
    let create_text = body
        .get("create_time")
        .and_then(text_of)
        .unwrap_or_default();
    let create_time = create_text
        .parse::<i64>()
        .ok()
        .and_then(|t| OffsetDateTime::from_unix_timestamp(t).ok());
    // `content` is a serialized JSON string; an object is taken as is.
    let (content_text, content) = match body.get("content") {
        Some(Value::String(text)) => (
            text.clone(),
            serde_json::from_str::<Value>(text)
                .ok()
                .filter(Value::is_object)
                .unwrap_or(Value::Null),
        ),
        Some(object @ Value::Object(_)) => (object.to_string(), object.clone()),
        _ => (String::new(), Value::Null),
    };
    let mut digest = Sha256::new();
    for part in [&event, &open_id, &create_text, &content_text] {
        digest.update(part.as_bytes());
        digest.update([0x1f]);
    }
    Ok(TiktokHook {
        client_key,
        event,
        create_time,
        open_id,
        content,
        external_id: hex(&digest.finalize()),
    })
}

impl TiktokHook {
    /// What the system does about it (see the module docs).
    pub fn effect(&self) -> TiktokHookEffect {
        if self.event == AUTHORIZATION_REMOVED {
            let code = self.content["reason"].as_i64();
            let reason = AUTHORIZATION_REASONS
                .iter()
                .find(|(c, _)| Some(*c) == code)
                .map_or("unknown", |(_, key)| key);
            return TiktokHookEffect::AuthorizationRemoved {
                reason: reason.to_owned(),
            };
        }
        if PUBLISH_MOVED.contains(&self.event.as_str())
            && let Some(publish_id) = field(&self.content["publish_id"])
        {
            return TiktokHookEffect::PublishMoved { publish_id };
        }
        TiktokHookEffect::Kept
    }

    /// The inbound event it is stored as (see the module docs).
    pub fn draft(&self) -> InboundEventDraft {
        let mut item = Map::new();
        item.insert("event".to_owned(), json!(self.event));
        item.insert(
            "create_time".to_owned(),
            json!(self.create_time.map(OffsetDateTime::unix_timestamp)),
        );
        item.insert("content".to_owned(), self.content.clone());
        InboundEventDraft {
            external_id: self.external_id.clone(),
            kind: EventKind::parse(&self.event),
            payload: json!({ "tiktok": item }),
            occurred_at: self.create_time,
        }
    }

    /// The event as the use cases take it: the account it is about, its effect and its draft.
    pub fn into_event(self) -> TiktokHookEvent {
        TiktokHookEvent {
            effect: self.effect(),
            draft: self.draft(),
            open_id: self.open_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(event: &str, content: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "client_key": "tiktok-client-key",
            "event": event,
            "create_time": 1_792_682_935,
            "user_openid": "open-id-test",
            "content": content,
        }))
        .unwrap()
    }

    #[test]
    fn a_body_is_read_with_its_content_parsed() {
        let hook = parse(&body("authorization.removed", "{\"reason\": 1 }")).unwrap();
        assert_eq!(hook.client_key, "tiktok-client-key");
        assert_eq!(hook.event, "authorization.removed");
        assert_eq!(hook.open_id, "open-id-test");
        assert_eq!(
            hook.create_time,
            Some(OffsetDateTime::from_unix_timestamp(1_792_682_935).unwrap())
        );
        assert_eq!(hook.content, json!({ "reason": 1 }));
        assert_eq!(hook.external_id.len(), 64);
        assert!(
            hook.external_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }

    #[test]
    fn what_is_not_a_webhook_is_refused() {
        for raw in [&b""[..], b"[]", b"\"x\"", b"{", b"null"] {
            assert_eq!(parse(raw), Err(ParseError::NotJson), "{raw:?}");
        }
        for raw in [&br#"{}"#[..], br#"{"event":""}"#, br#"{"event":7.5}"#] {
            assert_eq!(parse(raw), Err(ParseError::NoEvent), "{raw:?}");
        }
        // The rest is optional: missing, or not as TikTok writes it, it reads as nothing.
        let hook = parse(br#"{"event":"x","create_time":"soon","content":7}"#).unwrap();
        assert_eq!((hook.client_key.as_str(), hook.open_id.as_str()), ("", ""));
        assert_eq!((hook.create_time, hook.content), (None, Value::Null));
    }

    #[test]
    fn the_identity_is_what_the_event_says() {
        let a = parse(&body("post.publish.complete", r#"{"publish_id":"p1"}"#)).unwrap();
        // The same event in another layout (a redelivery) is the same event.
        let again: Value =
            serde_json::from_slice(&body("post.publish.complete", r#"{"publish_id":"p1"}"#))
                .unwrap();
        let mut reordered = serde_json::to_vec_pretty(&again).unwrap();
        reordered.push(b'\n');
        assert_eq!(parse(&reordered).unwrap().external_id, a.external_id);
        // Anything it says differently is another.
        for other in [
            body("post.publish.failed", r#"{"publish_id":"p1"}"#),
            body("post.publish.complete", r#"{"publish_id":"p2"}"#),
            body("post.publish.complete", r#"{"publish_id": "p1"}"#),
        ] {
            assert_ne!(parse(&other).unwrap().external_id, a.external_id);
        }
        let mut later: Value = again.clone();
        later["create_time"] = json!(1_792_682_936);
        assert_ne!(
            parse(&serde_json::to_vec(&later).unwrap())
                .unwrap()
                .external_id,
            a.external_id
        );
        let mut elsewhere = again;
        elsewhere["user_openid"] = json!("another-open-id");
        assert_ne!(
            parse(&serde_json::to_vec(&elsewhere).unwrap())
                .unwrap()
                .external_id,
            a.external_id
        );
    }

    #[test]
    fn effects_follow_the_event() {
        let effect = |event: &str, content: &str| parse(&body(event, content)).unwrap().effect();
        for (code, key) in AUTHORIZATION_REASONS {
            assert_eq!(
                effect(AUTHORIZATION_REMOVED, &format!("{{\"reason\": {code}}}")),
                TiktokHookEffect::AuthorizationRemoved {
                    reason: (*key).to_owned()
                }
            );
        }
        for content in ["{\"reason\": 9}", "{}", "not json"] {
            assert_eq!(
                effect(AUTHORIZATION_REMOVED, content),
                TiktokHookEffect::AuthorizationRemoved {
                    reason: "unknown".into()
                },
                "{content}"
            );
        }
        for event in PUBLISH_MOVED {
            assert_eq!(
                effect(
                    event,
                    r#"{"publish_id":"v_pub_file~v2-1.7","publish_type":"DIRECT_PUBLISH","post_id":"7300000000000000001","reason":"spam_risk"}"#
                ),
                TiktokHookEffect::PublishMoved {
                    publish_id: "v_pub_file~v2-1.7".into()
                },
                "{event}"
            );
            assert_eq!(effect(event, "{}"), TiktokHookEffect::Kept, "{event}");
            assert_eq!(
                effect(event, r#"{"publish_id":""}"#),
                TiktokHookEffect::Kept,
                "{event}"
            );
        }
        for event in [
            "post.publish.no_longer_publicaly_available",
            "video.upload.failed",
            "video.publish.completed",
            "portability.download.ready",
            "something.new",
        ] {
            assert_eq!(
                effect(event, r#"{"publish_id":"p1","share_id":"s1"}"#),
                TiktokHookEffect::Kept,
                "{event}"
            );
        }
    }

    #[test]
    fn the_draft_keeps_the_event_not_the_app_or_the_account() {
        let hook = parse(&body(
            "post.publish.publicly_available",
            r#"{"publish_id":"p1","post_id":"7300000000000000001","publish_type":"DIRECT_PUBLISH"}"#,
        ))
        .unwrap();
        let draft = hook.draft();
        assert_eq!(draft.external_id, hook.external_id);
        assert_eq!(draft.kind.key(), "post.publish.publicly_available");
        assert_eq!(draft.occurred_at, hook.create_time);
        assert_eq!(
            draft.payload,
            json!({ "tiktok": {
                "event": "post.publish.publicly_available",
                "create_time": 1_792_682_935,
                "content": {
                    "publish_id": "p1",
                    "post_id": "7300000000000000001",
                    "publish_type": "DIRECT_PUBLISH",
                },
            } })
        );
        let text = draft.payload.to_string();
        assert!(!text.contains("tiktok-client-key") && !text.contains("open-id-test"));
        let event = hook.into_event();
        assert_eq!(event.open_id, "open-id-test");
        assert_eq!(
            event.effect,
            TiktokHookEffect::PublishMoved {
                publish_id: "p1".into()
            }
        );
    }
}
