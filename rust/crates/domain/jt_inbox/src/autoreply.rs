//! The rules the server holds an automatic reply to, whatever the model wrote (the inbox's
//! automatic replies, `usecases::inbox::autoreply`): what a reply may say, what a quote must say,
//! which links it may carry and when the day's limits are reached. Pure: no I/O, no clock (the
//! calendar year is the caller's).
//!
//! The bias is to hand over: a wrong price reaching a customer is the costly error, a needless
//! hand-over only costs a person a look. So the rules are inverted where they can be: a text is
//! first normalised ([`normalise`]: NFKC, format characters removed, every decimal digit as ASCII,
//! Turkish lower case), then
//!
//! - **every digit sequence is refused** unless it is an allowed form ([`ALLOWED_FORMS`], which
//!   the model is told as they are, [`allowed_forms_prompt`]): a date, a clock time, a phone
//!   number, a count or a range of counts followed by an allowed unit (gün, saat, hafta, ay, cm,
//!   mm, adet …), a one-digit count before a count noun, an age (`5 yaşında`), the work's
//!   dimension (`3D`, `3 boyutlu`), a short number before `numara` (`10 numara`), a one-digit list
//!   number opening a line (`1.`, `2)`), a day before a month's name, or the bare current or
//!   next calendar year beside a month's name or before `yıl` and beside no price word; a range
//!   rises and its first end has no more digits than its second; a count of months stands beside
//!   no payment word; a number beside a currency is an amount whatever its form;
//! - **number words** that build an amount are refused: "bin" with any suffix, "buçuk" next to
//!   "bin" or "yüz", a number word before "yüz" (any suffix), "yüz" before a number word, a tens
//!   word with a case suffix ("elliye"); plain "yüz" (face) and "bir/iki/üç" before a noun stay;
//! - **the money lexicon** is refused, with any suffix: the currency words and symbols, indirim,
//!   iskonto, kdv, yüzde, %, bedava, beleş, ücretsiz, yarı fiyat, yarı yarıya, taksit, peşin,
//!   kapora, vade, ödeme, havale, nakit, iban, eft, hediye çeki.
//!
//! The lexicon and the number words are read as typed with or without Turkish letters
//! ([`stands_for`]: `ucretsiz`, `yuz`, `kirk` are `ücretsiz`, `yüz`, `kırk`), while a word written
//! with Turkish letters is read exactly as written.
//!
//! A reply ([`check_reply`]), and a hand-over's line, may hold none of it; [`refused_parts`] names
//! what a refused one held, word by word and by kind ([`PartKind`]). A quote
//! ([`check_quote`]) states its amount exactly once, next to its currency, and nothing else of it.
//! What the rules cannot list is left to a second, independent check by the model (the use case's
//! judge). A link (any `label.tld`, an IP address, an `xn--` name, anything with a scheme) is
//! allowed only when the cards hold the same host, and the same path when the text names one, as
//! a whole token ([`links_allowed`]).

use unicode_normalization::UnicodeNormalization;

/// The longest text of one automatic message, in characters.
pub const MAX_TEXT_CHARS: usize = 1_000;

/// Why the server turned down what the model answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The text is empty.
    EmptyText,
    /// The text is over [`MAX_TEXT_CHARS`].
    TextTooLong,
    /// A reply names money, a number or a term the rules do not allow.
    PriceWithoutQuote,
    /// The quote's amount is outside the owner's range.
    QuoteOutOfRange,
    /// The quote's text does not state its amount exactly once, or names something else of money.
    QuoteTextMismatch,
    /// The text carries a link the cards do not hold.
    LinkInReply,
}

impl Refusal {
    /// The stable code, e.g. `"price_without_quote"`.
    pub fn key(self) -> &'static str {
        match self {
            Refusal::EmptyText => "empty_text",
            Refusal::TextTooLong => "text_too_long",
            Refusal::PriceWithoutQuote => "price_without_quote",
            Refusal::QuoteOutOfRange => "quote_out_of_range",
            Refusal::QuoteTextMismatch => "quote_text_mismatch",
            Refusal::LinkInReply => "link_in_reply",
        }
    }
}

/// Whether a person's `text` states money, read generously (a person on the team writes a price
/// as "3500 olur" as often as "3.500 TL"): an amount, a currency, a word of the money and discount
/// lexicon, any number in no allowed form (a date, a clock time, a phone number and a count with
/// its unit are allowed), or "buçuk" next to a number word ("iki buçuk").
pub fn states_money(text: &str, year: i32) -> bool {
    let s = scan(text, year);
    if !(s.amounts.is_empty()
        && s.currency.is_empty()
        && s.terms.is_empty()
        && s.numbers.is_empty())
    {
        return true;
    }
    let words = words_of(text);
    words.iter().enumerate().any(|(i, w)| {
        starts(&w.stem, "buçuk")
            && (i.checked_sub(1).is_some_and(|p| is_number_word(&words[p]))
                || words.get(i + 1).is_some_and(is_number_word))
    })
}

/// The owner's price range, in minor units of its currency (both ends included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub min_minor: i64,
    pub max_minor: i64,
}

/// A reply the model wrote (or a hand-over's line), checked in calendar year `year`: its
/// length, no money, no number but an allowed form, only the cards' links.
pub fn check_reply(text: &str, cards: &str, year: i32) -> Result<(), Refusal> {
    check_reply_in(text, cards, year, Reading::Reply)
}

/// How a reply is read: as any reply, or while the customer is ordering (the order tool is
/// offered and collects card or bank transfer), when the payment method's words
/// ([`PAYMENT_METHOD_STEMS`]) are allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    Reply,
    Ordering,
}

/// [`check_reply`] read as `reading` says.
pub fn check_reply_in(text: &str, cards: &str, year: i32, reading: Reading) -> Result<(), Refusal> {
    check_text(text, cards)?;
    if !scan_in(text, year, reading).clean() {
        return Err(Refusal::PriceWithoutQuote);
    }
    Ok(())
}

/// A quote of `amount` whole currency units with its `text`, checked against `range` in calendar
/// year `year`: answers the amount in minor units. The amount is within the range; the text
/// states it exactly once, next to a currency word or symbol, and holds nothing else the reply
/// rules refuse (a currency word is allowed only beside that amount).
pub fn check_quote(
    amount: i64,
    text: &str,
    range: Range,
    cards: &str,
    year: i32,
) -> Result<i64, Refusal> {
    let minor = amount
        .checked_mul(100)
        .filter(|m| (range.min_minor..=range.max_minor).contains(m))
        .ok_or(Refusal::QuoteOutOfRange)?;
    check_text(text, cards)?;
    let s = scan(text, year);
    let [(at, stated)] = s.amounts.as_slice() else {
        return Err(Refusal::QuoteTextMismatch);
    };
    let beside = |i: &usize| *i == *at || *i + 1 == *at || *i == *at + 1;
    if *stated != minor
        || !s.terms.is_empty()
        || !s.numbers.is_empty()
        || !s.currency.iter().all(beside)
    {
        return Err(Refusal::QuoteTextMismatch);
    }
    Ok(minor)
}

/// The length and the links of any automatic text.
fn check_text(text: &str, cards: &str) -> Result<(), Refusal> {
    let n = text.trim().chars().count();
    if n == 0 {
        return Err(Refusal::EmptyText);
    }
    if n > MAX_TEXT_CHARS {
        return Err(Refusal::TextTooLong);
    }
    if !links_allowed(text, cards) {
        return Err(Refusal::LinkInReply);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The allowed forms, as the model is told them
// ---------------------------------------------------------------------------------------------

/// A form a number may take in a reply ([`scan`]): what it is, as the model is told, and
/// examples the rules let through (a test holds every example to [`check_reply`]). `{units}` and
/// `{nouns}` in `what` stand for the rules' own lists ([`allowed_forms_prompt`]).
#[derive(Clone, Copy, Debug)]
pub struct AllowedForm {
    pub what: &'static str,
    pub examples: &'static [&'static str],
}

/// Every form a number may take in a reply or a hand-over's line: anything else is refused.
pub const ALLOWED_FORMS: &[AllowedForm] = &[
    AllowedForm {
        what: "a date or a clock time, or a day before a month's name",
        examples: &["21.11", "21.11.2026", "14:30", "15 Aralık"],
    },
    AllowedForm {
        what: "a count, or a range of counts, right before its unit ({units}); months only up to 24",
        examples: &[
            "7 gün",
            "3-5 iş günü",
            "2 hafta",
            "15 cm",
            "15-20 cm",
            "15 ile 20 cm",
            "2 adet",
        ],
    },
    AllowedForm {
        what: "a one-digit count, or two of them, right before what is counted ({nouns})",
        examples: &["2 fotoğraf", "2-3 fotoğraf", "2 ya da 3 fotoğraf", "2 tane"],
    },
    AllowedForm {
        what: "an age: one or two digits right before `yaş` in any form",
        examples: &["5 yaşında", "12 yaşındaki", "3-5 yaş"],
    },
    AllowedForm {
        what: "the work's dimension",
        examples: &["3D", "2D", "3B", "3 boyutlu"],
    },
    AllowedForm {
        what: "one or two digits right before `numara` in any form, such as a jersey's number",
        examples: &["10 numara", "7 numaralı"],
    },
    AllowedForm {
        what: "a one-digit list number opening a line, the line's words after it",
        examples: &["1. Kaç kişilik olsun?", "2) Boyu ne kadar olsun?"],
    },
    AllowedForm {
        what: "a full phone number, or the current or next year beside a month's name or before \
               `yıl`, only as the cards give them",
        examples: &[],
    },
];

/// The model's instruction on numbers, made from [`ALLOWED_FORMS`] and the rules' own lists, so
/// what the model is told and what the rules let through cannot part.
pub fn allowed_forms_prompt() -> String {
    let units: Vec<&str> = UNITS.iter().chain(UNITS_EXACT).copied().collect();
    let mut out = String::from(
        "Digits in a `reply` (and in a hand-over's line) are allowed only in these forms; the \
         server refuses anything else and the message is not sent:\n",
    );
    for form in ALLOWED_FORMS {
        let what = form
            .what
            .replace("{units}", &units.join(", "))
            .replace("{nouns}", &COUNT_NOUNS.join(", "));
        out.push_str("  - ");
        out.push_str(&what);
        if !form.examples.is_empty() {
            let examples: Vec<String> = form.examples.iter().map(|e| format!("`{e}`")).collect();
            out.push_str(": ");
            out.push_str(&examples.join(", "));
        }
        out.push('\n');
    }
    out.push_str(
        "  Write every other number in words. A number next to a currency, a discount or a \
         payment word is a price, whatever its form.",
    );
    out
}

// ---------------------------------------------------------------------------------------------
// What a refused text held
// ---------------------------------------------------------------------------------------------

/// What kind of thing a part of a text the reply rules refuse is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PartKind {
    /// A digit sequence in no allowed form ([`ALLOWED_FORMS`]).
    Number,
    /// A number beside a currency.
    Amount,
    /// A currency word, code or symbol.
    Currency,
    /// Number words that build an amount (`bin`, `elliye`, `dokuz yüz`).
    NumberWord,
    /// A word of the money, discount and payment lexicon (indirim, taksit, kapora …), or a word
    /// written in mixed scripts.
    Term,
    /// A link the cards do not hold.
    Link,
}

impl PartKind {
    /// The stable code, e.g. `"number"`.
    pub fn key(self) -> &'static str {
        match self {
            PartKind::Number => "number",
            PartKind::Amount => "amount",
            PartKind::Currency => "currency",
            PartKind::NumberWord => "number_word",
            PartKind::Term => "term",
            PartKind::Link => "link",
        }
    }
}

/// One part of a text the reply rules refuse: its kind, and its word as the rules read it
/// (normalised, without the punctuation around it), or a link's host and path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefusedPart {
    pub kind: PartKind,
    pub text: String,
}

/// What of `text` the reply rules ([`check_reply`]) refuse, read in calendar year `year` with the
/// cards' text `cards`: its numbers, amounts, currency words, number words and terms in the order
/// they are written, then its links the cards lack; each (kind, word) once. Empty for a text the
/// rules pass (and for one refused only for its length).
pub fn refused_parts(text: &str, cards: &str, year: i32) -> Vec<RefusedPart> {
    refused_parts_in(text, cards, year, Reading::Reply)
}

/// [`refused_parts`] read as `reading` says ([`check_reply_in`]).
pub fn refused_parts_in(text: &str, cards: &str, year: i32, reading: Reading) -> Vec<RefusedPart> {
    let words = words_of(text);
    let s = scan_in(text, year, reading);
    let mut at: Vec<(usize, PartKind)> = Vec::new();
    at.extend(s.amounts.iter().map(|(i, _)| (*i, PartKind::Amount)));
    at.extend(s.currency.iter().map(|i| (*i, PartKind::Currency)));
    at.extend(s.numbers.iter().map(|i| (*i, PartKind::Number)));
    at.extend(s.terms.iter().map(|i| {
        let kind = if s.number_words.contains(i) {
            PartKind::NumberWord
        } else {
            PartKind::Term
        };
        (*i, kind)
    }));
    at.sort();
    at.dedup();
    // A word refused as money (`%10`, `950₺`) is named as that, not as a number too.
    let named: Vec<usize> = at
        .iter()
        .filter(|(_, k)| *k != PartKind::Number)
        .map(|(i, _)| *i)
        .collect();
    at.retain(|(i, k)| *k != PartKind::Number || !named.contains(i));
    let mut out: Vec<RefusedPart> = Vec::new();
    let mut push = |kind: PartKind, text: String| {
        if !out.iter().any(|p| p.kind == kind && p.text == text) {
            out.push(RefusedPart { kind, text });
        }
    };
    for (i, kind) in at {
        if let Some(w) = words.get(i) {
            push(kind, w.text.clone());
        }
    }
    let known = links_in(cards);
    for l in links_in(text) {
        if !link_known(&known, &l) {
            push(PartKind::Link, format!("{}{}", l.host, l.path));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------------------------

/// The first code point of each block of ten Unicode decimal digits (general category `Nd`)
/// beyond what NFKC already maps (full-width digits, mathematical digits).
const DIGIT_ZEROS: &[u32] = &[
    0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66,
    0x0DE6, 0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10,
    0x104A0, 0x10D30, 0x11066, 0x110F0, 0x11136, 0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650,
    0x116C0, 0x11730, 0x118E0, 0x11950, 0x11C50, 0x11D50, 0x11DA0, 0x16A60, 0x16AC0, 0x16B50,
    0x1E140, 0x1E2F0, 0x1E950, 0x1FBF0,
];

/// `c` as an ASCII digit when it is a decimal digit of another script.
fn ascii_digit(c: char) -> Option<char> {
    let cp = c as u32;
    DIGIT_ZEROS
        .iter()
        .find(|z| (**z..*z + 10).contains(&cp))
        .and_then(|z| char::from_digit(cp - z, 10))
}

/// Whether `c` is a format character (zero-width spaces and joiners, direction marks, the soft
/// hyphen, the byte-order mark and the like): removed.
fn format_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD | 0x061C | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064
            | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB
    )
}

/// `text` as the rules read it: NFKC, format characters removed, every decimal digit as its ASCII
/// digit, every dash and the minus sign as `-` (`15–20` is `15-20`), other spaces as a plain
/// space, and Turkish lower case (`I` → `ı`, `İ` → `i`).
pub fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.nfkc() {
        if format_char(c) {
            continue;
        }
        let c = ascii_digit(c).unwrap_or(c);
        match c {
            'I' => out.push('ı'),
            'İ' => out.push('i'),
            '\u{2010}'..='\u{2015}' | '\u{2212}' => out.push('-'),
            c if c.is_whitespace() => out.push(' '),
            c => out.extend(c.to_lowercase()),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

/// What [`scan`] found in a text, by word position.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    /// Numbers that read as amounts (next to a currency), in minor units.
    pub amounts: Vec<(usize, i64)>,
    /// Where a currency word or symbol stands.
    pub currency: Vec<usize>,
    /// Digit sequences in no allowed form.
    pub numbers: Vec<usize>,
    /// Number words that build an amount, and the money and discount lexicon.
    pub terms: Vec<usize>,
    /// Which of `terms` are number words that build an amount (`bin`, `elliye`).
    pub number_words: Vec<usize>,
}

impl Scan {
    /// Whether the text holds nothing of money and no number but an allowed form.
    pub fn clean(&self) -> bool {
        self.amounts.is_empty()
            && self.currency.is_empty()
            && self.numbers.is_empty()
            && self.terms.is_empty()
    }
}

/// One word: its text without surrounding punctuation, its stem (before an apostrophe suffix:
/// `2750'ye` → `2750`, `tl'dir` → `tl`), whether it had such a suffix, and whether it is a list
/// number ([`list_number`]) opening a line that has more words.
#[derive(Clone, Debug)]
struct Word {
    text: String,
    stem: String,
    suffixed: bool,
    marker: bool,
}

/// What a text's lines are split at (every other space is a plain space).
const LINE_BREAKS: &[char] = &[
    '\n', '\r', '\u{0B}', '\u{0C}', '\u{85}', '\u{2028}', '\u{2029}',
];

/// `raw` (a token as normalised, before its punctuation is trimmed) as a list number: one digit
/// from 1 to 9 and one `.` or `)`, nothing else (`1.`, `2)`).
fn list_number(raw: &str) -> bool {
    matches!(raw.as_bytes(), [b'1'..=b'9', b'.' | b')'])
}

fn words_of(text: &str) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    for line in text.split(LINE_BREAKS) {
        let start = out.len();
        for (n, raw) in normalise(line)
            .split(' ')
            .filter(|raw| !raw.is_empty())
            .enumerate()
        {
            let t = raw
                .trim_matches(|c: char| "()[]{}<>\"«»“”‘,;:!?…*_".contains(c))
                .trim_end_matches('.')
                .to_owned();
            if t.is_empty() {
                continue;
            }
            let mut parts = t.splitn(2, ['\'', '’']);
            let stem = parts.next().unwrap_or_default().to_owned();
            let suffixed = parts.next().is_some();
            out.push(Word {
                text: t,
                stem,
                suffixed,
                marker: n == 0 && list_number(raw),
            });
        }
        // A list number stands before its line's own words, never alone on a line.
        if out.len() - start < 2
            && let Some(w) = out.get_mut(start)
        {
            w.marker = false;
        }
    }
    out
}

const NUMBER_WORDS: &[&str] = &[
    "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "yirmi",
    "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan",
];
/// Tens words: with a case suffix (`elliye`, `otuza`) they are an amount on their own.
const TENS: &[&str] = &[
    "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan",
];
/// What may follow "bin", "yüz" or a tens word to make it an amount (`bine`, `binlik`, `yüze`).
const NUMBER_SUFFIXES: &[&str] = &[
    "", "e", "i", "ı", "in", "ın", "de", "da", "den", "dan", "le", "la", "lik", "lık", "lük",
    "luk", "ler", "lar", "lerce", "ye", "ya", "a", "ü", "ün", "ü", "te", "ta", "ten", "tan",
    "likler", "lıklar", "dir", "dır",
];
/// Currency codes, as a whole stem.
const CURRENCY_CODES: &[&str] = &["tl", "try", "usd", "eur", "gbp", "ytl"];
/// Currency words, with any suffix.
const CURRENCY_STEMS: &[&str] = &["lira", "dolar", "euro", "avro", "sterlin", "kuruş"];
/// Money and discount words, with any suffix (English ones too).
const TERM_STEMS: &[&str] = &[
    "indirim",
    "iskonto",
    "kdv",
    "yüzde",
    "bedava",
    "beleş",
    "ücretsiz",
    "taksit",
    "peşin",
    "kapora",
    "vade",
    "ödeme",
    "havale",
    "nakit",
    "iban",
    "free",
    "discount",
    "percent",
];
/// The payment method's words, allowed in a reply while the customer is ordering
/// ([`Reading::Ordering`]), with `eft`: the order tool asks for card or bank transfer.
pub const PAYMENT_METHOD_STEMS: &[&str] = &["havale", "ödeme"];
/// Money and payment words, as a whole stem (`EFT'yle`).
const TERM_EXACT: &[&str] = &["eft"];
/// The months, by a stem the word starts with: a year beside one reads as a date.
const MONTHS: &[&str] = &[
    "ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim",
    "kasım", "aralık",
];
/// Words beside which a bare number is a price (`Fiyatı 2026`, `2027 olur`).
const PRICE_WORDS: &[&str] = &["fiyat", "ücret", "tutar", "olur"];
/// Words after which "hediye" (a gift) is a free item.
const GIFT_AFTER: &[&str] = &["ikincisi", "ikinci", "üçüncü", "üçüncüsü", "yanında"];
/// Units a count is allowed with: a stem the next word starts with.
const UNITS: &[&str] = &[
    "gün", "saat", "hafta", "dakika", "adet", "kişi", "parça", "santim", "metre",
];
/// Units a count is allowed with: the next word exactly (with an apostrophe suffix at most).
const UNITS_EXACT: &[&str] = &[
    "ay", "aylık", "ayda", "cm", "mm", "m", "dk", "sn", "kg", "gr",
];
/// The nouns a one-digit count, or a one-digit range (`2-3`, `2 ya da 3`), may stand before
/// (`2-3 fotoğraf`): a stem the next word starts with.
const COUNT_NOUNS: &[&str] = &[
    "fotoğraf",
    "foto",
    "görsel",
    "açı",
    "kişi",
    "figür",
    "adet",
    "parça",
    "renk",
    "seçenek",
    "örnek",
    "gün",
    "hafta",
    "saat",
    "tane",
];
/// Units that may be glued to a count (`15cm`).
const GLUED_UNITS: &[&str] = &["cm", "mm", "m", "kg", "gr", "dk"];

/// What a Turkish letter is typed as on a keyboard without it.
fn plain(c: char) -> char {
    match c {
        'ç' => 'c',
        'ğ' => 'g',
        'ı' => 'i',
        'ö' => 'o',
        'ş' => 's',
        'ü' => 'u',
        c => c,
    }
}

/// Whether `w`, a letter as written, may stand for `t`, a letter of a word of the rules: the
/// same letter, the plain letter typed for a Turkish one (`u` for `ü`, `s` for `ş`), or `ı` for
/// `i` (a capital `I` typed for `İ`, which reads as `ı`). A Turkish letter stands only for
/// itself, so a word written with Turkish letters is read exactly as before (`ön` is never `on`).
fn stands_for(w: char, t: char) -> bool {
    w == t || (w.is_ascii() && plain(t) == w) || (w == 'ı' && t == 'i')
}

/// `word` read as starting with `prefix`, letter by letter ([`stands_for`]): what follows it.
fn strip<'a>(word: &'a str, prefix: &str) -> Option<&'a str> {
    let mut at = 0;
    let mut letters = word.chars();
    for t in prefix.chars() {
        let w = letters.next()?;
        if !stands_for(w, t) {
            return None;
        }
        at += w.len_utf8();
    }
    Some(&word[at..])
}

/// Whether `word` starts with `prefix`, read as [`strip`] reads it.
fn starts(word: &str, prefix: &str) -> bool {
    strip(word, prefix).is_some()
}

/// Whether `word` is `target`, read as [`strip`] reads it.
fn is(word: &str, target: &str) -> bool {
    strip(word, target) == Some("")
}

fn is_any(word: &str, targets: &[&str]) -> bool {
    targets.iter().any(|t| is(word, t))
}

fn starts_any(word: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| starts(word, p))
}

/// `stem` is `base` followed by one of [`NUMBER_SUFFIXES`].
fn with_suffix(stem: &str, base: &str) -> bool {
    strip(stem, base).is_some_and(|rest| is_any(rest, NUMBER_SUFFIXES))
}

/// "bin" (a thousand) in any form (`bine`, `binliğe`, `biner`): every word starting so but
/// "bina" (a building) and its forms. "milyon" likewise.
fn is_bin(w: &Word) -> bool {
    (starts(&w.stem, "bin") && !starts(&w.stem, "bina")) || starts(&w.stem, "milyon")
}

fn is_yuz(w: &Word) -> bool {
    with_suffix(&w.stem, "yüz") || starts(&w.stem, "yüzlü")
}

/// The distributive forms of the numbers (`kırkar`, `beşer`, `yüzer`): an amount each.
const DISTRIBUTIVE: &[&str] = &[
    "birer",
    "ikişer",
    "üçer",
    "dörder",
    "beşer",
    "altışar",
    "yedişer",
    "sekizer",
    "dokuzar",
    "onar",
    "yirmişer",
    "otuzar",
    "kırkar",
    "ellişer",
    "altmışar",
    "yetmişer",
    "seksener",
    "doksanar",
    "yüzer",
    "biner",
];

/// Whether `stem` is two or more number words glued together (`üçbin`, `dokuzyüzelli`),
/// optionally with a case suffix (`dokuzyüzelliye`).
fn glued_number_words(stem: &str) -> bool {
    const PARTS: &[&str] = &[
        "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on",
        "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan", "yüz", "bin",
        "milyon",
    ];
    fn go(rest: &str, parts: usize) -> bool {
        if parts >= 2 && is_any(rest, NUMBER_SUFFIXES) {
            return true;
        }
        PARTS
            .iter()
            .any(|p| strip(rest, p).is_some_and(|r| go(r, parts + 1)))
    }
    go(stem, 0)
}

/// Whether `c` is a letter of the Latin script (the Turkish letters included).
fn latin(c: char) -> bool {
    c.is_ascii_alphabetic() || matches!(c as u32, 0x00C0..=0x024F | 0x1E00..=0x1EFF)
}

/// A word mixing Latin letters with letters of another script (a disguise: `ТL`, `lіra`).
fn mixed_script(w: &Word) -> bool {
    w.text.chars().any(latin) && w.text.chars().any(|c| c.is_alphabetic() && !latin(c))
}

fn is_number_word(w: &Word) -> bool {
    is_any(&w.stem, NUMBER_WORDS)
}

fn is_currency(w: &Word) -> bool {
    w.text.contains(['₺', '$', '€', '£'])
        || is_any(&w.stem, CURRENCY_CODES)
        || starts_any(&w.stem, CURRENCY_STEMS)
}

fn is_term(w: &Word) -> bool {
    // `vadetmek` (to promise: `vadediyoruz`) is no `vade` (a payment's term).
    let promise = starts(&w.stem, "vadet") || starts(&w.stem, "vaded");
    w.text.contains('%')
        || TERM_STEMS
            .iter()
            .any(|s| starts(&w.stem, s) && !(*s == "vade" && promise))
        || is_any(&w.stem, TERM_EXACT)
}

/// Whether `w` is a word beside which a bare number is a price ([`PRICE_WORDS`]).
fn is_price_word(w: &Word) -> bool {
    starts_any(&w.stem, PRICE_WORDS)
}

fn is_unit(w: &Word) -> bool {
    UNITS.iter().any(|u| w.stem.starts_with(u)) || UNITS_EXACT.contains(&w.stem.as_str())
}

/// `s` as a date (`21.11.2026`, `21/11/26`, `21.11`, `21/11`) or a clock time (`14.30`, `14:30`).
fn date_or_time(s: &str) -> bool {
    let parts: Vec<&str> = s.split(['.', '/', ':']).collect();
    if parts.len() < 2
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let n = |p: &str| p.parse::<u32>().ok();
    match parts.as_slice() {
        [d, m, y] => {
            d.len() <= 2
                && m.len() <= 2
                && matches!((n(d), n(m)), (Some(1..=31), Some(1..=12)))
                && (y.len() == 2 || y.len() == 4)
        }
        [a, b] if a.len() <= 2 && b.len() == 2 => {
            matches!((n(a), n(b)), (Some(1..=31), Some(1..=12)))
                || matches!((n(a), n(b)), (Some(0..=23), Some(0..=59)))
        }
        [a, b] if a.len() <= 2 && b.len() == 1 && s.contains('/') => {
            matches!((n(a), n(b)), (Some(1..=31), Some(1..=9)))
        }
        _ => false,
    }
}

/// The fewest digits a phone number has in all, its groups together.
const PHONE_DIGITS: usize = 10;

/// `s` (digits, an optional leading `+`) as the start of a phone number: `+` and a country code,
/// or a number of four digits or more beginning with `0` (prices never do); it is one only when
/// its groups reach [`PHONE_DIGITS`] digits.
fn phone_start(s: &str) -> bool {
    let digits = s.chars().filter(char::is_ascii_digit).count();
    s.chars().all(|c| c.is_ascii_digit() || c == '+')
        && ((s.starts_with('+') && digits >= 2) || (s.starts_with('0') && digits >= 4))
}

/// `token` (digits and `.` `,` separators) as (whole units, kuruş).
fn parse_amount(token: &str) -> Option<(i64, i64)> {
    let groups: Vec<&str> = token.split(['.', ',']).collect();
    if groups
        .iter()
        .any(|g| g.is_empty() || !g.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let (whole_groups, kurus) = match groups.as_slice() {
        [.., last] if groups.len() > 1 && (1..=2).contains(&last.len()) => {
            let k: i64 = last.parse().ok()?;
            let k = if last.len() == 1 { k * 10 } else { k };
            (&groups[..groups.len() - 1], k)
        }
        _ => (&groups[..], 0),
    };
    let value: i64 = whole_groups.concat().parse().ok()?;
    Some((value, kurus))
}

/// `stem` (a currency symbol before it taken off) as its number and what is glued after it:
/// `15cm` → (`15`, `cm`), `3d` → (`3`, `d`), `2.` → (`2`, ``).
fn split_number(stem: &str) -> (&str, &str) {
    let split = stem
        .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | ',' | '/' | ':' | '+' | '-')))
        .unwrap_or(stem.len());
    let (num, glued) = stem.split_at(split);
    (num.trim_end_matches(['.', ',', '-']), glued)
}

/// `p` as one count: at most four digits with at most one decimal separator inside (`2.5`).
fn count_part(p: &str) -> bool {
    let digits = p.chars().filter(char::is_ascii_digit).count();
    let separators = p.chars().filter(|c| matches!(c, '.' | ',')).count();
    (1..=4).contains(&digits)
        && separators <= 1
        && !p.starts_with(['.', ','])
        && p.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ','))
}

/// `num` as one value or a range of two (`3-5`), each `part`: a range rises (`3500-7` is a price
/// and a count) and its first end has no more whole digits than its second.
fn range_of(num: &str, part: fn(&str) -> bool) -> bool {
    match num.split('-').collect::<Vec<_>>().as_slice() {
        [one] => part(one),
        [a, b] => part(a) && part(b) && rising(a, b),
        _ => false,
    }
}

/// Whether `a` is less than `b` (decimals with `.` or `,`), with no more whole digits.
fn rising(a: &str, b: &str) -> bool {
    let value = |p: &str| p.replace(',', ".").parse::<f64>().ok();
    let whole = |p: &str| p.split(['.', ',']).next().map_or(0, str::len);
    // `3.500` is three thousand five hundred, never three and a half.
    let thousands = |p: &str| p.split(['.', ',']).nth(1).is_some_and(|f| f.len() >= 3);
    matches!((value(a), value(b)), (Some(x), Some(y)) if x < y)
        && whole(a) <= whole(b)
        && !thousands(a)
        && !thousands(b)
}

/// `p` as an age: one or two digits, the first not `0`.
fn age_part(p: &str) -> bool {
    matches!(p.as_bytes(), [b'1'..=b'9'] | [b'1'..=b'9', b'0'..=b'9'])
}

/// Whether the word after `words[j]` is `yaş` in any form (`yaşında`, `yaşındaki`).
fn age_after(words: &[Word], j: usize) -> bool {
    words.get(j + 1).is_some_and(|n| n.stem.starts_with("yaş"))
}

/// Whether the count `num` at `words[j]` stands before an allowed unit ([`UNITS`],
/// [`UNITS_EXACT`], `iş günü`); a count of months only up to 24 (`36 ay` is a price's
/// instalments), and never beside a payment word.
fn unit_after(words: &[Word], j: usize, num: &str) -> bool {
    let next = words.get(j + 1);
    // A count of months beside a payment word is a price's term (`12 ay vadeli`, `2 ayda bir
    // ödeme`).
    let payment = (j + 2..=j + 3).any(|k| words.get(k).is_some_and(is_term));
    let months = next.is_some_and(|n| n.stem.starts_with("ay"))
        && (payment || !num.parse::<u32>().is_ok_and(|n| n <= 24));
    (next.is_some_and(is_unit) && !months)
        || (next.is_some_and(|n| n.stem == "iş")
            && words.get(j + 2).is_some_and(|n| n.stem.starts_with("gün")))
}

/// What `text` says, read in calendar year `year` (see the module docs and [`Scan`]).
pub fn scan(text: &str, year: i32) -> Scan {
    scan_in(text, year, Reading::Reply)
}

/// [`scan`] read as `reading` says: while ordering, the payment method's words are no terms.
fn scan_in(text: &str, year: i32, reading: Reading) -> Scan {
    let words = words_of(text);
    let mut out = Scan::default();
    // The phone number being read: its words and its digits so far.
    let mut phone: Vec<usize> = Vec::new();
    let mut phone_digits = 0;
    let end_phone = |out: &mut Scan, phone: &mut Vec<usize>, digits: &mut usize| {
        if !phone.is_empty() && *digits < PHONE_DIGITS {
            out.numbers.append(phone);
        }
        phone.clear();
        *digits = 0;
    };
    for (i, w) in words.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| &words[p]);
        let next = words.get(i + 1);
        let after_next = words.get(i + 2);
        // The lexicon.
        if is_currency(w) {
            out.currency.push(i);
        }
        let method = reading == Reading::Ordering
            && (starts_any(&w.stem, PAYMENT_METHOD_STEMS) || is(&w.stem, "eft"));
        if (is_term(w) && !method)
            || mixed_script(w)
            || (is(&w.stem, "yarı")
                && next.is_some_and(|n| starts(&n.stem, "fiyat") || starts(&n.stem, "yarı")))
            || starts(&w.stem, "yarısı")
            || is(&w.stem, "yarıya")
            || (starts(&w.stem, "hediye")
                && (next.is_some_and(|n| starts(&n.stem, "çek"))
                    || prev.is_some_and(|p| is_any(&p.stem, GIFT_AFTER))))
            || (is(&w.stem, "bizden")
                && prev.is_some_and(|p| starts(&p.stem, "kargo") || is(&p.stem, "ikincisi")))
            || (w.stem == "half" && next.is_some_and(|n| n.stem.starts_with("price")))
        {
            out.terms.push(i);
        }
        // Number words.
        let tens_suffixed = TENS
            .iter()
            .any(|t| !is(&w.stem, t) && with_suffix(&w.stem, t));
        if is_bin(w)
            || tens_suffixed
            || is_any(&w.stem, DISTRIBUTIVE)
            || starts(&w.stem, "yüzlü")
            || glued_number_words(&w.stem)
            || (is(&w.stem, "buçuk")
                && (prev.is_some_and(|p| is_bin(p) || is_yuz(p))
                    || next.is_some_and(|n| is_bin(n) || is_yuz(n))))
            || (is_number_word(w) && next.is_some_and(is_yuz))
            || (is_yuz(w) && next.is_some_and(|n| is_number_word(n) || is_bin(n)))
        {
            out.terms.push(i);
            out.number_words.push(i);
        }
        // Digits: refused unless an allowed form.
        if !w.text.chars().any(|c| c.is_ascii_digit() || c.is_numeric()) {
            end_phone(&mut out, &mut phone, &mut phone_digits);
            continue;
        }
        let symbol_before = w.stem.starts_with(['₺', '$', '€', '£']);
        let stem = w.stem.trim_start_matches(['₺', '$', '€', '£']);
        let (num, glued) = split_number(stem);
        if num.is_empty() || !num.is_ascii() {
            out.numbers.push(i);
            end_phone(&mut out, &mut phone, &mut phone_digits);
            continue;
        }
        let digits_only = num.chars().all(|c| c.is_ascii_digit());
        let digits = num.chars().filter(char::is_ascii_digit).count();
        if !phone.is_empty() && glued.is_empty() && digits_only && (2..=4).contains(&num.len()) {
            phone.push(i);
            phone_digits += digits;
            continue;
        }
        end_phone(&mut out, &mut phone, &mut phone_digits);
        if glued.is_empty() && phone_start(num) {
            phone.push(i);
            phone_digits = digits;
            continue;
        }
        let glued_currency = matches!(glued, "tl" | "try" | "₺" | "$" | "€");
        let money = symbol_before || glued_currency || next.is_some_and(is_currency);
        if money {
            match parse_amount(num) {
                Some((whole, kurus)) => out
                    .amounts
                    .push((i, whole.saturating_mul(100).saturating_add(kurus))),
                None => out.numbers.push(i),
            }
            continue;
        }
        if glued.is_empty() && date_or_time(num) {
            continue;
        }
        let bare = glued.is_empty() && !w.suffixed;
        // A list number opening a line (`1.`, `2)`): [`words_of`] marks it.
        if w.marker && bare {
            continue;
        }
        // The work's dimension: `2D`, `3D` (`3D'li`), `2B`, `3B`, `3 boyutlu`.
        if matches!(num, "2" | "3")
            && (matches!(glued, "d" | "b")
                || (bare && next.is_some_and(|n| n.stem.starts_with("boyut"))))
        {
            continue;
        }
        // An age, or a range of two, before `yaş` in any form (`5 yaşında`, `3-5 yaş`).
        if bare && range_of(num, age_part) && age_after(&words, i) {
            continue;
        }
        // One or two digits before `numara` in any form (`10 numara`, `7 numaralı`).
        if bare
            && digits_only
            && num.len() <= 2
            && next.is_some_and(|n| n.stem.starts_with("numara"))
        {
            continue;
        }
        // A day of the month before a month's name (`15 Aralık`).
        if bare
            && digits_only
            && num.len() <= 2
            && num.parse::<u32>().is_ok_and(|d| (1..=31).contains(&d))
            && next.is_some_and(|n| starts_any(&n.stem, MONTHS))
        {
            continue;
        }
        // A count, or a range of counts (`3-5`), before an allowed unit or with one glued.
        if range_of(num, count_part)
            && ((glued.is_empty() && unit_after(&words, i, num)) || GLUED_UNITS.contains(&glued))
        {
            continue;
        }
        // A range written with words between its ends (`15 ile 20 cm`, `15 - 20 cm`,
        // `3 ila 5 yaş`): both ends of one shape, the first the smaller, and the second before
        // the unit (or with it glued) or before `yaş`.
        let to = match (
            next.map(|n| n.stem.as_str()),
            after_next.map(|n| n.stem.as_str()),
        ) {
            (Some("-" | "ile" | "ila" | "veya"), _) => Some(i + 2),
            (Some("ya"), Some("da")) => Some(i + 3),
            _ => None,
        };
        let spaced = bare
            && to.is_some_and(|j| {
                let Some(m) = words.get(j) else {
                    return false;
                };
                let (m_num, m_glued) = split_number(&m.stem);
                let rising = rising(num, m_num);
                let units = count_part(num)
                    && count_part(m_num)
                    && (GLUED_UNITS.contains(&m_glued)
                        || (m_glued.is_empty() && unit_after(&words, j, m_num)));
                let ages =
                    age_part(num) && age_part(m_num) && m_glued.is_empty() && age_after(&words, j);
                rising && (units || ages)
            });
        if spaced {
            continue;
        }
        // A one-digit count or range before a count noun: `2-3 fotoğraf`, `2 ya da 3 fotoğraf`.
        fn one_digit(t: &str) -> bool {
            t.len() == 1 && t.as_bytes()[0].is_ascii_digit()
        }
        let counted =
            |n: Option<&Word>| n.is_some_and(|n| COUNT_NOUNS.iter().any(|c| n.stem.starts_with(c)));
        if glued.is_empty() && !w.suffixed {
            if range_of(num, one_digit) && counted(next) {
                continue;
            }
            let (other, noun) = match (
                next.map(|n| n.stem.as_str()),
                after_next.map(|n| n.stem.as_str()),
            ) {
                (Some("ya"), Some("da")) => (words.get(i + 3), words.get(i + 4)),
                (Some("veya"), _) => (words.get(i + 2), words.get(i + 3)),
                _ => (None, None),
            };
            if one_digit(num) && other.is_some_and(|o| one_digit(&o.stem)) && counted(noun) {
                continue;
            }
        }
        // The current or next year, bare, only where it reads as a date: beside a month's name,
        // or before `yıl` (`yılı`, `yılında`, `yılbaşı`); never beside a price's word.
        let month = |n: Option<&Word>| n.is_some_and(|n| starts_any(&n.stem, MONTHS));
        let bare_year = glued.is_empty()
            && !w.suffixed
            && digits_only
            && num.len() == 4
            && num.parse::<i32>().is_ok_and(|y| y == year || y == year + 1)
            && (month(prev) || month(next) || next.is_some_and(|n| starts(&n.stem, "yıl")))
            && !prev.is_some_and(|p| is_currency(p) || is_term(p) || is_price_word(p))
            && !next.is_some_and(|n| is_currency(n) || is_term(n) || is_bin(n) || is_price_word(n));
        if bare_year {
            continue;
        }
        out.numbers.push(i);
    }
    end_phone(&mut out, &mut phone, &mut phone_digits);
    out
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/// A link of a text, normalised: its host (lower case, without `www.`) and its path (without a
/// trailing `/`; empty for none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub host: String,
    pub path: String,
}

/// The links in `text`: every token with a scheme, every `label.tld` (at least two letters after
/// the last dot, an `xn--` ending included), every IPv4 address, with or without a path, and an
/// email address's domain.
pub fn links_in(text: &str) -> Vec<Link> {
    normalise(text).split(' ').filter_map(link_of).collect()
}

fn link_of(token: &str) -> Option<Link> {
    let t = token.trim_matches(|c: char| "()[]<>{}\"'.,;:!?«»“”‘’".contains(c));
    let t = t.rsplit_once('@').map_or(t, |(_, domain)| domain);
    let (scheme, rest) = match t.split_once("://") {
        Some((_, rest)) => (true, rest),
        None => (false, t),
    };
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host = host.trim_start_matches('[');
    let host = host.split([':', ']']).next().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    let labels_ok = labels.len() >= 2
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '-'));
    let ipv4 = labels.len() == 4
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.len() <= 3 && l.parse::<u16>().is_ok_and(|n| n <= 255));
    let name = labels_ok
        && labels.last().is_some_and(|tld| {
            tld.starts_with("xn--")
                || (tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic))
        });
    let link = (scheme && !host.is_empty()) || ipv4 || name;
    link.then(|| Link {
        host: host.to_owned(),
        path: path.trim_end_matches('/').to_owned(),
    })
}

/// Whether every link of `text` is one the cards' text `cards` holds as a whole token: the same
/// host, and the same path when the text's link has one.
pub fn links_allowed(text: &str, cards: &str) -> bool {
    let known = links_in(cards);
    links_in(text).iter().all(|l| link_known(&known, l))
}

/// Whether link `l` is one of `known` (the cards'): the same host, and the same path when `l`
/// has one.
fn link_known(known: &[Link], l: &Link) -> bool {
    known
        .iter()
        .any(|k| k.host == l.host && (l.path.is_empty() || k.path == l.path))
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/// The day's limits an automatic reply is held to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Model calls per conversation per local day.
    pub per_conversation: u32,
    /// Model calls per workspace per local day.
    pub per_workspace: u32,
    /// The model's cost per workspace per local day, in millionths of a US dollar.
    pub spend_micro_usd: i64,
}

/// The day so far: the model calls made and their cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Today {
    pub conversation_sent: u32,
    pub workspace_sent: u32,
    pub spend_micro_usd: i64,
}

/// The limit `today` reached under `limits`, if any, by its code: `limit_conversation`,
/// `limit_workspace` or `limit_spend`.
pub fn limit_reached(limits: Limits, today: Today) -> Option<&'static str> {
    if today.conversation_sent >= limits.per_conversation {
        Some("limit_conversation")
    } else if today.workspace_sent >= limits.per_workspace {
        Some("limit_workspace")
    } else if today.spend_micro_usd >= limits.spend_micro_usd {
        Some("limit_spend")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const YEAR: i32 = 2026;
    const RANGE: Range = Range {
        min_minor: 100_000,
        max_minor: 500_000,
    };

    fn reply(text: &str) -> Result<(), Refusal> {
        check_reply(text, "", YEAR)
    }

    #[test]
    fn a_persons_price_is_read_generously_and_dates_times_and_phones_are_not() {
        for text in [
            "3500 olur",
            "3.500",
            "3500'e yaparım",
            "2750 olsun",
            "iki buçuk",
            "3.500 TL",
            "%10 indirim",
        ] {
            assert!(states_money(text, YEAR), "{text}");
        }
        for text in [
            "Yarın 14:30'da",
            "21.11 teslim",
            "0532 123 45 67",
            "7 gün içinde",
            "Merhaba, bakıyorum.",
        ] {
            assert!(!states_money(text, YEAR), "{text}");
        }
    }

    #[test]
    fn replies_that_name_no_money_pass() {
        for text in [
            "2026 yılbaşı siparişleri",
            "2027 yılında da alıyoruz",
            "Aralık 2026",
            "2027 Ocak ayında",
            "21.11.2026",
            "21/11 teslim",
            "Saat 14.30'da",
            "14:30",
            "+90 532 123 4567",
            "05321234567",
            "0532 123 45 67",
            "1200 mm",
            "1200mm",
            "15 cm",
            "7 gün",
            "3-5 iş günü",
            "2 adet",
            "14.30",
            "Merhaba, nasıl yardımcı olabilirim?",
            "Siparişinizi bir binaya teslim ederiz.",
            "Yüz yüze görüşebiliriz.",
            "Bir figür mü, iki figür mü?",
            "Boyu 2.5 cm",
            "12 ay garanti",
            "Binanıza teslim",
            "Hediye paketi isterseniz söyleyin.",
            "Yarın kargoda.",
            // One-digit counts before a count noun.
            "2-3 fotoğraf yeterli olur.",
            "2 ya da 3 fotoğraf gönderebilir misiniz?",
            "1 veya 2 açıdan",
            "3 figür için",
            "2 renk seçeneği",
            "4 örnek",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
        }
    }

    #[test]
    fn replies_that_name_money_are_refused() {
        for text in [
            // The first review's table.
            "950 liraya yaparız",
            "3 bin civarı",
            "2 bin 500",
            "üç bin olur",
            "dokuz yüz elli lira",
            "%30 indirim yapabiliriz",
            "yüzde 30",
            "iskonto var",
            "KDV dahil",
            "$150",
            "150 dolar",
            "150 euro",
            "€150",
            "150 USD",
            "2750'ye yaparız",
            "Fiyatı 1.250 TL",
            "950₺",
            "950tl",
            "TL'dir",
            "450 olur",
            "1250",
            "liralık bir iş",
            // The second review's.
            "2 bine yaparız",
            "3 binlik",
            "5 binden",
            "2bin olur",
            "iki buçuk bin",
            "dokuz yüz elliye yaparız",
            "sekiz yüze olur",
            "ikincisi bedava",
            "yarı fiyatına",
            "ücretsiz kargo",
            "2.025'e yaparız",
            "２７５０ olur",
            "٢٧٥٠ olur",
            "2\u{200B}750",
            "İNDİRİM VAR",
            "elliye olur",
            "beleş",
            // Counts stay strict beyond one digit and a count noun.
            "2-3 bin",
            "3 figür 5000",
            "12 fotoğraf",
            "2-3 olur",
            "taksit yapılır",
            "peşine",
            "kapora alınır",
            "hediye çeki",
            "yarı yarıya",
            "2028 olur",
            "2026 TL",
            // The third review's.
            "binliğe yaparız",
            "biner tane",
            "yüzlüğe",
            "kırkar",
            "üçbin",
            "dokuzyüzelli",
            "dokuzyüzelliye",
            "ikincisi hediye",
            "yanında hediye",
            "hediye çekimiz var",
            "yarısına",
            "kargo bizden",
            "ikincisi bizden",
            "free shipping",
            "20 percent discount",
            "half price",
            "ТL",
            "lіra",
            "0532 123",
            "36 ay",
            "+90 532",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        assert_eq!(reply("  "), Err(Refusal::EmptyText));
        assert_eq!(
            reply(&"a".repeat(MAX_TEXT_CHARS + 1)),
            Err(Refusal::TextTooLong)
        );
    }

    #[test]
    fn every_allowed_forms_example_passes_and_the_model_is_told_each() {
        let prompt = allowed_forms_prompt();
        for form in ALLOWED_FORMS {
            for example in form.examples {
                assert_eq!(reply(example), Ok(()), "{example}");
                assert!(!states_money(example, YEAR), "{example}");
                assert!(prompt.contains(&format!("`{example}`")), "{example}");
            }
        }
        // The lists the rules hold are the lists the model reads.
        for word in UNITS.iter().chain(UNITS_EXACT).chain(COUNT_NOUNS) {
            assert!(prompt.contains(word), "{word}");
        }
        assert!(!prompt.contains("{units}") && !prompt.contains("{nouns}"));
        // The forms with no example of their own.
        assert_eq!(reply("0532 123 45 67"), Ok(()));
        assert_eq!(reply("2026 yılı siparişleri"), Ok(()));
        assert_eq!(reply("Aralık 2026"), Ok(()));
    }

    #[test]
    fn the_ordinary_numbers_of_a_sales_conversation_pass() {
        for text in [
            // The dimension.
            "3D baskı yapıyoruz.",
            "3D'li baskı",
            "3d baskı",
            "3 boyutlu baskı",
            "2D çizim",
            "3B baskı",
            // Ages.
            "12 yaşında",
            "12 yaşındaki biri için",
            "5 yaşında",
            "3-5 yaş arası",
            "3 ila 5 yaş",
            // A short number before `numara`.
            "10 numara",
            "7 numaralı olsun",
            // List numbers opening a line.
            "Birkaç sorum var:\n1. Kaç adet olsun?\n2. Boyu ne kadar olsun?",
            "1) Fotoğraf\n2) Boyut",
            // Ranges with a dash, spaces or words between their ends.
            "15–20 cm arası",
            "15 - 20 cm",
            "15 ile 20 cm arası",
            "15 ile 20cm",
            "10 ila 15 gün",
            "2 veya 3 hafta",
            "2 tane fotoğraf",
            "3 adet",
            // A day before a month's name.
            "15 Aralık'a kadar",
            // All of it together, as a first answer may be.
            "Merhaba! 12 yaşında biri için 3D baskı yapabiliriz.\n1. Boyu 15–20 cm arası mı \
             olsun?\n2. 2 fotoğraf gönderebilir misiniz?",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
            assert!(!states_money(text, YEAR), "{text}");
        }
        assert_eq!(normalise("15–20 ‒ 3−2"), "15-20 - 3-2");
    }

    #[test]
    fn the_new_forms_never_let_money_through() {
        for text in [
            // The dimension beside money, glued to it or in another form.
            "3D 500 TL",
            "3D baskı 3500",
            "3D 3500 olur",
            "3dtl",
            "3D₺",
            "₺3D",
            "3D TL",
            "3d dolar",
            "3D'ye 2500",
            "3 boyutlu 2500 olur",
            "4D",
            "13D",
            "3 D",
            "3D baskı %20 indirimli",
            // Ages beside money or out of their form.
            "12 yaşında 1500",
            "120 yaşında",
            "1.500 yaşında",
            "05 yaşında",
            "5 yaşına 500 TL",
            "5 yaş indirimi var",
            "150 ile 200 yaş",
            "5-3 yaş",
            // `numara` with more than two digits or beside money.
            "100 numara",
            "1.000 numara",
            "10 numara 500",
            "10 numara indirim",
            // A list number but not opening a line, or with nothing after it, or with money.
            "1. 500 TL",
            "1) 3500",
            "12. Soru",
            "Fiyat 1. sınıf",
            "1500.\nBaşka",
            "Kaç tane?\n3.",
            // Ranges: falling, beside money, with no unit, or months over 24.
            "3500 - 7 gün",
            "20 ile 15 cm",
            "15 ile 20 TL",
            "1500 ile 2000",
            "1.250–1.500 TL",
            "2 ile 36 ay",
            "12 tane",
            "2 tane 500",
            // A day before a month only up to 31, with no more than two digits.
            "32 Aralık",
            "1500 Aralık",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        for text in ["3D 3500 olur", "12 yaşında 1500", "10 numara 500"] {
            assert!(states_money(text, YEAR), "{text}");
        }
        let quote = |text| check_quote(1_250, text, RANGE, "", YEAR);
        assert_eq!(quote("3D baskı için teklifimiz 1.250 TL."), Ok(125_000));
        assert_eq!(
            quote("3D baskı 1.250 TL, 10 numara 500 TL"),
            Err(Refusal::QuoteTextMismatch)
        );
    }

    #[test]
    fn money_typed_without_turkish_letters_is_refused() {
        for text in [
            "Fiyatı dokuz yuz elli olur.",
            "ucretsiz kargo",
            "pesin odersen",
            "yuzde on daha uygun",
            "kirka olur",
            "kirk bin",
            "kurus",
            "yuzelli",
            "dokuzyuzelli",
            "iki bucuk bin",
            "UCRETSIZ KARGO",
            "ikincisi bedava",
            "yari fiyatina",
            "yarisina",
            "hediye ceki",
            "IBAN'a gönderin",
            "sekiz yuze olur",
            "iki bine",
            "kirkar",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        assert!(states_money("iki bucuk", YEAR));
        // Ordinary words that read onto a number or a money word stay as they were.
        for text in [
            "Yüzünü net gösteren bir fotoğraf olsun.",
            "yuzunu gosteren bir fotograf",
            "Yüz yüze görüşebiliriz.",
            "yuz yuze gorusebiliriz",
            "Önce bir fotoğraf gönderin.",
            "Ön yüz ve arka yüz",
            "Binanıza teslim ederiz.",
            "Elli kere teşekkürler",
            "Kırk yıllık usta",
            "kirk yillik usta",
            "Bir de arka taraf",
            "Uç kısmı ince olsun.",
            "Kuru bir yerde saklayın.",
            "Yarın kargoda.",
            "yarin kargoda",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
        }
    }

    #[test]
    fn payment_terms_and_a_count_of_months_beside_them_are_refused() {
        for text in [
            "12 ay vadeli",
            "6 aylık vade farksız",
            "2 ayda bir ödeme",
            "2 ayda bir odeme",
            "Havale ile",
            "havaleyle olur",
            "Nakit olur",
            "EFT yapabilirsiniz",
            "EFT'yle",
            "IBAN gönderelim",
            "Ödemeyi kapıda alırız",
            "Vadesiz",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        assert!(
            scan("12 ay vadeli", YEAR).numbers.contains(&0),
            "the count too"
        );
        for text in [
            "12 ay garanti",
            "6 aylık bakım",
            "2 ayda bir kontrol",
            "3 ay sonra",
            "Kalite vadediyoruz.",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
        }
    }

    #[test]
    fn while_ordering_the_payment_method_may_be_asked() {
        let ordering = |t: &str| check_reply_in(t, "", YEAR, Reading::Ordering);
        for text in [
            "Kartla mı havaleyle mi ödemek istersiniz?",
            "Ödemeyi kartla mı yaparsınız, EFT ile mi?",
            "odemeyi havale ile mi yaparsiniz",
        ] {
            assert_eq!(ordering(text), Ok(()), "{text}");
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        // Everything else of money stays refused while ordering.
        for text in [
            "12 ay vadeli",
            "Nakit olur",
            "IBAN gönderelim",
            "950 TL",
            "peşin olur",
        ] {
            assert_eq!(ordering(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
    }

    #[test]
    fn a_range_rises_and_its_first_end_is_no_longer() {
        for text in [
            "3500-7 gün",
            "3500–7 gün",
            "9500-1 hafta",
            "3.500-7 gün",
            "20-15 cm",
            "100-20 adet",
            "5-3 fotoğraf",
            "1-2-3 gün",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
            assert!(states_money(text, YEAR), "{text}");
        }
        for text in [
            "3-5 iş günü",
            "15-20 cm",
            "1-2 hafta",
            "2.5-3 cm",
            "10-15 gün",
            "2-3 fotoğraf",
            "9-10 gün",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
        }
    }

    #[test]
    fn a_bare_year_passes_only_as_a_date() {
        for text in [
            "Fiyatı 2026",
            "2027 olur",
            "2026",
            "Ücreti 2026",
            "ucreti 2026",
            "Tutarı 2027",
            "2027 için de alıyoruz",
            "Aralık 2026 olur",
        ] {
            assert_eq!(reply(text), Err(Refusal::PriceWithoutQuote), "{text}");
        }
        for text in [
            "Aralık 2026",
            "2026 Aralık ayında",
            "2027 yılında",
            "2026 yılbaşı",
            "21.11.2026",
        ] {
            assert_eq!(reply(text), Ok(()), "{text}");
        }
    }

    #[test]
    fn a_refused_text_is_named_part_by_part() {
        let parts = refused_parts(
            "12 fotoğraf, 950 liraya, %10 indirim, iki bin, ornek.test, 12 fotoğraf",
            "",
            YEAR,
        );
        let got: Vec<(&str, &str)> = parts
            .iter()
            .map(|p| (p.kind.key(), p.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("number", "12"),
                ("amount", "950"),
                ("currency", "liraya"),
                ("term", "%10"),
                ("term", "indirim"),
                ("number_word", "bin"),
                ("link", "ornek.test"),
            ]
        );
        assert!(refused_parts("3D baskı, 12 yaşında, 15–20 cm", "", YEAR).is_empty());
        assert!(refused_parts("ornek.test", "ornek.test", YEAR).is_empty());
        // What check_reply refuses, refused_parts names.
        for text in ["450 olur", "ücretsiz kargo", "dokuz yüz elli", "baska.shop"] {
            assert!(reply(text).is_err(), "{text}");
            assert!(!refused_parts(text, "", YEAR).is_empty(), "{text}");
        }
    }

    #[test]
    fn a_quote_states_its_amount_once_and_nothing_else_of_money() {
        let quote = |amount, text| check_quote(amount, text, RANGE, "", YEAR);
        assert_eq!(quote(1_250, "Teklifimiz 1.250 TL, 15 cm."), Ok(125_000));
        assert_eq!(quote(1_250, "₺1.250 olur."), Ok(125_000));
        assert_eq!(
            quote(1_250, "1.250 TL, 30.11.2026 tarihine kadar geçerli."),
            Ok(125_000)
        );
        assert_eq!(quote(1_250, "1.250 TL, 7 gün geçerli."), Ok(125_000));
        for (amount, text, refusal) in [
            (6_000, "6.000 TL", Refusal::QuoteOutOfRange),
            (999, "999 TL", Refusal::QuoteOutOfRange),
            (i64::MAX, "x", Refusal::QuoteOutOfRange),
            (1_250, "Teklifimiz hazır.", Refusal::QuoteTextMismatch),
            (1_250, "1250 olur", Refusal::QuoteTextMismatch),
            (1_250, "1.250 TL ya da 1.500 TL", Refusal::QuoteTextMismatch),
            (1_250, "1.250 TL, yani 1.250 TL", Refusal::QuoteTextMismatch),
            (
                1_000,
                "1.000 TL, ikincisi %50 indirimli",
                Refusal::QuoteTextMismatch,
            ),
            (1_250, "1.250 TL + KDV", Refusal::QuoteTextMismatch),
            (1_250, "1 bin 250 TL", Refusal::QuoteTextMismatch),
            (
                1_250,
                "1.250 TL, ikincisi bedava",
                Refusal::QuoteTextMismatch,
            ),
            (
                1_250,
                "1.250 TL, ikinci figür sekiz yüz",
                Refusal::QuoteTextMismatch,
            ),
            (1_250, "1.250 TL, kargo 2 lira", Refusal::QuoteTextMismatch),
            (1_250, "1.250 TL, 3 taksit", Refusal::QuoteTextMismatch),
        ] {
            assert_eq!(quote(amount, text), Err(refusal), "{text}");
        }
    }

    #[test]
    fn text_is_normalised_before_it_is_read() {
        assert_eq!(normalise("２٧\u{200B}5０"), "2750");
        assert_eq!(normalise("İNDİRİM IŞIK"), "indirim ışık");
        assert_eq!(normalise("a\u{00A0}b"), "a b");
    }

    #[test]
    fn a_link_must_be_one_of_the_cards_whole() {
        let cards = "Katalog: https://ornek.example.com/katalog ve ornek.com.tr";
        assert!(links_allowed("Bakın: ornek.example.com/katalog", cards));
        assert!(links_allowed("ornek.example.com", cards), "the host alone");
        assert!(links_allowed("www.ornek.com.tr adresinden", cards));
        assert!(
            !links_allowed("ornek.example.com/baska", cards),
            "another path"
        );
        assert!(!links_allowed("https://baska.com", cards));
        assert!(!links_allowed("baska.shop", cards), "any ending is a link");
        assert!(!links_allowed("example.com", cards), "never by substring");
        assert!(!links_allowed("kisa.link/abc", cards));
        assert!(!links_allowed("http://192.168.1.5/x", cards), "an address");
        assert!(!links_allowed("10.0.0.1", cards), "a bare address");
        assert!(!links_allowed("ornek.xn--p1ai", cards), "an IDN ending");
        assert!(
            !links_allowed("https://localhost/a", cards),
            "anything with a scheme"
        );
        assert!(links_allowed("Teşekkürler. Görüşürüz!", cards));
        assert!(links_allowed("Ölçü 2.5 cm, 3.5cm", cards));
        assert!(links_allowed("ornek.xn--p1ai", "ornek.xn--p1ai"));
        assert_eq!(
            check_reply("Detay: https://baska.com", cards, YEAR),
            Err(Refusal::LinkInReply)
        );
    }

    #[test]
    fn limits_are_reached_in_order() {
        let limits = Limits {
            per_conversation: 2,
            per_workspace: 3,
            spend_micro_usd: 10,
        };
        let today = |c, w, s| Today {
            conversation_sent: c,
            workspace_sent: w,
            spend_micro_usd: s,
        };
        assert_eq!(limit_reached(limits, today(1, 2, 9)), None);
        assert_eq!(
            limit_reached(limits, today(2, 2, 0)),
            Some("limit_conversation")
        );
        assert_eq!(
            limit_reached(limits, today(0, 3, 0)),
            Some("limit_workspace")
        );
        assert_eq!(limit_reached(limits, today(0, 0, 10)), Some("limit_spend"));
    }
}
