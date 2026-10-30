//! Public items (spec 2026-10-30-inbox-comments-marketplace-design.md §3): the four public
//! channels and their namespaces, the rules per surface, the reply fence, the text checks and the
//! item lifecycle.

use std::collections::BTreeSet;

use jt_capability::CapabilityId;
use jt_inbox::public::*;
use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde_json::json;
use sha2::{Digest, Sha256};
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

/// When the test comment was written.
const T0: OffsetDateTime = datetime!(2026-10-30 10:00:00 UTC);

/// The four public channels, their capability kind and their identity namespace (spec §3.1).
const PUBLIC: [(Channel, &str, IdentityChannel, &str); 4] = [
    (
        Channel::InstagramComment,
        "instagram",
        IdentityChannel::InstagramCommenter,
        "instagram_comment",
    ),
    (
        Channel::FacebookComment,
        "facebook_page",
        IdentityChannel::FacebookCommenter,
        "facebook_comment",
    ),
    (
        Channel::TrendyolQuestion,
        "trendyol",
        IdentityChannel::TrendyolBuyer,
        "trendyol_question",
    ),
    (
        Channel::HepsiburadaQuestion,
        "hepsiburada",
        IdentityChannel::HepsiburadaBuyer,
        "hepsiburada_question",
    ),
];

/// The seven private channels and the kind each is the contact channel of.
const PRIVATE: [(Channel, &str); 7] = [
    (Channel::WhatsApp, "whatsapp_cloud"),
    (Channel::InstagramDm, "instagram_dm"),
    (Channel::Messenger, "messenger"),
    (Channel::Sms, "sms_line"),
    (Channel::Email, "mailbox"),
    (Channel::Webchat, "webchat"),
    (Channel::Phone, "netgsm_pbx"),
];

#[test]
fn public_channels_map_to_their_kinds_and_namespaces() {
    for (channel, kind, namespace, key) in PUBLIC {
        assert_eq!(public_channel_for_kind(kind), Some(channel), "{kind}");
        assert_eq!(channel.identity_channel(), namespace, "{kind}");
        assert!(channel.is_public(), "{kind}");
        // The private contact channel of a kind keeps its meaning: none for these.
        assert_eq!(channel_for_kind(kind), None, "{kind}");
        assert_eq!(conversation_channel(kind), Some(channel), "{kind}");
        assert_eq!(serde_json::to_value(channel).unwrap(), json!(key));
        assert_eq!(
            serde_json::from_value::<Channel>(json!(key)).unwrap(),
            channel
        );
    }
    for (channel, kind) in PRIVATE {
        assert!(!channel.is_public(), "{kind}");
        assert_eq!(public_channel_for_kind(kind), None, "{kind}");
        assert_eq!(conversation_channel(kind), Some(channel), "{kind}");
    }
    // Every channel there is is the conversation channel of exactly one kind.
    let channels: BTreeSet<String> = PUBLIC
        .iter()
        .map(|(c, ..)| *c)
        .chain(PRIVATE.iter().map(|(c, _)| *c))
        .map(|c| serde_json::to_string(&c).unwrap())
        .collect();
    assert_eq!(channels.len(), 11);
    for off_list in [
        "",
        "Instagram",
        " instagram",
        "instagram_comment",
        "x",
        "tiktok",
        "n11",
        "unknown",
    ] {
        assert_eq!(public_channel_for_kind(off_list), None, "{off_list:?}");
        assert_eq!(conversation_channel(off_list), None, "{off_list:?}");
    }
}

#[test]
fn new_namespaces_are_opaque() {
    for (_, _, namespace, _) in PUBLIC {
        assert_eq!(normalise(namespace, "  17  ").unwrap(), "17");
        // Case and inner punctuation are the provider's: kept as they are.
        assert_eq!(normalise(namespace, " AbC:q-9 ").unwrap(), "AbC:q-9");
        assert_eq!(normalise(namespace, ""), Err(IdentityError::Invalid));
        assert_eq!(normalise(namespace, " \t\n "), Err(IdentityError::Invalid));
        assert_eq!(scope_opaque("seller-1", "17"), "seller-1:17");
    }
}

fn sha256_hex(namespace: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update(value.as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn erasure_namespaces_are_stable() {
    let every = [
        IdentityChannel::Phone,
        IdentityChannel::Email,
        IdentityChannel::InstagramDm,
        IdentityChannel::Messenger,
        IdentityChannel::Webchat,
        IdentityChannel::InstagramCommenter,
        IdentityChannel::FacebookCommenter,
        IdentityChannel::TrendyolBuyer,
        IdentityChannel::HepsiburadaBuyer,
    ];
    let value = "account-1:17";
    let hashes: BTreeSet<String> = every.iter().map(|c| identity_hash(*c, value)).collect();
    assert_eq!(hashes.len(), every.len(), "one hash per namespace");
    for (namespace, name) in [
        (IdentityChannel::InstagramCommenter, "instagram_commenter"),
        (IdentityChannel::FacebookCommenter, "facebook_commenter"),
        (IdentityChannel::TrendyolBuyer, "trendyol_buyer"),
        (IdentityChannel::HepsiburadaBuyer, "hepsiburada_buyer"),
    ] {
        assert_eq!(identity_hash(namespace, value), sha256_hex(name, value));
        // The hash's namespace is the name the identity is stored under.
        assert_eq!(serde_json::to_value(namespace).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<IdentityChannel>(json!(name)).unwrap(),
            namespace
        );
    }
}

#[test]
fn rules_table_is_the_spec_table() {
    assert_eq!(INSTAGRAM_COMMENT_MAX, 2_200);
    assert_eq!(INSTAGRAM_PRIVATE_MAX, 1_000);
    assert_eq!(FACEBOOK_COMMENT_MAX, 8_000);
    assert_eq!(FACEBOOK_PRIVATE_MAX, 2_000);
    assert_eq!(
        TRENDYOL_ANSWER,
        TextBounds {
            min: 10,
            max: 2_000
        }
    );
    assert_eq!(PRIVATE_REPLY_WINDOW, Duration::days(7));
    assert_eq!(HEPSIBURADA_ANSWER_BOUNDS, None, "set by H0");
    let seven_days = |max_chars| {
        Some(PrivateRule {
            window: Duration::days(7),
            max_chars,
        })
    };
    let expected = [
        (
            Channel::InstagramComment,
            PublicRules {
                public: Some(TextBounds { min: 1, max: 2_200 }),
                private: seven_days(1_000),
                one_answer: false,
                moderated: false,
                hide: true,
                delete: true,
                report: false,
                marketplace: false,
            },
        ),
        (
            Channel::FacebookComment,
            PublicRules {
                public: Some(TextBounds { min: 1, max: 8_000 }),
                private: seven_days(2_000),
                one_answer: false,
                moderated: false,
                hide: true,
                delete: true,
                report: false,
                marketplace: false,
            },
        ),
        (
            Channel::TrendyolQuestion,
            PublicRules {
                public: Some(TextBounds {
                    min: 10,
                    max: 2_000,
                }),
                private: None,
                one_answer: true,
                moderated: true,
                hide: false,
                delete: false,
                report: false,
                marketplace: true,
            },
        ),
        (
            Channel::HepsiburadaQuestion,
            PublicRules {
                public: None,
                private: None,
                one_answer: true,
                moderated: HEPSIBURADA_MODERATED,
                hide: false,
                delete: false,
                report: true,
                marketplace: true,
            },
        ),
    ];
    for (channel, rules_of) in expected {
        assert_eq!(rules(channel), Some(rules_of), "{channel:?}");
    }
    for (channel, _) in PRIVATE {
        assert_eq!(rules(channel), None, "{channel:?}");
    }
}

#[test]
fn answer_state_serialises_with_a_state_tag() {
    let message_id = MessageId::new_v7();
    let user = UserId::new_v7();
    let at = "2026-10-30T10:00:00Z";
    let cases = [
        (AnswerState::Awaiting, json!({"state": "awaiting"})),
        (
            AnswerState::Pending { message_id },
            json!({"state": "pending", "message_id": message_id}),
        ),
        (
            AnswerState::Answered {
                by: AnsweredBy::Us,
                message_id: Some(message_id),
                at: T0,
            },
            json!({"state": "answered", "by": "us", "message_id": message_id, "at": at}),
        ),
        (
            AnswerState::Answered {
                by: AnsweredBy::Elsewhere,
                message_id: None,
                at: T0,
            },
            json!({"state": "answered", "by": "elsewhere", "message_id": null, "at": at}),
        ),
        (
            AnswerState::Rejected {
                reason: "contains a link".into(),
                at: T0,
            },
            json!({"state": "rejected", "reason": "contains a link", "at": at}),
        ),
        (
            AnswerState::Handled {
                by: EventSource::Human(user),
                reason: HandledReason::NoReplyNeeded,
                at: T0,
            },
            json!({"state": "handled", "by": {"human": user}, "reason": "no_reply_needed", "at": at}),
        ),
        (
            AnswerState::Expired { at: T0 },
            json!({"state": "expired", "at": at}),
        ),
    ];
    let mut keys = Vec::new();
    for (state, encoded) in cases {
        assert_eq!(serde_json::to_value(&state).unwrap(), encoded);
        assert_eq!(json!(state.key()), encoded["state"]);
        assert_eq!(
            serde_json::from_value::<AnswerState>(encoded).unwrap(),
            state
        );
        if !keys.contains(&state.key()) {
            keys.push(state.key());
        }
    }
    // The values 0019's generated `answer_state` column accepts.
    assert_eq!(
        keys,
        [
            "awaiting", "pending", "answered", "rejected", "handled", "expired"
        ]
    );
    // An answered state written without its message reads as none.
    assert_eq!(
        serde_json::from_value::<AnswerState>(json!({"state": "answered", "by": "us", "at": at}))
            .unwrap(),
        AnswerState::Answered {
            by: AnsweredBy::Us,
            message_id: None,
            at: T0
        }
    );
    assert!(serde_json::from_value::<AnswerState>(json!({"state": "lost"})).is_err());

    for (reason, key) in [
        (HandledReason::NoReplyNeeded, "no_reply_needed"),
        (HandledReason::Spam, "spam"),
        (HandledReason::Duplicate, "duplicate"),
        (HandledReason::AnsweredElsewhere, "answered_elsewhere"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), json!(key));
    }
    for (moderation, key) in [
        (Moderation::Visible, "visible"),
        (Moderation::Hidden, "hidden"),
        (Moderation::Deleted, "deleted"),
        (Moderation::Removed, "removed"),
        (Moderation::Reported, "reported"),
    ] {
        assert_eq!(moderation.key(), key);
        assert_eq!(Moderation::from_key(key), Some(moderation));
        assert_eq!(serde_json::to_value(moderation).unwrap(), json!(key));
    }
    assert_eq!(Moderation::from_key("Visible"), None);
    assert_eq!(Moderation::default(), Moderation::Visible);
    for (kind, key) in [
        (PublicKind::Comment, "comment"),
        (PublicKind::Question, "question"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(key));
    }
    for (kind, key) in [
        (SubjectKind::Post, "post"),
        (SubjectKind::Product, "product"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(key));
    }
    for (visibility, key) in [
        (Visibility::Public, "public"),
        (Visibility::Private, "private"),
    ] {
        assert_eq!(serde_json::to_value(visibility).unwrap(), json!(key));
    }
}

/// A new, owed item of `channel`, written at [`T0`].
fn item(channel: Channel) -> PublicItem {
    let kind = match channel {
        Channel::InstagramComment | Channel::FacebookComment => PublicKind::Comment,
        _ => PublicKind::Question,
    };
    PublicItem {
        id: PublicItemId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        capability_id: CapabilityId::new_v7(),
        conversation_id: ConversationId::new_v7(),
        message_id: MessageId::new_v7(),
        subject_id: None,
        kind,
        external_id: "17890".into(),
        parent_external_id: None,
        root_external_id: "17890".into(),
        created_at: T0,
        deadline: None,
        private_reply_until: rules(channel)
            .and_then(|r| r.private)
            .map(|p| T0 + p.window),
        answer: AnswerState::Awaiting,
        moderation: Moderation::Visible,
        private_reply_message_id: None,
        agent_replied: false,
        checked_at: None,
        updated_at: T0,
    }
}

#[test]
fn items_and_subjects_read_tolerantly_and_round_trip() {
    let full = item(Channel::InstagramComment);
    let encoded = serde_json::to_value(&full).unwrap();
    assert_eq!(
        serde_json::from_value::<PublicItem>(encoded.clone()).unwrap(),
        full
    );
    let mut sparse = serde_json::Map::new();
    for key in [
        "id",
        "workspace_id",
        "capability_id",
        "conversation_id",
        "message_id",
        "kind",
        "external_id",
        "root_external_id",
        "answer",
    ] {
        sparse.insert(key.into(), encoded[key].clone());
    }
    sparse.insert("future".into(), json!(true));
    let read: PublicItem = serde_json::from_value(sparse.clone().into()).unwrap();
    assert_eq!(read.moderation, Moderation::Visible);
    assert!(!read.agent_replied);
    assert_eq!(read.deadline, None);
    assert_eq!(read.created_at, OffsetDateTime::UNIX_EPOCH);
    // The answer is the item's state: never invented on read.
    sparse.remove("answer");
    assert!(serde_json::from_value::<PublicItem>(sparse.into()).is_err());

    let subject = PublicSubject {
        id: PublicSubjectId::new_v7(),
        workspace_id: full.workspace_id,
        capability_id: full.capability_id,
        kind: SubjectKind::Post,
        external_id: "17841".into(),
        title: "Yeni sezon".into(),
        url: Some("https://example.com/p/1".into()),
        image_url: None,
        facts: json!({"media_product_type": "FEED"}),
        publication_id: None,
        first_seen_at: T0,
        updated_at: T0,
    };
    let encoded = serde_json::to_value(&subject).unwrap();
    assert_eq!(
        serde_json::from_value::<PublicSubject>(encoded.clone()).unwrap(),
        subject
    );
    let bare: PublicSubject = serde_json::from_value(json!({
        "id": encoded["id"], "workspace_id": encoded["workspace_id"],
        "capability_id": encoded["capability_id"], "kind": "product", "external_id": "B-1"
    }))
    .unwrap();
    assert_eq!(bare.title, "");
    assert_eq!(bare.facts, json!({}));
    assert_eq!(MAX_SUBJECT_TITLE_CHARS, 280);
}

#[test]
fn awaiting_means_owed_and_visible() {
    let states = [
        (AnswerState::Awaiting, true),
        (
            AnswerState::Rejected {
                reason: "r".into(),
                at: T0,
            },
            true,
        ),
        (
            AnswerState::Pending {
                message_id: MessageId::new_v7(),
            },
            false,
        ),
        (
            AnswerState::Answered {
                by: AnsweredBy::Us,
                message_id: None,
                at: T0,
            },
            false,
        ),
        (
            AnswerState::Handled {
                by: EventSource::Agent,
                reason: HandledReason::Spam,
                at: T0,
            },
            false,
        ),
        (AnswerState::Expired { at: T0 }, false),
    ];
    for (answer, owed) in states {
        for moderation in [
            Moderation::Visible,
            Moderation::Hidden,
            Moderation::Deleted,
            Moderation::Removed,
            Moderation::Reported,
        ] {
            let mut i = item(Channel::InstagramComment);
            i.answer = answer.clone();
            i.moderation = moderation;
            assert_eq!(
                i.awaiting(),
                owed && moderation == Moderation::Visible,
                "{answer:?} {moderation:?}"
            );
        }
    }
}

/// One row of the reply fence's matrix: what it shows, the surface, how the owed item differs,
/// the reply's visibility, whether the agent replies, when, and the answer.
type Row = (
    &'static str,
    Channel,
    fn(&mut PublicItem),
    Visibility,
    bool,
    OffsetDateTime,
    Result<(), PublicRefusal>,
);

fn same(_: &mut PublicItem) {}
fn answered_by_agent(i: &mut PublicItem) {
    i.answer = AnswerState::Answered {
        by: AnsweredBy::Us,
        message_id: Some(MessageId::new_v7()),
        at: T0,
    };
    i.agent_replied = true;
}
fn answered_by_human(i: &mut PublicItem) {
    i.answer = AnswerState::Answered {
        by: AnsweredBy::Us,
        message_id: Some(MessageId::new_v7()),
        at: T0,
    };
}
fn answered_elsewhere(i: &mut PublicItem) {
    i.answer = AnswerState::Answered {
        by: AnsweredBy::Elsewhere,
        message_id: None,
        at: T0,
    };
}
fn pending(i: &mut PublicItem) {
    i.answer = AnswerState::Pending {
        message_id: MessageId::new_v7(),
    };
}
fn rejected(i: &mut PublicItem) {
    i.answer = AnswerState::Rejected {
        reason: "link".into(),
        at: T0,
    };
}
fn handled(i: &mut PublicItem) {
    i.answer = AnswerState::Handled {
        by: EventSource::Agent,
        reason: HandledReason::NoReplyNeeded,
        at: T0,
    };
}
fn expired(i: &mut PublicItem) {
    i.answer = AnswerState::Expired { at: T0 };
}
fn hidden(i: &mut PublicItem) {
    i.moderation = Moderation::Hidden;
}
fn deleted(i: &mut PublicItem) {
    i.moderation = Moderation::Deleted;
}
fn removed(i: &mut PublicItem) {
    i.moderation = Moderation::Removed;
}
fn reported(i: &mut PublicItem) {
    i.moderation = Moderation::Reported;
}
fn due_in_a_day(i: &mut PublicItem) {
    i.deadline = Some(T0 + Duration::days(1));
}
fn private_sent(i: &mut PublicItem) {
    i.private_reply_message_id = Some(MessageId::new_v7());
}
fn no_window(i: &mut PublicItem) {
    i.private_reply_until = None;
}

#[test]
fn reply_allowed_matrix() {
    use Channel::TrendyolQuestion as Ty;
    use Channel::{FacebookComment as Fb, HepsiburadaQuestion as Hb, InstagramComment as Ig};
    use PublicRefusal::*;
    use Visibility::{Private, Public};
    let soon = T0 + Duration::hours(1);
    let week = T0 + Duration::days(7);
    #[rustfmt::skip]
    let rows: [Row; 26] = [
        // Allowed cases.
        ("agent answers an owed comment", Ig, same, Public, true, soon, Ok(())),
        ("human answers an owed comment", Fb, same, Public, false, soon, Ok(())),
        ("human replies again on an answered comment", Ig, answered_by_agent, Public, false, soon, Ok(())),
        ("human answers a hidden comment", Ig, hidden, Public, false, soon, Ok(())),
        ("human answers a handled comment", Fb, handled, Public, false, soon, Ok(())),
        ("agent answers a rejected question again", Ty, rejected, Public, true, soon, Ok(())),
        ("an answer at the deadline itself", Ty, due_in_a_day, Public, true, T0 + Duration::days(1), Ok(())),
        ("private reply on the window's last second", Ig, same, Private, true, week, Ok(())),
        ("private reply on an answered comment", Fb, answered_by_agent, Private, true, soon, Ok(())),
        // Removed items.
        ("deleted comment", Ig, deleted, Public, false, soon, Err(ItemRemoved)),
        ("removed comment", Fb, removed, Public, true, soon, Err(ItemRemoved)),
        ("private reply to a removed comment", Ig, removed, Private, false, soon, Err(ItemRemoved)),
        // Public replies.
        ("expired question", Ty, expired, Public, false, soon, Err(DeadlinePassed)),
        ("past the deadline", Ty, due_in_a_day, Public, false, T0 + Duration::days(1) + Duration::seconds(1), Err(DeadlinePassed)),
        ("a Trendyol answer in review", Ty, pending, Public, false, soon, Err(AlreadyAnswered)),
        ("a question answered elsewhere", Ty, answered_elsewhere, Public, true, soon, Err(AlreadyAnswered)),
        ("agent's second reply", Ig, answered_by_agent, Public, true, soon, Err(AgentAlreadyReplied)),
        ("agent on a comment a human answered", Ig, answered_by_human, Public, true, soon, Err(ItemNotOwed)),
        ("agent on a hidden comment", Fb, hidden, Public, true, soon, Err(ItemNotOwed)),
        ("agent on a handled comment", Ig, handled, Public, true, soon, Err(ItemNotOwed)),
        ("agent on a reported question", Ty, reported, Public, true, soon, Err(ItemNotOwed)),
        ("Hepsiburada before H0", Hb, same, Public, false, soon, Err(HepsiburadaUnverified)),
        // Private replies.
        ("private reply on a marketplace", Ty, same, Private, false, soon, Err(PrivateReplyUnsupported)),
        ("private reply a second after the window", Ig, same, Private, true, week + Duration::seconds(1), Err(PrivateWindowClosed)),
        ("private reply without a window", Fb, no_window, Private, false, soon, Err(PrivateWindowClosed)),
        ("second private reply", Ig, private_sent, Private, false, soon, Err(PrivateReplyUsed)),
    ];
    let mut refusals = BTreeSet::new();
    for (name, channel, change, visibility, by_agent, now, expected) in rows {
        let mut i = item(channel);
        change(&mut i);
        let rules_of = rules(channel).unwrap();
        assert_eq!(
            reply_allowed(&i, &rules_of, visibility, by_agent, now),
            expected,
            "{name}"
        );
        if let Err(refusal) = expected {
            refusals.insert(refusal.to_string());
        }
    }
    // Every refusal of spec §3.6 rule 4 is reached, and reads as its stable key.
    assert_eq!(
        refusals,
        BTreeSet::from(
            [
                "item_removed",
                "deadline_passed",
                "already_answered",
                "agent_already_replied",
                "item_not_owed",
                "hepsiburada_unverified",
                "private_reply_unsupported",
                "private_window_closed",
                "private_reply_used",
            ]
            .map(String::from)
        )
    );
}

#[test]
fn refusals_have_stable_keys() {
    use PublicRefusal::*;
    for (refusal, key) in [
        (ItemRequired, "item_required"),
        (ItemNotInConversation, "item_not_in_conversation"),
        (ItemRemoved, "item_removed"),
        (DeadlinePassed, "deadline_passed"),
        (AlreadyAnswered, "already_answered"),
        (AgentAlreadyReplied, "agent_already_replied"),
        (ItemNotOwed, "item_not_owed"),
        (PrivateReplyUnsupported, "private_reply_unsupported"),
        (PrivateWindowClosed, "private_window_closed"),
        (PrivateReplyUsed, "private_reply_used"),
        (TextTooShort, "text_too_short"),
        (TextTooLong, "text_too_long"),
        (ContactDataInPublicReply, "contact_data_in_public_reply"),
        (
            ContactDataInMarketplaceAnswer,
            "contact_data_in_marketplace_answer",
        ),
        (CommercialOnPublicSurface, "commercial_on_public_surface"),
        (CommentsNotEnabled, "comments_not_enabled"),
        (HepsiburadaUnverified, "hepsiburada_unverified"),
    ] {
        assert_eq!(refusal.to_string(), key);
        assert_eq!(serde_json::to_value(refusal).unwrap(), json!(key));
    }
}

#[test]
fn check_text_bounds_and_contact_fences() {
    use PublicRefusal::*;
    use Visibility::{Private, Public};
    let ig = rules(Channel::InstagramComment).unwrap();
    let fb = rules(Channel::FacebookComment).unwrap();
    let ty = rules(Channel::TrendyolQuestion).unwrap();
    let hb = rules(Channel::HepsiburadaQuestion).unwrap();
    let none: &[String] = &[];
    let text = |n: usize| "a".repeat(n);

    // Bounds, in characters.
    assert_eq!(check_text(&ty, Public, &text(9), none), Err(TextTooShort));
    assert_eq!(check_text(&ty, Public, &text(10), none), Ok(()));
    assert_eq!(check_text(&ty, Public, &"ş".repeat(2_000), none), Ok(()));
    assert_eq!(
        check_text(&ty, Public, &text(2_001), none),
        Err(TextTooLong)
    );
    // Padding is not an answer.
    assert_eq!(
        check_text(&ty, Public, &format!("   {}   ", text(9)), none),
        Err(TextTooShort)
    );
    assert_eq!(check_text(&ig, Public, "", none), Err(TextTooShort));
    assert_eq!(check_text(&ig, Public, " \n ", none), Err(TextTooShort));
    assert_eq!(check_text(&ig, Public, "🙏", none), Ok(()));
    assert_eq!(check_text(&ig, Public, &text(2_200), none), Ok(()));
    assert_eq!(
        check_text(&ig, Public, &text(2_201), none),
        Err(TextTooLong)
    );
    assert_eq!(check_text(&fb, Public, &text(8_000), none), Ok(()));
    assert_eq!(
        check_text(&fb, Public, &text(8_001), none),
        Err(TextTooLong)
    );
    assert_eq!(check_text(&ig, Private, &text(1_000), none), Ok(()));
    assert_eq!(
        check_text(&ig, Private, &text(1_001), none),
        Err(TextTooLong)
    );
    assert_eq!(check_text(&fb, Private, &text(2_000), none), Ok(()));
    assert_eq!(
        check_text(&fb, Private, &text(2_001), none),
        Err(TextTooLong)
    );
    assert_eq!(check_text(&ig, Private, "", none), Err(TextTooShort));
    assert_eq!(
        check_text(&ty, Private, &text(20), none),
        Err(PrivateReplyUnsupported)
    );
    assert_eq!(
        check_text(&hb, Public, &text(20), none),
        Err(HepsiburadaUnverified)
    );

    // The person's own contact data is never repeated publicly, however it is written.
    let person = ["+905321234567".to_owned(), "ayse@example.com".to_owned()];
    for written in [
        "Sizi 05321234567 numarasından arayacağız",
        "Sizi 0532 123 45 67 numarasından arayacağız",
        "Sizi +90 (532) 123-45-67 numarasından arayacağız",
        "Sizi 532.123.45.67 numarasından arayacağız",
        "Sizi 90 532 123 4567'den arayacağız",
        "Ayse@Example.COM adresinize yazdık",
    ] {
        assert_eq!(
            check_text(&ig, Public, written, &person),
            Err(ContactDataInPublicReply),
            "{written}"
        );
        assert_eq!(
            check_text(&fb, Public, written, &person),
            Err(ContactDataInPublicReply),
            "{written}"
        );
        // Answering the person privately may name it.
        assert_eq!(
            check_text(&ig, Private, written, &person),
            Ok(()),
            "{written}"
        );
    }
    // Another number, and the business's own address, are fine on a comment.
    for fine in [
        "Mağazamızı 0532 765 43 21 numarasından arayabilirsiniz",
        "Detaylar https://example.com/magaza sayfamızda",
        "Bize destek@example.com adresinden yazın",
        "Siparişiniz 3 gün içinde kargoda",
    ] {
        assert_eq!(check_text(&ig, Public, fine, &person), Ok(()), "{fine}");
    }

    // A marketplace answer carries no link, address or phone number at all.
    for refused in [
        "Detaylar https://example.com sayfamızda",
        "Detaylar http://example.com sayfamızda",
        "Detaylar HTTPS://EXAMPLE.COM sayfamızda",
        "Detaylar www.example.com sayfamızda",
        "Bize destek@example.com adresinden yazın",
        "Bizi 0532 765 43 21 numarasından arayın",
        "Bizi 05327654321 numarasından arayın",
    ] {
        assert_eq!(
            check_text(&ty, Public, refused, none),
            Err(ContactDataInMarketplaceAnswer),
            "{refused}"
        );
    }
    for fine in [
        "Ürün 250 gram paketlerde gelir, 3 adet sipariş verebilirsiniz.",
        "Model numarası 123 456 789, kutuda yazar.",
        "Evet, ürün 2026 yılında üretildi ve garantilidir.",
    ] {
        assert_eq!(check_text(&ty, Public, fine, none), Ok(()), "{fine}");
    }
    // The person's own data is named first.
    assert_eq!(
        check_text(
            &ty,
            Public,
            "Sizi 0532 123 45 67 numarasından arayacağız",
            &person
        ),
        Err(ContactDataInPublicReply)
    );
}

fn at(minutes: i64) -> OffsetDateTime {
    T0 + Duration::minutes(minutes)
}

#[test]
fn transitions() {
    let m = MessageId::new_v7();
    let user = UserId::new_v7();
    let base = item(Channel::TrendyolQuestion);
    let with = |answer: AnswerState, moderation: Moderation| {
        let mut i = base.clone();
        i.answer = answer;
        i.moderation = moderation;
        i
    };
    let awaiting = with(AnswerState::Awaiting, Moderation::Visible);
    let rejected = with(
        AnswerState::Rejected {
            reason: "link".into(),
            at: at(1),
        },
        Moderation::Visible,
    );
    let pending = with(AnswerState::Pending { message_id: m }, Moderation::Visible);
    let answered = with(
        AnswerState::Answered {
            by: AnsweredBy::Us,
            message_id: Some(m),
            at: at(1),
        },
        Moderation::Visible,
    );
    let handled = with(
        AnswerState::Handled {
            by: EventSource::Agent,
            reason: HandledReason::Spam,
            at: at(1),
        },
        Moderation::Visible,
    );
    let expired = with(AnswerState::Expired { at: at(1) }, Moderation::Visible);

    let ok = |from: &PublicItem, event: ItemEvent| {
        let to = apply(from, event.clone(), at(5))
            .unwrap_or_else(|e| panic!("{event:?} from {:?}: {e}", from.answer));
        assert_eq!(to.updated_at, at(5));
        to
    };
    let refused = |from: &PublicItem, event: ItemEvent, expected: (&str, &str)| {
        let e = apply(from, event.clone(), at(5)).unwrap_err();
        assert_eq!((e.from, e.event), expected, "{event:?}");
        assert_eq!(e.to_string(), format!("{} cannot take {}", e.from, e.event));
    };

    // AnswerSent: Awaiting or Rejected → Pending (moderated) or Answered{Us}.
    for from in [&awaiting, &rejected] {
        assert_eq!(
            ok(
                from,
                ItemEvent::AnswerSent {
                    message_id: m,
                    moderated: true
                }
            )
            .answer,
            AnswerState::Pending { message_id: m }
        );
        assert_eq!(
            ok(
                from,
                ItemEvent::AnswerSent {
                    message_id: m,
                    moderated: false
                }
            )
            .answer,
            AnswerState::Answered {
                by: AnsweredBy::Us,
                message_id: Some(m),
                at: at(5)
            }
        );
    }
    for (from, key) in [
        (&pending, "pending"),
        (&answered, "answered"),
        (&handled, "handled"),
        (&expired, "expired"),
    ] {
        refused(
            from,
            ItemEvent::AnswerSent {
                message_id: m,
                moderated: false,
            },
            (key, "answer_sent"),
        );
    }

    // AnswerConfirmed and AnswerRejected: from Pending only.
    assert_eq!(
        ok(&pending, ItemEvent::AnswerConfirmed).answer,
        AnswerState::Answered {
            by: AnsweredBy::Us,
            message_id: Some(m),
            at: at(5)
        }
    );
    assert_eq!(
        ok(
            &pending,
            ItemEvent::AnswerRejected {
                reason: "contains a phone number".into()
            }
        )
        .answer,
        AnswerState::Rejected {
            reason: "contains a phone number".into(),
            at: at(5)
        }
    );
    for (from, key) in [
        (&awaiting, "awaiting"),
        (&rejected, "rejected"),
        (&answered, "answered"),
        (&handled, "handled"),
        (&expired, "expired"),
    ] {
        refused(from, ItemEvent::AnswerConfirmed, (key, "answer_confirmed"));
        refused(
            from,
            ItemEvent::AnswerRejected { reason: "r".into() },
            (key, "answer_rejected"),
        );
    }

    // AnsweredElsewhere: Awaiting, Rejected, Pending → Answered{Elsewhere}.
    for from in [&awaiting, &rejected, &pending] {
        assert_eq!(
            ok(from, ItemEvent::AnsweredElsewhere { message_id: None }).answer,
            AnswerState::Answered {
                by: AnsweredBy::Elsewhere,
                message_id: None,
                at: at(5)
            }
        );
    }
    assert_eq!(
        ok(
            &awaiting,
            ItemEvent::AnsweredElsewhere {
                message_id: Some(m)
            }
        )
        .answer,
        AnswerState::Answered {
            by: AnsweredBy::Elsewhere,
            message_id: Some(m),
            at: at(5)
        }
    );
    for (from, key) in [
        (&answered, "answered"),
        (&handled, "handled"),
        (&expired, "expired"),
    ] {
        refused(
            from,
            ItemEvent::AnsweredElsewhere { message_id: None },
            (key, "answered_elsewhere"),
        );
    }

    // MarkedHandled and Expired: Awaiting, Rejected only.
    let mark = ItemEvent::MarkedHandled {
        by: EventSource::Human(user),
        reason: HandledReason::NoReplyNeeded,
    };
    for from in [&awaiting, &rejected] {
        assert_eq!(
            ok(from, mark.clone()).answer,
            AnswerState::Handled {
                by: EventSource::Human(user),
                reason: HandledReason::NoReplyNeeded,
                at: at(5)
            }
        );
        assert_eq!(
            ok(from, ItemEvent::Expired).answer,
            AnswerState::Expired { at: at(5) }
        );
    }
    for (from, key) in [
        (&pending, "pending"),
        (&answered, "answered"),
        (&handled, "handled"),
        (&expired, "expired"),
    ] {
        refused(from, mark.clone(), (key, "marked_handled"));
        refused(from, ItemEvent::Expired, (key, "expired"));
    }

    // Moderation: its own axis; the answer state is kept.
    let hidden = ok(&answered, ItemEvent::Hidden);
    assert_eq!(hidden.moderation, Moderation::Hidden);
    assert_eq!(
        hidden.answer, answered.answer,
        "hiding keeps the answer state"
    );
    assert_eq!(
        ok(&hidden, ItemEvent::Unhidden).moderation,
        Moderation::Visible
    );
    for from in [&awaiting, &hidden] {
        assert_eq!(ok(from, ItemEvent::Deleted).moderation, Moderation::Deleted);
        assert_eq!(ok(from, ItemEvent::Removed).moderation, Moderation::Removed);
    }
    assert_eq!(
        ok(&awaiting, ItemEvent::Reported).moderation,
        Moderation::Reported
    );
    refused(&hidden, ItemEvent::Hidden, ("hidden", "hidden"));
    refused(&awaiting, ItemEvent::Unhidden, ("visible", "unhidden"));
    refused(&hidden, ItemEvent::Reported, ("hidden", "reported"));
    for (moderation, key) in [
        (Moderation::Deleted, "deleted"),
        (Moderation::Removed, "removed"),
        (Moderation::Reported, "reported"),
    ] {
        let from = with(AnswerState::Awaiting, moderation);
        for (event, event_key) in [
            (ItemEvent::Hidden, "hidden"),
            (ItemEvent::Unhidden, "unhidden"),
            (ItemEvent::Deleted, "deleted"),
            (ItemEvent::Removed, "removed"),
            (ItemEvent::Reported, "reported"),
        ] {
            refused(&from, event, (key, event_key));
        }
    }

    // PrivateReplySent: once, while the window is open, whatever the answer state.
    let comment = item(Channel::InstagramComment);
    let mut answered_comment = comment.clone();
    answered_comment.answer = answered.answer.clone();
    for from in [&comment, &answered_comment] {
        let to = ok(from, ItemEvent::PrivateReplySent { message_id: m });
        assert_eq!(to.private_reply_message_id, Some(m));
        assert_eq!(to.answer, from.answer);
        refused(
            &to,
            ItemEvent::PrivateReplySent { message_id: m },
            ("private_reply_used", "private_reply_sent"),
        );
    }
    let mut closed = comment.clone();
    closed.private_reply_until = Some(at(4));
    refused(
        &closed,
        ItemEvent::PrivateReplySent { message_id: m },
        ("private_window_closed", "private_reply_sent"),
    );
    refused(
        &base,
        ItemEvent::PrivateReplySent { message_id: m },
        ("private_window_closed", "private_reply_sent"),
    );

    // A refused event leaves nothing changed: apply never mutates its input.
    let before = answered.clone();
    let _ = apply(
        &answered,
        ItemEvent::AnswerSent {
            message_id: m,
            moderated: false,
        },
        at(5),
    );
    assert_eq!(answered, before);
}

#[test]
fn derived_state_follows_owed_items() {
    let owed = item(Channel::InstagramComment);
    let mut answered = owed.clone();
    answered.answer = AnswerState::Answered {
        by: AnsweredBy::Us,
        message_id: None,
        at: T0,
    };
    let mut hidden = owed.clone();
    hidden.moderation = Moderation::Hidden;
    let until = T0 + Duration::days(1);
    for current in [ConvState::Open, ConvState::Ours, ConvState::Theirs] {
        assert_eq!(
            derived_state(&[answered.clone(), owed.clone()], &current),
            ConvState::Ours
        );
        assert_eq!(
            derived_state(&[answered.clone(), hidden.clone()], &current),
            ConvState::Theirs
        );
        assert_eq!(derived_state(&[], &current), ConvState::Theirs);
    }
    for kept in [ConvState::Snoozed { until }, ConvState::Closed] {
        assert_eq!(derived_state(std::slice::from_ref(&owed), &kept), kept);
        assert_eq!(derived_state(std::slice::from_ref(&answered), &kept), kept);
    }
}
