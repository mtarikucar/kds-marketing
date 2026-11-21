//! The rules the server holds an automatic reply to, whatever the model wrote (the inbox's
//! automatic replies, `usecases::inbox::autoreply`): what a reply may say, what a quote must say,
//! which links it may carry and when the day's limits are reached. Pure: no I/O, no clock.
//!
//! - A reply ([`check_reply`]) is 1 to [`MAX_TEXT_CHARS`] characters, names **no money amount**
//!   (a number next to TL, ₺, lira or TRY, or a number of four digits or more: a price is only
//!   ever given through a quote) and no link the knowledge cards do not hold.
//! - A quote ([`check_quote`]) is a whole amount within the owner's range, and its text states
//!   that amount and no other.
//! - A link is allowed only when the cards' text holds it ([`links_allowed`]).
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
    /// A reply names a money amount: prices go out only as a quote.
    PriceWithoutQuote,
    /// The quote's amount is outside the owner's range.
    QuoteOutOfRange,
    /// The quote's text does not state its amount, or states another one.
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

/// A reply the model wrote, checked: its length, no money amount, only the cards' links.
pub fn check_reply(text: &str, cards: &str) -> Result<(), Refusal> {
    check_text(text, cards)?;
    if !money_amounts(text).is_empty() {
        return Err(Refusal::PriceWithoutQuote);
    }
    Ok(())
}

/// A quote of `amount` whole currency units with its `text`, checked against `range`: answers the
/// amount in minor units. The amount is within the range; the text states it and no other amount.
pub fn check_quote(amount: i64, text: &str, range: Range, cards: &str) -> Result<i64, Refusal> {
    let minor = amount
        .checked_mul(100)
        .filter(|m| (range.min_minor..=range.max_minor).contains(m))
        .ok_or(Refusal::QuoteOutOfRange)?;
    check_text(text, cards)?;
    let stated = money_amounts(text);
    if stated.is_empty() || stated.iter().any(|m| *m != minor) {
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

/// The money amounts `text` names, in minor units, in order: each number next to a currency
/// (TL, ₺, lira, TRY, before or after it, "bin" multiplying by a thousand) and each number of four
/// digits or more. A Turkish thousands separator (`2.750`) or an English one (`2,750`) is read as
/// such; one or two digits after the last separator are kuruş (`2.750,50`).
pub fn money_amounts(text: &str) -> Vec<i64> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i;
        while end < chars.len()
            && (chars[end].is_ascii_digit()
                || (matches!(chars[end], '.' | ',')
                    && chars.get(end + 1).is_some_and(char::is_ascii_digit)))
        {
            end += 1;
        }
        i = end;
        // A number glued to a word (`A4`, `x2000`) is a name, not an amount.
        if start > 0 && is_word(chars[start - 1]) {
            continue;
        }
        let token: String = chars[start..end].iter().collect();
        let Some((whole, kurus, digits)) = parse_number(&token) else {
            continue;
        };
        let (thousand, after) = currency_after(&chars, end);
        let marked = after || currency_before(&chars, start);
        if !(marked || digits >= 4) {
            continue;
        }
        let whole = if thousand {
            whole.saturating_mul(1000)
        } else {
            whole
        };
        out.push(whole.saturating_mul(100).saturating_add(kurus));
    }
    out
}

/// A letter or a digit: a number glued to a word (`A4`, `x2000`) is not an amount.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() && !c.is_ascii_digit()
}

/// `token` (digits and separators) as (whole units, kuruş, digits of the whole part).
fn parse_number(token: &str) -> Option<(i64, i64, usize)> {
    let groups: Vec<&str> = token.split(['.', ',']).collect();
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

/// What follows position `at`: `(multiplied by a thousand, a currency)`.
fn currency_after(chars: &[char], at: usize) -> (bool, bool) {
    let rest: String = chars[at..].iter().collect::<String>().to_lowercase();
    let rest = rest.trim_start();
    let (thousand, rest) = match rest.strip_prefix("bin") {
        Some(r) if !r.chars().next().is_some_and(char::is_alphanumeric) => (true, r.trim_start()),
        _ => (false, rest),
    };
    let marked = ["tl", "₺", "lira", "try"].iter().any(|m| {
        rest.strip_prefix(m)
            .is_some_and(|r| *m == "₺" || !r.chars().next().is_some_and(char::is_alphanumeric))
    });
    (thousand && marked, marked)
}

/// Whether a currency comes right before position `at` (`₺2.750`, `TL 2.750`, `TRY 2750`).
fn currency_before(chars: &[char], at: usize) -> bool {
    let before: String = chars[..at].iter().collect::<String>().to_lowercase();
    let before = before.trim_end();
    if before.ends_with('₺') {
        return true;
    }
    ["tl", "try"].iter().any(|m| {
        before
            .strip_suffix(m)
            .is_some_and(|r| !r.chars().next_back().is_some_and(char::is_alphanumeric))
    })
}

/// The top-level domains a bare name is read as a link with (`ornek.com`, `ornek.com.tr`);
/// a scheme or `www.` makes any name a link.
const TLDS: &[&str] = &[
    "com", "net", "org", "tr", "io", "co", "me", "app", "shop", "store", "info", "biz", "xyz",
    "link", "ly", "gl", "to", "ai", "dev", "site", "online", "page", "eu", "de", "uk", "us",
];

/// The links in `text`, normalised: lower case, without the scheme, `www.` and a trailing `/`.
pub fn links_in(text: &str) -> Vec<String> {
    text.split_whitespace().filter_map(link_of).collect()
}

fn link_of(token: &str) -> Option<String> {
    let t = token
        .trim_matches(|c: char| "()[]<>{}\"'.,;:!?«»“”‘’".contains(c))
        .to_lowercase();
    let t = t.rsplit_once('@').map_or(t.as_str(), |(_, domain)| domain);
    let explicit = t.contains("://") || t.starts_with("www.");
    let bare = t.split_once("://").map_or(t, |(_, rest)| rest);
    let bare = bare.strip_prefix("www.").unwrap_or(bare);
    let bare = bare.trim_end_matches('/');
    let host = bare.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() {
        return None;
    }
    let domain_like = host.contains('.')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|tld| TLDS.contains(&tld));
    (explicit || domain_like).then(|| bare.to_owned())
}

/// Whether every link of `text` is one the cards' text `cards` holds.
pub fn links_allowed(text: &str, cards: &str) -> bool {
    let known: Vec<String> = links_in(cards);
    let cards = cards.to_lowercase();
    links_in(text)
        .iter()
        .all(|l| known.iter().any(|k| k == l) || cards.contains(l.as_str()))
}

/// The day's limits an automatic reply is held to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Automatic messages per conversation per local day.
    pub per_conversation: u32,
    /// Automatic messages per workspace per local day.
    pub per_workspace: u32,
    /// The model's cost per workspace per local day, in millionths of a US dollar.
    pub spend_micro_usd: i64,
}

/// The day so far: what was sent and spent.
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
    fn a_number_next_to_a_currency_or_of_four_digits_is_money() {
        assert_eq!(money_amounts("Fiyatı 1.250 TL"), vec![125_000]);
        assert_eq!(money_amounts("₺1.250,50 olur"), vec![125_050]);
        assert_eq!(money_amounts("1,250 try"), vec![125_000]);
        assert_eq!(money_amounts("950 lira"), vec![95_000]);
        assert_eq!(money_amounts("950₺"), vec![95_000]);
        assert_eq!(money_amounts("TL 950"), vec![95_000]);
        assert_eq!(money_amounts("3 bin TL"), vec![300_000]);
        assert_eq!(money_amounts("toplam 1250"), vec![125_000]);
        assert_eq!(money_amounts("2.5 lira"), vec![250]);
    }

    #[test]
    fn sizes_days_and_glued_numbers_are_not_money() {
        assert!(money_amounts("15 cm, 3-5 iş günü, 2 figür").is_empty());
        assert!(money_amounts("A4 kâğıt ve x2000 kod").is_empty());
        assert!(money_amounts("950 tlx").is_empty());
        assert!(money_amounts("Merhaba, nasıl yardımcı olabilirim?").is_empty());
    }

    #[test]
    fn a_reply_with_a_price_is_refused() {
        assert_eq!(check_reply("Merhaba!", ""), Ok(()));
        assert_eq!(
            check_reply("Bunun fiyatı 950 TL.", ""),
            Err(Refusal::PriceWithoutQuote)
        );
        assert_eq!(check_reply("  ", ""), Err(Refusal::EmptyText));
        assert_eq!(
            check_reply(&"a".repeat(MAX_TEXT_CHARS + 1), ""),
            Err(Refusal::TextTooLong)
        );
    }

    #[test]
    fn a_quote_is_in_range_and_states_its_amount_only() {
        assert_eq!(
            check_quote(1_250, "Teklifimiz 1.250 TL, 15 cm.", RANGE, ""),
            Ok(125_000)
        );
        assert_eq!(
            check_quote(6_000, "6.000 TL", RANGE, ""),
            Err(Refusal::QuoteOutOfRange)
        );
        assert_eq!(
            check_quote(999, "999 TL", RANGE, ""),
            Err(Refusal::QuoteOutOfRange)
        );
        assert_eq!(
            check_quote(1_250, "Teklifimiz hazır.", RANGE, ""),
            Err(Refusal::QuoteTextMismatch)
        );
        assert_eq!(
            check_quote(1_250, "1.250 TL ya da 1.500 TL", RANGE, ""),
            Err(Refusal::QuoteTextMismatch)
        );
        assert_eq!(
            check_quote(i64::MAX, "x", RANGE, ""),
            Err(Refusal::QuoteOutOfRange)
        );
    }

    #[test]
    fn only_the_cards_links_are_allowed() {
        let cards = "Katalog: https://ornek.example.com/katalog ve ornek.com.tr";
        assert!(links_allowed("Bakın: ornek.example.com/katalog", cards));
        assert!(links_allowed("www.ornek.com.tr adresinden", cards));
        assert!(!links_allowed("https://baska.com", cards));
        assert!(!links_allowed("baska.com.tr", cards));
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
