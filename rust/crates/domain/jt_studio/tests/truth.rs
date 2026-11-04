//! The caption truth check (spec 2026-11-03 §7): what a caption claims (a date, a place, an event,
//! a client) against the structured olay data of its subject and its materials.
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{UserId, WorkspaceId};
use std::collections::BTreeSet;
use time::Date;
use time::macros::{date, datetime};
use uuid::Uuid;

fn ws() -> WorkspaceId {
    WorkspaceId(Uuid::from_u128(1))
}
fn owner() -> UserId {
    UserId(Uuid::from_u128(2))
}
fn mark() -> Option<HumanMark> {
    Some(HumanMark {
        by: owner(),
        at: datetime!(2025-01-01 0:00 UTC),
    })
}

fn olay(n: u128, title: &str, place: Option<&str>, starts: Date, ends: Date) -> Olay {
    Olay {
        id: OlayId(Uuid::from_u128(100 + n)),
        workspace_id: ws(),
        kind: OlayKind::Workshop,
        title: title.into(),
        starts_on: starts,
        ends_on: ends,
        place: place.map(Into::into),
        client: None,
        notes: String::new(),
        occasion: None,
        status: OlayStatus::Confirmed,
        confirmed: mark(),
        revision: 1,
        created_at: datetime!(2025-01-01 0:00 UTC),
    }
}

fn workshop(n: u128, title: &str, place: &str, day: Date) -> Olay {
    olay(n, title, Some(place), day, day)
}

fn yilbasi(n: u128, starts: Date, ends: Date) -> Olay {
    Olay {
        kind: OlayKind::Season,
        occasion: Some("yilbasi".into()),
        ..olay(n, "Yılbaşı koleksiyonu", None, starts, ends)
    }
}

fn material(n: u128, o: &Olay, permission: SharePermission) -> Material {
    Material {
        id: MaterialId(Uuid::from_u128(200 + n)),
        workspace_id: ws(),
        file_id: FileId(Uuid::from_u128(300 + n)),
        mime: "image/jpeg".into(),
        title: String::new(),
        origin: Origin::Real,
        binding: Binding::Olay { olay_id: o.id },
        freed: mark(),
        share: Some(ShareDecision {
            permission,
            by: Some(owner()),
            at: datetime!(2025-01-01 0:00 UTC),
        }),
        tags: Tags {
            quality: Some(Quality::Publishable),
            ..Tags::default()
        },
        tags_reviewed_by: None,
        people: BTreeSet::new(),
        captured_at: None,
        created_by: Actor::Human { user_id: owner() },
        revision: 1,
        created_at: datetime!(2025-01-01 0:00 UTC),
        erased_at: None,
    }
}

fn about(o: &Olay) -> Subject {
    Subject::Olay { olay_id: o.id }
}

fn calendar() -> Calendar {
    Calendar::effective(2024..=2028, &[])
}

/// The findings of one caption about `subject`, with no material and no client name.
fn check(text: &str, subject: Subject, olays: &[Olay]) -> Vec<CaptionFinding> {
    check_caption(&[text], &subject, &[], olays, &[], &calendar())
}

fn codes(findings: &[CaptionFinding]) -> Vec<CaptionCode> {
    findings.iter().map(|f| f.code).collect()
}

fn finding(
    code: CaptionCode,
    olay: &Olay,
    material: Option<&Material>,
    matched: &str,
) -> CaptionFinding {
    CaptionFinding {
        code,
        olay_id: Some(olay.id),
        material_id: material.map(|m| m.id),
        matched: matched.into(),
    }
}

/// Two workshops in Istanbul: Kadıköy on 16 November 2026, Beşiktaş on 23 November 2026.
fn two_workshops() -> (Olay, Olay) {
    (
        workshop(
            1,
            "Kadıköy Figür Atölyesi",
            "Moda Sahnesi, Kadıköy, İstanbul",
            date!(2026 - 11 - 16),
        ),
        workshop(
            2,
            "Beşiktaş Diorama Atölyesi",
            "Beşiktaş, İstanbul",
            date!(2026 - 11 - 23),
        ),
    )
}

#[test]
fn folding_lowercases_the_turkish_way_and_collapses_whitespace() {
    assert_eq!(turkish_fold("İSTANBUL"), "istanbul");
    assert_eq!(turkish_fold("Kadıköy"), "kadikoy");
    assert_eq!(turkish_fold("KADIKÖY"), "kadikoy");
    assert_eq!(turkish_fold("IŞIK  ve\n\tÇİÇEK "), "isik ve cicek");
    assert_eq!(turkish_fold("Ağustos Eylül Şubat"), "agustos eylul subat");
    // Decomposed input (a base letter and its combining mark) folds the same.
    assert_eq!(
        turkish_fold("I\u{307}stanbul S\u{327}is\u{327}li"),
        "istanbul sisli"
    );
    // The optional circumflex of Turkish spelling.
    assert_eq!(turkish_fold("Kâğıthane"), turkish_fold("Kağıthane"));
}

#[test]
fn another_confirmed_olays_title_place_or_client_is_named() {
    let (kadikoy, mut besiktas) = two_workshops();
    besiktas.client = Some(OlayClient {
        person_id: None,
        organization: Some("Çarşı Spor Kulübü".into()),
    });
    let olays = [kadikoy.clone(), besiktas.clone()];
    assert_eq!(
        check(
            "Beşiktaş'taki atölyemizden kareler",
            about(&kadikoy),
            &olays
        ),
        [finding(
            CaptionCode::NamesOtherOlay,
            &besiktas,
            None,
            "besiktas"
        )]
    );
    assert_eq!(
        check("BEŞİKTAŞ DİORAMA ATÖLYESİ'nden", about(&kadikoy), &olays),
        [
            finding(CaptionCode::NamesOtherOlay, &besiktas, None, "besiktas"),
            finding(
                CaptionCode::NamesOtherOlay,
                &besiktas,
                None,
                "besiktas diorama atolyesi"
            ),
        ]
    );
    assert_eq!(
        codes(&check(
            "Çarşı Spor Kulübü için hazırladık",
            about(&kadikoy),
            &olays
        )),
        [CaptionCode::NamesOtherOlay]
    );
    // The subject's own title and place are its to state.
    assert!(
        check(
            "Kadıköy Figür Atölyesi, Moda Sahnesi'nde",
            about(&kadikoy),
            &olays
        )
        .is_empty()
    );
}

#[test]
fn two_workshops_in_one_city_do_not_collide_on_the_place() {
    let (kadikoy, besiktas) = two_workshops();
    let olays = [kadikoy.clone(), besiktas.clone()];
    assert!(check("İstanbul'daki atölyemiz", about(&kadikoy), &olays).is_empty());
    assert!(check("İSTANBUL", about(&besiktas), &olays).is_empty());
    // The other workshop's district, in any casing, is another olay's.
    for district in ["Kadıköy'de", "KADIKÖY'DE", "kadıköy"] {
        assert_eq!(
            check(district, about(&besiktas), &olays),
            [finding(
                CaptionCode::NamesOtherOlay,
                &kadikoy,
                None,
                "kadikoy"
            )],
            "{district}"
        );
    }
    // A place that is part of the subject's title is the subject's too.
    let subject = workshop(
        3,
        "Kadıköy Figür Atölyesi",
        "Moda Sahnesi",
        date!(2026 - 11 - 30),
    );
    let neighbour = workshop(4, "Boyama günü", "Kadıköy", date!(2026 - 12 - 7));
    let olays = [subject.clone(), neighbour];
    assert!(check("Kadıköy Figür Atölyesi bugün", about(&subject), &olays).is_empty());
    assert!(check("Kadıköy'de bugün", about(&subject), &olays).is_empty());
    assert_eq!(
        codes(&check("Boyama günü Kadıköy'de", about(&subject), &olays)),
        [CaptionCode::NamesOtherOlay]
    );
}

#[test]
fn an_unconfirmed_olay_and_a_mere_substring_are_not_named() {
    let (kadikoy, mut besiktas) = two_workshops();
    besiktas.status = OlayStatus::Proposed;
    besiktas.confirmed = None;
    assert!(check("Beşiktaş'ta", about(&kadikoy), &[kadikoy.clone(), besiktas]).is_empty());
    // "Moda" (a place) is not "modası" (its fashion).
    let moda = workshop(3, "Moda Atölyesi", "Moda", date!(2026 - 11 - 30));
    let other = workshop(4, "Başka Atölye", "Üsküdar", date!(2026 - 11 - 30));
    assert!(
        check(
            "Bu sezonun modası",
            about(&other),
            &[other.clone(), moda.clone()]
        )
        .is_empty()
    );
    assert_eq!(
        codes(&check("Moda'da", about(&other), &[other, moda])),
        [CaptionCode::NamesOtherOlay]
    );
}

#[test]
fn a_token_shorter_than_four_characters_never_matches() {
    let subject = workshop(
        1,
        "Kadıköy Figür Atölyesi",
        "Kadıköy",
        date!(2026 - 11 - 16),
    );
    let mut short = workshop(2, "Ev", "Ev", date!(2026 - 11 - 23));
    short.client = Some(OlayClient {
        person_id: None,
        organization: Some("ABC".into()),
    });
    assert!(
        check(
            "Ev gibi bir atölye, ABC harfleri",
            about(&subject),
            &[subject.clone(), short]
        )
        .is_empty()
    );
    let mut product_only = workshop(3, "Sipariş", "Atölye", date!(2026 - 11 - 23));
    let ali = Uuid::from_u128(900);
    product_only.client = Some(OlayClient {
        person_id: Some(ali),
        organization: None,
    });
    let m = material(1, &product_only, SharePermission::ProductOnly);
    let names = [(ali, "Ali Can".to_owned())];
    assert!(
        check_caption(
            &["Ali ve Can için"],
            &about(&product_only),
            &[&m],
            std::slice::from_ref(&product_only),
            &names,
            &calendar()
        )
        .is_empty()
    );
}

#[test]
fn a_generic_caption_does_not_name_its_materials_context() {
    let (kadikoy, besiktas) = two_workshops();
    let olays = [kadikoy.clone(), besiktas.clone()];
    let m = material(1, &kadikoy, SharePermission::Shareable);
    let run =
        |text: &str| check_caption(&[text], &Subject::Generic, &[&m], &olays, &[], &calendar());
    assert_eq!(
        run("Moda Sahnesi'nden bir an"),
        [finding(
            CaptionCode::NamesMaterialContext,
            &kadikoy,
            Some(&m),
            "moda sahnesi"
        )]
    );
    assert!(run("Atölyelerimizden bir an").is_empty());
    // Another olay named in a generic caption is another olay's claim.
    assert_eq!(
        codes(&run("Beşiktaş'ta da görüşelim")),
        [CaptionCode::NamesOtherOlay]
    );
    // The same words about the olay itself are its own to state.
    assert!(
        check_caption(
            &["Moda Sahnesi'nden bir an"],
            &about(&kadikoy),
            &[&m],
            &olays,
            &[],
            &calendar()
        )
        .is_empty()
    );
}

#[test]
fn a_date_outside_the_subjects_olay_is_found_in_every_format() {
    let (kadikoy, _) = two_workshops();
    let olays = [kadikoy.clone()];
    for inside in [
        "16 Kasım'da görüşürüz",
        "16 KASIM 2026",
        "16 kasım",
        "16.11",
        "Tarih: 16.11.2026.",
        "16/11/2026",
        "6 kişilik, 16.11'de",
    ] {
        assert!(
            check(inside, about(&kadikoy), &olays).is_empty(),
            "{inside}"
        );
    }
    for (outside, matched) in [
        ("17 Kasım'da", "17 kasim"),
        ("16 Kasım 2025", "16 kasim 2025"),
        ("17.11", "17.11"),
        ("16.11.2025", "16.11.2025"),
        ("16/11/2027", "16/11/2027"),
        ("1 ARALIK", "1 aralik"),
    ] {
        assert_eq!(
            check(outside, about(&kadikoy), &olays),
            [finding(
                CaptionCode::DateOutsideOlay,
                &kadikoy,
                None,
                matched
            )],
            "{outside}"
        );
    }
    // Not dates: a time, a fraction, a two-digit year, a day with no month.
    for not_a_date in [
        "Saat 10.30'da",
        "16:30",
        "1/2 fiyatına",
        "16.11.26",
        "16 kişi",
    ] {
        assert!(
            check(not_a_date, about(&kadikoy), &olays).is_empty(),
            "{not_a_date}"
        );
    }
}

#[test]
fn a_date_without_a_year_is_compared_in_every_year_of_the_range() {
    let new_year = olay(
        5,
        "Yeni yıl atölyesi",
        None,
        date!(2026 - 12 - 28),
        date!(2027 - 01 - 03),
    );
    let olays = [new_year.clone()];
    for inside in ["2 Ocak", "29 Aralık", "02.01", "29.12.2026", "3 Ocak 2027"] {
        assert!(
            check(inside, about(&new_year), &olays).is_empty(),
            "{inside}"
        );
    }
    for outside in ["5 Ocak", "27 Aralık", "2 Ocak 2026", "29.12.2027"] {
        assert_eq!(
            codes(&check(outside, about(&new_year), &olays)),
            [CaptionCode::DateOutsideOlay],
            "{outside}"
        );
    }
}

#[test]
fn a_generic_caption_does_not_state_its_materials_olay_date() {
    let (kadikoy, _) = two_workshops();
    let olays = [kadikoy.clone()];
    let m = material(1, &kadikoy, SharePermission::Shareable);
    let run = |text: &str, subject: Subject| {
        check_caption(&[text], &subject, &[&m], &olays, &[], &calendar())
    };
    assert_eq!(
        run("16 Kasım'daki gibi", Subject::Generic),
        [finding(
            CaptionCode::DateInGeneric,
            &kadikoy,
            Some(&m),
            "16 kasim"
        )]
    );
    assert_eq!(
        codes(&run("16.11.2026", Subject::Generic)),
        [CaptionCode::DateInGeneric]
    );
    assert!(run("20 Kasım'da yeni ürünler", Subject::Generic).is_empty());
    assert!(run("16 Kasım'da", about(&kadikoy)).is_empty());
}

#[test]
fn an_archive_caption_states_its_season_year() {
    // A yılbaşı collection shot in November 2025 belongs to the 2025 window.
    let last_year = yilbasi(6, date!(2025 - 11 - 20), date!(2025 - 12 - 31));
    let olays = [last_year.clone()];
    let archive = Subject::Archive {
        olay_id: last_year.id,
    };
    assert_eq!(
        check("Geçen yılbaşından", archive, &olays),
        [finding(
            CaptionCode::ArchiveYearMissing,
            &last_year,
            None,
            "2025"
        )]
    );
    assert!(check("2025 yılbaşı koleksiyonumuz", archive, &olays).is_empty());
    assert!(check("2025'in yılbaşı", archive, &olays).is_empty());
    assert!(check("31.12.2025", archive, &olays).is_empty());
    assert_eq!(
        codes(&check("12025 parça", archive, &olays)),
        [CaptionCode::ArchiveYearMissing]
    );
    // The olay's own subject needs no year.
    assert!(check("Yılbaşı koleksiyonu", about(&last_year), &olays).is_empty());
}

#[test]
fn a_product_only_material_does_not_name_its_client() {
    let ayse = Uuid::from_u128(900);
    let mut order = workshop(7, "Kulüp siparişi", "Atölye", date!(2026 - 11 - 20));
    order.kind = OlayKind::Order;
    order.client = Some(OlayClient {
        person_id: Some(ayse),
        organization: Some("Moda Spor Kulübü".into()),
    });
    let olays = [order.clone()];
    let names = [(ayse, "Ayşe Yılmaz".to_owned())];
    let hidden = material(1, &order, SharePermission::ProductOnly);
    let shown = material(2, &order, SharePermission::Shareable);
    let run = |text: &str, m: &Material| {
        check_caption(&[text], &about(&order), &[m], &olays, &names, &calendar())
    };
    assert_eq!(
        run("AYŞE Hanım'ın figürleri", &hidden),
        [finding(
            CaptionCode::ClientNamedProductOnly,
            &order,
            Some(&hidden),
            "ayse"
        )]
    );
    assert_eq!(
        run("Moda Spor Kulübü için 200 figür", &hidden),
        [finding(
            CaptionCode::ClientNamedProductOnly,
            &order,
            Some(&hidden),
            "moda spor kulubu"
        )]
    );
    assert_eq!(
        codes(&run("Yılmaz ailesine", &hidden)),
        [CaptionCode::ClientNamedProductOnly]
    );
    assert!(run("Bir kulüp için 200 figür", &hidden).is_empty());
    assert!(run("Ayşe Hanım'ın figürleri", &shown).is_empty());
}

#[test]
fn every_text_source_is_checked_and_the_findings_are_sorted_and_unique() {
    let (kadikoy, besiktas) = two_workshops();
    let olays = [kadikoy.clone(), besiktas.clone()];
    let texts = [
        "Beşiktaş ve 17 Kasım",
        "Bir adaptasyon: Beşiktaş",
        "TikTok başlığı: 17.11",
    ];
    let found = check_caption(&texts, &about(&kadikoy), &[], &olays, &[], &calendar());
    assert_eq!(
        found,
        [
            finding(CaptionCode::NamesOtherOlay, &besiktas, None, "besiktas"),
            finding(CaptionCode::DateOutsideOlay, &kadikoy, None, "17 kasim"),
            finding(CaptionCode::DateOutsideOlay, &kadikoy, None, "17.11"),
        ]
    );
    let reversed: Vec<&str> = texts.iter().rev().copied().collect();
    assert_eq!(
        check_caption(&reversed, &about(&kadikoy), &[], &olays, &[], &calendar()),
        found
    );
    // A match never spans two sources.
    assert!(
        check_caption(
            &["Beşiktaş Diorama", "Atölyesi"],
            &about(&kadikoy),
            &[],
            &olays,
            &[],
            &calendar()
        )
        .iter()
        .all(|f| f.matched != "besiktas diorama atolyesi")
    );
}

#[test]
fn the_canonical_form_is_stable_and_changes_with_any_finding() {
    let (kadikoy, besiktas) = two_workshops();
    let olays = [kadikoy.clone(), besiktas.clone()];
    let a = check("Beşiktaş, 17 Kasım", about(&kadikoy), &olays);
    let mut shuffled = a.clone();
    shuffled.reverse();
    shuffled.push(a[0].clone());
    assert_eq!(canonical_findings(&a), canonical_findings(&shuffled));
    let b = check("Beşiktaş, 18 Kasım", about(&kadikoy), &olays);
    assert_ne!(canonical_findings(&a), canonical_findings(&b));
    assert_ne!(canonical_findings(&a), canonical_findings(&[]));
    // A line break in the matched text cannot forge a second finding.
    let one = |matched: &str| CaptionFinding {
        code: CaptionCode::NamesOtherOlay,
        olay_id: None,
        material_id: None,
        matched: matched.into(),
    };
    assert_ne!(
        canonical_findings(&[one("x\nnames_other_olay|-|-|y")]),
        canonical_findings(&[one("x"), one("y")])
    );
}

#[test]
fn caption_codes_serialize_as_their_closed_names() {
    for (code, key) in [
        (CaptionCode::NamesOtherOlay, "names_other_olay"),
        (CaptionCode::NamesMaterialContext, "names_material_context"),
        (CaptionCode::DateOutsideOlay, "date_outside_olay"),
        (CaptionCode::DateInGeneric, "date_in_generic"),
        (CaptionCode::ArchiveYearMissing, "archive_year_missing"),
        (
            CaptionCode::ClientNamedProductOnly,
            "client_named_product_only",
        ),
    ] {
        assert_eq!(code.code(), key);
        assert_eq!(serde_json::to_value(code).unwrap(), key);
    }
}
