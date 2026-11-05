//! The outreach policy's defaults (spec §6.1, D15, D17, D19): the business-recipient basis is off
//! and can only count with the counsel's confirmation, on email only.

mod support;

use jt_inbox::Channel;
use jt_outreach::*;
use jt_tenancy::UserId;
use serde_json::json;
use support::*;
use uuid::Uuid;

fn ack(counsel_confirmed: bool) -> LegalAck {
    LegalAck {
        counsel_confirmed,
        note: "Avukat görüşü alındı".into(),
        by: UserId(Uuid::from_u128(7)),
        at: NOW,
    }
}

#[test]
fn b2b_basis_is_off_by_default() {
    let p = OutreachPolicy::default();
    assert!(p.b2b_basis.is_empty());
    assert!(p.b2b_channels().is_empty());
    assert!(p.legal_ack.is_none());
    assert!(
        !p.requires_approval,
        "owner rule 3: approval off by default"
    );
    assert!(p.require_iys_lookup);
    assert!(!p.click_tracking_default);
    assert_eq!(p.warmup, WarmupPolicy::default());
    assert_eq!(p.frequency, Frequency::default());
    assert!(!p.sender_identity_complete());
    let read: OutreachPolicy = serde_json::from_value(json!({})).unwrap();
    assert_eq!(read, p, "an empty stored object reads as the defaults");
    let read: OutreachPolicy =
        serde_json::from_value(json!({"warmup": {"start": 5}, "requires_approval": true})).unwrap();
    assert_eq!(read.warmup.start, 5);
    assert_eq!(read.warmup.max, WarmupPolicy::default().max);
    assert!(read.requires_approval);
    assert!(read.b2b_channels().is_empty());
}

#[test]
fn b2b_channels_need_the_counsel_confirmation_and_are_email_only() {
    let mut p = OutreachPolicy {
        b2b_basis: vec![Channel::Sms, Channel::Email, Channel::WhatsApp],
        ..OutreachPolicy::default()
    };
    assert!(p.b2b_channels().is_empty(), "no acknowledgement recorded");
    p.legal_ack = Some(ack(false));
    assert!(p.b2b_channels().is_empty(), "the counsel did not confirm");
    p.legal_ack = Some(ack(true));
    assert_eq!(p.b2b_channels(), vec![Channel::Email]);
    assert_eq!(B2B_BASIS_CHANNELS, &[Channel::Email]);
    p.b2b_basis = vec![Channel::Sms];
    assert!(p.b2b_channels().is_empty());
}

#[test]
fn sender_identity_needs_company_address_and_a_privacy_link() {
    let complete = OutreachPolicy {
        sender_company: "Örnek Yazılım A.Ş.".into(),
        sender_address: "Örnek Mah. Deneme Sok. 1, İstanbul".into(),
        privacy_notice_url: "https://ornek-yazilim.example.invalid/kvkk".into(),
        ..OutreachPolicy::default()
    };
    assert!(complete.sender_identity_complete());
    let cases: [fn(&mut OutreachPolicy); 5] = [
        |p| p.sender_company = " ".into(),
        |p| p.sender_address = String::new(),
        |p| p.privacy_notice_url = String::new(),
        |p| p.privacy_notice_url = "ornek-yazilim.example.invalid/kvkk".into(),
        |p| p.privacy_notice_url = "javascript:alert(1)".into(),
    ];
    for change in cases {
        let mut p = complete.clone();
        change(&mut p);
        assert!(!p.sender_identity_complete(), "{p:?}");
    }
}
