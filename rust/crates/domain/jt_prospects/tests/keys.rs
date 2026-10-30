//! Dedupe keys (spec §3.3): normalisation per kind, platform hosts, free mail, the Turkish fold.

mod support;

use jt_prospects::*;
use support::*;

fn keys_of(p: &Prospect) -> Vec<(KeyKind, String)> {
    derive_keys(p)
        .into_iter()
        .map(|k| (k.kind, k.value))
        .collect()
}

fn key(p: &Prospect, kind: KeyKind) -> Vec<String> {
    keys_of(p)
        .into_iter()
        .filter(|(k, _)| *k == kind)
        .map(|(_, v)| v)
        .collect()
}

#[test]
fn phone_keys_use_inbox_normalisation() {
    for raw in [
        "0500 000 00 00",
        "500 000 00 00",
        "+90 500 000 00 00",
        "(0500) 000-0000",
    ] {
        let mut i = input();
        i.phone = Some(field(raw.into()));
        let p = prospect(i);
        assert_eq!(key(&p, KeyKind::Phone), ["+905000000000"], "{raw}");
        assert_eq!(
            p.contact.phone.as_ref().unwrap().value,
            "+905000000000",
            "{raw}"
        );
    }
}

#[test]
fn email_key_lowercases_and_domain_key_skips_free_mail() {
    let mut i = input();
    i.email = Some(field(" Bilgi@Ornek-Kafe.Example.Invalid ".into()));
    let p = prospect(i);
    assert_eq!(
        key(&p, KeyKind::Email),
        ["bilgi@ornek-kafe.example.invalid"]
    );
    assert_eq!(key(&p, KeyKind::Domain), ["ornek-kafe.example.invalid"]);

    for free in ["gmail.com", "hotmail.com", "outlook.com", "yandex.com"] {
        assert!(FREE_MAIL_DOMAINS.contains(&free), "{free}");
        let mut i = input();
        i.email = Some(field(format!("ornekkafe@{free}")));
        let p = prospect(i);
        assert_eq!(key(&p, KeyKind::Email), [format!("ornekkafe@{free}")]);
        assert!(
            key(&p, KeyKind::Domain).is_empty(),
            "{free} is not a domain key"
        );
    }
}

#[test]
fn website_domain_strips_www_and_idna() {
    assert_eq!(
        website_domain("https://www.Örnek.com.tr/x").unwrap(),
        Some("xn--rnek-4qa.com.tr".to_owned())
    );
    assert_eq!(
        website_domain("http://ornek-kafe.example.invalid").unwrap(),
        Some("ornek-kafe.example.invalid".to_owned())
    );
    // One leading www only.
    assert_eq!(
        website_domain("https://www.www.ornek.example.invalid/").unwrap(),
        Some("www.ornek.example.invalid".to_owned())
    );
    assert!(website_domain("ftp://ornek.example.invalid").is_err());
    assert!(website_domain("not a url").is_err());
    let mut i = input();
    i.website = Some(field("https://www.ornek-kafe.example.invalid/menu".into()));
    i.email = Some(field("bilgi@ornek-kafe.example.invalid".into()));
    let p = prospect(i);
    // The website's host and the email's domain are one key.
    assert_eq!(key(&p, KeyKind::Domain), ["ornek-kafe.example.invalid"]);
}

#[test]
fn platform_hosts_are_not_domains() {
    for u in [
        "https://www.instagram.com/ornekkafe",
        "https://m.facebook.com/ornekkafe",
        "https://www.tiktok.com/@ornekkafe",
        "https://linktr.ee/ornekkafe",
        "https://maps.app.goo.gl/0000",
    ] {
        assert_eq!(website_domain(u).unwrap(), None, "{u}");
    }
    assert!(PLATFORM_HOSTS.contains(&"instagram.com"));
}

#[test]
fn instagram_url_becomes_handle_key() {
    assert_eq!(
        normalise_handle(
            KeyKind::Instagram,
            "https://www.instagram.com/Ornek.Kafe/?hl=tr"
        )
        .unwrap(),
        "ornek.kafe"
    );
    assert_eq!(
        normalise_handle(KeyKind::Instagram, "@Ornek_Kafe").unwrap(),
        "ornek_kafe"
    );
    assert!(normalise_handle(KeyKind::Instagram, "ornek kafe").is_err());
    assert!(normalise_handle(KeyKind::Instagram, &"a".repeat(31)).is_err());
    let mut i = input();
    i.instagram = Some(field("instagram.com/Ornek.Kafe".into()));
    let p = prospect(i);
    assert_eq!(key(&p, KeyKind::Instagram), ["ornek.kafe"]);
    assert_eq!(p.contact.instagram.as_ref().unwrap().value, "ornek.kafe");
}

#[test]
fn tiktok_at_handle_is_normalised() {
    assert_eq!(
        normalise_handle(KeyKind::Tiktok, "@Ornek_Kafe").unwrap(),
        "ornek_kafe"
    );
    assert_eq!(
        normalise_handle(
            KeyKind::Tiktok,
            "https://www.tiktok.com/@Ornek.Kafe?lang=tr"
        )
        .unwrap(),
        "ornek.kafe"
    );
    assert!(
        normalise_handle(KeyKind::Tiktok, "a").is_err(),
        "two at least"
    );
    assert!(normalise_handle(KeyKind::Tiktok, &"a".repeat(25)).is_err());
    assert!(
        normalise_handle(KeyKind::Phone, "ornek").is_err(),
        "not a handle kind"
    );
}

#[test]
fn name_city_folds_turkish_and_legal_forms() {
    assert_eq!(
        name_city("ÖRNEK Kafe Ltd. Şti.", "İstanbul").as_deref(),
        Some("ornek kafe|istanbul")
    );
    assert_eq!(
        name_city("Örnek Gıda Sanayi ve Ticaret A.Ş.", "IĞDIR").as_deref(),
        Some("ornek gida sanayi ticaret|igdir"),
        "`ve` and `a.ş` are dropped; I folds to ı and then to i"
    );
    assert_eq!(
        name_city("  Çiçek   Pastanesi  San. Tic.  ", " Muğla ").as_deref(),
        Some("cicek pastanesi|mugla")
    );
    // The same business written two ways is one key.
    assert_eq!(
        name_city("örnek kafe", "istanbul"),
        name_city("ÖRNEK KAFE LTD ŞTİ", "İSTANBUL")
    );
}

#[test]
fn no_name_city_without_city() {
    assert_eq!(name_city("Örnek Kafe", ""), None);
    assert_eq!(
        name_city("Ltd. Şti.", "İstanbul"),
        None,
        "nothing left of the name"
    );
    let mut i = input();
    i.city = None;
    let p = prospect(i);
    assert!(key(&p, KeyKind::NameCity).is_empty());
}

#[test]
fn derive_keys_is_deduplicated_and_stable() {
    let mut i = input();
    i.email = Some(field("bilgi@ornek-kafe.example.invalid".into()));
    i.website = Some(field("https://ornek-kafe.example.invalid".into()));
    i.instagram = Some(field("@ornek.kafe".into()));
    i.tiktok = Some(field("@ornek.kafe".into()));
    let p = prospect(i);
    let keys = keys_of(&p);
    assert_eq!(
        keys,
        vec![
            (KeyKind::Phone, "+905000000000".to_owned()),
            (
                KeyKind::Email,
                "bilgi@ornek-kafe.example.invalid".to_owned()
            ),
            (KeyKind::Instagram, "ornek.kafe".to_owned()),
            (KeyKind::Tiktok, "ornek.kafe".to_owned()),
            (KeyKind::Domain, "ornek-kafe.example.invalid".to_owned()),
            (KeyKind::NameCity, "ornek kafe|istanbul".to_owned()),
        ]
    );
    assert_eq!(keys_of(&p), keys, "the same prospect gives the same keys");
    let hard: Vec<KeyKind> = KeyKind::ALL.iter().copied().filter(|k| k.hard()).collect();
    assert_eq!(
        hard,
        [
            KeyKind::Phone,
            KeyKind::Email,
            KeyKind::Instagram,
            KeyKind::Tiktok
        ]
    );
    let names: Vec<&str> = KeyKind::ALL.iter().map(|k| k.key()).collect();
    assert_eq!(
        names,
        [
            "phone",
            "email",
            "instagram",
            "tiktok",
            "domain",
            "name_city"
        ]
    );
}

#[test]
fn blocklist_material_separates_kinds() {
    assert_eq!(
        blocklist_material(KeyKind::Instagram, "ornek"),
        b"instagram\0ornek".to_vec()
    );
    assert_ne!(
        blocklist_material(KeyKind::Instagram, "ornek"),
        blocklist_material(KeyKind::Tiktok, "ornek")
    );
    // A kind's name and the value cannot run together.
    assert_ne!(
        blocklist_material(KeyKind::Domain, "x"),
        blocklist_material(KeyKind::Email, "x")
    );
}

#[test]
fn normalise_key_accepts_raw_values_of_every_kind() {
    assert_eq!(
        normalise_key(KeyKind::Phone, "0500 000 00 00").unwrap(),
        "+905000000000"
    );
    assert_eq!(
        normalise_key(KeyKind::Email, "Bilgi@Ornek.Example.Invalid").unwrap(),
        "bilgi@ornek.example.invalid"
    );
    assert_eq!(
        normalise_key(KeyKind::Domain, "https://www.ornek.example.invalid/x").unwrap(),
        "ornek.example.invalid"
    );
    assert_eq!(
        normalise_key(KeyKind::Domain, "www.Ornek.Example.Invalid").unwrap(),
        "ornek.example.invalid"
    );
    assert_eq!(
        normalise_key(KeyKind::NameCity, "ÖRNEK Kafe Ltd. Şti.|İstanbul").unwrap(),
        "ornek kafe|istanbul"
    );
    assert!(normalise_key(KeyKind::Phone, "12").is_err());
    assert!(normalise_key(KeyKind::Domain, "https://instagram.com/x").is_err());
    assert!(normalise_key(KeyKind::NameCity, "Örnek Kafe").is_err());
}
