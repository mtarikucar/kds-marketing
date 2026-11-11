//! Module requirement expressions (spec 2026-11-10-module-capability-gating-design.md).
use jt_capability::{KINDS, KindGroup, Requirement, StoredStatus, missing_requirements};

#[test]
fn kind_and_group_keys_share_one_namespace_without_collisions() {
    for group in KindGroup::all() {
        assert!(
            KINDS.iter().all(|k| k.key != group.key()),
            "{}",
            group.key()
        );
    }
}

#[test]
fn a_line_gates_only_when_every_alternative_is_a_known_key() {
    assert!(Requirement::parse("messaging").is_some());
    assert_eq!(
        Requirement::parse(" mailbox | sms_line|whatsapp_cloud ")
            .unwrap()
            .text(),
        "mailbox|sms_line|whatsapp_cloud"
    );
    for note in [
        "Telefon erişimi",
        "",
        "mailbox|",
        "mailbox|mailbox",
        "mailbox|nope",
    ] {
        assert!(Requirement::parse(note).is_none(), "{note:?} is a note");
    }
}

#[test]
fn only_connected_capabilities_satisfy_a_requirement() {
    let messaging = Requirement::parse("messaging").unwrap();
    assert!(messaging.is_met([("mailbox", StoredStatus::Verified)]));
    assert!(messaging.is_met([("whatsapp_cloud", StoredStatus::Unreachable)]));
    assert!(!messaging.is_met([("mailbox", StoredStatus::Declared)]));
    assert!(!messaging.is_met([("mailbox", StoredStatus::Retired)]));
    assert!(!messaging.is_met([("instagram", StoredStatus::Verified)]));
    let sending = Requirement::parse("mailbox|sms_line|whatsapp_cloud").unwrap();
    assert!(!sending.is_met([("instagram_dm", StoredStatus::Verified)]));
    assert!(sending.is_met([("sms_line", StoredStatus::Verified)]));
}

#[test]
fn missing_lists_unmet_gating_lines_and_ignores_notes() {
    let caps = [("instagram", StoredStatus::Verified)];
    assert_eq!(
        missing_requirements(["social_account", "messaging", "Bir not"], &caps),
        vec!["messaging".to_owned()]
    );
    assert!(missing_requirements(["Bir not"], &[]).is_empty());
}
