//! The phrases the bridge may play on its own: exactly the set the owner approved on 2026-10-29.
use jt_calls::{BridgePhrases, PhraseSet};
use serde_json::json;

#[test]
fn the_defaults_are_the_approved_set() {
    let p = BridgePhrases::default();
    assert_eq!(
        p.acknowledgements,
        ["Hı hı.", "Anladım.", "Tamam.", "Peki."]
    );
    assert_eq!(
        p.fillers,
        [
            "Bir saniye, hemen bakıyorum.",
            "Kontrol ediyorum, kısa bir an."
        ]
    );
    assert_eq!(
        p.long_wait,
        ["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]
    );
    assert_eq!(p.not_heard, ["Sizi tam duyamadım, tekrar eder misiniz?"]);
    assert_eq!(p.still_there, ["Hâlâ orada mısınız?"]);
    assert_eq!(
        p.fault,
        ["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."]
    );
    assert_eq!(p.all().count(), 10);
}

#[test]
fn a_phrase_is_found_by_its_set_and_index() {
    let p = BridgePhrases::default();
    assert_eq!(
        p.text(PhraseSet::Filler, 1),
        Some("Kontrol ediyorum, kısa bir an.")
    );
    assert_eq!(p.text(PhraseSet::LongWait, 1), None);
    assert_eq!(p.set(PhraseSet::Acknowledgement).len(), 4);
}

#[test]
fn sets_read_and_write_snake_case_and_missing_sets_keep_their_defaults() {
    assert_eq!(
        serde_json::to_value(PhraseSet::LongWait).unwrap(),
        json!("long_wait")
    );
    assert_eq!(
        serde_json::to_value(PhraseSet::StillThere).unwrap(),
        json!("still_there")
    );
    let p: BridgePhrases = serde_json::from_value(json!({ "fillers": ["Bir dakika."] })).unwrap();
    assert_eq!(p.fillers, ["Bir dakika."]);
    assert_eq!(
        p.acknowledgements,
        BridgePhrases::default().acknowledgements
    );
}

// Added beyond the plan's tests: the owner's approved texts, pinned character for character.

/// Every text the owner approved on 2026-10-29 that the domain holds, set by set, in the order
/// `BridgePhrases::all` yields them.
const APPROVED: [(PhraseSet, &[&str]); 6] = [
    (
        PhraseSet::Acknowledgement,
        &["Hı hı.", "Anladım.", "Tamam.", "Peki."],
    ),
    (
        PhraseSet::Filler,
        &[
            "Bir saniye, hemen bakıyorum.",
            "Kontrol ediyorum, kısa bir an.",
        ],
    ),
    (
        PhraseSet::LongWait,
        &["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."],
    ),
    (
        PhraseSet::NotHeard,
        &["Sizi tam duyamadım, tekrar eder misiniz?"],
    ),
    (PhraseSet::StillThere, &["Hâlâ orada mısınız?"]),
    (
        PhraseSet::Fault,
        &["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."],
    ),
];

#[test]
fn the_approved_texts_are_pinned_set_by_set() {
    let p = BridgePhrases::default();
    for (set, texts) in APPROVED {
        let have: Vec<&str> = p.set(set).iter().map(String::as_str).collect();
        assert_eq!(have, texts, "{set:?}");
    }
    let flat: Vec<&str> = APPROVED
        .iter()
        .flat_map(|(_, t)| t.iter().copied())
        .collect();
    assert_eq!(p.all().collect::<Vec<_>>(), flat);
    assert_eq!(
        jt_calls::TRANSCRIPT_NOTICE,
        "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."
    );
}

#[test]
fn the_approved_texts_use_the_precomposed_turkish_letters() {
    // "Hı hı." has the dotless ı (U+0131) and "Hâlâ" the precomposed â (U+00E2), never an i or an
    // a followed by a combining mark: the speech engine and the phrase cache key on the bytes.
    let p = BridgePhrases::default();
    assert!(p.acknowledgements[0].contains('\u{131}'));
    assert!(!p.acknowledgements[0].contains('i'));
    assert!(p.still_there[0].contains('\u{e2}'));
    for text in p.all().chain([jt_calls::TRANSCRIPT_NOTICE]) {
        assert!(
            !text.chars().any(|c| ('\u{300}'..='\u{36f}').contains(&c)),
            "{text}"
        );
        assert_eq!(text, text.trim(), "{text}");
        assert!(text.ends_with(['.', '?']), "{text}");
    }
}

#[test]
fn sets_have_stable_positions_and_a_cleared_set_is_never_played() {
    for (i, set) in PhraseSet::ALL.into_iter().enumerate() {
        assert_eq!(set.position(), i, "{set:?}");
    }
    let p: BridgePhrases = serde_json::from_value(json!({ "fillers": [] })).unwrap();
    assert!(p.set(PhraseSet::Filler).is_empty());
    assert_eq!(p.text(PhraseSet::Filler, 0), None);
    assert_eq!(p.all().count(), 8);
    assert_eq!(
        BridgePhrases::default().text(PhraseSet::Fault, u8::MAX),
        None
    );
}

#[test]
fn the_defaults_survive_a_trip_through_json() {
    let p = BridgePhrases::default();
    let back: BridgePhrases = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    assert_eq!(back, p);
    let empty: BridgePhrases = serde_json::from_value(json!({})).unwrap();
    assert_eq!(empty, p);
}
