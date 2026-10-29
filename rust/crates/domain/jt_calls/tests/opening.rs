//! The approved opening with the business's name, its suffix fitted (owner decision 2026-10-29).
use jt_calls::{TRANSCRIPT_NOTICE, disclosure, genitive, inbound_greeting, outbound_opening};

#[test]
fn genitive_follows_vowel_harmony_and_the_buffer_n() {
    for (name, want) in [
        ("Jeeta", "Jeeta'nın"),
        ("Figurunica", "Figurunica'nın"),
        ("Atölye", "Atölye'nin"),
        ("Ahmet", "Ahmet'in"),
        ("Test Atölye", "Test Atölye'nin"),
        ("Acme", "Acme'nin"),
        ("Kuzu", "Kuzu'nun"),
        ("Ütü", "Ütü'nün"),
        ("Gül", "Gül'ün"),
        ("Ayşe", "Ayşe'nin"),
        ("Kitap", "Kitap'ın"),
        ("Sırçalı", "Sırçalı'nın"),
        ("Oto", "Oto'nun"),
        ("Doğruluk", "Doğruluk'un"),
        ("Ahmet Usta", "Ahmet Usta'nın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn capitals_are_lowered_the_turkish_way() {
    assert_eq!(genitive("İSTANBUL"), "İSTANBUL'un");
    assert_eq!(genitive("ISPARTA"), "ISPARTA'nın");
    assert_eq!(genitive("KIRIKKALE"), "KIRIKKALE'nin");
}

#[test]
fn vowelless_words_are_read_by_their_letters() {
    assert_eq!(genitive("THY"), "THY'nin");
    assert_eq!(genitive("KDS"), "KDS'nin");
    assert_eq!(genitive("BMW"), "BMW'nin");
}

#[test]
fn trailing_numbers_are_read_aloud() {
    for (name, want) in [
        ("Studio 54", "Studio 54'ün"),
        ("Kahve 10", "Kahve 10'un"),
        ("Bina 100", "Bina 100'ün"),
        ("Lokanta 2000", "Lokanta 2000'in"),
        ("Oda 6", "Oda 6'nın"),
        ("Ofis 3", "Ofis 3'ün"),
        ("Kat 0", "Kat 0'ın"),
        ("Cafe 7", "Cafe 7'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn blank_names_give_no_opening() {
    assert_eq!(genitive("  "), "");
    assert_eq!(outbound_opening(""), None);
    assert_eq!(disclosure("\t"), None);
}

#[test]
fn the_approved_sentences() {
    assert_eq!(
        outbound_opening("Jeeta").unwrap(),
        "Merhaba, ben Jeeta'nın dijital asistanıyım."
    );
    assert_eq!(
        inbound_greeting("Atölye").unwrap(),
        "Merhaba, ben Atölye'nin dijital asistanıyım. Size nasıl yardımcı olabilirim?"
    );
    let d = disclosure("Figurunica").unwrap();
    assert_eq!(d, "ben Figurunica'nın dijital asistanıyım");
    assert!(outbound_opening("Figurunica").unwrap().contains(&d));
    assert!(inbound_greeting("Figurunica").unwrap().contains(&d));
    assert_eq!(
        TRANSCRIPT_NOTICE,
        "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."
    );
}

// Added beyond the plan's tests: the owner's checklist of names, and the edges of the rules.

#[test]
fn every_vowel_class_with_and_without_the_buffer_n() {
    for (name, want) in [
        ("Zeytin", "Zeytin'in"),
        ("Okul", "Okul'un"),
        ("Göz", "Göz'ün"),
        ("Arı", "Arı'nın"),
        ("Kapı", "Kapı'nın"),
        ("Bahçe", "Bahçe'nin"),
        ("Kulüp", "Kulüp'ün"),
        ("Gözlük", "Gözlük'ün"),
        ("Ev", "Ev'in"),
        ("O", "O'nun"),
        ("Ömer", "Ömer'in"),
        ("Kâr", "Kâr'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn capital_dotted_and_dotless_i_decide_the_suffix_wherever_they_stand() {
    for (name, want) in [
        ("İzmir", "İzmir'in"),
        ("Işık", "Işık'ın"),
        ("Iğdır", "Iğdır'ın"),
        ("ALİ", "ALİ'nin"),
        ("TAKSİ", "TAKSİ'nin"),
        ("ISI", "ISI'nın"),
        ("KIZILIRMAK", "KIZILIRMAK'ın"),
        ("ÇİÇEK", "ÇİÇEK'in"),
        ("DİKİLİ", "DİKİLİ'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn a_number_glued_to_the_name_or_inside_it_is_read_the_same_way() {
    for (name, want) in [
        ("Studio54", "Studio54'ün"),
        ("B2B", "B2B'nin"),
        ("7Eleven", "7Eleven'in"),
        ("3 Kardeşler", "3 Kardeşler'in"),
        ("Hotel 40", "Hotel 40'ın"),
        ("Hotel 20", "Hotel 20'nin"),
        ("Hotel 30", "Hotel 30'un"),
        ("Kat 11", "Kat 11'in"),
        ("Kat 5", "Kat 5'in"),
        ("Plaza 1000000", "Plaza 1000000'un"),
        ("Plaza 1100", "Plaza 1100'ün"),
        ("Plaza 12", "Plaza 12'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn an_absurdly_long_number_does_not_panic() {
    let name = format!("Hat {}", "9".repeat(40));
    assert!(genitive(&name).starts_with("Hat 99"));
}

#[test]
fn a_name_of_nothing_but_punctuation_gives_no_opening() {
    assert_eq!(genitive("..."), "");
    assert_eq!(outbound_opening("- -"), None);
    assert_eq!(inbound_greeting("   "), None);
}

#[test]
fn the_name_is_trimmed_but_otherwise_kept_as_written() {
    assert_eq!(genitive("  Atölye\t"), "Atölye'nin");
    assert_eq!(
        outbound_opening("  Test Atölye ").unwrap(),
        "Merhaba, ben Test Atölye'nin dijital asistanıyım."
    );
}
