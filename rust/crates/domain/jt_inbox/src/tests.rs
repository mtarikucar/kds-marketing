use jt_capability::{CapabilityId, KINDS, KindGroup};
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use crate::*;

fn now() -> OffsetDateTime {
    OffsetDateTime::UNIX_EPOCH + Duration::days(20_000)
}

fn conversation() -> Conversation {
    serde_json::from_value(json!({
        "id": ConversationId::new_v7(), "workspace_id": WorkspaceId::new_v7(),
        "person_id": PersonId::new_v7(), "capability_id": CapabilityId::new_v7(),
        "kind_key": "whatsapp_cloud"
    }))
    .unwrap()
}

fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(value: T) {
    let encoded = serde_json::to_string(&value).unwrap();
    assert_eq!(serde_json::from_str::<T>(&encoded).unwrap(), value);
}

#[test]
fn phone_channels_share_one_identity() {
    for channel in [Channel::WhatsApp, Channel::Sms, Channel::Phone] {
        assert_eq!(channel.identity_channel(), IdentityChannel::Phone);
        assert_eq!(
            normalise(channel.identity_channel(), "0532 123 45 67").unwrap(),
            "+905321234567"
        );
    }
    for (channel, identity) in [
        (Channel::Email, IdentityChannel::Email),
        (Channel::InstagramDm, IdentityChannel::InstagramDm),
        (Channel::Messenger, IdentityChannel::Messenger),
        (Channel::Webchat, IdentityChannel::Webchat),
    ] {
        assert_eq!(channel.identity_channel(), identity);
    }
}

#[test]
fn phone_variants_normalise_to_one_e164() {
    for raw in [
        "5321234567",
        "532 123 45 67",
        "(532) 123-45-67",
        "05321234567",
        "905321234567",
        "+905321234567",
        " 0 (532) 123-45-67 ",
        "+90 (532) 123 45 67",
    ] {
        assert_eq!(
            normalise(IdentityChannel::Phone, raw).unwrap(),
            "+905321234567"
        );
    }
    for (raw, expected) in [
        ("+1 (202) 555-0123", "+12025550123"),
        ("+12125551234", "+12125551234"),
        ("+5321234567", "+5321234567"),
        ("12345678", "+12345678"),
        ("+123456789012345", "+123456789012345"),
        ("+01234567890", "+01234567890"),
    ] {
        assert_eq!(normalise(IdentityChannel::Phone, raw).unwrap(), expected);
    }
    for raw in [
        "",
        "words",
        "+",
        "1234567",
        "1234567890123456",
        "+1234567890123456",
        "１２３４５６７８",
    ] {
        assert_eq!(
            normalise(IdentityChannel::Phone, raw),
            Err(IdentityError::Invalid)
        );
    }
}

#[test]
fn email_normalises_case_and_space() {
    assert_eq!(
        normalise(IdentityChannel::Email, "  Alice@EXAMPLE.COM \n").unwrap(),
        "alice@example.com"
    );
    for raw in [
        "",
        "a",
        "@example.com",
        "a@",
        "a@@example.com",
        "a b@example.com",
        "a@exam ple.com",
        "a\0@example.com",
    ] {
        assert_eq!(
            normalise(IdentityChannel::Email, raw),
            Err(IdentityError::Invalid),
            "{raw:?}"
        );
    }
}

#[test]
fn opaque_ids_are_account_scoped() {
    for channel in [
        IdentityChannel::InstagramDm,
        IdentityChannel::Messenger,
        IdentityChannel::Webchat,
    ] {
        let raw = normalise(channel, "  AbC:123  ").unwrap();
        assert_eq!(raw, "AbC:123");
        assert_eq!(scope_opaque("page-a", &raw), "page-a:AbC:123");
        assert_ne!(scope_opaque("page-a", &raw), scope_opaque("page-b", &raw));
        assert_eq!(normalise(channel, " \t\n "), Err(IdentityError::Invalid));
    }
}

#[test]
fn channel_for_every_messaging_kind() {
    for kind in KINDS
        .iter()
        .filter(|kind| kind.group == KindGroup::Messaging || kind.key == "netgsm_pbx")
    {
        let expected = match kind.key {
            "whatsapp_cloud" => Channel::WhatsApp,
            "instagram_dm" => Channel::InstagramDm,
            "messenger" => Channel::Messenger,
            "sms_line" => Channel::Sms,
            "mailbox" => Channel::Email,
            "webchat" => Channel::Webchat,
            "netgsm_pbx" => Channel::Phone,
            other => panic!("add an expected contact channel for {other}"),
        };
        assert_eq!(channel_for_kind(kind.key), Some(expected));
    }
    for kind in KINDS
        .iter()
        .filter(|kind| kind.group != KindGroup::Messaging && kind.key != "netgsm_pbx")
    {
        assert_eq!(channel_for_kind(kind.key), None);
    }
    assert_eq!(channel_for_kind("unknown"), None);
}

#[test]
fn inbound_and_outbound_clear_snooze() {
    let mut conv = conversation();
    let user = UserId::new_v7();
    conv.take_over(Some(user));
    for initial in [
        ConvState::Open,
        ConvState::Ours,
        ConvState::Theirs,
        ConvState::Snoozed { until: now() },
        ConvState::Closed,
    ] {
        conv.state = initial.clone();
        assert_eq!(conv.reopen_on_inbound(now()), initial == ConvState::Closed);
        assert_eq!(conv.state, ConvState::Ours);
        assert_eq!(conv.last_inbound_at, Some(now()));
        conv.snooze(now() + Duration::days(1));
        assert_eq!(
            conv.state,
            ConvState::Snoozed {
                until: now() + Duration::days(1)
            }
        );
        conv.on_outbound(now() + Duration::seconds(1));
        assert_eq!(conv.state, ConvState::Theirs);
        assert_eq!(conv.last_outbound_at, Some(now() + Duration::seconds(1)));
        assert_eq!(conv.last_inbound_at, Some(now()));
        assert_eq!(
            conv.executor,
            Executor::Human {
                user_id: Some(user)
            }
        );
        assert_eq!(conv.executor_generation, 1);
    }
    conv.snooze(now());
    conv.unsnooze();
    assert_eq!(conv.state, ConvState::Ours);
}

#[test]
fn executor_changes_bump_generation() {
    let mut conv = conversation();
    assert_eq!(conv.executor, Executor::Agent);
    assert_eq!(conv.executor_generation, 0);
    let user = UserId::new_v7();
    assert_eq!(conv.take_over(Some(user)), 1);
    assert_eq!(
        conv.executor,
        Executor::Human {
            user_id: Some(user)
        }
    );
    assert_eq!(conv.take_over(None), 2);
    assert_eq!(conv.executor, Executor::Human { user_id: None });
    assert_eq!(conv.hand_to_agent(), 3);
    assert_eq!(conv.executor, Executor::Agent);
    assert_eq!(conv.hand_to_agent(), 4);
}

#[test]
fn generation_exhaustion_never_reuses_a_fence() {
    let mut conv = conversation();
    conv.executor_generation = u32::MAX;
    let before = conv.clone();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| conv.take_over(None))).is_err()
    );
    assert_eq!(conv, before);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| conv.hand_to_agent())).is_err()
    );
    assert_eq!(conv, before);
}

#[test]
fn stored_records_tolerate_missing_new_fields() {
    let person_id = PersonId::new_v7();
    let workspace_id = WorkspaceId::new_v7();
    let person: Person = serde_json::from_value(json!({
        "id": person_id, "workspace_id": workspace_id,
        "first_touch": { "source": "import", "future": true }, "future": true
    }))
    .unwrap();
    assert_eq!(person.display_name, "");
    assert_eq!(person.company, "");
    assert_eq!(person.first_touch.capability_id, None);
    assert_eq!(person.first_touch.at, OffsetDateTime::UNIX_EPOCH);
    assert_eq!(person.merged_into, None);
    assert_eq!(person.erased_at, None);
    assert_eq!(person.created_at, OffsetDateTime::UNIX_EPOCH);
    assert_eq!(person.updated_at, OffsetDateTime::UNIX_EPOCH);
    round_trip(person);
    let identity: Identity = serde_json::from_value(json!({
        "id": IdentityId::new_v7(), "workspace_id": workspace_id, "person_id": person_id,
        "channel": "phone", "value_normalized": "+905321234567", "future": true
    }))
    .unwrap();
    assert!(identity.active);
    assert_eq!(identity.value_display, "");
    assert_eq!(identity.first_seen_at, OffsetDateTime::UNIX_EPOCH);
    round_trip(identity);
    let conv = conversation();
    assert_eq!(conv.state, ConvState::Open);
    assert_eq!(conv.last_inbound_at, None);
    assert_eq!(conv.last_outbound_at, None);
    round_trip(conv);
    let message: Message = serde_json::from_value(json!({
        "id": MessageId::new_v7(), "workspace_id": workspace_id,
        "conversation_id": ConversationId::new_v7(), "direction": "outbound", "future": true
    }))
    .unwrap();
    assert_eq!(message.author, Author::System);
    assert_eq!(message.body, "");
    assert_eq!(message.external_id, None);
    assert_eq!(message.status, MsgStatus::Unknown);
    assert_eq!(message.cost_minor, None);
    assert_eq!(message.at, OffsetDateTime::UNIX_EPOCH);
    round_trip(message);
    for empty in [json!({}), json!({"future": true})] {
        assert!(serde_json::from_value::<Person>(empty.clone()).is_err());
        assert!(serde_json::from_value::<Identity>(empty.clone()).is_err());
        assert!(serde_json::from_value::<Conversation>(empty.clone()).is_err());
        assert!(serde_json::from_value::<Message>(empty).is_err());
    }
}

#[test]
fn serde_round_trips_preserve_variants_and_populated_records() {
    let user = UserId::new_v7();
    for channel in [
        Channel::WhatsApp,
        Channel::InstagramDm,
        Channel::Messenger,
        Channel::Sms,
        Channel::Email,
        Channel::Webchat,
        Channel::Phone,
    ] {
        round_trip(channel);
        round_trip(channel.identity_channel());
        round_trip(Source::Channel(channel));
    }
    assert_eq!(
        serde_json::to_value(Channel::WhatsApp).unwrap(),
        json!("whats_app")
    );
    for source in [
        Source::MetaAds,
        Source::Import,
        Source::Form,
        Source::Repeat,
    ] {
        round_trip(source);
    }
    for source in [
        EventSource::System,
        EventSource::Agent,
        EventSource::Human(user),
    ] {
        round_trip(source);
    }
    for author in [
        Author::Customer,
        Author::Agent,
        Author::Human(user),
        Author::System,
    ] {
        round_trip(author);
    }
    for state in [
        ConvState::Open,
        ConvState::Ours,
        ConvState::Theirs,
        ConvState::Snoozed { until: now() },
        ConvState::Closed,
    ] {
        let mut conv = conversation();
        conv.state = state;
        conv.executor = Executor::Human {
            user_id: Some(user),
        };
        conv.executor_generation = 42;
        conv.last_inbound_at = Some(now());
        conv.last_outbound_at = Some(now());
        round_trip(conv);
    }
    round_trip(Executor::Human { user_id: None });
    let person = Person {
        id: PersonId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        display_name: "Alice".into(),
        company: "Example".into(),
        first_touch: FirstTouch {
            source: Source::MetaAds,
            capability_id: Some(CapabilityId::new_v7()),
            at: now(),
        },
        merged_into: Some(PersonId::new_v7()),
        erased_at: Some(now()),
        created_at: now(),
        updated_at: now(),
    };
    round_trip(Identity {
        id: IdentityId::new_v7(),
        workspace_id: person.workspace_id,
        person_id: person.id,
        channel: IdentityChannel::Email,
        value_normalized: "alice@example.com".into(),
        value_display: "Alice@Example.com".into(),
        active: false,
        first_seen_at: now(),
    });
    for direction in [Direction::Inbound, Direction::Outbound] {
        for status in [
            MsgStatus::Received,
            MsgStatus::Queued,
            MsgStatus::Sent,
            MsgStatus::Delivered,
            MsgStatus::Failed,
            MsgStatus::Unknown,
            MsgStatus::Refused {
                reason: "executor_changed".into(),
            },
        ] {
            round_trip(Message {
                id: MessageId::new_v7(),
                workspace_id: person.workspace_id,
                conversation_id: ConversationId::new_v7(),
                direction,
                author: Author::Human(user),
                body: "Hello".into(),
                external_id: Some("mid-1".into()),
                status,
                cost_minor: Some(12),
                at: now(),
            });
        }
    }
    round_trip(person);
    let mut value = serde_json::to_value(conversation()).unwrap();
    value["future"] = Value::Bool(true);
    assert!(serde_json::from_value::<Conversation>(value).is_ok());
}
