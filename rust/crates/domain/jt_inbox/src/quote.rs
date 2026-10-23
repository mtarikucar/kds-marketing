//! Journey quotes with assigned ISO 4217 currency codes.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Channel, JourneyId};

/// Lifecycle of a quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuoteState {
    /// Sent to the customer.
    Sent,
    /// Accepted by the customer.
    Accepted,
    /// Validity window elapsed.
    Expired,
}

/// A quoted amount; file references are opaque, agent-owned references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    /// Journey receiving the quote.
    pub journey_id: JourneyId,
    /// Price in minor currency units.
    pub amount_minor: i64,
    /// Assigned uppercase ISO 4217 code.
    pub currency: String,
    /// Last instant of validity.
    #[serde(with = "time::serde::rfc3339")]
    pub valid_until: OffsetDateTime,
    /// An opaque reference; the platform does not fetch or manage this asset.
    #[serde(default)]
    pub file_ref: Option<String>,
    /// Contact channel used to deliver it.
    pub channel: Channel,
    /// Current lifecycle state.
    pub state: QuoteState,
}

/// Invalid quote input; errors do not echo personal data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum QuoteError {
    /// Currency is not an assigned uppercase ISO 4217 code.
    #[error("invalid ISO 4217 currency")]
    InvalidCurrency,
}

impl Quote {
    /// Validate before recording a quote; storage deserialization is not input validation.
    pub fn validate(&self) -> Result<(), QuoteError> {
        if CURRENCIES.binary_search(&self.currency.as_str()).is_ok() {
            Ok(())
        } else {
            Err(QuoteError::InvalidCurrency)
        }
    }
}

// ISO 4217 maintenance agency, List One published 2026-09-17 (including funds/special codes).
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
// Update this sorted snapshot when the maintenance agency publishes assignments/withdrawals.
const CURRENCIES: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD",
    "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF",
    "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF",
    "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
    "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR",
    "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
    "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
    "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
    "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB",
    "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN",
    "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
    "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD",
    "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF",
    "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG",
];
