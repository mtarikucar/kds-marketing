//! Public items (spec 2026-10-30-inbox-comments-marketplace-design.md §3): the two public
//! channels and their namespaces, the rules per surface, the reply fence, the text checks and the
//! item lifecycle. Phone numbers, addresses and handles here are made up.

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

/// The two public channels, their capability kind and their identity namespace (spec §3.1).
const PUBLIC: [(Channel, &str, IdentityChannel, &str); 2] = [
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
];

/// A surface whose items take one answer, which the platform reviews before it shows, and that
/// has no private reply, hiding or deleting. No channel has these rules today; the fence and
/// the lifecycle hold them all the same.
const REVIEWED: PublicRules = PublicRules {
    public: TextBounds {
        min: 10,
        max: 2_000,
    },
    private: None,
    one_answer: true,
    moderated: true,
    hide: false,
    delete: false,
};

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
    assert_eq!(channels.len(), 9);
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
        assert_eq!(scope_opaque("page-1", "17"), "page-1:17");
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
    ];
    let value = "account-1:17";
    let hashes: BTreeSet<String> = every.iter().map(|c| identity_hash(*c, value)).collect();
    assert_eq!(hashes.len(), every.len(), "one hash per namespace");
    for (namespace, name) in [
        (IdentityChannel::InstagramCommenter, "instagram_commenter"),
        (IdentityChannel::FacebookCommenter, "facebook_commenter"),
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
    assert_eq!(PRIVATE_REPLY_WINDOW, Duration::days(7));
    assert_eq!(MAX_AGENT_ANSWERS, 2);
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
                public: TextBounds { min: 1, max: 2_200 },
                private: seven_days(1_000),
                one_answer: false,
                moderated: false,
                hide: true,
                delete: true,
            },
        ),
        (
            Channel::FacebookComment,
            PublicRules {
                public: TextBounds { min: 1, max: 8_000 },
                private: seven_days(2_000),
                one_answer: false,
                moderated: false,
                hide: true,
                delete: true,
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
                message_id: Some(message_id),
                at: T0,
            },
            json!({"state": "rejected", "reason": "contains a link",
                   "message_id": message_id, "at": at}),
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
    // An answered or rejected state written without its message reads as none.
    assert_eq!(
        serde_json::from_value::<AnswerState>(json!({"state": "answered", "by": "us", "at": at}))
            .unwrap(),
        AnswerState::Answered {
            by: AnsweredBy::Us,
            message_id: None,
            at: T0
        }
    );
    assert_eq!(
        serde_json::from_value::<AnswerState>(
            json!({"state": "rejected", "reason": "r", "at": at})
        )
        .unwrap(),
        AnswerState::Rejected {
            reason: "r".into(),
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
    ] {
        assert_eq!(moderation.key(), key);
        assert_eq!(Moderation::from_key(key), Some(moderation));
        assert_eq!(serde_json::to_value(moderation).unwrap(), json!(key));
    }
    assert_eq!(Moderation::from_key("Visible"), None);
    assert_eq!(Moderation::default(), Moderation::Visible);
    // The values 0043's kind checks accept: a comment, on a post.
    assert_eq!(
        serde_json::to_value(PublicKind::Comment).unwrap(),
        json!("comment")
    );
    assert_eq!(
        serde_json::to_value(SubjectKind::Post).unwrap(),
        json!("post")
    );
    for gone in ["question", "product"] {
        assert!(serde_json::from_value::<PublicKind>(json!(gone)).is_err());
        assert!(serde_json::from_value::<SubjectKind>(json!(gone)).is_err());
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
    item_under(&rules(channel).expect("a public channel"))
}

/// A new, owed item of a surface whose rules are `rules_of`, written at [`T0`].
fn item_under(rules_of: &PublicRules) -> PublicItem {
    PublicItem {
        id: PublicItemId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        capability_id: CapabilityId::new_v7(),
        conversation_id: ConversationId::new_v7(),
        message_id: MessageId::new_v7(),
        subject_id: None,
        kind: PublicKind::Comment,
        external_id: "17890".into(),
        parent_external_id: None,
        root_external_id: "17890".into(),
        created_at: T0,
        taken_at: None,
        deadline: None,
        private_reply_until: private_reply_until(rules_of, T0, false),
        live: false,
        answer: AnswerState::Awaiting,
        moderation: Moderation::Visible,
        private_reply_message_id: None,
        agent_answers: 0,
        checked_at: None,
        updated_at: T0,
    }
}

#[test]
fn items_and_subjects_read_tolerantly_and_round_trip() {
    let mut full = item(Channel::InstagramComment);
    full.live = true;
    full.agent_answers = 1;
    let encoded = serde_json::to_value(&full).unwrap();
    assert_eq!(
        serde_json::from_value::<PublicItem>(encoded.clone()).unwrap(),
        full
    );
    assert!(full.agent_replied());
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
    assert_eq!(read.agent_answers, 0);
    assert!(!read.agent_replied());
    assert!(!read.live);
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
        "capability_id": encoded["capability_id"], "kind": "post", "external_id": "B-1"
    }))
    .unwrap();
    assert_eq!(bare.title, "");
    assert_eq!(bare.facts, json!({}));
    assert_eq!(MAX_SUBJECT_TITLE_CHARS, 280);
    assert_eq!(MAX_EXTERNAL_ID_CHARS, 512);
}

#[test]
fn awaiting_means_owed_and_visible() {
    let states = [
        (AnswerState::Awaiting, true),
        (
            AnswerState::Rejected {
                reason: "r".into(),
                message_id: None,
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

#[test]
fn private_reply_until_follows_the_surface_and_the_live() {
    let ig = rules(Channel::InstagramComment).unwrap();
    let fb = rules(Channel::FacebookComment).unwrap();
    let reviewed = REVIEWED;
    assert_eq!(
        private_reply_until(&ig, T0, false),
        Some(T0 + Duration::days(7))
    );
    assert_eq!(
        private_reply_until(&fb, T0, false),
        Some(T0 + Duration::days(7))
    );
    // A live comment is answered privately only during the live.
    assert_eq!(
        private_reply_until(&ig, T0, true),
        Some(T0 + LIVE_PRIVATE_REPLY_WINDOW)
    );
    assert!(LIVE_PRIVATE_REPLY_WINDOW < PRIVATE_REPLY_WINDOW);
    // A surface without a private reply has no window.
    assert_eq!(private_reply_until(&reviewed, T0, false), None);
    assert_eq!(private_reply_until(&reviewed, T0, true), None);
}

/// One row of the reply fence's matrix: what it shows, the surface, how the owed item differs,
/// the reply's visibility, whether the agent replies, when, and the answer.
type Row = (
    &'static str,
    PublicRules,
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
    i.agent_answers = 1;
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
/// A human's answer the platform refused.
fn rejected(i: &mut PublicItem) {
    i.answer = AnswerState::Rejected {
        reason: "link".into(),
        message_id: Some(MessageId::new_v7()),
        at: T0,
    };
}
/// The agent's answer, sent and then refused by the platform's review.
fn agent_answer_rejected(i: &mut PublicItem) {
    rejected(i);
    i.agent_answers = 1;
}
/// The agent's second answer refused too.
fn agent_answers_rejected_twice(i: &mut PublicItem) {
    rejected(i);
    i.agent_answers = MAX_AGENT_ANSWERS;
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
fn due_in_a_day(i: &mut PublicItem) {
    i.deadline = Some(T0 + Duration::days(1));
}
fn private_sent(i: &mut PublicItem) {
    i.private_reply_message_id = Some(MessageId::new_v7());
}
fn no_window(i: &mut PublicItem) {
    i.private_reply_until = None;
}
/// A comment on a live video, its private-reply window the live's.
fn live(i: &mut PublicItem) {
    i.live = true;
    i.private_reply_until = Some(T0 + LIVE_PRIVATE_REPLY_WINDOW);
}

#[test]
fn reply_allowed_matrix() {
    use PublicRefusal::*;
    use Visibility::{Private, Public};
    let ig = rules(Channel::InstagramComment).unwrap();
    let fb = rules(Channel::FacebookComment).unwrap();
    // One answer, reviewed: see [`REVIEWED`].
    let rv = REVIEWED;
    let soon = T0 + Duration::hours(1);
    let week = T0 + Duration::days(7);
    let after_live = T0 + LIVE_PRIVATE_REPLY_WINDOW + Duration::seconds(1);
    #[rustfmt::skip]
    let rows: [Row; 30] = [
        // Allowed cases.
        ("agent answers an owed comment", ig, same, Public, true, soon, Ok(())),
        ("human answers an owed comment", fb, same, Public, false, soon, Ok(())),
        ("human replies again on an answered comment", ig, answered_by_agent, Public, false, soon, Ok(())),
        ("human answers a hidden comment", ig, hidden, Public, false, soon, Ok(())),
        ("human answers a handled comment", fb, handled, Public, false, soon, Ok(())),
        ("agent answers an item a human's rejected answer left owed", rv, rejected, Public, true, soon, Ok(())),
        ("agent answers again after its answer was rejected", rv, agent_answer_rejected, Public, true, soon, Ok(())),
        ("human answers after the agent's two rejected answers", rv, agent_answers_rejected_twice, Public, false, soon, Ok(())),
        ("an answer at the deadline itself", ig, due_in_a_day, Public, true, T0 + Duration::days(1), Ok(())),
        ("private reply on the window's last second", ig, same, Private, true, week, Ok(())),
        ("private reply on an answered comment", fb, answered_by_agent, Private, true, soon, Ok(())),
        ("private reply to a live comment during the live", ig, live, Private, true, soon, Ok(())),
        // Removed items.
        ("deleted comment", ig, deleted, Public, false, soon, Err(ItemRemoved)),
        ("removed comment", fb, removed, Public, true, soon, Err(ItemRemoved)),
        ("private reply to a removed comment", ig, removed, Private, false, soon, Err(ItemRemoved)),
        // Public replies.
        ("public reply to a live comment, by a human", ig, live, Public, false, soon, Err(LiveCommentPublicReply)),
        ("public reply to a live comment, by the agent", ig, live, Public, true, soon, Err(LiveCommentPublicReply)),
        ("expired item", rv, expired, Public, false, soon, Err(DeadlinePassed)),
        ("past the deadline", fb, due_in_a_day, Public, false, T0 + Duration::days(1) + Duration::seconds(1), Err(DeadlinePassed)),
        ("an answer in review on a one-answer surface", rv, pending, Public, false, soon, Err(AlreadyAnswered)),
        ("a one-answer item answered elsewhere", rv, answered_elsewhere, Public, true, soon, Err(AlreadyAnswered)),
        ("agent's second reply", ig, answered_by_agent, Public, true, soon, Err(AgentAlreadyReplied)),
        ("agent's third answer after two rejections", rv, agent_answers_rejected_twice, Public, true, soon, Err(AgentAlreadyReplied)),
        ("agent on a comment a human answered", ig, answered_by_human, Public, true, soon, Err(ItemNotOwed)),
        ("agent on a hidden comment", fb, hidden, Public, true, soon, Err(ItemNotOwed)),
        ("agent on a handled comment", ig, handled, Public, true, soon, Err(ItemNotOwed)),
        // Private replies.
        ("private reply on a surface without one", rv, same, Private, false, soon, Err(PrivateReplyUnsupported)),
        ("private reply a second after the window", ig, same, Private, true, week + Duration::seconds(1), Err(PrivateWindowClosed)),
        ("private reply to a live comment after the live", ig, live, Private, false, after_live, Err(PrivateWindowClosed)),
        ("private reply without a window", fb, no_window, Private, false, soon, Err(PrivateWindowClosed)),
    ];
    let mut refusals = BTreeSet::new();
    for (name, rules_of, change, visibility, by_agent, now, expected) in rows {
        let mut i = item_under(&rules_of);
        change(&mut i);
        assert_eq!(
            reply_allowed(&i, &rules_of, visibility, by_agent, now),
            expected,
            "{name}"
        );
        if let Err(refusal) = expected {
            refusals.insert(refusal.to_string());
        }
    }
    let mut used = item(Channel::InstagramComment);
    private_sent(&mut used);
    assert_eq!(
        reply_allowed(&used, &ig, Private, false, soon),
        Err(PrivateReplyUsed)
    );
    refusals.insert(PrivateReplyUsed.to_string());
    // Every refusal of spec §3.6 rule 4 is reached, and reads as its stable key.
    assert_eq!(
        refusals,
        BTreeSet::from(
            [
                "item_removed",
                "live_comment_public_reply",
                "deadline_passed",
                "already_answered",
                "agent_already_replied",
                "item_not_owed",
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
        (LiveCommentPublicReply, "live_comment_public_reply"),
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
        (CommercialOnPublicSurface, "commercial_on_public_surface"),
        (CommentsNotEnabled, "comments_not_enabled"),
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
    // A surface with a minimum above one character and no private reply: see [`REVIEWED`].
    let rv = REVIEWED;
    let none: &[String] = &[];
    let text = |n: usize| "a".repeat(n);

    // Bounds, in characters.
    assert_eq!(check_text(&rv, Public, &text(9), none), Err(TextTooShort));
    assert_eq!(check_text(&rv, Public, &text(10), none), Ok(()));
    assert_eq!(check_text(&rv, Public, &"ş".repeat(2_000), none), Ok(()));
    assert_eq!(
        check_text(&rv, Public, &text(2_001), none),
        Err(TextTooLong)
    );
    // Padding is not an answer.
    assert_eq!(
        check_text(&rv, Public, &format!("   {}   ", text(9)), none),
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
        check_text(&rv, Private, &text(20), none),
        Err(PrivateReplyUnsupported)
    );

    // The person's own contact data is never repeated publicly, however it is written.
    let person = ["+905321234567".to_owned(), "ayse@example.com".to_owned()];
    for written in [
        "Sizi 05321234567 numarasından arayacağız",
        "Sizi 0532 123 45 67 numarasından arayacağız",
        "Sizi +90 (532) 123-45-67 numarasından arayacağız",
        "Sizi 532.123.45.67 numarasından arayacağız",
        "Sizi 90 532 123 4567'den arayacağız",
        "Sizi 0532–123–45–67 numarasından arayacağız",
        "Sizi 0532\u{a0}123\u{a0}45\u{a0}67 numarasından arayacağız",
        "Sizi 0532/123/45/67 numarasından arayacağız",
        "Sizi sıfır beş üç iki bir iki üç dört beş altı yedi numarasından arayacağız",
        "Sizi SIFIR BEŞ ÜÇ İKİ BİR İKİ ÜÇ DÖRT BEŞ ALTI YEDİ numarasından arayacağız",
        "We will call zero five three two one two three four five six seven",
        "Sizi 0️⃣5️⃣3️⃣2️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣ numarasından arayacağız",
        "Ayse@Example.COM adresinize yazdık",
        "ayse at example dot com adresinize yazdık",
        "ayse(at)example(dot)com adresinize yazdık",
        "ayse [at] example [nokta] com adresinize yazdık",
        "ayse @ example . com adresinize yazdık",
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
        "Bize @magazamiz hesabından ulaşın",
    ] {
        assert_eq!(check_text(&ig, Public, fine, &person), Ok(()), "{fine}");
    }
}

fn at(minutes: i64) -> OffsetDateTime {
    T0 + Duration::minutes(minutes)
}

#[test]
fn transitions() {
    let m = MessageId::new_v7();
    let user = UserId::new_v7();
    let base = item_under(&REVIEWED);
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
            message_id: Some(m),
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

    // AnswerSent is a receipt, a fact: taken from any state. An owed, settled or expired item
    // becomes pending (moderated surface) or answered by us; an answered one stays answered.
    let m2 = MessageId::new_v7();
    let sent = |moderated| ItemEvent::AnswerSent {
        message_id: m2,
        moderated,
    };
    for from in [&awaiting, &rejected, &handled, &expired, &pending] {
        assert_eq!(
            ok(from, sent(true)).answer,
            AnswerState::Pending { message_id: m2 },
            "{:?}",
            from.answer
        );
        assert_eq!(
            ok(from, sent(false)).answer,
            AnswerState::Answered {
                by: AnsweredBy::Us,
                message_id: Some(m2),
                at: at(5)
            },
            "{:?}",
            from.answer
        );
    }
    for moderated in [true, false] {
        assert_eq!(ok(&answered, sent(moderated)).answer, answered.answer);
    }

    // AnswerConfirmed and AnswerRejected: from Pending only; a rejection keeps the answer's
    // message.
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
            message_id: Some(m),
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
    refused(&hidden, ItemEvent::Hidden, ("hidden", "hidden"));
    refused(&awaiting, ItemEvent::Unhidden, ("visible", "unhidden"));
    for (moderation, key) in [
        (Moderation::Deleted, "deleted"),
        (Moderation::Removed, "removed"),
    ] {
        let from = with(AnswerState::Awaiting, moderation);
        for (event, event_key) in [
            (ItemEvent::Hidden, "hidden"),
            (ItemEvent::Unhidden, "unhidden"),
            (ItemEvent::Deleted, "deleted"),
            (ItemEvent::Removed, "removed"),
        ] {
            refused(&from, event, (key, event_key));
        }
        // A receipt still applies to a removed item: the platform accepted the send.
        assert!(apply(&from, sent(false), at(5)).is_ok());
    }

    // PrivateReplySent is a receipt too: recorded whatever the state and the window; a second
    // receipt keeps the first private reply.
    let comment = item(Channel::InstagramComment);
    let mut answered_comment = comment.clone();
    answered_comment.answer = answered.answer.clone();
    let mut closed = comment.clone();
    closed.private_reply_until = Some(at(4));
    for from in [&comment, &answered_comment, &closed, &base] {
        let to = ok(from, ItemEvent::PrivateReplySent { message_id: m });
        assert_eq!(to.private_reply_message_id, Some(m));
        assert_eq!(to.answer, from.answer);
        let again = ok(&to, ItemEvent::PrivateReplySent { message_id: m2 });
        assert_eq!(again.private_reply_message_id, Some(m));
    }

    // A refused event leaves nothing changed: apply never mutates its input.
    let before = answered.clone();
    let _ = apply(&answered, ItemEvent::AnswerConfirmed, at(5));
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
