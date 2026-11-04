//! What a reply's text holds, read the way a person evading a filter would write it: links (with or
//! without a scheme, a bare `label.tld`), email addresses and handles, and Turkish phone numbers.
//! Every check runs on [`normalised`] text, so spelled-out symbols (`at`, `(dot)`, `nokta`), digit
//! words (Turkish and English), keycap and full-width digits, Unicode spaces and dashes and
//! zero-width characters do not hide what is written.

/// `text` lower-cased, with zero-width characters removed, Unicode whitespace as a space, Unicode
/// dashes as `-`, keycap (`5️⃣`) and full-width digits as ASCII digits, full-width `＠` and `．` as
/// `@` and `.`; then, word by word, `at` / `(at)` / `[at]` as `@`, `dot` / `nokta` (bare or in
/// brackets) as `.`, both joined to their neighbours (`ayse at example dot com` reads
/// `ayse@example.com`), and the digit words `sıfır` … `dokuz` and `zero` … `nine` as digits.
pub(crate) fn normalised(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // Zero-width spaces and joiners, the word joiner, a byte-order mark; a keycap's
            // variation selector and enclosing keycap on their own.
            '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}' | '\u{fe0f}' | '\u{20e3}' => {}
            '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{fe58}' | '\u{fe63}' | '\u{ff0d}' => {
                plain.push('-')
            }
            '\u{ff10}'..='\u{ff19}' => {
                plain.push(char::from(b'0' + (u32::from(c) - 0xff10) as u8));
            }
            '\u{ff20}' => plain.push('@'),
            '\u{ff0e}' => plain.push('.'),
            c if c.is_whitespace() => plain.push(' '),
            c => {
                for lower in c.to_lowercase() {
                    // `İ` lower-cases to `i` and a combining dot above: keep the `i`.
                    if lower != '\u{307}' {
                        plain.push(lower);
                    }
                }
            }
        }
        // A keycap digit is the digit, an optional variation selector, the enclosing keycap.
        if c.is_ascii_digit() {
            if chars.peek() == Some(&'\u{fe0f}') {
                chars.next();
            }
            if chars.peek() == Some(&'\u{20e3}') {
                chars.next();
            }
        }
    }
    // Bracketed symbol words become plain words, which the word pass reads.
    for (bracketed, word) in [
        ("(at)", " at "),
        ("[at]", " at "),
        ("{at}", " at "),
        ("<at>", " at "),
        ("(dot)", " dot "),
        ("[dot]", " dot "),
        ("{dot}", " dot "),
        ("<dot>", " dot "),
        ("(nokta)", " nokta "),
        ("[nokta]", " nokta "),
        ("{nokta}", " nokta "),
        ("<nokta>", " nokta "),
    ] {
        plain = plain.replace(bracketed, word);
    }
    let mut out = String::with_capacity(plain.len());
    let mut glue_next = true;
    for word in plain.split(' ').filter(|w| !w.is_empty()) {
        let (lead, core, trail) = split_word(word);
        let symbol = match core {
            "at" | "@" if lead.is_empty() && trail.is_empty() => Some('@'),
            "dot" | "nokta" | "." if lead.is_empty() && trail.is_empty() => Some('.'),
            _ => None,
        };
        if let Some(symbol) = symbol {
            out.push(symbol);
            glue_next = true;
            continue;
        }
        if !glue_next {
            out.push(' ');
        }
        glue_next = false;
        out.push_str(lead);
        match digit_word(core) {
            Some(digit) => out.push(digit),
            None => out.push_str(core),
        }
        out.push_str(trail);
    }
    out
}

/// `word` as its leading non-alphanumerics, its alphanumeric core and its trailing rest.
fn split_word(word: &str) -> (&str, &str, &str) {
    let start = word
        .char_indices()
        .find(|(_, c)| c.is_alphanumeric())
        .map_or(word.len(), |(i, _)| i);
    let end = word[start..]
        .char_indices()
        .find(|(_, c)| !c.is_alphanumeric())
        .map_or(word.len(), |(i, _)| start + i);
    if start == word.len() {
        // No alphanumeric at all: the whole word is its core (a lone `@` or `.`).
        return ("", word, "");
    }
    (&word[..start], &word[start..end], &word[end..])
}

/// The digit a Turkish or English digit word stands for (lower case, with or without Turkish
/// letters).
fn digit_word(word: &str) -> Option<char> {
    Some(match word {
        "sıfır" | "sifir" | "zero" => '0',
        "bir" | "one" => '1',
        "iki" | "two" => '2',
        "üç" | "uç" | "üc" | "uc" | "three" => '3',
        "dört" | "dort" | "four" => '4',
        "beş" | "bes" | "five" => '5',
        "altı" | "alti" | "six" => '6',
        "yedi" | "seven" => '7',
        "sekiz" | "eight" => '8',
        "dokuz" | "nine" => '9',
        _ => return None,
    })
}

/// The top-level domains a bare `label.tld` is a link with: the common generic ones, Türkiye's,
/// and those of the link shorteners and messaging links people paste (`bit.ly`, `t.me`, `wa.me`,
/// `goo.gl`, `linktr.ee`, `youtu.be`, …).
const TLDS: &[&str] = &[
    "com", "net", "org", "tr", "io", "co", "me", "ly", "info", "biz", "shop", "store", "app",
    "link", "site", "online", "xyz", "ee", "be", "gl", "gd", "to", "tv", "us", "uk", "de", "eu",
    "ai", "dev", "page", "club", "top", "live", "blog", "art", "cc", "im", "gg", "la", "fm", "sh",
    "so", "bio", "website", "space", "tech", "market", "social", "ws",
];

/// The words of normalised text a link or an address is looked for in: split at whitespace and at
/// the punctuation that cannot be inside one.
fn words(norm: &str) -> impl Iterator<Item = &str> {
    norm.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ',' | ';'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '<'
                    | '>'
                    | '"'
                    | '\''
                    | '!'
                    | '?'
                    | '«'
                    | '»'
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
            )
    })
    .filter(|w| !w.is_empty())
}

/// Whether normalised text holds a web link: a scheme (`http://`, `https://`), `www.`, or a bare
/// host whose last label is one of [`TLDS`] (`magaza.com.tr`, `t.me/magaza`, `bit.ly/x`).
pub(crate) fn has_link(norm: &str) -> bool {
    if ["http://", "https://", "www."]
        .iter()
        .any(|marker| norm.contains(marker))
    {
        return true;
    }
    words(norm).any(|word| {
        if word.contains('@') {
            return false;
        }
        let host = word.split(['/', '?', '#', ':']).next().unwrap_or("");
        let host = host.trim_matches(|c: char| c == '.' || c == '-');
        let labels: Vec<&str> = host.split('.').collect();
        labels.len() >= 2
            && labels
                .iter()
                .all(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '-'))
            && labels[0].chars().any(char::is_alphanumeric)
            && TLDS.contains(&labels[labels.len() - 1])
    })
}

/// Whether normalised text holds something shaped like an email address: a word with an `@` that
/// has something before it and a dotted host after it.
pub(crate) fn has_email(norm: &str) -> bool {
    words(norm).any(|word| {
        word.split_once('@').is_some_and(|(local, domain)| {
            let domain = domain.trim_end_matches(['.', ':', '-']);
            !local.is_empty()
                && domain
                    .split_once('.')
                    .is_some_and(|(host, tld)| !host.is_empty() && !tld.is_empty())
        })
    })
}

/// Whether normalised text holds a handle: an `@` that starts a word (or follows a
/// non-alphanumeric) and is followed by at least two of letters, digits, `.` and `_`
/// (`@magazamiz`).
pub(crate) fn has_handle(norm: &str) -> bool {
    let chars: Vec<char> = norm.chars().collect();
    chars.iter().enumerate().any(|(i, c)| {
        *c == '@'
            && (i == 0 || !chars[i - 1].is_alphanumeric())
            && chars[i + 1..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || matches!(c, '.' | '_'))
                .count()
                >= 2
    })
}

/// The digit groups of each run of normalised text: a run is digits with any non-alphanumerics
/// between them (spaces, dots, dashes, brackets, slashes, a plus sign, emoji…), ended by a letter;
/// its groups are its maximal digit sequences.
pub(crate) fn digit_runs(norm: &str) -> Vec<Vec<String>> {
    let mut runs = Vec::new();
    let mut groups: Vec<String> = Vec::new();
    let mut group = String::new();
    for c in norm.chars() {
        if c.is_ascii_digit() {
            group.push(c);
            continue;
        }
        if !group.is_empty() {
            groups.push(std::mem::take(&mut group));
        }
        if c.is_alphanumeric() && !groups.is_empty() {
            runs.push(std::mem::take(&mut groups));
        }
    }
    if !group.is_empty() {
        groups.push(group);
    }
    if !groups.is_empty() {
        runs.push(groups);
    }
    runs
}

/// Whether `digits` is a Turkish phone number as written in full: a mobile number (`05xx…` or
/// `905xx…`), a landline (`0` or `90`, then `2`–`4`), an `0850`/`0800` line (or `90850`/`90800`),
/// eleven or twelve digits; or a `444` line, seven digits.
fn turkish_phone(digits: &str) -> bool {
    let with_zero = |rest: &str| {
        rest.starts_with('5')
            || rest.starts_with(['2', '3', '4'])
            || rest.starts_with("850")
            || rest.starts_with("800")
    };
    match digits.len() {
        11 => digits.strip_prefix('0').is_some_and(with_zero),
        12 => digits.strip_prefix("90").is_some_and(with_zero),
        7 => digits.starts_with("444"),
        _ => false,
    }
}

/// Whether normalised text holds a Turkish phone number: consecutive digit groups of one run,
/// from a group's start to a group's end, that together are [`turkish_phone`]. Sizes
/// (`36 38 40 42 44`), a barcode or a number without its leading `0` are not phone numbers.
pub(crate) fn has_phone_number(norm: &str) -> bool {
    for groups in digit_runs(norm) {
        for start in 0..groups.len() {
            let mut digits = String::new();
            for group in &groups[start..] {
                digits.push_str(group);
                if digits.len() > 12 {
                    break;
                }
                if turkish_phone(&digits) {
                    return true;
                }
            }
        }
    }
    false
}

/// Whether normalised text repeats `contact`: an email address anywhere; a phone number as a run
/// whose digits hold its last ten digits (its national number for `+90`), so that separators, a
/// leading `0` or a country code do not hide it.
pub(crate) fn repeats_contact(norm: &str, contact: &str) -> bool {
    if contact.contains('@') {
        return norm.contains(&contact.to_lowercase());
    }
    let digits: String = contact.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 7 {
        return false;
    }
    let national = &digits[digits.len().saturating_sub(10)..];
    digit_runs(norm)
        .iter()
        .any(|groups| groups.concat().contains(national))
}
