//! The one error shape provider adapters return, and the redaction every reason goes through.

use time::Duration;

/// Why a call to a provider failed (spec §6.4). The only error shape adapters return:
///
/// - `Auth`: the credential is no longer accepted (expired, revoked, wrong password); the
///   capability turns unreachable and needs reconnecting (`reauth_required`);
/// - `Permission`: the credential is valid but lacks a scope or a role for this call;
/// - `Throttle`: the provider asks to slow down; back off, for `retry_after` when it says;
/// - `Transient`: a network or provider-side failure worth a bounded retry;
/// - `Permanent`: the request itself cannot succeed (a deleted page, a refused number); record it
///   and stop.
///
/// Build it through the constructors ([`ConnectorError::auth`], ...): they run the reason through
/// [`redact_reason`], so a reason never carries a credential even when it quotes a provider's
/// response or a request URL.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectorError {
    #[error("authentication failed: {reason}")]
    Auth { reason: String },
    #[error("permission denied: {reason}")]
    Permission { reason: String },
    #[error("rate limited{}", retry_text(.retry_after))]
    Throttle { retry_after: Option<Duration> },
    #[error("temporary failure: {reason}")]
    Transient { reason: String },
    #[error("permanent failure: {reason}")]
    Permanent { reason: String },
}

fn retry_text(retry_after: &Option<Duration>) -> String {
    match retry_after {
        Some(d) => format!(", retry after {} s", d.whole_seconds()),
        None => String::new(),
    }
}

impl ConnectorError {
    /// `Auth`, its reason redacted.
    pub fn auth(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Auth {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Permission`, its reason redacted.
    pub fn permission(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Permission {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Throttle`; a negative wait reads as no wait.
    pub fn throttle(retry_after: Option<Duration>) -> ConnectorError {
        ConnectorError::Throttle {
            retry_after: retry_after.map(|d| d.max(Duration::ZERO)),
        }
    }

    /// `Transient`, its reason redacted.
    pub fn transient(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Transient {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// `Permanent`, its reason redacted.
    pub fn permanent(reason: impl AsRef<str>) -> ConnectorError {
        ConnectorError::Permanent {
            reason: redact_reason(reason.as_ref()),
        }
    }

    /// The stable key of the variant, e.g. `"throttle"` (what a probe run records).
    pub fn kind(&self) -> &'static str {
        match self {
            ConnectorError::Auth { .. } => "auth",
            ConnectorError::Permission { .. } => "permission",
            ConnectorError::Throttle { .. } => "throttle",
            ConnectorError::Transient { .. } => "transient",
            ConnectorError::Permanent { .. } => "permanent",
        }
    }

    /// The reason, for every variant but `Throttle`.
    pub fn reason(&self) -> Option<&str> {
        match self {
            ConnectorError::Auth { reason }
            | ConnectorError::Permission { reason }
            | ConnectorError::Transient { reason }
            | ConnectorError::Permanent { reason } => Some(reason),
            ConnectorError::Throttle { .. } => None,
        }
    }

    /// Whether trying again later may succeed: `Throttle` and `Transient`.
    pub fn is_retriable(&self) -> bool {
        matches!(
            self,
            ConnectorError::Throttle { .. } | ConnectorError::Transient { .. }
        )
    }
}

/// What a masked value is replaced with.
const MASK: &str = "***";

/// `text` with every credential it may carry replaced by `***`:
///
/// - after an HTTP authorization scheme: `Bearer <token>` and `Basic <credentials>` (any case,
///   the scheme a word of its own, so `instagram_basic` is left alone);
/// - the value of a JSON-looking `"key": value` pair whose key looks like a secret's name (one of
///   [`jt_capability::REDACTED_KEYS`] by exact name, or containing `pass`, `secret`, `token`,
///   `key`, `auth` or `credential`, in any case; see [`jt_capability::is_secret_looking_key`]):
///   a string value, also when the JSON is escaped inside another JSON string and when the text
///   ends before the closing quote, or a scalar other than `null`, `true` and `false`;
/// - the value of a query-string or form pair `key=value` whose key looks like a secret's name.
///
/// Everything else is kept byte for byte. It errs on the side of masking: prose such as
/// `"basic setup"` loses its second word. Redacting twice changes nothing more.
pub fn redact_reason(text: &str) -> String {
    let text = mask_auth_schemes(text);
    let text = mask_json_pairs(&text);
    mask_query_pairs(&text)
}

/// `text` with each byte range of `ranges` (in order, not overlapping, each starting and ending
/// next to an ASCII byte or at an end of the text) replaced by [`MASK`].
fn apply_masks(text: &str, ranges: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for &(start, end) in ranges {
        out.push_str(&text[last..start]);
        out.push_str(MASK);
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

/// A byte of a key name: `[A-Za-z0-9_.-]`.
fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

/// A byte of an identifier word: `[A-Za-z0-9_]`.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// A byte of an authorization credential (RFC 7235 `token68`, plus `%` for encoded ones).
fn is_credential_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'%')
}

/// Masks the credential after `Bearer` and `Basic`.
fn mask_auth_schemes(text: &str) -> String {
    const SCHEMES: [&[u8]; 2] = [b"bearer", b"basic"];
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let word_start = i == 0 || !is_word_byte(b[i - 1]);
        let scheme = SCHEMES.iter().find(|s| {
            word_start && b.len() >= i + s.len() && b[i..i + s.len()].eq_ignore_ascii_case(s)
        });
        let Some(scheme) = scheme else {
            i += 1;
            continue;
        };
        let mut j = i + scheme.len();
        let spaces = j;
        while j < b.len() && matches!(b[j], b' ' | b'\t') {
            j += 1;
        }
        if j == spaces {
            // Part of a longer word ("Basically") or the last word of the text.
            i += 1;
            continue;
        }
        let start = j;
        while j < b.len() && is_credential_byte(b[j]) {
            j += 1;
        }
        if j > start {
            ranges.push((start, j));
        }
        i = j;
    }
    apply_masks(text, &ranges)
}

/// How many backslashes stand right before `b[i]`.
fn backslashes_before(b: &[u8], i: usize) -> usize {
    b[..i].iter().rev().take_while(|&&c| c == b'\\').count()
}

/// Whether `b[at..]` starts with exactly `run` backslashes and a quote: a quote at the escaping
/// level `run` (0 in plain JSON, 1 in JSON escaped inside a JSON string, ...).
fn quote_at(b: &[u8], at: usize, run: usize) -> bool {
    at + run < b.len() && b[at..at + run].iter().all(|&c| c == b'\\') && b[at + run] == b'"'
}

/// The first index at or after `from` where `b` holds a quote of escaping level `run`
/// ([`quote_at`]) whose backslashes are exactly `run` (a quote escaped once more belongs to the
/// value); `b.len()` when there is none.
fn closing_quote(b: &[u8], from: usize, run: usize) -> usize {
    (from..b.len())
        .find(|&q| b[q] == b'"' && q >= from + run && backslashes_before(b, q) == run)
        .map_or(b.len(), |q| q - run)
}

fn skip_spaces(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Masks the value of each `"key": value` pair whose key looks like a secret's name, at any
/// escaping level.
fn mask_json_pairs(text: &str) -> String {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'"' {
            i += 1;
            continue;
        }
        // A key: key bytes between two quotes of the same escaping level.
        let run = backslashes_before(b, i);
        let key_start = i + 1;
        let mut j = key_start;
        while j < b.len() && is_key_byte(b[j]) {
            j += 1;
        }
        if j == key_start || !quote_at(b, j, run) {
            i += 1;
            continue;
        }
        let key = &text[key_start..j];
        let after_key = j + run + 1;
        let colon = skip_spaces(b, after_key);
        if colon >= b.len() || b[colon] != b':' {
            i = after_key;
            continue;
        }
        let secret = jt_capability::is_secret_looking_key(key);
        let value = skip_spaces(b, colon + 1);
        if quote_at(b, value, run) {
            let start = value + run + 1;
            let end = closing_quote(b, start, run);
            if secret {
                if end > start {
                    ranges.push((start, end));
                }
                i = end + run + 1;
            } else {
                // Not secret: look inside, it may hold escaped JSON.
                i = value;
            }
        } else if value < b.len() && !matches!(b[value], b'{' | b'[' | b'"' | b'\\') {
            let mut end = value;
            while end < b.len()
                && !b[end].is_ascii_whitespace()
                && !matches!(b[end], b',' | b'}' | b']' | b'"' | b'\\')
            {
                end += 1;
            }
            let scalar = &text[value..end];
            if secret && end > value && !matches!(scalar, "null" | "true" | "false") {
                ranges.push((value, end));
            }
            i = end;
        } else {
            // An object, an array, a quote of another level, or the end: look inside.
            i = value;
        }
    }
    apply_masks(text, &ranges)
}

/// A byte that ends the value of a query-string or form pair.
fn ends_query_value(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, b'&' | b'"' | b'\'' | b'<' | b'>' | b'\\')
}

/// Masks the value of each `key=value` pair whose key looks like a secret's name.
fn mask_query_pairs(text: &str) -> String {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !is_key_byte(b[i]) || (i > 0 && is_key_byte(b[i - 1])) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && is_key_byte(b[j]) {
            j += 1;
        }
        if j >= b.len() || b[j] != b'=' {
            i = j;
            continue;
        }
        let start = j + 1;
        let mut end = start;
        while end < b.len() && !ends_query_value(b[end]) {
            end += 1;
        }
        if jt_capability::is_secret_looking_key(&text[i..j]) {
            if end > start {
                ranges.push((start, end));
            }
            i = end.max(start);
        } else {
            // Not secret: look inside, an unencoded URL may hold pairs of its own.
            i = start;
        }
    }
    apply_masks(text, &ranges)
}
