//! The workspace's own opening of an agent's call (owner decision 2026-10-29): the approved
//! sentences with the business's name in them, its genitive suffix fitted by Turkish vowel harmony.
//! The sentences are the owner's; the server only puts the workspace's own name in them.

/// Played after the opening on every agent call (owner-approved 2026-10-29).
pub const TRANSCRIPT_NOTICE: &str = "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.";

const VOWELS: &str = "aeıioöuüâîû";

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

/// How a letter is read when a word without vowels is spelled out.
fn letter_name(c: char) -> &'static str {
    match c {
        'b' => "be",
        'c' => "ce",
        'ç' => "çe",
        'd' => "de",
        'f' => "fe",
        'g' => "ge",
        'ğ' => "yumuşak ge",
        'h' => "he",
        'j' => "je",
        'k' => "ke",
        'l' => "le",
        'm' => "me",
        'n' => "ne",
        'p' => "pe",
        'q' => "kü",
        'r' => "re",
        's' => "se",
        'ş' => "şe",
        't' => "te",
        'v' | 'w' => "ve",
        'x' => "iks",
        'y' => "ye",
        'z' => "ze",
        _ => "",
    }
}

/// The last word of a number's Turkish reading (`54` → `dört`, `100` → `yüz`).
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
    } else {
        "milyar"
    }
}

/// How the end of `word` (letters and digits only) is read aloud: a trailing number by its
/// reading, a word without vowels by its last letter's name, any other word as written.
fn spoken_tail(word: &str) -> String {
    let digits: Vec<char> = word
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    if !digits.is_empty() {
        let digits: String = digits.into_iter().rev().collect();
        return number_tail(&digits).to_owned();
    }
    let lower: String = word.chars().map(lower_tr).collect();
    if lower.chars().any(is_vowel) {
        return lower;
    }
    lower
        .chars()
        .last()
        .map(letter_name)
        .unwrap_or_default()
        .to_owned()
}

/// The genitive suffix of a word read as `spoken`: the last vowel picks it (a ı → ın, e i → in,
/// o u → un, ö ü → ün), and a final vowel takes the buffer `n`.
fn genitive_suffix(spoken: &str) -> &'static str {
    let ends_in_vowel = spoken.chars().last().is_some_and(is_vowel);
    let (bare, buffered) = match spoken.chars().rev().find(|c| is_vowel(*c)) {
        Some('a' | 'ı' | 'â') => ("ın", "nın"),
        Some('o' | 'u' | 'û') => ("un", "nun"),
        Some('ö' | 'ü') => ("ün", "nün"),
        _ => ("in", "nin"),
    };
    if ends_in_vowel { buffered } else { bare }
}

/// `name` with its genitive suffix after an apostrophe: `Jeeta'nın`, `Atölye'nin`, `Ahmet'in`,
/// `THY'nin`, `Studio 54'ün`. The suffix follows the name's last word as it is spelled; a name
/// pronounced otherwise needs its opening written by hand in the call policy. Blank → blank.
pub fn genitive(name: &str) -> String {
    let name = name.trim();
    let Some(word) = name.split_whitespace().last() else {
        return String::new();
    };
    let core: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
    if core.is_empty() {
        return String::new();
    }
    format!("{name}'{}", genitive_suffix(&spoken_tail(&core)))
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
