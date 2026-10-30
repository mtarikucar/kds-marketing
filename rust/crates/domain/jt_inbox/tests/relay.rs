//! The Amazon.com.tr buyer-message relay (spec 2026-10-30-inbox-comments-marketplace-design.md
//! §8.4): recognised from the sender's address alone, with its order id, cleaned display name and
//! reply fence. Addresses are made up.

use jt_inbox::relay::*;
use serde_json::json;
use time::Duration;

#[test]
fn amazon_relay_domain_only() {
    assert_eq!(AMAZON_TR_RELAY_DOMAIN, "marketplace.amazon.com.tr");
    for relay in [
        "x@marketplace.amazon.com.tr",
        "0a1b2c3d4e5f@marketplace.amazon.com.tr",
    ] {
        assert_eq!(marketplace_relay(relay), Some(Relay::AmazonTr), "{relay}");
    }
    for other in [
        "x@amazon.com.tr",
        "x@marketplace.amazon.com.tr.evil.example",
        "x@evil-marketplace.amazon.com.tr",
        "x@sub.marketplace.amazon.com.tr",
        "x@marketplace.amazon.com",
        "marketplace.amazon.com.tr",
        "@marketplace.amazon.com.tr",
        "x@y@marketplace.amazon.com.tr",
        "",
    ] {
        assert_eq!(marketplace_relay(other), None, "{other:?}");
    }
    assert_eq!(
        serde_json::to_value(Relay::AmazonTr).unwrap(),
        json!("amazon_tr")
    );
    assert_eq!(RELAY_DEADLINE, Duration::hours(24));
}

#[test]
fn order_id_from_subject_and_body() {
    assert_eq!(
        amazon_order_id("Sipariş 405-1234567-7654321 hakkında soru").as_deref(),
        Some("405-1234567-7654321")
    );
    assert_eq!(
        amazon_order_id("Merhaba,\n(Sipariş No: 171-0000001-0000002)\nKargo nerede?").as_deref(),
        Some("171-0000001-0000002")
    );
    // The first of several.
    assert_eq!(
        amazon_order_id("405-1234567-7654321 ve 406-7654321-1234567").as_deref(),
        Some("405-1234567-7654321")
    );
    for none in [
        "Kargo nerede?",
        "",
        "1405-1234567-7654321",
        "405-1234567-76543210",
        "405-123456-7654321",
        "405 1234567 7654321",
        "40a-1234567-7654321",
    ] {
        assert_eq!(amazon_order_id(none), None, "{none:?}");
    }
    // Further along, after a near miss.
    assert_eq!(
        amazon_order_id("1405-1234567-7654321 değil, 405-1234567-7654321").as_deref(),
        Some("405-1234567-7654321")
    );
}

#[test]
fn display_name_drops_the_suffix() {
    for (raw, name) in [
        ("Ayşe - Amazon Marketplace", "Ayşe"),
        ("  Ayşe Y. - Amazon Marketplace  ", "Ayşe Y."),
        ("Ayşe", "Ayşe"),
        (" - Amazon Marketplace", ""),
        ("Amazon Marketplace", "Amazon Marketplace"),
        (
            "Ayşe - Amazon Marketplace - Amazon Marketplace",
            "Ayşe - Amazon Marketplace",
        ),
    ] {
        assert_eq!(relay_display_name(raw), name, "{raw:?}");
    }
}

#[test]
fn relay_reply_refuses_commercial_and_links() {
    assert_eq!(relay_reply_allowed("Kargonuz yarın yolda.", false), Ok(()));
    assert_eq!(
        relay_reply_allowed("Kargonuz yarın yolda.", true),
        Err(RelayRefusal::CommercialOnRelay)
    );
    for link in [
        "Takip: https://example.com/kargo",
        "Takip: http://example.com/kargo",
        "Takip: www.example.com",
        "Bize destek@example.com adresinden yazın",
    ] {
        assert_eq!(
            relay_reply_allowed(link, false),
            Err(RelayRefusal::LinkInRelayReply),
            "{link}"
        );
        // Commercial intent is named first.
        assert_eq!(
            relay_reply_allowed(link, true),
            Err(RelayRefusal::CommercialOnRelay)
        );
    }
    for (refusal, key) in [
        (RelayRefusal::CommercialOnRelay, "commercial_on_relay"),
        (RelayRefusal::LinkInRelayReply, "link_in_relay_reply"),
    ] {
        assert_eq!(refusal.to_string(), key);
        assert_eq!(serde_json::to_value(refusal).unwrap(), json!(key));
    }
}
