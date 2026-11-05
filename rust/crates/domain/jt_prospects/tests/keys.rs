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
fn turkish_phone_forms_normalise_before_the_inbox_rules() {
    for (raw, normal) in [
        // `00` is the international prefix.
        ("0090 500 000 00 00", "+905000000000"),
        ("0090-500-000-00-00", "+905000000000"),
        // The national `0` written after the country code.
        ("+90 (0) 500 000 00 00", "+905000000000"),
        ("+90(0)500 000 00 00", "+905000000000"),
        ("+90 0500 000 00 00", "+905000000000"),
        // Extensions are not part of the number.
        ("0200 000 00 00 dahili 12", "+902000000000"),
        ("0200 000 00 00 Dahili: 12", "+902000000000"),
        ("0200 000 00 00 DAHİLİ 12", "+902000000000"),
        ("0200 000 00 00 ext. 12", "+902000000000"),
        ("0200 000 00 00 x12", "+902000000000"),
        ("0200 000 00 00 / 12", "+902000000000"),
        // A label before the number is not an extension.
        ("Tel/Fax: 0200 000 00 00 (Fax)", "+902000000000"),
        ("Tel: +90 500 000 00 00", "+905000000000"),
        // The forms the inbox already reads, and its own output.
        ("0500 000 00 00", "+905000000000"),
        ("+905000000000", "+905000000000"),
    ] {
        assert_eq!(normalise_phone(raw).unwrap(), normal, "{raw}");
        assert_eq!(normalise_key(KeyKind::Phone, raw).unwrap(), normal, "{raw}");
        assert!(phone_is_dialable(normal), "{raw}");
    }
    for bad in [
        "00 0500 000 00 00",
        "+0 500 000 00 00",
        "+00500000000",
        "05000000",
        "dahili 12",
        "",
    ] {
        assert_eq!(
            normalise_phone(bad),
            Err(ProspectError::Invalid {
                field: "phone",
                reason: "invalid"
            }),
            "{bad}"
        );
    }
    let mut i = input();
    i.phone = Some(field("0090 500 000 00 00".into()));
    let p = prospect(i);
    assert_eq!(key(&p, KeyKind::Phone), ["+905000000000"]);
    assert!(p.contact.phone.as_ref().unwrap().deliverable);
}

#[test]
fn tr444_numbers_are_a_distinct_key_and_never_dialled() {
    for raw in [
        "444 0 000",
        "4440000",
        "444-0-000",
        "0444 0 000",
        "+90 444 0 000",
        "tr444:4440000",
    ] {
        assert_eq!(normalise_phone(raw).unwrap(), "tr444:4440000", "{raw}");
    }
    assert!(!phone_is_dialable("tr444:4440000"));
    assert!(normalise_phone("tr444:5550000").is_err());
    assert!(normalise_phone("tr444:44400").is_err());
    let mut i = input();
    i.phone = Some(field("444 0 000".into()));
    validate_create(&i, NOW, &agent()).unwrap();
    let p = prospect(i);
    assert_eq!(key(&p, KeyKind::Phone), ["tr444:4440000"]);
    let phone = p.contact.phone.as_ref().unwrap();
    assert_eq!(phone.value, "tr444:4440000");
    assert!(!phone.deliverable, "no identity a promotion would dial");
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
    use PlatformKind::*;
    for (u, kind) in [
        ("https://www.instagram.com/ornekkafe", SocialProfile),
        ("https://m.facebook.com/ornekkafe", SocialProfile),
        ("https://www.tiktok.com/@ornekkafe", SocialProfile),
        ("https://linktr.ee/ornekkafe", LinkInBio),
        ("https://wa.me/905000000000", Messaging),
        ("https://t.me/ornekkafe", Messaging),
        ("https://maps.app.goo.gl/0000", MapListing),
        ("https://g.page/ornekkafe", MapListing),
        ("https://www.google.com/maps/place/Ornek", MapListing),
        ("https://www.google.com.tr/maps/place/Ornek", MapListing),
        ("https://maps.google.com/?cid=0", MapListing),
        ("https://yandex.com.tr/maps/org/ornek/0", MapListing),
        ("https://yandex.ru/maps/-/0", MapListing),
        ("https://www.google.com/search?q=ornek", SharedHost),
        ("https://sites.google.com/view/ornekkafe", SharedHost),
        ("https://goo.gl/0000", ShortLink),
        ("https://bit.ly/0000", ShortLink),
        ("https://www.trendyol.com/magaza/ornek-m-0", Marketplace),
        ("https://www.hepsiburada.com/magaza/ornek", Marketplace),
        ("https://www.n11.com/magaza/ornek", Marketplace),
        ("https://www.ciceksepeti.com/ornek", Marketplace),
        ("https://www.yemeksepeti.com/ornek-kafe", Marketplace),
        ("https://getir.com/yemek/restoran/ornek", Marketplace),
        ("https://www.sahibinden.com/ornek", Marketplace),
        ("https://armut.com/ornek", Marketplace),
    ] {
        assert_eq!(website_domain(u).unwrap(), None, "{u}");
        assert_eq!(
            classify_website(u).unwrap(),
            WebsiteHost::Platform(kind),
            "{u}"
        );
    }
    assert!(PLATFORM_HOSTS.iter().any(|(h, _)| *h == "instagram.com"));
    // A business's own site whose name merely contains a platform's is its own.
    for own in [
        "https://googleornek.example.invalid",
        "https://ornek-trendyol.example.invalid",
        "https://instagram.community.example.invalid",
    ] {
        assert!(website_domain(own).unwrap().is_some(), "{own}");
    }
}

#[test]
fn ip_and_overlong_hosts_are_no_domains() {
    assert_eq!(
        classify_website("http://192.0.2.1/menu").unwrap(),
        WebsiteHost::IpAddress
    );
    assert_eq!(
        classify_website("http://[2001:db8::1]/").unwrap(),
        WebsiteHost::IpAddress
    );
    let long = format!("https://{}.example.invalid/", "a".repeat(250));
    assert_eq!(
        classify_website(&long),
        Err(ProspectError::Invalid {
            field: "website",
            reason: "host_too_long"
        })
    );
    assert!(normalise_key(KeyKind::Domain, &long).is_err());
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
fn instagram_post_reel_and_story_urls_are_no_handle() {
    for url in [
        "https://www.instagram.com/p/C0000000000/",
        "https://instagram.com/reel/C0000000000",
        "https://www.instagram.com/reels/C0000000000/",
        "https://www.instagram.com/stories/ornek.kafe/0000000000",
        "https://www.instagram.com/explore/tags/kafe/",
        "https://www.instagram.com/tv/C0000000000",
        "https://www.instagram.com/accounts/login/",
        "instagram.com/p/C0000000000",
        "https://www.instagram.com/",
        "https://ornek.example.invalid/ornek.kafe",
    ] {
        assert_eq!(
            normalise_handle(KeyKind::Instagram, url),
            Err(ProspectError::Invalid {
                field: "instagram",
                reason: "not_a_profile_url"
            }),
            "{url}"
        );
    }
    // A profile URL on the platform's own subdomains is its handle.
    for url in [
        "https://m.instagram.com/ornek.kafe/",
        "http://instagram.com/ornek.kafe/tagged",
        "www.instagram.com/ornek.kafe",
    ] {
        assert_eq!(
            normalise_handle(KeyKind::Instagram, url).unwrap(),
            "ornek.kafe",
            "{url}"
        );
    }
}

#[test]
fn bare_handles_keep_www_and_m() {
    assert_eq!(
        normalise_handle(KeyKind::Instagram, "m.kafe").unwrap(),
        "m.kafe"
    );
    assert_eq!(
        normalise_handle(KeyKind::Instagram, "www.kafe").unwrap(),
        "www.kafe"
    );
    assert_eq!(
        normalise_handle(KeyKind::Tiktok, "@www.kafe").unwrap(),
        "www.kafe"
    );
    // A host that only starts like the platform's is no profile URL.
    assert!(normalise_handle(KeyKind::Instagram, "instagram.community/kafe").is_err());
}

#[test]
fn tiktok_profile_urls_need_the_at() {
    for url in [
        "https://www.tiktok.com/ornek.kafe",
        "https://www.tiktok.com/t/ZS0000000/",
        "https://www.tiktok.com/video/0000000000",
        "https://www.tiktok.com/tag/kafe",
        "https://www.tiktok.com/music/ornek-0000",
        "https://www.tiktok.com/discover/kafe",
        "https://vm.tiktok.com/ZM0000000/",
    ] {
        assert!(normalise_handle(KeyKind::Tiktok, url).is_err(), "{url}");
    }
    assert_eq!(
        normalise_handle(
            KeyKind::Tiktok,
            "https://m.tiktok.com/@ornek.kafe/video/0000000000"
        )
        .unwrap(),
        "ornek.kafe"
    );
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
    // The circumflex of older spellings folds too.
    assert_eq!(
        name_city("Kâr Hâlî Kûtu", "Âşağı").as_deref(),
        Some("kar hali kutu|asagi")
    );
    assert_eq!(
        name_city("KÂR HÂLÎ KÛTU", "aşağı"),
        name_city("Kar Hali Kutu", "Asagi")
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
