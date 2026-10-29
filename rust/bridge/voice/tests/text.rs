use jeeta_voice_bridge::text::{heard_chars, is_backchannel, sentences};

fn texts(t: &str) -> Vec<String> {
    sentences(t).into_iter().map(|s| s.text).collect()
}

#[test]
fn a_text_is_cut_at_its_sentence_ends() {
    assert_eq!(
        texts(
            "Merhaba, ben Acme'nin dijital asistanıyım. Görüşmemiz yazıya dökülmektedir. Ada Hanım ile mi görüşüyorum?"
        ),
        [
            "Merhaba, ben Acme'nin dijital asistanıyım.",
            "Görüşmemiz yazıya dökülmektedir.",
            "Ada Hanım ile mi görüşüyorum?",
        ]
    );
}

#[test]
fn numbers_times_and_abbreviations_stay_whole() {
    assert_eq!(
        texts("Tutar 1.250 TL. Saat 14.30'da Dr. Ahmet bekliyor! Tamam mı?"),
        [
            "Tutar 1.250 TL.",
            "Saat 14.30'da Dr. Ahmet bekliyor!",
            "Tamam mı?"
        ]
    );
    assert_eq!(texts("Randevunuz 14:00'e."), ["Randevunuz 14:00'e."]);
}

#[test]
fn offsets_are_characters_of_the_original_text() {
    let s = sentences("Öğle. İkindi.");
    assert_eq!((s[0].start, s[0].end), (0, 5));
    assert_eq!((s[1].start, s[1].end), (6, 13));
}

#[test]
fn a_very_long_sentence_is_cut_at_a_comma() {
    let long = format!("{}, ve devamı.", "kelime ".repeat(40).trim_end());
    let parts = sentences(&long);
    assert_eq!(parts.len(), 2);
    assert!(parts[0].text.ends_with(','));
}

#[test]
fn heard_characters_count_finished_sentences_and_the_share_of_the_current_one() {
    let s = sentences("Bir iki. Üç dört beş.");
    assert_eq!(heard_chars(&s, 0, 0.0), 0);
    assert_eq!(heard_chars(&s, 1, 0.0), 9);
    assert_eq!(heard_chars(&s, 1, 0.5), 15);
    assert_eq!(heard_chars(&s, 2, 0.0), 21);
}

#[test]
fn backchannel_words_alone_are_an_acknowledgement() {
    assert!(is_backchannel("hı hı"));
    assert!(is_backchannel("evet evet tamam"));
    assert!(!is_backchannel("evet ama yarın olmaz"));
    assert!(!is_backchannel(""));
}
