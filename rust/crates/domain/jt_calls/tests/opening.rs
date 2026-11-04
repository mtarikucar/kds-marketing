//! The approved opening with the business's name, its suffix fitted (owner decision 2026-10-29).
use jt_calls::{
    CLOSING, TRANSCRIPT_NOTICE, disclosure, genitive, inbound_greeting, outbound_opening,
};

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

// Added in the A3 fix-up: words whose suffix is front although their last vowel is back.

#[test]
fn soft_l_loanwords_and_the_front_table_take_the_front_suffix() {
    for (name, want) in [
        ("Kemal", "Kemal'in"),
        ("Saat", "Saat'in"),
        ("Hal", "Hal'in"),
        ("Kalp", "Kalp'in"),
        ("Kontrol", "Kontrol'ün"),
        ("Petrol", "Petrol'ün"),
        ("İstiklâl", "İstiklâl'in"),
        ("Kuzey Petrol", "Kuzey Petrol'ün"),
        // Every word of the table, once.
        ("Alkol", "Alkol'ün"),
        ("Bilal", "Bilal'in"),
        ("Celal", "Celal'in"),
        ("Cemal", "Cemal'in"),
        ("Dikkat", "Dikkat'in"),
        ("Gol", "Gol'ün"),
        ("Hakikat", "Hakikat'in"),
        ("Harf", "Harf'in"),
        ("Hayal", "Hayal'in"),
        ("Hilal", "Hilal'in"),
        ("Kabul", "Kabul'ün"),
        ("Nihal", "Nihal'in"),
        ("Protokol", "Protokol'ün"),
        ("Rol", "Rol'ün"),
        ("Sembol", "Sembol'ün"),
        ("Usul", "Usul'ün"),
        // Any word ending in "âl".
        ("Kemâl", "Kemâl'in"),
        ("Hilâl", "Hilâl'in"),
        ("Celâl", "Celâl'in"),
        ("İSTİKLÂL", "İSTİKLÂL'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn the_front_table_is_matched_on_the_turkish_lowercased_whole_word() {
    for (name, want) in [
        ("KONTROL", "KONTROL'ün"),
        ("HAL", "HAL'in"),
        ("ROL", "ROL'ün"),
        ("DİKKAT", "DİKKAT'in"),
        ("BİLAL", "BİLAL'in"),
        ("HİLAL", "HİLAL'in"),
        ("NİHAL", "NİHAL'in"),
        ("HAKİKAT", "HAKİKAT'in"),
        ("kalp", "kalp'in"),
        ("Petrol.", "Petrol.'ün"),
        // Only a whole word: these merely begin with a table word, or are plain back words.
        ("Sanat", "Sanat'ın"),
        ("Okul", "Okul'un"),
        ("Halk", "Halk'ın"),
        ("Kalpak", "Kalpak'ın"),
        ("Kemalpaşa", "Kemalpaşa'nın"),
        ("Petrolcü", "Petrolcü'nün"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn the_front_table_is_not_applied_to_a_trailing_number() {
    assert_eq!(genitive("Hal 7"), "Hal 7'nin");
    assert_eq!(genitive("Rol 4"), "Rol 4'ün");
}

// Added in the A3 fix-up: a trailing word of symbols, and whitespace inside the name.

#[test]
fn a_trailing_word_of_symbols_is_dropped_and_the_last_real_word_decides() {
    for (name, want) in [
        ("Kafe ☕", "Kafe'nin"),
        ("Acme -", "Acme'nin"),
        ("Acme .", "Acme'nin"),
        ("Acme - ☕ .", "Acme'nin"),
        ("Atölye &", "Atölye'nin"),
        ("Studio 54 ★", "Studio 54'ün"),
        ("☕ Kafe", "☕ Kafe'nin"),
        ("Test & Atölye", "Test & Atölye'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
    assert_eq!(
        outbound_opening("Kafe ☕").unwrap(),
        "Merhaba, ben Kafe'nin dijital asistanıyım."
    );
    assert_eq!(
        disclosure("Acme .").unwrap(),
        "ben Acme'nin dijital asistanıyım"
    );
    assert_eq!(outbound_opening("☕ -"), None);
}

#[test]
fn words_are_joined_by_single_spaces_so_no_newline_reaches_the_sentence() {
    assert_eq!(genitive("Test\nAtölye"), "Test Atölye'nin");
    assert_eq!(genitive("  Test \t\r\n  Atölye \n"), "Test Atölye'nin");
    for text in [
        outbound_opening("Test\nAtölye").unwrap(),
        inbound_greeting("Test\r\nAtölye").unwrap(),
        disclosure("Test\u{a0}\u{a0}Atölye").unwrap(),
    ] {
        assert!(!text.contains(['\n', '\r', '\t']), "{text:?}");
        assert!(!text.contains("  "), "{text:?}");
        assert!(text.contains("Test Atölye'nin"), "{text:?}");
    }
}

// Added in the A3 fix-up: numbers of a trillion and more.

#[test]
fn round_numbers_up_to_a_trillion_and_more_are_read_by_their_unit() {
    for (name, want) in [
        ("Plaza 1000000000", "Plaza 1000000000'ın"),
        ("Plaza 1000000000000", "Plaza 1000000000000'un"),
        ("Plaza 5000000000000", "Plaza 5000000000000'un"),
        ("Plaza 1000000000000000", "Plaza 1000000000000000'un"),
        ("Plaza 100000000000000000", "Plaza 100000000000000000'un"),
        ("Plaza 1500000000000", "Plaza 1500000000000'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

// Added in the A3 fix-up: dotted acronyms are spelled out by their last letter.

#[test]
fn a_dotted_acronym_is_read_by_the_name_of_its_last_letter() {
    for (name, want) in [
        ("A.Ş.", "A.Ş.'nin"),
        ("Acme A.Ş.", "Acme A.Ş.'nin"),
        ("Acme A.Ş", "Acme A.Ş'nin"),
        ("T.C.", "T.C.'nin"),
        ("A.B.D.", "A.B.D.'nin"),
        ("I.B.M.", "I.B.M.'nin"),
        ("S.A.", "S.A.'nın"),
        ("A.O.", "A.O.'nun"),
        ("Ö.Ü.", "Ö.Ü.'nün"),
        ("T.İ.", "T.İ.'nin"),
        ("Y.Ğ.", "Y.Ğ.'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn dots_that_do_not_spell_an_acronym_change_nothing() {
    for (name, want) in [
        ("Ltd.", "Ltd.'nin"),
        ("Ahmet A.", "Ahmet A.'nın"),
        ("St.Anne", "St.Anne'nin"),
        ("Dr.", "Dr.'nin"),
        ("v1.2", "v1.2'nin"),
        ("3.5", "3.5'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn an_acronym_with_vowels_and_no_dots_is_read_as_a_word() {
    // The documented limit: ABD is spoken "A-Be-De" but its spelling has a vowel, so it follows
    // the spelling. An owner whose name is read otherwise writes the opening by hand.
    assert_eq!(genitive("ABD"), "ABD'ın");
    assert_eq!(genitive("AVM"), "AVM'ın");
    assert_eq!(genitive("IBM"), "IBM'ın");
    // Without a vowel the same names are spelled out.
    assert_eq!(genitive("BMW"), "BMW'nin");
}

#[test]
fn the_approved_closing_is_a_pinned_constant() {
    assert_eq!(CLOSING, "Görüşmek üzere, iyi günler.");
    assert_ne!(CLOSING, TRANSCRIPT_NOTICE);
}

// Added in the second A3 fix-up: words checked against TDK's Güncel Türkçe Sözlük (sozluk.gov.tr),
// which shows each entry's suffixed ending: a front vowel after a back-vowel stem (-li, -lü, -ti)
// is the mark of a front suffix.

#[test]
fn words_the_dictionary_marks_with_a_front_suffix_take_it() {
    for (name, want) in [
        ("Metal", "Metal'in"),
        ("Kristal", "Kristal'in"),
        ("Lokal", "Lokal'in"),
        ("Final", "Final'in"),
        ("Sinyal", "Sinyal'in"),
        ("İkbal", "İkbal'in"),
        ("İKBAL", "İKBAL'in"),
        ("Ankara Metal", "Ankara Metal'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn words_the_dictionary_marks_with_a_back_suffix_stay_back() {
    // "emlak" is listed with the ending -kı (emlakı): back, though it looks like a soft-k word.
    for (name, want) in [
        ("Emlak", "Emlak'ın"),
        ("Ahlak", "Ahlak'ın"),
        ("Kitap", "Kitap'ın"),
        ("Kalpak", "Kalpak'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn words_outside_the_table_follow_the_spelling_whatever_their_pronunciation() {
    // The documented limits: a compound of a table word, a word the dictionary does not list
    // (İclal), and one it lists without a front mark (global).
    assert_eq!(genitive("Akpetrol"), "Akpetrol'un");
    assert_eq!(genitive("İclal"), "İclal'ın");
    assert_eq!(genitive("Global"), "Global'ın");
}
