//! The rules the server holds an automatic reply to, whatever the model wrote (the inbox's
//! automatic replies, `usecases::inbox::autoreply`): what a reply may say, what a quote must say,
//! which links it may carry and when the day's limits are reached. Pure: no I/O, no clock.
//!
//! The bias is to hand over: a wrong price reaching a customer is the costly error, a needless
//! hand-over only costs a person a look.
//!
//! - A reply ([`check_reply`]), and a hand-over's line to the customer, name **no money**: no
//!   currency word or symbol (TL, ₺, TRY, lira and its suffixed forms, dolar, euro, $, €, USD,
//!   EUR), no "bin" (thousand) after a number, no percent, discount or VAT wording, and no bare
//!   number of three digits or more unless it is a date, a time, a year (2020 to 2039), a phone
//!   number or a quantity with its unit (gün, saat, hafta, ay, cm, mm, adet …).
//! - A quote ([`check_quote`]) is a whole amount within the owner's range, and its text states
//!   that amount exactly once, and no other amount, percent, discount or VAT.
//! - A link (any `label.tld`, with or without a scheme or a path) is allowed only when the cards
//!   hold the same host, and the same path when the reply names one, as a whole token
//!   ([`links_allowed`]).
//!
//! What is refused is a [`Refusal`]; the caller hands the conversation to a person with its code.

/// The longest text of one automatic message, in characters.
pub const MAX_TEXT_CHARS: usize = 1_000;

/// Why the server turned down what the model answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The text is empty.
    EmptyText,
    /// The text is over [`MAX_TEXT_CHARS`].
    TextTooLong,
    /// A reply names money: prices go out only as a quote.
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

/// The owner's price range, in minor units of its currency (both ends included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub min_minor: i64,
    pub max_minor: i64,
}

/// A reply the model wrote (or a hand-over's line), checked: its length, no money, only the
/// cards' links.
pub fn check_reply(text: &str, cards: &str) -> Result<(), Refusal> {
    check_text(text, cards)?;
    if scan(text).names_money() {
        return Err(Refusal::PriceWithoutQuote);
    }
    Ok(())
}

/// A quote of `amount` whole currency units with its `text`, checked against `range`: answers the
/// amount in minor units. The amount is within the range; the text states it exactly once, with
/// no other amount and no percent, discount, VAT or "bin".
pub fn check_quote(amount: i64, text: &str, range: Range, cards: &str) -> Result<i64, Refusal> {
    let minor = amount
        .checked_mul(100)
        .filter(|m| (range.min_minor..=range.max_minor).contains(m))
        .ok_or(Refusal::QuoteOutOfRange)?;
    check_text(text, cards)?;
    let s = scan(text);
    if s.discount || s.thousand_word || s.amounts != [minor] {
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

/// What [`scan`] found of money in a text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scan {
    /// A currency word or symbol.
    pub currency: bool,
    /// Percent, discount or VAT wording.
    pub discount: bool,
    /// "bin" or "milyon" after a number or a number word.
    pub thousand_word: bool,
    /// The numbers that read as amounts, in minor units, in order: every number next to a
    /// currency, and every bare number of three digits or more that is not a date, a time, a
    /// year, a phone number or a quantity with its unit.
    pub amounts: Vec<i64>,
}

impl Scan {
    /// Whether the text names money in any way.
    pub fn names_money(&self) -> bool {
        self.currency || self.discount || self.thousand_word || !self.amounts.is_empty()
    }
}

/// Number words, for "üç bin" and the like.
const NUMBER_WORDS: &[&str] = &[
    "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "yirmi",
    "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan", "yüz",
];

/// Currency words, matched as a word's stem with any Turkish suffix (`liraya`, `dolarlık`).
const CURRENCY_STEMS: &[&str] = &["lira", "dolar", "euro", "avro", "sterlin"];
/// Currency codes and abbreviations, matched as a whole word (an apostrophe suffix allowed).
const CURRENCY_CODES: &[&str] = &["tl", "try", "usd", "eur", "gbp", "ytl"];
/// Discount and VAT words, matched as a stem.
const DISCOUNT_STEMS: &[&str] = &["indirim", "iskonto", "kdv", "yüzde", "kampanya"];
/// Units a quantity is read with: exact words.
const UNITS_EXACT: &[&str] = &[
    "cm", "mm", "m", "km", "kg", "gr", "g", "ml", "lt", "dk", "sn", "ay", "ayda", "aylık", "ayı",
    "mt", "metre", "x",
];
/// Units a quantity is read with: stems with any suffix.
const UNIT_STEMS: &[&str] = &[
    "gün", "saat", "hafta", "adet", "dakika", "yıl", "santim", "parça", "kişi", "sayfa", "kat",
];
/// What may be glued after a number as its unit (`1200mm`, `15cm`).
const GLUED_UNITS: &[&str] = &["cm", "mm", "m", "km", "kg", "gr", "g", "ml", "lt"];
/// Glued currency suffixes (`950tl`, `150$`).
const GLUED_CURRENCY: &[&str] = &["tl", "try", "usd", "eur", "₺", "$", "€"];

/// One word of a text: its lower-cased text without surrounding punctuation, and its stem (the
/// part before an apostrophe suffix: `2750'ye` → `2750`, `tl'dir` → `tl`).
#[derive(Clone, Debug)]
struct Word {
    text: String,
    stem: String,
}

fn words_of(text: &str) -> Vec<Word> {
    text.split_whitespace()
        .filter_map(|raw| {
            let t = raw
                .trim_matches(|c: char| "()[]{}<>\"«»“”‘,;:!?…".contains(c))
                .trim_end_matches('.')
                .to_lowercase();
            if t.is_empty() {
                return None;
            }
            let stem = t
                .split(['\'', '’'])
                .next()
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_owned();
            Some(Word { text: t, stem })
        })
        .collect()
}

fn is_number_word(w: &Word) -> bool {
    NUMBER_WORDS.contains(&w.stem.as_str())
}

fn is_currency(w: &Word) -> bool {
    w.text.contains(['₺', '$', '€'])
        || CURRENCY_CODES.contains(&w.stem.as_str())
        || CURRENCY_STEMS.iter().any(|s| w.stem.starts_with(s))
}

fn is_discount(w: &Word) -> bool {
    w.text.contains('%') || DISCOUNT_STEMS.iter().any(|s| w.stem.starts_with(s))
}

fn is_unit(w: &Word) -> bool {
    UNITS_EXACT.contains(&w.stem.as_str()) || UNIT_STEMS.iter().any(|s| w.stem.starts_with(s))
}

/// A number word's digits and separators only: `1.250,50`, `21.11.2026`, `+90`.
fn numeric(s: &str) -> bool {
    !s.is_empty()
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '/' | ':' | '+' | '-'))
}

/// `s` as a date (`21.11.2026`, `21/11`, `21.11`) or a time (`14.30`, `14:30`).
fn date_or_time(s: &str) -> bool {
    let parts: Vec<&str> = s.split(['.', '/', ':']).collect();
    let n = |p: &str| p.parse::<u32>().ok();
    let all_digits = parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !all_digits || parts.len() < 2 {
        return false;
    }
    match parts.as_slice() {
        [d, m, y] => {
            matches!((n(d), n(m)), (Some(1..=31), Some(1..=12))) && (y.len() == 2 || y.len() == 4)
        }
        [a, b] if b.len() == 2 => {
            let date = matches!((n(a), n(b)), (Some(1..=31), Some(1..=12))) && a.len() <= 2;
            let time = matches!((n(a), n(b)), (Some(0..=23), Some(0..=59))) && a.len() <= 2;
            date || time
        }
        [a, b] if s.contains('/') => matches!((n(a), n(b)), (Some(1..=31), Some(1..=12))),
        _ => false,
    }
}

/// `s` (digits, an optional leading `+`) as the start of a phone number: `+90…`, or a number of
/// four digits or more beginning with `0` (prices never do).
fn phone_start(s: &str) -> bool {
    let digits: String = s.chars().filter(char::is_ascii_digit).collect();
    s.starts_with('+') && digits.len() >= 2 || s.starts_with('0') && digits.len() >= 4
}

/// `token` (digits and separators) as (whole units, kuruş, digits of the whole part).
fn parse_amount(token: &str) -> Option<(i64, i64, usize)> {
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
    let whole: String = whole_groups.concat();
    let digits = whole.trim_start_matches('0').len().max(1);
    let value: i64 = whole.parse().ok()?;
    Some((value, kurus, digits))
}

/// What `text` says of money (see [`Scan`]).
pub fn scan(text: &str) -> Scan {
    let words = words_of(text);
    let mut out = Scan::default();
    let mut in_phone = false;
    for (i, w) in words.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| &words[p]);
        let next = words.get(i + 1);
        if is_currency(w) {
            out.currency = true;
        }
        if is_discount(w) {
            out.discount = true;
        }
        if matches!(w.stem.as_str(), "bin" | "milyon")
            && prev.is_some_and(|p| numeric(&p.stem) || is_number_word(p))
        {
            out.thousand_word = true;
        }
        // A number: a currency symbol before it (`₺950`), its digits, and what may be glued after
        // them (`950tl`, `1200mm`).
        let stem = w.stem.trim_start_matches(['₺', '$', '€']);
        let symbol_before = stem.len() != w.stem.len();
        let split = stem
            .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | ',' | '/' | ':' | '+' | '-')))
            .unwrap_or(stem.len());
        let (num, glued) = stem.split_at(split);
        let glued = glued.trim();
        if !numeric(num) || (!glued.is_empty() && num.chars().all(|c| !c.is_ascii_digit())) {
            in_phone = false;
            continue;
        }
        let num = num.trim_matches(|c| c == '-' || c == '.' || c == ',');
        if phone_start(num) {
            in_phone = true;
            continue;
        }
        let digits_only = num.chars().all(|c| c.is_ascii_digit());
        if in_phone && digits_only && (2..=4).contains(&num.len()) {
            continue;
        }
        in_phone = false;
        if date_or_time(num) {
            continue;
        }
        // A range (`3-5`) or a span of numbers: each part on its own.
        for part in num.split('-').filter(|p| !p.is_empty()) {
            let Some((whole, kurus, digits)) = parse_amount(part) else {
                continue;
            };
            let money_next =
                symbol_before || GLUED_CURRENCY.contains(&glued) || next.is_some_and(is_currency);
            if money_next {
                out.amounts
                    .push(whole.saturating_mul(100).saturating_add(kurus));
                continue;
            }
            let unit = GLUED_UNITS.contains(&glued) || next.is_some_and(is_unit);
            let year = digits == 4 && (2020..=2039).contains(&whole) && kurus == 0;
            if digits >= 3 && !unit && !year {
                out.amounts
                    .push(whole.saturating_mul(100).saturating_add(kurus));
            }
        }
    }
    out
}

/// The money amounts `text` names, in minor units, in order (see [`Scan::amounts`]).
pub fn money_amounts(text: &str) -> Vec<i64> {
    scan(text).amounts
}

/// A link of a text, normalised: its host (lower case, without `www.`) and its path (without a
/// trailing `/`; empty for none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub host: String,
    pub path: String,
}

/// The links in `text`: every token of the form `label.tld` (at least two letters after the last
/// dot), with or without a scheme and a path, and an email address's domain.
pub fn links_in(text: &str) -> Vec<Link> {
    text.split_whitespace().filter_map(link_of).collect()
}

fn link_of(token: &str) -> Option<Link> {
    let t = token
        .trim_matches(|c: char| "()[]<>{}\"'.,;:!?«»“”‘’".contains(c))
        .to_lowercase();
    let t = t.rsplit_once('@').map_or(t.as_str(), |(_, domain)| domain);
    let rest = t.split_once("://").map_or(t, |(_, rest)| rest);
    let (host, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host = host.split(':').next().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    let ok = labels.len() >= 2
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_alphanumeric() || c == '-'))
        && labels
            .last()
            .is_some_and(|tld| tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic));
    ok.then(|| Link {
        host: host.to_owned(),
        path: path.trim_end_matches('/').to_owned(),
    })
}

/// Whether every link of `text` is one the cards' text `cards` holds as a whole token: the same
/// host, and the same path when the text's link has one.
pub fn links_allowed(text: &str, cards: &str) -> bool {
    let known = links_in(cards);
    links_in(text).iter().all(|l| {
        known
            .iter()
            .any(|k| k.host == l.host && (l.path.is_empty() || k.path == l.path))
    })
}

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

    const RANGE: Range = Range {
        min_minor: 100_000,
        max_minor: 500_000,
    };

    #[test]
    fn replies_that_name_no_money_pass() {
        for text in [
            "2026 yılbaşı siparişleri",
            "21.11.2026",
            "21/11 teslim",
            "+90 532 123 4567",
            "05321234567",
            "0532 123 45 67",
            "1200 mm",
            "1200mm",
            "7 gün",
            "14.30",
            "15 cm, 3-5 iş günü, 2 figür",
            "Merhaba, nasıl yardımcı olabilirim?",
            "Siparişinizi bir binaya teslim ederiz.",
            "A4 kâğıt",
            "250 adet",
        ] {
            assert_eq!(check_reply(text, ""), Ok(()), "{text}");
        }
    }

    #[test]
    fn replies_that_name_money_are_refused() {
        for text in [
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
        ] {
            assert_eq!(
                check_reply(text, ""),
                Err(Refusal::PriceWithoutQuote),
                "{text}"
            );
        }
        assert_eq!(check_reply("  ", ""), Err(Refusal::EmptyText));
        assert_eq!(
            check_reply(&"a".repeat(MAX_TEXT_CHARS + 1), ""),
            Err(Refusal::TextTooLong)
        );
    }

    #[test]
    fn a_quote_states_its_amount_once_and_nothing_else_of_money() {
        assert_eq!(
            check_quote(1_250, "Teklifimiz 1.250 TL, 15 cm.", RANGE, ""),
            Ok(125_000)
        );
        assert_eq!(check_quote(1_250, "₺1.250 olur.", RANGE, ""), Ok(125_000));
        assert_eq!(
            check_quote(
                1_250,
                "1.250 TL, 30.11.2026 tarihine kadar geçerli.",
                RANGE,
                ""
            ),
            Ok(125_000)
        );
        for (amount, text, refusal) in [
            (6_000, "6.000 TL", Refusal::QuoteOutOfRange),
            (999, "999 TL", Refusal::QuoteOutOfRange),
            (i64::MAX, "x", Refusal::QuoteOutOfRange),
            (1_250, "Teklifimiz hazır.", Refusal::QuoteTextMismatch),
            (1_250, "1.250 TL ya da 1.500 TL", Refusal::QuoteTextMismatch),
            (1_250, "1.250 TL, yani 1.250 TL", Refusal::QuoteTextMismatch),
            (
                1_000,
                "1.000 TL, ikincisi %50 indirimli",
                Refusal::QuoteTextMismatch,
            ),
            (1_250, "1.250 TL + KDV", Refusal::QuoteTextMismatch),
            (1_250, "1 bin 250 TL", Refusal::QuoteTextMismatch),
        ] {
            assert_eq!(check_quote(amount, text, RANGE, ""), Err(refusal), "{text}");
        }
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
        assert!(links_allowed("Teşekkürler. Görüşürüz!", cards));
        assert!(links_allowed("Ölçü 2.5 cm, 3.5cm", cards));
        assert_eq!(
            check_reply("Detay: https://baska.com", cards),
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
