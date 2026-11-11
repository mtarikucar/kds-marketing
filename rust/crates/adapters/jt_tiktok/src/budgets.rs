//! TikTok's "budget verification ratio" of each currency an ad account can be in, as its reference
//! table lists them (<https://business-api.tiktok.com/portal/docs?id=1737585839634433>, read
//! 2026-11-11; generated from that page, not typed). TikTok states its least budgets in US
//! dollars and multiplies them by the currency's ratio
//! (<https://business-api.tiktok.com/portal/docs?id=1739381246298114>): an ad group's least daily
//! budget is 20 times the ratio, and its least lifetime budget that times the scheduled days; a
//! campaign's least budget is 50 times the ratio in the value-range table of the first page (the
//! second page says 20: the stricter one is kept).

/// The least daily budget of an ad group, in US dollars, before the currency's ratio.
pub(crate) const ADGROUP_DAILY_USD: i64 = 20;

/// The least budget of a campaign, in US dollars, before the currency's ratio.
pub(crate) const CAMPAIGN_USD: i64 = 50;

/// `(currency, ratio)`, in the table's order.
pub(crate) const RATIOS: &[(&str, i64)] = &[
    ("USD", 1),
    ("EUR", 1),
    ("JPY", 100),
    ("HKD", 10),
    ("GBP", 1),
    ("MYR", 1),
    ("RUB", 100),
    ("ZAR", 10),
    ("KRW", 1000),
    ("AED", 1),
    ("SAR", 1),
    ("HUF", 1),
    ("PLN", 4),
    ("DKK", 10),
    ("SEK", 10),
    ("NOK", 10),
    ("TRY", 10),
    ("MXN", 10),
    ("THB", 10),
    ("AUD", 1),
    ("CAD", 1),
    ("NZD", 1),
    ("SGD", 1),
    ("CHF", 1),
    ("CNY", 10),
    ("DZD", 100),
    ("ARS", 1),
    ("BDT", 100),
    ("BOB", 10),
    ("BRL", 1),
    ("CLP", 1000),
    ("COP", 1000),
    ("CRC", 1000),
    ("CZK", 10),
    ("EGP", 10),
    ("GTQ", 10),
    ("HNL", 10),
    ("ISK", 100),
    ("INR", 100),
    ("IDR", 10000),
    ("ILS", 1),
    ("KES", 100),
    ("MOP", 10),
    ("TWD", 10),
    ("NIO", 10),
    ("NGN", 100),
    ("PKR", 100),
    ("PYG", 10000),
    ("PEN", 1),
    ("PHP", 50),
    ("QAR", 1),
    ("RON", 1),
    ("UAH", 10),
    ("UYU", 10),
    ("VEF", 100000),
    ("VND", 10000),
];

/// TikTok's budget verification ratio of `currency` (three uppercase letters), when its table
/// lists the currency.
pub(crate) fn ratio_of(currency: &str) -> Option<i64> {
    RATIOS
        .iter()
        .find(|(listed, _)| *listed == currency)
        .map(|(_, ratio)| *ratio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_currency_is_listed_once_with_a_ratio() {
        assert_eq!(RATIOS.len(), 56);
        for (n, (code, ratio)) in RATIOS.iter().enumerate() {
            assert!(
                code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()),
                "{code}"
            );
            assert!(*ratio >= 1, "{code}");
            assert!(RATIOS[..n].iter().all(|(other, _)| other != code), "{code}");
        }
        assert_eq!(ratio_of("USD"), Some(1));
        assert_eq!(ratio_of("TRY"), Some(10));
        assert_eq!(ratio_of("XXX"), None);
    }
}
