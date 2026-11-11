use jeeta_voice_bridge::text::{self, heard_chars, is_backchannel, sentences};

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
        texts("Tutar 1.250 TL. Saat 14.30'da Dr. Ahmet bekliyor! Size uygun mu acaba?"),
        [
            "Tutar 1.250 TL.",
            "Saat 14.30'da Dr. Ahmet bekliyor!",
            "Size uygun mu acaba?"
        ]
    );
    assert_eq!(texts("Randevunuz 14:00'e."), ["Randevunuz 14:00'e."]);
    assert_eq!(
        texts("Faiz oranı yüzde 3,5 oldu. Prof.Dr. Ahmet bugün burada."),
        ["Faiz oranı yüzde 3,5 oldu.", "Prof.Dr. Ahmet bugün burada."]
    );
}

#[test]
fn offsets_are_characters_of_the_original_text() {
    let s = sentences("Öğle yemeği hazır. İkindi çayı da hazır.");
    assert_eq!((s[0].start, s[0].end), (0, 18));
    assert_eq!((s[1].start, s[1].end), (19, 40));
}

#[test]
fn a_very_long_sentence_is_cut_at_a_comma() {
    let long = format!(
        "{}, ve sonra devam ediyoruz.",
        "kelime ".repeat(40).trim_end()
    );
    let parts = sentences(&long);
    assert_eq!(parts.len(), 2);
    assert!(parts[0].text.ends_with(','));
}

#[test]
fn heard_characters_count_finished_sentences_and_the_share_of_the_current_one() {
    let s = sentences("Bir iki üç. Dört beş altı sekiz.");
    assert_eq!(heard_chars(&s, 0, 0.0), 0);
    assert_eq!(heard_chars(&s, 1, 0.0), 12);
    assert_eq!(heard_chars(&s, 1, 0.5), 22);
    assert_eq!(heard_chars(&s, 2, 0.0), 32);
}

#[test]
fn backchannel_words_alone_are_an_acknowledgement() {
    assert!(is_backchannel("hı hı"));
    assert!(is_backchannel("evet evet tamam"));
    assert!(!is_backchannel("evet ama yarın olmaz"));
    assert!(!is_backchannel(""));
}

// B4 review I5 (2026-10-29): the cuts the speak service makes (`split_sentences` of
// `speech/speak/jeeta_speak.py`, which holds the same cases).

#[test]
fn an_ordinal_number_ends_no_sentence() {
    assert_eq!(
        texts("Ofisimiz 3. katta bulunuyor."),
        ["Ofisimiz 3. katta bulunuyor."]
    );
    assert_eq!(texts("1. seçenek iyi."), ["1. seçenek iyi."]);
    assert_eq!(
        texts("Bizim ofisimiz 3. katta ve bahçeye bakıyor."),
        ["Bizim ofisimiz 3. katta ve bahçeye bakıyor."]
    );
    // A number that ends a sentence, before one that starts in capitals, still ends it.
    assert_eq!(
        texts("Kapı numarası 12. Ondan sonra sağa dönün."),
        ["Kapı numarası 12.", "Ondan sonra sağa dönün."]
    );
}

#[test]
fn a_piece_of_fewer_than_three_words_joins_the_next() {
    assert_eq!(
        texts("Evet. Tamam. Yarın görüşürüz."),
        ["Evet. Tamam. Yarın görüşürüz."]
    );
    // The last one joins the one before it.
    assert_eq!(
        texts("Yarın sizi arayacağız. Tamam mı?"),
        ["Yarın sizi arayacağız. Tamam mı?"]
    );
    assert_eq!(texts("Peki."), ["Peki."]);
    let s = sentences("Evet. Tamam. Yarın görüşürüz.");
    assert_eq!((s[0].start, s[0].end), (0, 29));
}

/// The table the speak service's test holds too (`speech/speak/tests/speak_sentence_cases.py`): one
/// JSON array per line, `[text, [sentence, ...]]`.
#[test]
fn texts_are_cut_where_the_speak_service_cuts_them() {
    let table = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("speech/speak/tests/speak_sentence_cases.py");
    let source = std::fs::read_to_string(&table).expect("the shared table");
    let mut cases = 0;
    for line in source.lines().filter(|l| l.starts_with('[')) {
        let (text, expected): (String, Vec<String>) =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}"));
        assert_eq!(texts(&text), expected, "{text}");
        cases += 1;
    }
    assert!(cases >= 25, "only {cases} cases in {}", table.display());
}

/// The word lists both cutters keep, on the shared table's `LISTS` line.
#[test]
fn the_word_lists_are_the_speak_services() {
    let table = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("speech/speak/tests/speak_sentence_cases.py");
    let source = std::fs::read_to_string(&table).expect("the shared table");
    let line = source
        .lines()
        .find(|l| l.starts_with("{\"abbreviations\""))
        .expect("the LISTS line");
    let lists: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(line).expect("the LISTS line is JSON");
    let ours = |words: &[&str]| words.iter().map(|w| (*w).to_owned()).collect::<Vec<_>>();
    assert_eq!(lists["abbreviations"], ours(&text::ABBREVIATIONS));
    assert_eq!(lists["ordinal_nouns"], ours(&text::ORDINAL_NOUNS));
}

#[test]
fn an_interrobang_and_an_ellipsis_end_a_sentence_once() {
    assert_eq!(
        texts("Bunu gerçekten bilmiyor muydunuz?! Şaşırdım doğrusu bunu."),
        [
            "Bunu gerçekten bilmiyor muydunuz?!",
            "Şaşırdım doğrusu bunu."
        ]
    );
    assert_eq!(
        texts("Bir düşüneyim bakalım… Evet, uygun görünüyor."),
        ["Bir düşüneyim bakalım…", "Evet, uygun görünüyor."]
    );
    assert_eq!(texts("   "), Vec::<String>::new());
}
