//! The workspace's own opening of an agent's call (owner decision 2026-10-29): the approved
//! sentences with the business's name in them, its genitive suffix fitted by Turkish vowel harmony.
//! The sentences are the owner's; the server only puts the workspace's own name in them.

/// Played after the opening on every agent call (owner-approved 2026-10-29).
pub const TRANSCRIPT_NOTICE: &str = "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.";

/// Played before an agent's call is hung up when its plan brings none (owner-approved 2026-10-29;
/// the policy's `closing` by default, task C1).
pub const CLOSING: &str = "Görüşmek üzere, iyi günler.";

const VOWELS: &str = "aeıioöuüâîû";

/// Words whose suffix is front although their last vowel is back: "Kemal'in", "Saat'in",
/// "Kontrol'ün". Each is listed in TDK's Güncel Türkçe Sözlük with an ending that has a front vowel
/// after the back-vowel stem (kemal -li, saat -ti, kalp -bi, petrol -lü; checked 2026-10-29), except
/// `bilal` and `nihal`: first names the dictionary does not list, which inflect the same way as
/// `hilal` and `kemal`. Matched whole, on the Turkish-lowercased last word of a name, so a
/// compound ("Akpetrol") follows the spelling. Words ending in "âl" are covered by a rule
/// ([`takes_front_suffix`]), whether or not they are listed. Not listed, on purpose: `global` (the
/// dictionary shows no front mark), `emlak` (its ending is -kı: back) and `iclal` (no entry).
const FRONT_SUFFIX_WORDS: [&str; 28] = [
    "alkol", "bilal", "celal", "cemal", "dikkat", "final", "gol", "hakikat", "hal", "harf",
    "hayal", "hilal", "ikbal", "kabul", "kalp", "kemal", "kontrol", "kristal", "lokal", "metal",
    "nihal", "petrol", "protokol", "rol", "saat", "sembol", "sinyal", "usul",
];

fn is_vowel(c: char) -> bool {
    VOWELS.contains(c)
}

/// `c` lowercased the Turkish way (`I` → `ı`, `İ` → `i`).
fn lower_tr(c: char) -> char {
    match c {
        'I' => 'ı',
        'İ' => 'i',
        _ => c.to_lowercase().next().unwrap_or(c),
    }
}

/// How a letter is read when a word is spelled out (a vowel letter is read as itself).
fn letter_name(c: char) -> &'static str {
    match c {
        'a' => "a",
        'b' => "be",
        'c' => "ce",
        'ç' => "çe",
        'd' => "de",
        'e' => "e",
        'f' => "fe",
        'g' => "ge",
        'ğ' => "yumuşak ge",
        'h' => "he",
        'ı' => "ı",
        'i' => "i",
        'j' => "je",
        'k' => "ke",
        'l' => "le",
        'm' => "me",
        'n' => "ne",
        'o' => "o",
        'ö' => "ö",
        'p' => "pe",
        'q' => "kü",
        'r' => "re",
        's' => "se",
        'ş' => "şe",
        't' => "te",
        'u' => "u",
        'ü' => "ü",
        'v' | 'w' => "ve",
        'x' => "iks",
        'y' => "ye",
        'z' => "ze",
        _ => "",
    }
}

/// The last word of a number's Turkish reading (`54` → `dört`, `100` → `yüz`, `10^12` → `trilyon`).
/// Only the last 18 digits are read: a longer number is not supported.
fn number_tail(digits: &str) -> &'static str {
    const ONES: [&str; 10] = [
        "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz",
    ];
    const TENS: [&str; 10] = [
        "", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan",
    ];
    let tail = &digits[digits.len().saturating_sub(18)..];
    let n: u64 = tail.parse().unwrap_or(0);
    if n == 0 {
        "sıfır"
    } else if !n.is_multiple_of(10) {
        ONES[(n % 10) as usize]
    } else if !n.is_multiple_of(100) {
        TENS[((n / 10) % 10) as usize]
    } else if !n.is_multiple_of(1_000) {
        "yüz"
    } else if !n.is_multiple_of(1_000_000) {
        "bin"
    } else if !n.is_multiple_of(1_000_000_000) {
        "milyon"
    } else if !n.is_multiple_of(1_000_000_000_000) {
        "milyar"
    } else {
        "trilyon"
    }
}

/// Whether the last word `lower` (Turkish-lowercased, letters and digits only) takes the front
/// suffix although its last vowel is back: a word of [`FRONT_SUFFIX_WORDS`], or any word ending in
/// "âl" (İstiklâl'in, Hilâl'in).
fn takes_front_suffix(lower: &str) -> bool {
    FRONT_SUFFIX_WORDS.contains(&lower) || lower.ends_with("âl")
}

/// The last letter of a dotted acronym (`A.Ş.`, `T.C.`, `A.B.D.`; the last dot is optional): two or
/// more single letters, each followed by a dot. Anything else is not one.
fn dotted_acronym_last_letter(word: &str) -> Option<char> {
    let parts: Vec<&str> = word.trim_end_matches('.').split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let mut last = None;
    for part in parts {
        let mut chars = part.chars();
        let (Some(c), None) = (chars.next(), chars.next()) else {
            return None;
        };
        if !c.is_alphabetic() {
            return None;
        }
        last = Some(c);
    }
    last
}

/// How the end of `word` (a name's last word, which has a letter or a digit) is read aloud, and
/// whether its suffix is front although its last vowel is back: a dotted acronym by its last
/// letter's name, a trailing number by its reading, a word without vowels by its last letter's
/// name, any other word as written.
fn spoken_tail(word: &str) -> (String, bool) {
    if let Some(letter) = dotted_acronym_last_letter(word) {
        return (letter_name(lower_tr(letter)).to_owned(), false);
    }
    let core: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
    let digits: Vec<char> = core
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    if !digits.is_empty() {
        let digits: String = digits.into_iter().rev().collect();
        return (number_tail(&digits).to_owned(), false);
    }
    let lower: String = core.chars().map(lower_tr).collect();
    if lower.chars().any(is_vowel) {
        let front = takes_front_suffix(&lower);
        return (lower, front);
    }
    let spelled = lower
        .chars()
        .last()
        .map(letter_name)
        .unwrap_or_default()
        .to_owned();
    (spelled, false)
}

/// The genitive suffix of a word read as `spoken`: the last vowel picks it (a ı → ın, e i → in,
/// o u → un, ö ü → ün; `front` turns a ı → in and o u → ün), and a final vowel takes the buffer `n`.
fn genitive_suffix(spoken: &str, front: bool) -> &'static str {
    let ends_in_vowel = spoken.chars().last().is_some_and(is_vowel);
    let (bare, buffered) = match (spoken.chars().rev().find(|c| is_vowel(*c)), front) {
        (Some('a' | 'ı' | 'â'), false) => ("ın", "nın"),
        (Some('o' | 'u' | 'û'), false) => ("un", "nun"),
        (Some('ö' | 'ü'), _) | (Some('o' | 'u' | 'û'), true) => ("ün", "nün"),
        _ => ("in", "nin"),
    };
    if ends_in_vowel { buffered } else { bare }
}

/// `name` with its genitive suffix after an apostrophe: `Jeeta'nın`, `Atölye'nin`, `Ahmet'in`,
/// `THY'nin`, `A.Ş.'nin`, `Studio 54'ün`, `Kontrol'ün`. Blank → blank.
///
/// The name is its words joined by single spaces (so a newline inside it never reaches the spoken
/// sentence), up to its last word that holds a letter or a digit: a trailing word of symbols only
/// ("☕", "-", ".") is dropped. The suffix follows that last word as it is *spelled*:
///
/// - The last vowel decides (a ı → ın, e i → in, o u → un, ö ü → ün), a final vowel takes the buffer
///   `n`; capital `I` and `İ` are lowered the Turkish way.
/// - A short table of words that TDK's dictionary marks with a front suffix after a back vowel
///   (Kemal, Saat, Hal, Kalp, Kontrol, Petrol, Metal, Final, ...), matched whole, and any word
///   ending in "âl" take the front suffix: `Kemal'in`, `Kontrol'ün`, `İstiklâl'in`.
/// - A word without vowels is read by its last letter's name (`THY'nin`), a dotted acronym by the
///   name of its last letter (`A.Ş.'nin`, `T.C.'nin`), a trailing number by its Turkish reading
///   (`Studio 54'ün`, `Bina 100'ün`). A number of more than 18 digits is not supported (only its
///   last 18 digits are read).
///
/// Limits. An acronym that holds a vowel but has no dots (ABD, AKP, AVM, IBM) is read as a word, so
/// it gets `ABD'ın` where it is spoken "A-Be-De'nin"; a foreign or invented name pronounced
/// otherwise than spelled ("Apple") has the same problem. So has a word the table lacks: a compound
/// of a table word (Akpetrol), `İclal` (not in the dictionary) and `global` (listed without a front
/// mark) get `'ın`. An owner whose name is read otherwise writes the opening by hand in the call
/// policy.
pub fn genitive(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let Some(end) = words
        .iter()
        .rposition(|w| w.chars().any(char::is_alphanumeric))
    else {
        return String::new();
    };
    let shown = words[..=end].join(" ");
    let (spoken, front) = spoken_tail(words[end]);
    format!("{shown}'{}", genitive_suffix(&spoken, front))
}

/// The approved outbound opening: "Merhaba, ben {İşletme}'nın dijital asistanıyım."; `None` for a
/// blank name.
pub fn outbound_opening(business: &str) -> Option<String> {
    let g = genitive(business);
    (!g.is_empty()).then(|| format!("Merhaba, ben {g} dijital asistanıyım."))
}

/// The approved inbound greeting: the opening, then "Size nasıl yardımcı olabilirim?".
pub fn inbound_greeting(business: &str) -> Option<String> {
    outbound_opening(business).map(|o| format!("{o} Size nasıl yardımcı olabilirim?"))
}

/// The disclosure sentence both openings contain: "ben {İşletme}'nın dijital asistanıyım".
pub fn disclosure(business: &str) -> Option<String> {
    let g = genitive(business);
    (!g.is_empty()).then(|| format!("ben {g} dijital asistanıyım"))
}
